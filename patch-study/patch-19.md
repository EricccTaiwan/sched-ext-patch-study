# [PATCH 19/30] sched_ext: Make watchdog handle ops.dispatch() looping stall

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-20-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-20-tj@kernel.org)

## Commit Message

```text
The dispatch path retries if the local DSQ is still empty after
ops.dispatch() either dispatched or consumed a task. This is both out of
necessity and for convenience. It has to retry because the dispatch path
might lose the tasks to dequeue while the rq lock is released while trying
to migrate tasks across CPUs, and the retry mechanism makes ops.dispatch()
implementation easier as it only needs to make some forward progress each
iteration.

However, this makes it possible for ops.dispatch() to stall CPUs by
repeatedly dispatching ineligible tasks. If all CPUs are stalled that way,
the watchdog or sysrq handler can't run and the system can't be saved. Let's
address the issue by breaking out of the dispatch loop after 32 iterations.

It is unlikely but not impossible for ops.dispatch() to legitimately go over
the iteration limit. We want to come back to the dispatch path in such cases
as not doing so risks stalling the CPU by idling with runnable tasks
pending. As the previous task is still current in balance_scx(),
resched_curr() doesn't do anything - it will just get cleared. Let's instead
use scx_kick_bpf() which will trigger reschedule after switching to the next
task which will likely be the idle task.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
---
 kernel/sched/ext.c             | 17 +++++++++++++++++
 tools/sched_ext/scx_qmap.bpf.c | 15 +++++++++++++++
 tools/sched_ext/scx_qmap.c     |  8 ++++++--
 3 files changed, 38 insertions(+), 2 deletions(-)

diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 213793d086d7..89bcca84d6b5 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -8,6 +8,7 @@
 
 enum scx_consts {
 	SCX_DSP_DFL_MAX_BATCH		= 32,
+	SCX_DSP_MAX_LOOPS		= 32,
 	SCX_WATCHDOG_MAX_TIMEOUT	= 30 * HZ,
 
 	SCX_EXIT_BT_LEN			= 64,
@@ -665,6 +666,7 @@ static struct kobject *scx_root_kobj;
 #define CREATE_TRACE_POINTS
 #include <trace/events/sched_ext.h>
 
+static void scx_bpf_kick_cpu(s32 cpu, u64 flags);
 static __printf(3, 4) void scx_ops_exit_kind(enum scx_exit_kind kind,
 					     s64 exit_code,
 					     const char *fmt, ...);
@@ -1906,6 +1908,7 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 {
 	struct scx_dsp_ctx *dspc = this_cpu_ptr(scx_dsp_ctx);
 	bool prev_on_scx = prev->sched_class == &ext_sched_class;
+	int nr_loops = SCX_DSP_MAX_LOOPS;
 	bool has_tasks = false;
 
 	lockdep_assert_rq_held(rq);
@@ -1962,6 +1965,20 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 			goto has_tasks;
 		if (consume_dispatch_q(rq, rf, &scx_dsq_global))
 			goto has_tasks;
+
+		/*
+		 * ops.dispatch() can trap us in this loop by repeatedly
+		 * dispatching ineligible tasks. Break out once in a while to
+		 * allow the watchdog to run. As IRQ can't be enabled in
+		 * balance(), we want to complete this scheduling cycle and then
+		 * start a new one. IOW, we want to call resched_curr() on the
+		 * next, most likely idle, task, not the current one. Use
+		 * scx_bpf_kick_cpu() for deferred kicking.
+		 */
+		if (unlikely(!--nr_loops)) {
+			scx_bpf_kick_cpu(cpu_of(rq), 0);
+			break;
+		}
 	} while (dspc->nr_tasks);
 
 	goto out;
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 5b3da28bf042..879fc9c788e5 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -31,6 +31,7 @@ char _license[] SEC("license") = "GPL";
 const volatile u64 slice_ns = SCX_SLICE_DFL;
 const volatile u32 stall_user_nth;
 const volatile u32 stall_kernel_nth;
+const volatile u32 dsp_inf_loop_after;
 const volatile u32 dsp_batch;
 const volatile s32 disallow_tgid;
 const volatile bool suppress_dump;
@@ -198,6 +199,20 @@ void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
 	if (scx_bpf_consume(SHARED_DSQ))
 		return;
 
+	if (dsp_inf_loop_after && nr_dispatched > dsp_inf_loop_after) {
+		/*
+		 * PID 2 should be kthreadd which should mostly be idle and off
+		 * the scheduler. Let's keep dispatching it to force the kernel
+		 * to call this function over and over again.
+		 */
+		p = bpf_task_from_pid(2);
+		if (p) {
+			scx_bpf_dispatch(p, SCX_DSQ_LOCAL, slice_ns, 0);
+			bpf_task_release(p);
+			return;
+		}
+	}
+
 	if (!(cpuc = bpf_map_lookup_elem(&cpu_ctx_stor, &zero))) {
 		scx_bpf_error("failed to look up cpu_ctx");
 		return;
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index a1123a17581b..594147a710a8 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -19,13 +19,14 @@ const char help_fmt[] =
 "\n"
 "See the top-level comment in .bpf.c for more details.\n"
 "\n"
-"Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-b COUNT]\n"
+"Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-l COUNT] [-b COUNT]\n"
 "       [-d PID] [-D LEN] [-p] [-v]\n"
 "\n"
 "  -s SLICE_US   Override slice duration\n"
 "  -e COUNT      Trigger scx_bpf_error() after COUNT enqueues\n"
 "  -t COUNT      Stall every COUNT'th user thread\n"
 "  -T COUNT      Stall every COUNT'th kernel thread\n"
+"  -l COUNT      Trigger dispatch infinite looping after COUNT dispatches\n"
 "  -b COUNT      Dispatch upto COUNT tasks together\n"
 "  -d PID        Disallow a process from switching into SCHED_EXT (-1 for self)\n"
 "  -D LEN        Set scx_exit_info.dump buffer length\n"
@@ -61,7 +62,7 @@ int main(int argc, char **argv)
 
 	skel = SCX_OPS_OPEN(qmap_ops, scx_qmap);
 
-	while ((opt = getopt(argc, argv, "s:e:t:T:b:d:D:Spvh")) != -1) {
+	while ((opt = getopt(argc, argv, "s:e:t:T:l:b:d:D:Spvh")) != -1) {
 		switch (opt) {
 		case 's':
 			skel->rodata->slice_ns = strtoull(optarg, NULL, 0) * 1000;
@@ -75,6 +76,9 @@ int main(int argc, char **argv)
 		case 'T':
 			skel->rodata->stall_kernel_nth = strtoul(optarg, NULL, 0);
 			break;
+		case 'l':
+			skel->rodata->dsp_inf_loop_after = strtoul(optarg, NULL, 0);
+			break;
 		case 'b':
 			skel->rodata->dsp_batch = strtoul(optarg, NULL, 0);
 			break;
-- 
2.45.2
```

