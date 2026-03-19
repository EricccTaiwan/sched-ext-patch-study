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

### Overview

This patch lets BPF schedulers permanently exclude specific tasks from SCHED_EXT. The motivating case is kernel threads that must not be managed by an arbitrary BPF scheduler (e.g., a kthread that is critical for boot or PM operations). The mechanism is a single boolean `p->scx.disallow` on `sched_ext_entity`. When a BPF scheduler sets this flag during `ops.init_task()`, the kernel reverts the task's policy to `SCHED_NORMAL` and blocks any future `sched_setscheduler(2)` calls that would move it to `SCHED_EXT`.

### Code Walkthrough

**`include/linux/sched/ext.h` — the `disallow` field**

```c
bool    disallow;   /* reject switching into sched_ext */
```

Added to `sched_ext_entity` after `slice`. The comment explains two distinct effects: (1) reject future `sched_setscheduler` calls with `-EACCES`, and (2) if set during `ops.init_task()` while the task already has `SCHED_EXT` policy (possible during BPF scheduler load or via fork inheriting the parent's policy), force-revert the policy to `SCHED_NORMAL`. The counter `scx_nr_rejected` tracks how many such forced reversions happen and is exposed at `/sys/kernel/debug/sched_ext::nr_rejected`.

**`kernel/sched/ext.c` — enforcing disallow in `scx_ops_init_task()`**

```c
p->scx.disallow = false;

if (SCX_HAS_OP(init_task)) {
    ...
    SCX_CALL_OP_RET(SCX_KF_SLEEPABLE, init_task, p, &args);
    ...
}

scx_set_task_state(p, SCX_TASK_INIT);

if (p->scx.disallow) {
    struct rq *rq;
    struct rq_flags rf;

    rq = task_rq_lock(p, &rf);
    if (p->policy == SCHED_EXT) {
        p->policy = SCHED_NORMAL;
        atomic_long_inc(&scx_nr_rejected);
    }
    task_rq_unlock(rq, p, &rf);
}
```

The flag is explicitly cleared before calling `ops.init_task()` so stale values cannot persist. After the BPF callback returns, the kernel checks the flag and, if set, acquires the task's `rq` lock to safely modify `p->policy`. This is important: the caller is either in `fork` or in the load path and `p->policy` is about to be applied, so reverting it here ensures the task never actually enters the ext class.

**`kernel/sched/ext.c` — `scx_check_setscheduler()`**

```c
int scx_check_setscheduler(struct task_struct *p, int policy)
{
    lockdep_assert_rq_held(task_rq(p));

    if (scx_enabled() && READ_ONCE(p->scx.disallow) &&
        p->policy != policy && policy == SCHED_EXT)
        return -EACCES;

    return 0;
}
```

This new function is called from `__sched_setscheduler()` in `kernel/sched/syscalls.c` (after the existing capability check, before the "nothing to do" early-return). The lockdep assertion documents that `rq->lock` must be held by the caller, which `__sched_setscheduler()` guarantees. The `READ_ONCE` is used because `disallow` can be set from BPF context on a different CPU without holding any lock.

**`kernel/sched/ext.c` — BPF BTF accessor**

```c
if (off >= offsetof(struct task_struct, scx.disallow) &&
    off + size <= offsetofend(struct task_struct, scx.disallow))
    return SCALAR_VALUE;
```

Added to `bpf_scx_btf_struct_access()` so BPF programs can write `p->scx.disallow` directly from within `ops.init_task()`. Without this, the BPF verifier would reject the store.

**`tools/sched_ext/scx_qmap.bpf.c` — example usage**

```c
s32 BPF_STRUCT_OPS(qmap_init_task, struct task_struct *p,
                   struct scx_init_task_args *args)
{
    if (p->tgid == disallow_tgid)
        p->scx.disallow = true;
    ...
}
```

The BPF scheduler checks if the task's TGID matches a configured value and sets `disallow`. This demonstrates the intended usage pattern: set the flag in `ops.init_task()` to guarantee the task can never run under SCHED_EXT.

### Key Concepts

- **`p->scx.disallow`**: A boolean in `sched_ext_entity` that acts as a per-task veto on SCHED_EXT membership. The flag is checked in two places: `scx_ops_init_task()` (for new tasks) and `scx_check_setscheduler()` (for `sched_setscheduler(2)` calls).
- **`scx_nr_rejected`**: An `atomic_long_t` counter incremented whenever a task is force-reverted from SCHED_EXT to SCHED_NORMAL due to `disallow` being set. It resets on each BPF scheduler load (`scx_ops_enable()`). Exposed via sysfs at `/sys/kernel/sched_ext/nr_rejected`.
- **`scx_check_setscheduler()`**: A new hook inserted into the policy-change syscall path. It is the runtime guard that prevents `disallow`ed tasks from being moved to SCHED_EXT after initial setup.
- **Two-path enforcement**: The `disallow` flag is checked both at `init_task` time (for tasks that inherit policy or are already SCHED_EXT when the BPF scheduler loads) and at `sched_setscheduler` time (for future attempts). This two-path design is what makes the guarantee watertight.

### Locking and Concurrency Notes

- When `disallow` is checked in `scx_ops_init_task()`, the code acquires `task_rq_lock(p, &rf)` before modifying `p->policy`. This is the correct protocol for changing a task's scheduling policy outside the full setscheduler path.
- `scx_check_setscheduler()` uses `lockdep_assert_rq_held(task_rq(p))` to document that it always runs under the task's rq lock. This is satisfied because `__sched_setscheduler()` holds the lock before calling it.
- `READ_ONCE(p->scx.disallow)` in `scx_check_setscheduler()` provides ordering against concurrent BPF writes from `ops.init_task()` which may run without any lock.

### Why Maintainers Need to Know This

- **The `disallow` flag is racy by design**: The comment in the header explicitly says the flag "can be changed anytime". The guarantee is weaker than a lock: it is possible for a window to exist between `ops.init_task()` returning and the check in `scx_ops_init_task()`. The two-path check (init_task + check_setscheduler) is the mitigation.
- **Setting `disallow` outside `ops.init_task()` does not revoke SCHED_EXT**: If a BPF scheduler sets `p->scx.disallow = true` after the task is already running under SCHED_EXT (e.g., from `ops.enqueue()`), the kernel does not immediately demote the task. It only blocks future `sched_setscheduler` transitions. A maintainer reviewing BPF schedulers should flag any attempt to use `disallow` as a "revoke" mechanism outside `ops.init_task()`.
- **`nr_rejected` resets on each BPF scheduler load**: Monitoring tools should not treat this counter as a cumulative system-wide metric across scheduler restarts.
- **BTF write access is required**: Any new `sched_ext_entity` field that BPF schedulers need to write from `ops.init_task()` must be explicitly added to `bpf_scx_btf_struct_access()`. This is a common oversight when extending the interface.

### Connection to Other Patches

- Builds on the `ops.init_task()` callback from earlier patches that first allowed BPF schedulers to reject tasks by returning an error code; this patch adds a complementary per-task flag that survives initial setup.
- `scx_nr_rejected` feeds into the `scx_show_state.py` debugging tool added in PATCH 16/30, which reads the counter via drgn.
- The BTF accessor pattern used here (`bpf_scx_btf_struct_access()`) is the same mechanism used to expose `p->scx.slice` to BPF; maintainers adding new writable fields to `sched_ext_entity` must follow this pattern.

