# [PATCH 13/30] sched_ext: Allow BPF schedulers to disallow specific tasks from joining SCHED_EXT

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-14-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-14-tj@kernel.org)

## Commit Message

```text
BPF schedulers might not want to schedule certain tasks - e.g. kernel
threads. This patch adds p->scx.disallow which can be set by BPF schedulers
in such cases. The field can be changed anytime and setting it in
ops.prep_enable() guarantees that the task can never be scheduled by
sched_ext.

scx_qmap is updated with the -d option to disallow a specific PID:

  # echo $$
  1092
  # grep -E '(policy)|(ext\.enabled)' /proc/self/sched
  policy                                       :                    0
  ext.enabled                                  :                    0
  # ./set-scx 1092
  # grep -E '(policy)|(ext\.enabled)' /proc/self/sched
  policy                                       :                    7
  ext.enabled                                  :                    0

Run "scx_qmap -p -d 1092" in another terminal.

  # cat /sys/kernel/sched_ext/nr_rejected
  1
  # grep -E '(policy)|(ext\.enabled)' /proc/self/sched
  policy                                       :                    0
  ext.enabled                                  :                    0
  # ./set-scx 1092
  setparam failed for 1092 (Permission denied)

- v4: Refreshed on top of tip:sched/core.

- v3: Update description to reflect /sys/kernel/sched_ext interface change.

- v2: Use atomic_long_t instead of atomic64_t for scx_kick_cpus_pnt_seqs to
      accommodate 32bit archs.

Signed-off-by: Tejun Heo <tj@kernel.org>
Suggested-by: Barret Rhoden <brho@google.com>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 include/linux/sched/ext.h      | 12 ++++++++
 kernel/sched/ext.c             | 50 ++++++++++++++++++++++++++++++++++
 kernel/sched/ext.h             |  2 ++
 kernel/sched/syscalls.c        |  4 +++
 tools/sched_ext/scx_qmap.bpf.c |  4 +++
 tools/sched_ext/scx_qmap.c     | 11 ++++++--
 6 files changed, 81 insertions(+), 2 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index 96031252436f..ea7c501ac819 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -137,6 +137,18 @@ struct sched_ext_entity {
 	 */
 	u64			slice;
 
+	/*
+	 * If set, reject future sched_setscheduler(2) calls updating the policy
+	 * to %SCHED_EXT with -%EACCES.
+	 *
+	 * If set from ops.init_task() and the task's policy is already
+	 * %SCHED_EXT, which can happen while the BPF scheduler is being loaded
+	 * or by inhering the parent's policy during fork, the task's policy is
+	 * rejected and forcefully reverted to %SCHED_NORMAL. The number of
+	 * such events are reported through /sys/kernel/debug/sched_ext::nr_rejected.
+	 */
+	bool			disallow;	/* reject switching into SCX */
+
 	/* cold fields */
 	/* must be the last field, see init_scx_entity() */
 	struct list_head	tasks_node;
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 3dc515b3351f..8ff30b80e862 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -483,6 +483,8 @@ struct static_key_false scx_has_op[SCX_OPI_END] =
 static atomic_t scx_exit_kind = ATOMIC_INIT(SCX_EXIT_DONE);
 static struct scx_exit_info *scx_exit_info;
 
+static atomic_long_t scx_nr_rejected = ATOMIC_LONG_INIT(0);
+
 /*
  * The maximum amount of time in jiffies that a task may be runnable without
  * being scheduled on a CPU. If this timeout is exceeded, it will trigger
@@ -2332,6 +2334,8 @@ static int scx_ops_init_task(struct task_struct *p, struct task_group *tg, bool
 {
 	int ret;
 
+	p->scx.disallow = false;
+
 	if (SCX_HAS_OP(init_task)) {
 		struct scx_init_task_args args = {
 			.fork = fork,
@@ -2346,6 +2350,27 @@ static int scx_ops_init_task(struct task_struct *p, struct task_group *tg, bool
 
 	scx_set_task_state(p, SCX_TASK_INIT);
 
+	if (p->scx.disallow) {
+		struct rq *rq;
+		struct rq_flags rf;
+
+		rq = task_rq_lock(p, &rf);
+
+		/*
+		 * We're either in fork or load path and @p->policy will be
+		 * applied right after. Reverting @p->policy here and rejecting
+		 * %SCHED_EXT transitions from scx_check_setscheduler()
+		 * guarantees that if ops.init_task() sets @p->disallow, @p can
+		 * never be in SCX.
+		 */
+		if (p->policy == SCHED_EXT) {
+			p->policy = SCHED_NORMAL;
+			atomic_long_inc(&scx_nr_rejected);
+		}
+
+		task_rq_unlock(rq, p, &rf);
+	}
+
 	p->scx.flags |= SCX_TASK_RESET_RUNNABLE_AT;
 	return 0;
 }
@@ -2549,6 +2574,18 @@ static void switched_from_scx(struct rq *rq, struct task_struct *p)
 static void wakeup_preempt_scx(struct rq *rq, struct task_struct *p,int wake_flags) {}
 static void switched_to_scx(struct rq *rq, struct task_struct *p) {}
 
+int scx_check_setscheduler(struct task_struct *p, int policy)
+{
+	lockdep_assert_rq_held(task_rq(p));
+
+	/* if disallow, reject transitioning into SCX */
+	if (scx_enabled() && READ_ONCE(p->scx.disallow) &&
+	    p->policy != policy && policy == SCHED_EXT)
+		return -EACCES;
+
+	return 0;
+}
+
 /*
  * Omitted operations:
  *
@@ -2703,9 +2740,17 @@ static ssize_t scx_attr_switch_all_show(struct kobject *kobj,
 }
 SCX_ATTR(switch_all);
 
+static ssize_t scx_attr_nr_rejected_show(struct kobject *kobj,
+					 struct kobj_attribute *ka, char *buf)
+{
+	return sysfs_emit(buf, "%ld\n", atomic_long_read(&scx_nr_rejected));
+}
+SCX_ATTR(nr_rejected);
+
 static struct attribute *scx_global_attrs[] = {
 	&scx_attr_state.attr,
 	&scx_attr_switch_all.attr,
+	&scx_attr_nr_rejected.attr,
 	NULL,
 };
 
@@ -3178,6 +3223,8 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)
 	atomic_set(&scx_exit_kind, SCX_EXIT_NONE);
 	scx_warned_zero_slice = false;
 
+	atomic_long_set(&scx_nr_rejected, 0);
+
 	/*
 	 * Keep CPUs stable during enable so that the BPF scheduler can track
 	 * online CPUs by watching ->on/offline_cpu() after ->init().
@@ -3476,6 +3523,9 @@ static int bpf_scx_btf_struct_access(struct bpf_verifier_log *log,
 		if (off >= offsetof(struct task_struct, scx.slice) &&
 		    off + size <= offsetofend(struct task_struct, scx.slice))
 			return SCALAR_VALUE;
+		if (off >= offsetof(struct task_struct, scx.disallow) &&
+		    off + size <= offsetofend(struct task_struct, scx.disallow))
+			return SCALAR_VALUE;
 	}
 
 	return -EACCES;
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 56fcdb0b2c05..33a9f7fe5832 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -35,6 +35,7 @@ void scx_pre_fork(struct task_struct *p);
 int scx_fork(struct task_struct *p);
 void scx_post_fork(struct task_struct *p);
 void scx_cancel_fork(struct task_struct *p);
+int scx_check_setscheduler(struct task_struct *p, int policy);
 bool task_should_scx(struct task_struct *p);
 void init_sched_ext_class(void);
 
@@ -72,6 +73,7 @@ static inline void scx_pre_fork(struct task_struct *p) {}
 static inline int scx_fork(struct task_struct *p) { return 0; }
 static inline void scx_post_fork(struct task_struct *p) {}
 static inline void scx_cancel_fork(struct task_struct *p) {}
+static inline int scx_check_setscheduler(struct task_struct *p, int policy) { return 0; }
 static inline bool task_on_scx(const struct task_struct *p) { return false; }
 static inline void init_sched_ext_class(void) {}
 
diff --git a/kernel/sched/syscalls.c b/kernel/sched/syscalls.c
index 18d44d180db1..4fa59c9f69ac 100644
--- a/kernel/sched/syscalls.c
+++ b/kernel/sched/syscalls.c
@@ -714,6 +714,10 @@ int __sched_setscheduler(struct task_struct *p,
 		goto unlock;
 	}
 
+	retval = scx_check_setscheduler(p, policy);
+	if (retval)
+		goto unlock;
+
 	/*
 	 * If not changing anything there's no need to proceed further,
 	 * but store a possible modification of reset_on_fork.
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 8beae08dfdc7..5ff217c4bfa0 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -32,6 +32,7 @@ const volatile u64 slice_ns = SCX_SLICE_DFL;
 const volatile u32 stall_user_nth;
 const volatile u32 stall_kernel_nth;
 const volatile u32 dsp_batch;
+const volatile s32 disallow_tgid;
 
 u32 test_error_cnt;
 
@@ -243,6 +244,9 @@ void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
 s32 BPF_STRUCT_OPS(qmap_init_task, struct task_struct *p,
 		   struct scx_init_task_args *args)
 {
+	if (p->tgid == disallow_tgid)
+		p->scx.disallow = true;
+
 	/*
 	 * @p is new. Let's ensure that its task_ctx is available. We can sleep
 	 * in this function and the following will automatically use GFP_KERNEL.
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index 6e9e9726cd62..a2614994cfaa 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -19,13 +19,15 @@ const char help_fmt[] =
 "\n"
 "See the top-level comment in .bpf.c for more details.\n"
 "\n"
-"Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-b COUNT] [-p] [-v]\n"
+"Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-b COUNT]\n"
+"       [-d PID] [-p] [-v]\n"
 "\n"
 "  -s SLICE_US   Override slice duration\n"
 "  -e COUNT      Trigger scx_bpf_error() after COUNT enqueues\n"
 "  -t COUNT      Stall every COUNT'th user thread\n"
 "  -T COUNT      Stall every COUNT'th kernel thread\n"
 "  -b COUNT      Dispatch upto COUNT tasks together\n"
+"  -d PID        Disallow a process from switching into SCHED_EXT (-1 for self)\n"
 "  -p            Switch only tasks on SCHED_EXT policy intead of all\n"
 "  -v            Print libbpf debug messages\n"
 "  -h            Display this help and exit\n";
@@ -57,7 +59,7 @@ int main(int argc, char **argv)
 
 	skel = SCX_OPS_OPEN(qmap_ops, scx_qmap);
 
-	while ((opt = getopt(argc, argv, "s:e:t:T:b:pvh")) != -1) {
+	while ((opt = getopt(argc, argv, "s:e:t:T:b:d:pvh")) != -1) {
 		switch (opt) {
 		case 's':
 			skel->rodata->slice_ns = strtoull(optarg, NULL, 0) * 1000;
@@ -74,6 +76,11 @@ int main(int argc, char **argv)
 		case 'b':
 			skel->rodata->dsp_batch = strtoul(optarg, NULL, 0);
 			break;
+		case 'd':
+			skel->rodata->disallow_tgid = strtol(optarg, NULL, 0);
+			if (skel->rodata->disallow_tgid < 0)
+				skel->rodata->disallow_tgid = getpid();
+			break;
 		case 'p':
 			skel->struct_ops.qmap_ops->flags |= SCX_OPS_SWITCH_PARTIAL;
 			break;
-- 
2.45.2
```