## Diff

```diff
---
 kernel/sched/ext.c             | 17 +++++++++++++++++
 tools/sched_ext/scx_qmap.bpf.c | 15 +++++++++++++++
 tools/sched_ext/scx_qmap.c     |  8 ++++++--
 3 files changed, 38 insertions(+), 2 deletions(-)

diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 213793d086d7..89bcca84d6b5 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -8,6 +8,7 @@

 enum scx_consts {
 	SCX_DSP_DFL_MAX_BATCH		= 32,
+	SCX_DSP_MAX_LOOPS		= 32,
 	SCX_WATCHDOG_MAX_TIMEOUT	= 30 * HZ,

 	SCX_EXIT_BT_LEN			= 64,
@@ -665,6 +666,7 @@ static struct kobject *scx_root_kobj;
 #define CREATE_TRACE_POINTS
 #include <trace/events/sched_ext.h>

+static void scx_bpf_kick_cpu(s32 cpu, u64 flags);
 static __printf(3, 4) void scx_ops_exit_kind(enum scx_exit_kind kind,
 					     s64 exit_code,
 					     const char *fmt, ...);
@@ -1906,6 +1908,7 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 {
 	struct scx_dsp_ctx *dspc = this_cpu_ptr(scx_dsp_ctx);
 	bool prev_on_scx = prev->sched_class == &ext_sched_class;
+	int nr_loops = SCX_DSP_MAX_LOOPS;
 	bool has_tasks = false;

 	lockdep_assert_rq_held(rq);
@@ -1962,6 +1965,20 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 			goto has_tasks;
 		if (consume_dispatch_q(rq, rf, &scx_dsq_global))
 			goto has_tasks;
+
+		/*
+		 * ops.dispatch() can trap us in this loop by repeatedly
+		 * dispatching ineligible tasks. Break out once in a while to
+		 * allow the watchdog to run. As IRQ can't be enabled in
+		 * balance(), we want to complete this scheduling cycle and then
+		 * start a new one. IOW, we want to call resched_curr() on the
+		 * next, most likely idle, task, not the current one. Use
+		 * scx_bpf_kick_cpu() for deferred kicking.
+		 */
+		if (unlikely(!--nr_loops)) {
+			scx_bpf_kick_cpu(cpu_of(rq), 0);
+			break;
+		}
 	} while (dspc->nr_tasks);

 	goto out;
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 5b3da28bf042..879fc9c788e5 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -31,6 +31,7 @@ char _license[] SEC("license") = "GPL";
 const volatile u64 slice_ns = SCX_SLICE_DFL;
 const volatile u32 stall_user_nth;
 const volatile u32 stall_kernel_nth;
+const volatile u32 dsp_inf_loop_after;
 const volatile u32 dsp_batch;
 const volatile s32 disallow_tgid;
 const volatile bool suppress_dump;
@@ -198,6 +199,20 @@ void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
 	if (scx_bpf_consume(SHARED_DSQ))
 		return;

+	if (dsp_inf_loop_after && nr_dispatched > dsp_inf_loop_after) {
+		/*
+		 * PID 2 should be kthreadd which should mostly be idle and off
+		 * the scheduler. Let's keep dispatching it to force the kernel
+		 * to call this function over and over again.
+		 */
+		p = bpf_task_from_pid(2);
+		if (p) {
+			scx_bpf_dispatch(p, SCX_DSQ_LOCAL, slice_ns, 0);
+			bpf_task_release(p);
+			return;
+		}
+	}
+
 	if (!(cpuc = bpf_map_lookup_elem(&cpu_ctx_stor, &zero))) {
 		scx_bpf_error("failed to look up cpu_ctx");
 		return;
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index a1123a17581b..594147a710a8 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -19,13 +19,14 @@ const char help_fmt[] =
 "\n"
 "See the top-level comment in .bpf.c for more details.\n"
 "\n"
-"Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-b COUNT]\n"
+"Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-l COUNT] [-b COUNT]\n"
 "       [-d PID] [-D LEN] [-p] [-v]\n"
 "\n"
 "  -s SLICE_US   Override slice duration\n"
 "  -e COUNT      Trigger scx_bpf_error() after COUNT enqueues\n"
 "  -t COUNT      Stall every COUNT'th user thread\n"
 "  -T COUNT      Stall every COUNT'th kernel thread\n"
+"  -l COUNT      Trigger dispatch infinite looping after COUNT dispatches\n"
 "  -b COUNT      Dispatch upto COUNT tasks together\n"
 "  -d PID        Disallow a process from switching into SCHED_EXT (-1 for self)\n"
 "  -D LEN        Set scx_exit_info.dump buffer length\n"
@@ -61,7 +62,7 @@ int main(int argc, char **argv)

 	skel = SCX_OPS_OPEN(qmap_ops, scx_qmap);

-	while ((opt = getopt(argc, argv, "s:e:t:T:b:d:D:Spvh")) != -1) {
+	while ((opt = getopt(argc, argv, "s:e:t:T:l:b:d:D:Spvh")) != -1) {
 		switch (opt) {
 		case 's':
 			skel->rodata->slice_ns = strtoull(optarg, NULL, 0) * 1000;
@@ -75,6 +76,9 @@ int main(int argc, char **argv)
 		case 'T':
 			skel->rodata->stall_kernel_nth = strtoul(optarg, NULL, 0);
 			break;
+		case 'l':
+			skel->rodata->dsp_inf_loop_after = strtoul(optarg, NULL, 0);
+			break;
 		case 'b':
 			skel->rodata->dsp_batch = strtoul(optarg, NULL, 0);
 			break;
--
2.45.2


```

## Implementation Analysis

### High-Level Analysis
The dispatch path retries if the local DSQ is still empty after

### Detailed Walkthrough
1. File: `kernel/sched/ext.c`
   Hunk: `@@ -8,6 +8,7 @@`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   SCX_DSP_MAX_LOOPS		= 32,
   ```
   Note
   ```text
   Additional hunks continue in this file (3 more section(s)).
   ```
2. File: `tools/sched_ext/scx_qmap.bpf.c`
   Hunk: `@@ -31,6 +31,7 @@ char _license[] SEC("license") = "GPL";`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   const volatile u32 dsp_inf_loop_after;
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```
3. File: `tools/sched_ext/scx_qmap.c`
   Hunk: `@@ -19,13 +19,14 @@ const char help_fmt[] =`
   Before
   ```text
   "Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-b COUNT]\n"
   ```
   After
   ```text
   "Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-l COUNT] [-b COUNT]\n"
   "  -l COUNT      Trigger dispatch infinite looping after COUNT dispatches\n"
   ```
   Note
   ```text
   Additional hunks continue in this file (2 more section(s)).
   ```

### sched_ext Context
This patch directly expands sched_ext integration points and makes the scheduler core more extensible for BPF-defined policies.

