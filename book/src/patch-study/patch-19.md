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

### Overview

The sched_ext dispatch loop in `balance_scx()` automatically retries when `ops.dispatch()` makes progress (dispatches or consumes a task) but the local DSQ is still empty afterward. This retry is both necessary (for correctness when rq lock drops cause lost tasks) and convenient (BPF schedulers don't need to dispatch exactly the right amount). However, it creates a DoS vector: a buggy `ops.dispatch()` that repeatedly dispatches tasks ineligible for the current CPU traps the CPU in an infinite loop. If all CPUs are trapped, the watchdog cannot run, and the system hangs. This patch breaks out of the dispatch loop after `SCX_DSP_MAX_LOOPS = 32` iterations by using `scx_bpf_kick_cpu()` to reschedule after the current task is done.

### Code Walkthrough

**`kernel/sched/ext.c` — new constant**

```c
enum scx_consts {
    SCX_DSP_DFL_MAX_BATCH = 32,
    SCX_DSP_MAX_LOOPS     = 32,  // NEW
    ...
};
```

32 iterations is chosen as a balance: generous enough for legitimate dispatch bursts, strict enough to prevent indefinite stalls.

**`kernel/sched/ext.c` — forward declaration**

```c
static void scx_bpf_kick_cpu(s32 cpu, u64 flags);
```

`scx_bpf_kick_cpu()` is defined later in the file (as a `__bpf_kfunc`). This forward declaration is needed because `balance_scx()` calls it but appears before the function definition. This is the first time the kernel-internal scheduler code calls a function that is also exposed as a BPF kfunc — maintainers should note this coupling.

**`kernel/sched/ext.c` — loop counter in `balance_scx()`**

```c
static int balance_scx(struct rq *rq, struct task_struct *prev,
                        struct rq_flags *rf)
{
    int nr_loops = SCX_DSP_MAX_LOOPS;  // NEW
    ...

    do {
        ...
        if (rq->scx.local_dsq.nr) goto has_tasks;
        if (consume_dispatch_q(rq, rf, &scx_dsq_global)) goto has_tasks;

        if (unlikely(!--nr_loops)) {  // NEW
            scx_bpf_kick_cpu(cpu_of(rq), 0);
            break;
        }
    } while (dspc->nr_tasks);
    ...
}
```

The countdown runs inside the `do { ... } while (dspc->nr_tasks)` loop. When `nr_loops` reaches zero, instead of calling `resched_curr(rq)` directly, `scx_bpf_kick_cpu(cpu_of(rq), 0)` is called. This distinction is critical.

**Why `scx_bpf_kick_cpu()` and not `resched_curr()`?**

`balance_scx()` runs during the scheduler's task-pick path. At this point, `prev` is still `current` — `resched_curr(rq)` would set `TIF_NEED_RESCHED` on the current task, but because the scheduler is in the middle of selecting the next task, this flag would just get cleared immediately. The system would continue scheduling as if nothing happened.

`scx_bpf_kick_cpu(cpu_of(rq), 0)` defers the reschedule via `irq_work`. The irq_work fires after `balance_scx()` returns and after the scheduler has picked the next task (likely the idle task, since the local DSQ is empty). At that point, `TIF_NEED_RESCHED` is set on the idle task and the CPU will immediately try to schedule again — this time entering `balance_scx()` fresh with `nr_loops` reset to 32.

This "deferred self-kick" pattern is specifically designed for the case where the balancer itself needs to trigger a retry but cannot do so synchronously.

**`tools/sched_ext/scx_qmap.bpf.c` — test fixture**

```c
const volatile u32 dsp_inf_loop_after;

void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
{
    ...
    if (dsp_inf_loop_after && nr_dispatched > dsp_inf_loop_after) {
        p = bpf_task_from_pid(2);  // PID 2 = kthreadd (usually idle)
        if (p) {
            scx_bpf_dispatch(p, SCX_DSQ_LOCAL, slice_ns, 0);
            bpf_task_release(p);
            return;
        }
    }
    ...
}
```

This deliberately triggers the dispatch loop stall: after `dsp_inf_loop_after` dispatches, the scheduler repeatedly dispatches kthreadd (PID 2) to the local DSQ. kthreadd is typically not runnable or has a different CPU affinity, so it keeps getting dispatched but never satisfies the dispatch loop's termination condition. The `-l COUNT` flag in `scx_qmap.c` activates this behavior for testing.

### Key Concepts

- **The dispatch loop retry invariant**: `balance_scx()` retries when `ops.dispatch()` dispatched or consumed at least one task but the local DSQ is still empty. This retry is necessary for correctness because cross-CPU task migrations (which require dropping and re-acquiring `rq->lock`) can cause tasks to disappear from the local DSQ between dispatch rounds.
- **`SCX_DSP_MAX_LOOPS = 32`**: Hard limit on dispatch loop iterations. Legitimate schedulers should never need more than a handful of retries. If a scheduler hits this limit in production, it indicates either a bug in `ops.dispatch()` or an unusual workload with very high affinity-mismatch rates.
- **Deferred self-kick pattern**: When a CPU needs to retry scheduling after the current task has been selected, using `scx_bpf_kick_cpu(self, 0)` via irq_work is the correct mechanism. Direct `resched_curr()` in `balance_scx()` context has no effect.
- **`nr_loops` is per-invocation**: The counter resets every time `balance_scx()` is called. 32 loops per scheduling invocation, not 32 loops globally. A legitimately slow dispatcher gets 32 attempts each time the CPU needs to pick a task.

### Locking and Concurrency Notes

- `balance_scx()` is called with `rq->lock` held. The dispatch loop temporarily drops `rq->lock` during `ops.dispatch()` (to allow cross-CPU migrations). The `nr_loops` counter is a local variable and is not affected by lock drops.
- `scx_bpf_kick_cpu(cpu_of(rq), 0)` called from within `balance_scx()` uses `irq_work_queue()` which is IRQ-safe but requires IRQs to be disabled. `balance_scx()` runs with IRQs disabled (rq->lock requirement), so this is safe.
- The irq_work `kick_cpus_irq_work` is per-CPU. Calling it from `balance_scx()` for the same CPU (self-kick) will fire after `balance_scx()` completes and the lock is released.

### Why Maintainers Need to Know This

- **A looping stall is a BPF scheduler bug, not a kernel bug**: If a system hangs with all CPUs stuck in dispatch loops, the root cause is `ops.dispatch()` returning true (progress signal) without actually making the CPU runnable. The most common form is dispatching tasks to a local DSQ when those tasks have CPU affinity that prevents them from running on that CPU.
- **The 32-iteration limit gives the watchdog a chance to run**: By breaking out every 32 iterations, the CPU eventually picks the idle task, which allows the watchdog kthread and sysrq handler to run. Without this limit, a single-CPU system with a looping `ops.dispatch()` would hang permanently.
- **The forward declaration of `scx_bpf_kick_cpu()` is a code smell**: Having a `__bpf_kfunc` called from the internal scheduler hot path creates a coupling between the BPF API surface and the scheduler internals. Future restructuring should consider whether this forward declaration should be replaced with a separate internal helper.
- **Test with `-l` flag**: `scx_qmap -l 100` triggers the infinite dispatch loop after 100 dispatches. This is the canonical test for this patch's fix. Running it should produce a watchdog-style exit rather than a system hang.

### Connection to Other Patches

- **PATCH 17/30** introduced `scx_bpf_kick_cpu()`, which this patch repurposes as a deferred self-kick mechanism from within `balance_scx()`. The forward declaration added here is a direct consequence of that dependency.
- The original watchdog (from an earlier patch in this series) detects task starvation — tasks not running for too long. This patch addresses a different failure mode: the dispatch path itself looping, which starves the watchdog rather than tasks.
- **PATCH 18/30** (`scx_central`) is susceptible to this exact failure mode: if `dispatch_to_cpu()` keeps bouncing tasks to `FALLBACK_DSQ_ID` without successfully dispatching to any local DSQ, the dispatch retry loop could spin. The `scx_bpf_dispatch_nr_slots()` check in `central_dispatch` is the BPF-side guard against this; the 32-iteration limit is the kernel-side backstop.