## Diff

```diff
---
 include/linux/sched/ext.h      | 12 ++++++++
 kernel/sched/ext.c             | 50 ++++++++++++++++++++++++++++++++++
 kernel/sched/ext.h             |  2 ++
 kernel/sched/syscalls.c        |  4 +++
 tools/sched_ext/scx_qmap.bpf.c |  4 +++
 tools/sched_ext/scx_qmap.c     | 11 ++++++--
 6 files changed, 81 insertions(+), 2 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index 96031252436f..ea7c501ac819 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -137,6 +137,18 @@ struct sched_ext_entity {
 	 */
 	u64			slice;

+	/*
+	 * If set, reject future sched_setscheduler(2) calls updating the policy
+	 * to %SCHED_EXT with -%EACCES.
+	 *
+	 * If set from ops.init_task() and the task's policy is already
+	 * %SCHED_EXT, which can happen while the BPF scheduler is being loaded
+	 * or by inhering the parent's policy during fork, the task's policy is
+	 * rejected and forcefully reverted to %SCHED_NORMAL. The number of
+	 * such events are reported through /sys/kernel/debug/sched_ext::nr_rejected.
+	 */
+	bool			disallow;	/* reject switching into sched_ext */
+
 	/* cold fields */
 	/* must be the last field, see init_scx_entity() */
 	struct list_head	tasks_node;
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 3dc515b3351f..8ff30b80e862 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -483,6 +483,8 @@ struct static_key_false scx_has_op[SCX_OPI_END] =
 static atomic_t scx_exit_kind = ATOMIC_INIT(SCX_EXIT_DONE);
 static struct scx_exit_info *scx_exit_info;

+static atomic_long_t scx_nr_rejected = ATOMIC_LONG_INIT(0);
+
 /*
  * The maximum amount of time in jiffies that a task may be runnable without
  * being scheduled on a CPU. If this timeout is exceeded, it will trigger
@@ -2332,6 +2334,8 @@ static int scx_ops_init_task(struct task_struct *p, struct task_group *tg, bool
 {
 	int ret;

+	p->scx.disallow = false;
+
 	if (SCX_HAS_OP(init_task)) {
 		struct scx_init_task_args args = {
 			.fork = fork,
@@ -2346,6 +2350,27 @@ static int scx_ops_init_task(struct task_struct *p, struct task_group *tg, bool

 	scx_set_task_state(p, SCX_TASK_INIT);

+	if (p->scx.disallow) {
+		struct rq *rq;
+		struct rq_flags rf;
+
+		rq = task_rq_lock(p, &rf);
+
+		/*
+		 * We're either in fork or load path and @p->policy will be
+		 * applied right after. Reverting @p->policy here and rejecting
+		 * %SCHED_EXT transitions from scx_check_setscheduler()
+		 * guarantees that if ops.init_task() sets @p->disallow, @p can
+		 * never be in sched_ext.
+		 */
+		if (p->policy == SCHED_EXT) {
+			p->policy = SCHED_NORMAL;
+			atomic_long_inc(&scx_nr_rejected);
+		}
+
+		task_rq_unlock(rq, p, &rf);
+	}
+
 	p->scx.flags |= SCX_TASK_RESET_RUNNABLE_AT;
 	return 0;
 }
@@ -2549,6 +2574,18 @@ static void switched_from_scx(struct rq *rq, struct task_struct *p)
 static void wakeup_preempt_scx(struct rq *rq, struct task_struct *p,int wake_flags) {}
 static void switched_to_scx(struct rq *rq, struct task_struct *p) {}

+int scx_check_setscheduler(struct task_struct *p, int policy)
+{
+	lockdep_assert_rq_held(task_rq(p));
+
+	/* if disallow, reject transitioning into sched_ext */
+	if (scx_enabled() && READ_ONCE(p->scx.disallow) &&
+	    p->policy != policy && policy == SCHED_EXT)
+		return -EACCES;
+
+	return 0;
+}
+
 /*
  * Omitted operations:
  *
@@ -2703,9 +2740,17 @@ static ssize_t scx_attr_switch_all_show(struct kobject *kobj,
 }
 SCX_ATTR(switch_all);

+static ssize_t scx_attr_nr_rejected_show(struct kobject *kobj,
+					 struct kobj_attribute *ka, char *buf)
+{
+	return sysfs_emit(buf, "%ld\n", atomic_long_read(&scx_nr_rejected));
+}
+SCX_ATTR(nr_rejected);
+
 static struct attribute *scx_global_attrs[] = {
 	&scx_attr_state.attr,
 	&scx_attr_switch_all.attr,
+	&scx_attr_nr_rejected.attr,
 	NULL,
 };

@@ -3178,6 +3223,8 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)
 	atomic_set(&scx_exit_kind, SCX_EXIT_NONE);
 	scx_warned_zero_slice = false;

+	atomic_long_set(&scx_nr_rejected, 0);
+
 	/*
 	 * Keep CPUs stable during enable so that the BPF scheduler can track
 	 * online CPUs by watching ->on/offline_cpu() after ->init().
@@ -3476,6 +3523,9 @@ static int bpf_scx_btf_struct_access(struct bpf_verifier_log *log,
 		if (off >= offsetof(struct task_struct, scx.slice) &&
 		    off + size <= offsetofend(struct task_struct, scx.slice))
 			return SCALAR_VALUE;
+		if (off >= offsetof(struct task_struct, scx.disallow) &&
+		    off + size <= offsetofend(struct task_struct, scx.disallow))
+			return SCALAR_VALUE;
 	}

 	return -EACCES;
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 56fcdb0b2c05..33a9f7fe5832 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -35,6 +35,7 @@ void scx_pre_fork(struct task_struct *p);
 int scx_fork(struct task_struct *p);
 void scx_post_fork(struct task_struct *p);
 void scx_cancel_fork(struct task_struct *p);
+int scx_check_setscheduler(struct task_struct *p, int policy);
 bool task_should_scx(struct task_struct *p);
 void init_sched_ext_class(void);

@@ -72,6 +73,7 @@ static inline void scx_pre_fork(struct task_struct *p) {}
 static inline int scx_fork(struct task_struct *p) { return 0; }
 static inline void scx_post_fork(struct task_struct *p) {}
 static inline void scx_cancel_fork(struct task_struct *p) {}
+static inline int scx_check_setscheduler(struct task_struct *p, int policy) { return 0; }
 static inline bool task_on_scx(const struct task_struct *p) { return false; }
 static inline void init_sched_ext_class(void) {}

diff --git a/kernel/sched/syscalls.c b/kernel/sched/syscalls.c
index 18d44d180db1..4fa59c9f69ac 100644
--- a/kernel/sched/syscalls.c
+++ b/kernel/sched/syscalls.c
@@ -714,6 +714,10 @@ int __sched_setscheduler(struct task_struct *p,
 		goto unlock;
 	}

+	retval = scx_check_setscheduler(p, policy);
+	if (retval)
+		goto unlock;
+
 	/*
 	 * If not changing anything there's no need to proceed further,
 	 * but store a possible modification of reset_on_fork.
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 8beae08dfdc7..5ff217c4bfa0 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -32,6 +32,7 @@ const volatile u64 slice_ns = SCX_SLICE_DFL;
 const volatile u32 stall_user_nth;
 const volatile u32 stall_kernel_nth;
 const volatile u32 dsp_batch;
+const volatile s32 disallow_tgid;

 u32 test_error_cnt;

@@ -243,6 +244,9 @@ void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
 s32 BPF_STRUCT_OPS(qmap_init_task, struct task_struct *p,
 		   struct scx_init_task_args *args)
 {
+	if (p->tgid == disallow_tgid)
+		p->scx.disallow = true;
+
 	/*
 	 * @p is new. Let's ensure that its task_ctx is available. We can sleep
 	 * in this function and the following will automatically use GFP_KERNEL.
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index 6e9e9726cd62..a2614994cfaa 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -19,13 +19,15 @@ const char help_fmt[] =
 "\n"
 "See the top-level comment in .bpf.c for more details.\n"
 "\n"
-"Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-b COUNT] [-p] [-v]\n"
+"Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-b COUNT]\n"
+"       [-d PID] [-p] [-v]\n"
 "\n"
 "  -s SLICE_US   Override slice duration\n"
 "  -e COUNT      Trigger scx_bpf_error() after COUNT enqueues\n"
 "  -t COUNT      Stall every COUNT'th user thread\n"
 "  -T COUNT      Stall every COUNT'th kernel thread\n"
 "  -b COUNT      Dispatch upto COUNT tasks together\n"
+"  -d PID        Disallow a process from switching into SCHED_EXT (-1 for self)\n"
 "  -p            Switch only tasks on SCHED_EXT policy intead of all\n"
 "  -v            Print libbpf debug messages\n"
 "  -h            Display this help and exit\n";
@@ -57,7 +59,7 @@ int main(int argc, char **argv)

 	skel = SCX_OPS_OPEN(qmap_ops, scx_qmap);

-	while ((opt = getopt(argc, argv, "s:e:t:T:b:pvh")) != -1) {
+	while ((opt = getopt(argc, argv, "s:e:t:T:b:d:pvh")) != -1) {
 		switch (opt) {
 		case 's':
 			skel->rodata->slice_ns = strtoull(optarg, NULL, 0) * 1000;
@@ -74,6 +76,11 @@ int main(int argc, char **argv)
 		case 'b':
 			skel->rodata->dsp_batch = strtoul(optarg, NULL, 0);
 			break;
+		case 'd':
+			skel->rodata->disallow_tgid = strtol(optarg, NULL, 0);
+			if (skel->rodata->disallow_tgid < 0)
+				skel->rodata->disallow_tgid = getpid();
+			break;
 		case 'p':
 			skel->struct_ops.qmap_ops->flags |= SCX_OPS_SWITCH_PARTIAL;
 			break;
--
2.45.2


```

## Implementation Analysis

### High-Level Analysis
BPF schedulers might not want to schedule certain tasks - e.g. kernel

### Detailed Walkthrough
1. File: `include/linux/sched/ext.h`
   Hunk: `@@ -137,6 +137,18 @@ struct sched_ext_entity {`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   /*
   * If set, reject future sched_setscheduler(2) calls updating the policy
   * to %SCHED_EXT with -%EACCES.
   ```
2. File: `kernel/sched/ext.c`
   Hunk: `@@ -483,6 +483,8 @@ struct static_key_false scx_has_op[SCX_OPI_END] =`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   static atomic_long_t scx_nr_rejected = ATOMIC_LONG_INIT(0);
   
   ```
   Note
   ```text
   Additional hunks continue in this file (6 more section(s)).
   ```
3. File: `kernel/sched/ext.h`
   Hunk: `@@ -35,6 +35,7 @@ void scx_pre_fork(struct task_struct *p);`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   int scx_check_setscheduler(struct task_struct *p, int policy);
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```
4. File: `kernel/sched/syscalls.c`
   Hunk: `@@ -714,6 +714,10 @@ int __sched_setscheduler(struct task_struct *p,`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   retval = scx_check_setscheduler(p, policy);
   if (retval)
   goto unlock;
   ```
5. File: `tools/sched_ext/scx_qmap.bpf.c`
   Hunk: `@@ -32,6 +32,7 @@ const volatile u64 slice_ns = SCX_SLICE_DFL;`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   const volatile s32 disallow_tgid;
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```
6. File: `tools/sched_ext/scx_qmap.c`
   Hunk: `@@ -19,13 +19,15 @@ const char help_fmt[] =`
   Before
   ```text
   "Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-b COUNT] [-p] [-v]\n"
   ```
   After
   ```text
   "Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-b COUNT]\n"
   "       [-d PID] [-p] [-v]\n"
   "  -d PID        Disallow a process from switching into SCHED_EXT (-1 for self)\n"
   ```
   Note
   ```text
   Additional hunks continue in this file (2 more section(s)).
   ```

### sched_ext Context
This patch directly expands sched_ext integration points and makes the scheduler core more extensible for BPF-defined policies.

