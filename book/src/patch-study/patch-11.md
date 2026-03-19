# [PATCH 12/30] sched_ext: Implement runnable task stall watchdog

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-13-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-13-tj@kernel.org)

## Commit Message

```text
From: David Vernet <dvernet@meta.com>

The most common and critical way that a BPF scheduler can misbehave is by
failing to run runnable tasks for too long. This patch implements a
watchdog.

* All tasks record when they become runnable.

* A watchdog work periodically scans all runnable tasks. If any task has
  stayed runnable for too long, the BPF scheduler is aborted.

* scheduler_tick() monitors whether the watchdog itself is stuck. If so, the
  BPF scheduler is aborted.

Because the watchdog only scans the tasks which are currently runnable and
usually very infrequently, the overhead should be negligible.
scx_qmap is updated so that it can be told to stall user and/or
kernel tasks.

A detected task stall looks like the following:

 sched_ext: BPF scheduler "qmap" errored, disabling
 sched_ext: runnable task stall (dbus-daemon[953] failed to run for 6.478s)
    scx_check_timeout_workfn+0x10e/0x1b0
    process_one_work+0x287/0x560
    worker_thread+0x234/0x420
    kthread+0xe9/0x100
    ret_from_fork+0x1f/0x30

A detected watchdog stall:

 sched_ext: BPF scheduler "qmap" errored, disabling
 sched_ext: runnable task stall (watchdog failed to check in for 5.001s)
    scheduler_tick+0x2eb/0x340
    update_process_times+0x7a/0x90
    tick_sched_timer+0xd8/0x130
    __hrtimer_run_queues+0x178/0x3b0
    hrtimer_interrupt+0xfc/0x390
    __sysvec_apic_timer_interrupt+0xb7/0x2b0
    sysvec_apic_timer_interrupt+0x90/0xb0
    asm_sysvec_apic_timer_interrupt+0x1b/0x20
    default_idle+0x14/0x20
    arch_cpu_idle+0xf/0x20
    default_idle_call+0x50/0x90
    do_idle+0xe8/0x240
    cpu_startup_entry+0x1d/0x20
    kernel_init+0x0/0x190
    start_kernel+0x0/0x392
    start_kernel+0x324/0x392
    x86_64_start_reservations+0x2a/0x2c
    x86_64_start_kernel+0x104/0x109
    secondary_startup_64_no_verify+0xce/0xdb

Note that this patch exposes scx_ops_error[_type]() in kernel/sched/ext.h to
inline scx_notify_sched_tick().

v4: - While disabling, cancel_delayed_work_sync(&scx_watchdog_work) was
      being called before forward progress was guaranteed and thus could
      lead to system lockup. Relocated.

    - While enabling, it was comparing msecs against jiffies without
      conversion leading to spurious load failures on lower HZ kernels.
      Fixed.

    - runnable list management is now used by core bypass logic and moved to
      the patch implementing sched_ext core.

v3: - bpf_scx_init_member() was incorrectly comparing ops->timeout_ms
      against SCX_WATCHDOG_MAX_TIMEOUT which is in jiffies without
      conversion leading to spurious load failures in lower HZ kernels.
      Fixed.

v2: - Julia Lawall noticed that the watchdog code was mixing msecs and
      jiffies. Fix by using jiffies for everything.

Signed-off-by: David Vernet <dvernet@meta.com>
Reviewed-by: Tejun Heo <tj@kernel.org>
Signed-off-by: Tejun Heo <tj@kernel.org>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
Cc: Julia Lawall <julia.lawall@inria.fr>
---
 include/linux/sched/ext.h      |   1 +
 init/init_task.c               |   1 +
 kernel/sched/core.c            |   1 +
 kernel/sched/ext.c             | 130 ++++++++++++++++++++++++++++++++-
 kernel/sched/ext.h             |   2 +
 tools/sched_ext/scx_qmap.bpf.c |  12 +++
 tools/sched_ext/scx_qmap.c     |  12 ++-
 7 files changed, 153 insertions(+), 6 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index c1530a7992cc..96031252436f 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -122,6 +122,7 @@ struct sched_ext_entity {
 	atomic_long_t		ops_state;
 
 	struct list_head	runnable_node;	/* rq->scx.runnable_list */
+	unsigned long		runnable_at;
 
 	u64			ddsp_dsq_id;
 	u64			ddsp_enq_flags;
diff --git a/init/init_task.c b/init/init_task.c
index c6804396fe12..8a44c932d10f 100644
--- a/init/init_task.c
+++ b/init/init_task.c
@@ -106,6 +106,7 @@ struct task_struct init_task __aligned(L1_CACHE_BYTES) = {
 		.sticky_cpu	= -1,
 		.holding_cpu	= -1,
 		.runnable_node	= LIST_HEAD_INIT(init_task.scx.runnable_node),
+		.runnable_at	= INITIAL_JIFFIES,
 		.ddsp_dsq_id	= SCX_DSQ_INVALID,
 		.slice		= SCX_SLICE_DFL,
 	},
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 6042ce3bfee0..f4365becdc13 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -5516,6 +5516,7 @@ void sched_tick(void)
 	calc_global_load_tick(rq);
 	sched_core_tick(rq);
 	task_tick_mm_cid(rq, curr);
+	scx_tick(rq);
 
 	rq_unlock(rq, &rf);
 
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 1f5d80df263a..3dc515b3351f 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -8,6 +8,7 @@
 
 enum scx_consts {
 	SCX_DSP_DFL_MAX_BATCH		= 32,
+	SCX_WATCHDOG_MAX_TIMEOUT	= 30 * HZ,
 
 	SCX_EXIT_BT_LEN			= 64,
 	SCX_EXIT_MSG_LEN		= 1024,
@@ -24,6 +25,7 @@ enum scx_exit_kind {
 
 	SCX_EXIT_ERROR = 1024,	/* runtime error, error msg contains details */
 	SCX_EXIT_ERROR_BPF,	/* ERROR but triggered through scx_bpf_error() */
+	SCX_EXIT_ERROR_STALL,	/* watchdog detected stalled runnable tasks */
 };
 
 /*
@@ -319,6 +321,15 @@ struct sched_ext_ops {
 	 */
 	u64 flags;
 
+	/**
+	 * timeout_ms - The maximum amount of time, in milliseconds, that a
+	 * runnable task should be able to wait before being scheduled. The
+	 * maximum timeout may not exceed the default timeout of 30 seconds.
+	 *
+	 * Defaults to the maximum allowed timeout value of 30 seconds.
+	 */
+	u32 timeout_ms;
+
 	/**
 	 * name - BPF scheduler's name
 	 *
@@ -472,6 +483,23 @@ struct static_key_false scx_has_op[SCX_OPI_END] =
 static atomic_t scx_exit_kind = ATOMIC_INIT(SCX_EXIT_DONE);
 static struct scx_exit_info *scx_exit_info;
 
+/*
+ * The maximum amount of time in jiffies that a task may be runnable without
+ * being scheduled on a CPU. If this timeout is exceeded, it will trigger
+ * scx_ops_error().
+ */
+static unsigned long scx_watchdog_timeout;
+
+/*
+ * The last time the delayed work was run. This delayed work relies on
+ * ksoftirqd being able to run to service timer interrupts, so it's possible
+ * that this work itself could get wedged. To account for this, we check that
+ * it's not stalled in the timer tick, and trigger an error if it is.
+ */
+static unsigned long scx_watchdog_timestamp = INITIAL_JIFFIES;
+
+static struct delayed_work scx_watchdog_work;
+
 /* idle tracking */
 #ifdef CONFIG_SMP
 #ifdef CONFIG_CPUMASK_OFFSTACK
@@ -1170,6 +1198,11 @@ static void set_task_runnable(struct rq *rq, struct task_struct *p)
 {
 	lockdep_assert_rq_held(rq);
 
+	if (p->scx.flags & SCX_TASK_RESET_RUNNABLE_AT) {
+		p->scx.runnable_at = jiffies;
+		p->scx.flags &= ~SCX_TASK_RESET_RUNNABLE_AT;
+	}
+
 	/*
 	 * list_add_tail() must be used. scx_ops_bypass() depends on tasks being
 	 * appened to the runnable_list.
@@ -1177,9 +1210,11 @@ static void set_task_runnable(struct rq *rq, struct task_struct *p)
 	list_add_tail(&p->scx.runnable_node, &rq->scx.runnable_list);
 }
 
-static void clr_task_runnable(struct task_struct *p)
+static void clr_task_runnable(struct task_struct *p, bool reset_runnable_at)
 {
 	list_del_init(&p->scx.runnable_node);
+	if (reset_runnable_at)
+		p->scx.flags |= SCX_TASK_RESET_RUNNABLE_AT;
 }
 
 static void enqueue_task_scx(struct rq *rq, struct task_struct *p, int enq_flags)
@@ -1217,7 +1252,8 @@ static void ops_dequeue(struct task_struct *p, u64 deq_flags)
 {
 	unsigned long opss;
 
-	clr_task_runnable(p);
+	/* dequeue is always temporary, don't reset runnable_at */
+	clr_task_runnable(p, false);
 
 	/* acquire ensures that we see the preceding updates on QUEUED */
 	opss = atomic_long_read_acquire(&p->scx.ops_state);
@@ -1826,7 +1862,7 @@ static void set_next_task_scx(struct rq *rq, struct task_struct *p, bool first)
 
 	p->se.exec_start = rq_clock_task(rq);
 
-	clr_task_runnable(p);
+	clr_task_runnable(p, true);
 }
 
 static void put_prev_task_scx(struct rq *rq, struct task_struct *p)
@@ -2176,9 +2212,71 @@ static void reset_idle_masks(void) {}
 
 #endif	/* CONFIG_SMP */
 
-static void task_tick_scx(struct rq *rq, struct task_struct *curr, int queued)
+static bool check_rq_for_timeouts(struct rq *rq)
+{
+	struct task_struct *p;
+	struct rq_flags rf;
+	bool timed_out = false;
+
+	rq_lock_irqsave(rq, &rf);
+	list_for_each_entry(p, &rq->scx.runnable_list, scx.runnable_node) {
+		unsigned long last_runnable = p->scx.runnable_at;
+
+		if (unlikely(time_after(jiffies,
+					last_runnable + scx_watchdog_timeout))) {
+			u32 dur_ms = jiffies_to_msecs(jiffies - last_runnable);
+
+			scx_ops_error_kind(SCX_EXIT_ERROR_STALL,
+					   "%s[%d] failed to run for %u.%03us",
+					   p->comm, p->pid,
+					   dur_ms / 1000, dur_ms % 1000);
+			timed_out = true;
+			break;
+		}
+	}
+	rq_unlock_irqrestore(rq, &rf);
+
+	return timed_out;
+}
+
+static void scx_watchdog_workfn(struct work_struct *work)
+{
+	int cpu;
+
+	WRITE_ONCE(scx_watchdog_timestamp, jiffies);
+
+	for_each_online_cpu(cpu) {
+		if (unlikely(check_rq_for_timeouts(cpu_rq(cpu))))
+			break;
+
+		cond_resched();
+	}
+	queue_delayed_work(system_unbound_wq, to_delayed_work(work),
+			   scx_watchdog_timeout / 2);
+}
+
+void scx_tick(struct rq *rq)
 {
+	unsigned long last_check;
+
+	if (!scx_enabled())
+		return;
+
+	last_check = READ_ONCE(scx_watchdog_timestamp);
+	if (unlikely(time_after(jiffies,
+				last_check + READ_ONCE(scx_watchdog_timeout)))) {
+		u32 dur_ms = jiffies_to_msecs(jiffies - last_check);
+
+		scx_ops_error_kind(SCX_EXIT_ERROR_STALL,
+				   "watchdog failed to check in for %u.%03us",
+				   dur_ms / 1000, dur_ms % 1000);
+	}
+
 	update_other_load_avgs(rq);
+}
+
+static void task_tick_scx(struct rq *rq, struct task_struct *curr, int queued)
+{
 	update_curr_scx(rq);
 
 	/*
@@ -2248,6 +2346,7 @@ static int scx_ops_init_task(struct task_struct *p, struct task_group *tg, bool
 
 	scx_set_task_state(p, SCX_TASK_INIT);
 
+	p->scx.flags |= SCX_TASK_RESET_RUNNABLE_AT;
 	return 0;
 }
 
@@ -2326,6 +2425,7 @@ void init_scx_entity(struct sched_ext_entity *scx)
 	scx->sticky_cpu = -1;
 	scx->holding_cpu = -1;
 	INIT_LIST_HEAD(&scx->runnable_node);
+	scx->runnable_at = jiffies;
 	scx->ddsp_dsq_id = SCX_DSQ_INVALID;
 	scx->slice = SCX_SLICE_DFL;
 }
@@ -2783,6 +2883,8 @@ static const char *scx_exit_reason(enum scx_exit_kind kind)
 		return "runtime error";
 	case SCX_EXIT_ERROR_BPF:
 		return "scx_bpf_error";
+	case SCX_EXIT_ERROR_STALL:
+		return "runnable task stall";
 	default:
 		return "<UNKNOWN>";
 	}
@@ -2904,6 +3006,8 @@ static void scx_ops_disable_workfn(struct kthread_work *work)
 	if (scx_ops.exit)
 		SCX_CALL_OP(SCX_KF_UNLOCKED, exit, ei);
 
+	cancel_delayed_work_sync(&scx_watchdog_work);
+
 	/*
 	 * Delete the kobject from the hierarchy eagerly in addition to just
 	 * dropping a reference. Otherwise, if the object is deleted
@@ -3026,6 +3130,7 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)
 {
 	struct scx_task_iter sti;
 	struct task_struct *p;
+	unsigned long timeout;
 	int i, ret;
 
 	mutex_lock(&scx_ops_enable_mutex);
@@ -3103,6 +3208,16 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)
 		goto err_disable;
 	}
 
+	if (ops->timeout_ms)
+		timeout = msecs_to_jiffies(ops->timeout_ms);
+	else
+		timeout = SCX_WATCHDOG_MAX_TIMEOUT;
+
+	WRITE_ONCE(scx_watchdog_timeout, timeout);
+	WRITE_ONCE(scx_watchdog_timestamp, jiffies);
+	queue_delayed_work(system_unbound_wq, &scx_watchdog_work,
+			   scx_watchdog_timeout / 2);
+
 	/*
 	 * Lock out forks before opening the floodgate so that they don't wander
 	 * into the operations prematurely.
@@ -3413,6 +3528,12 @@ static int bpf_scx_init_member(const struct btf_type *t,
 		if (ret == 0)
 			return -EINVAL;
 		return 1;
+	case offsetof(struct sched_ext_ops, timeout_ms):
+		if (msecs_to_jiffies(*(u32 *)(udata + moff)) >
+		    SCX_WATCHDOG_MAX_TIMEOUT)
+			return -E2BIG;
+		ops->timeout_ms = *(u32 *)(udata + moff);
+		return 1;
 	}
 
 	return 0;
@@ -3569,6 +3690,7 @@ void __init init_sched_ext_class(void)
 	}
 
 	register_sysrq_key('S', &sysrq_sched_ext_reset_op);
+	INIT_DELAYED_WORK(&scx_watchdog_work, scx_watchdog_workfn);
 }
 
 
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 9c5a2d928281..56fcdb0b2c05 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -29,6 +29,7 @@ static inline bool task_on_scx(const struct task_struct *p)
 	return scx_enabled() && p->sched_class == &ext_sched_class;
 }
 
+void scx_tick(struct rq *rq);
 void init_scx_entity(struct sched_ext_entity *scx);
 void scx_pre_fork(struct task_struct *p);
 int scx_fork(struct task_struct *p);
@@ -66,6 +67,7 @@ static inline const struct sched_class *next_active_class(const struct sched_cla
 #define scx_enabled()		false
 #define scx_switched_all()	false
 
+static inline void scx_tick(struct rq *rq) {}
 static inline void scx_pre_fork(struct task_struct *p) {}
 static inline int scx_fork(struct task_struct *p) { return 0; }
 static inline void scx_post_fork(struct task_struct *p) {}
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 976a2693da71..8beae08dfdc7 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -29,6 +29,8 @@ enum consts {
 char _license[] SEC("license") = "GPL";
 
 const volatile u64 slice_ns = SCX_SLICE_DFL;
+const volatile u32 stall_user_nth;
+const volatile u32 stall_kernel_nth;
 const volatile u32 dsp_batch;
 
 u32 test_error_cnt;
@@ -129,11 +131,20 @@ static int weight_to_idx(u32 weight)
 
 void BPF_STRUCT_OPS(qmap_enqueue, struct task_struct *p, u64 enq_flags)
 {
+	static u32 user_cnt, kernel_cnt;
 	struct task_ctx *tctx;
 	u32 pid = p->pid;
 	int idx = weight_to_idx(p->scx.weight);
 	void *ring;
 
+	if (p->flags & PF_KTHREAD) {
+		if (stall_kernel_nth && !(++kernel_cnt % stall_kernel_nth))
+			return;
+	} else {
+		if (stall_user_nth && !(++user_cnt % stall_user_nth))
+			return;
+	}
+
 	if (test_error_cnt && !--test_error_cnt)
 		scx_bpf_error("test triggering error");
 
@@ -261,4 +272,5 @@ SCX_OPS_DEFINE(qmap_ops,
 	       .init_task		= (void *)qmap_init_task,
 	       .init			= (void *)qmap_init,
 	       .exit			= (void *)qmap_exit,
+	       .timeout_ms		= 5000U,
 	       .name			= "qmap");
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index 7c84ade7ecfb..6e9e9726cd62 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -19,10 +19,12 @@ const char help_fmt[] =
 "\n"
 "See the top-level comment in .bpf.c for more details.\n"
 "\n"
-"Usage: %s [-s SLICE_US] [-e COUNT] [-b COUNT] [-p] [-v]\n"
+"Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-b COUNT] [-p] [-v]\n"
 "\n"
 "  -s SLICE_US   Override slice duration\n"
 "  -e COUNT      Trigger scx_bpf_error() after COUNT enqueues\n"
+"  -t COUNT      Stall every COUNT'th user thread\n"
+"  -T COUNT      Stall every COUNT'th kernel thread\n"
 "  -b COUNT      Dispatch upto COUNT tasks together\n"
 "  -p            Switch only tasks on SCHED_EXT policy intead of all\n"
 "  -v            Print libbpf debug messages\n"
@@ -55,7 +57,7 @@ int main(int argc, char **argv)
 
 	skel = SCX_OPS_OPEN(qmap_ops, scx_qmap);
 
-	while ((opt = getopt(argc, argv, "s:e:b:pvh")) != -1) {
+	while ((opt = getopt(argc, argv, "s:e:t:T:b:pvh")) != -1) {
 		switch (opt) {
 		case 's':
 			skel->rodata->slice_ns = strtoull(optarg, NULL, 0) * 1000;
@@ -63,6 +65,12 @@ int main(int argc, char **argv)
 		case 'e':
 			skel->bss->test_error_cnt = strtoul(optarg, NULL, 0);
 			break;
+		case 't':
+			skel->rodata->stall_user_nth = strtoul(optarg, NULL, 0);
+			break;
+		case 'T':
+			skel->rodata->stall_kernel_nth = strtoul(optarg, NULL, 0);
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
 include/linux/sched/ext.h      |   1 +
 init/init_task.c               |   1 +
 kernel/sched/core.c            |   1 +
 kernel/sched/ext.c             | 130 ++++++++++++++++++++++++++++++++-
 kernel/sched/ext.h             |   2 +
 tools/sched_ext/scx_qmap.bpf.c |  12 +++
 tools/sched_ext/scx_qmap.c     |  12 ++-
 7 files changed, 153 insertions(+), 6 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index c1530a7992cc..96031252436f 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -122,6 +122,7 @@ struct sched_ext_entity {
 	atomic_long_t		ops_state;

 	struct list_head	runnable_node;	/* rq->scx.runnable_list */
+	unsigned long		runnable_at;

 	u64			ddsp_dsq_id;
 	u64			ddsp_enq_flags;
diff --git a/init/init_task.c b/init/init_task.c
index c6804396fe12..8a44c932d10f 100644
--- a/init/init_task.c
+++ b/init/init_task.c
@@ -106,6 +106,7 @@ struct task_struct init_task __aligned(L1_CACHE_BYTES) = {
 		.sticky_cpu	= -1,
 		.holding_cpu	= -1,
 		.runnable_node	= LIST_HEAD_INIT(init_task.scx.runnable_node),
+		.runnable_at	= INITIAL_JIFFIES,
 		.ddsp_dsq_id	= SCX_DSQ_INVALID,
 		.slice		= SCX_SLICE_DFL,
 	},
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 6042ce3bfee0..f4365becdc13 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -5516,6 +5516,7 @@ void sched_tick(void)
 	calc_global_load_tick(rq);
 	sched_core_tick(rq);
 	task_tick_mm_cid(rq, curr);
+	scx_tick(rq);

 	rq_unlock(rq, &rf);

diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 1f5d80df263a..3dc515b3351f 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -8,6 +8,7 @@

 enum scx_consts {
 	SCX_DSP_DFL_MAX_BATCH		= 32,
+	SCX_WATCHDOG_MAX_TIMEOUT	= 30 * HZ,

 	SCX_EXIT_BT_LEN			= 64,
 	SCX_EXIT_MSG_LEN		= 1024,
@@ -24,6 +25,7 @@ enum scx_exit_kind {

 	SCX_EXIT_ERROR = 1024,	/* runtime error, error msg contains details */
 	SCX_EXIT_ERROR_BPF,	/* ERROR but triggered through scx_bpf_error() */
+	SCX_EXIT_ERROR_STALL,	/* watchdog detected stalled runnable tasks */
 };

 /*
@@ -319,6 +321,15 @@ struct sched_ext_ops {
 	 */
 	u64 flags;

+	/**
+	 * timeout_ms - The maximum amount of time, in milliseconds, that a
+	 * runnable task should be able to wait before being scheduled. The
+	 * maximum timeout may not exceed the default timeout of 30 seconds.
+	 *
+	 * Defaults to the maximum allowed timeout value of 30 seconds.
+	 */
+	u32 timeout_ms;
+
 	/**
 	 * name - BPF scheduler's name
 	 *
@@ -472,6 +483,23 @@ struct static_key_false scx_has_op[SCX_OPI_END] =
 static atomic_t scx_exit_kind = ATOMIC_INIT(SCX_EXIT_DONE);
 static struct scx_exit_info *scx_exit_info;

+/*
+ * The maximum amount of time in jiffies that a task may be runnable without
+ * being scheduled on a CPU. If this timeout is exceeded, it will trigger
+ * scx_ops_error().
+ */
+static unsigned long scx_watchdog_timeout;
+
+/*
+ * The last time the delayed work was run. This delayed work relies on
+ * ksoftirqd being able to run to service timer interrupts, so it's possible
+ * that this work itself could get wedged. To account for this, we check that
+ * it's not stalled in the timer tick, and trigger an error if it is.
+ */
+static unsigned long scx_watchdog_timestamp = INITIAL_JIFFIES;
+
+static struct delayed_work scx_watchdog_work;
+
 /* idle tracking */
 #ifdef CONFIG_SMP
 #ifdef CONFIG_CPUMASK_OFFSTACK
@@ -1170,6 +1198,11 @@ static void set_task_runnable(struct rq *rq, struct task_struct *p)
 {
 	lockdep_assert_rq_held(rq);

+	if (p->scx.flags & SCX_TASK_RESET_RUNNABLE_AT) {
+		p->scx.runnable_at = jiffies;
+		p->scx.flags &= ~SCX_TASK_RESET_RUNNABLE_AT;
+	}
+
 	/*
 	 * list_add_tail() must be used. scx_ops_bypass() depends on tasks being
 	 * appened to the runnable_list.
@@ -1177,9 +1210,11 @@ static void set_task_runnable(struct rq *rq, struct task_struct *p)
 	list_add_tail(&p->scx.runnable_node, &rq->scx.runnable_list);
 }

-static void clr_task_runnable(struct task_struct *p)
+static void clr_task_runnable(struct task_struct *p, bool reset_runnable_at)
 {
 	list_del_init(&p->scx.runnable_node);
+	if (reset_runnable_at)
+		p->scx.flags |= SCX_TASK_RESET_RUNNABLE_AT;
 }

 static void enqueue_task_scx(struct rq *rq, struct task_struct *p, int enq_flags)
@@ -1217,7 +1252,8 @@ static void ops_dequeue(struct task_struct *p, u64 deq_flags)
 {
 	unsigned long opss;

-	clr_task_runnable(p);
+	/* dequeue is always temporary, don't reset runnable_at */
+	clr_task_runnable(p, false);

 	/* acquire ensures that we see the preceding updates on QUEUED */
 	opss = atomic_long_read_acquire(&p->scx.ops_state);
@@ -1826,7 +1862,7 @@ static void set_next_task_scx(struct rq *rq, struct task_struct *p, bool first)

 	p->se.exec_start = rq_clock_task(rq);

-	clr_task_runnable(p);
+	clr_task_runnable(p, true);
 }

 static void put_prev_task_scx(struct rq *rq, struct task_struct *p)
@@ -2176,9 +2212,71 @@ static void reset_idle_masks(void) {}

 #endif	/* CONFIG_SMP */

-static void task_tick_scx(struct rq *rq, struct task_struct *curr, int queued)
+static bool check_rq_for_timeouts(struct rq *rq)
+{
+	struct task_struct *p;
+	struct rq_flags rf;
+	bool timed_out = false;
+
+	rq_lock_irqsave(rq, &rf);
+	list_for_each_entry(p, &rq->scx.runnable_list, scx.runnable_node) {
+		unsigned long last_runnable = p->scx.runnable_at;
+
+		if (unlikely(time_after(jiffies,
+					last_runnable + scx_watchdog_timeout))) {
+			u32 dur_ms = jiffies_to_msecs(jiffies - last_runnable);
+
+			scx_ops_error_kind(SCX_EXIT_ERROR_STALL,
+					   "%s[%d] failed to run for %u.%03us",
+					   p->comm, p->pid,
+					   dur_ms / 1000, dur_ms % 1000);
+			timed_out = true;
+			break;
+		}
+	}
+	rq_unlock_irqrestore(rq, &rf);
+
+	return timed_out;
+}
+
+static void scx_watchdog_workfn(struct work_struct *work)
+{
+	int cpu;
+
+	WRITE_ONCE(scx_watchdog_timestamp, jiffies);
+
+	for_each_online_cpu(cpu) {
+		if (unlikely(check_rq_for_timeouts(cpu_rq(cpu))))
+			break;
+
+		cond_resched();
+	}
+	queue_delayed_work(system_unbound_wq, to_delayed_work(work),
+			   scx_watchdog_timeout / 2);
+}
+
+void scx_tick(struct rq *rq)
 {
+	unsigned long last_check;
+
+	if (!scx_enabled())
+		return;
+
+	last_check = READ_ONCE(scx_watchdog_timestamp);
+	if (unlikely(time_after(jiffies,
+				last_check + READ_ONCE(scx_watchdog_timeout)))) {
+		u32 dur_ms = jiffies_to_msecs(jiffies - last_check);
+
+		scx_ops_error_kind(SCX_EXIT_ERROR_STALL,
+				   "watchdog failed to check in for %u.%03us",
+				   dur_ms / 1000, dur_ms % 1000);
+	}
+
 	update_other_load_avgs(rq);
+}
+
+static void task_tick_scx(struct rq *rq, struct task_struct *curr, int queued)
+{
 	update_curr_scx(rq);

 	/*
@@ -2248,6 +2346,7 @@ static int scx_ops_init_task(struct task_struct *p, struct task_group *tg, bool

 	scx_set_task_state(p, SCX_TASK_INIT);

+	p->scx.flags |= SCX_TASK_RESET_RUNNABLE_AT;
 	return 0;
 }

@@ -2326,6 +2425,7 @@ void init_scx_entity(struct sched_ext_entity *scx)
 	scx->sticky_cpu = -1;
 	scx->holding_cpu = -1;
 	INIT_LIST_HEAD(&scx->runnable_node);
+	scx->runnable_at = jiffies;
 	scx->ddsp_dsq_id = SCX_DSQ_INVALID;
 	scx->slice = SCX_SLICE_DFL;
 }
@@ -2783,6 +2883,8 @@ static const char *scx_exit_reason(enum scx_exit_kind kind)
 		return "runtime error";
 	case SCX_EXIT_ERROR_BPF:
 		return "scx_bpf_error";
+	case SCX_EXIT_ERROR_STALL:
+		return "runnable task stall";
 	default:
 		return "<UNKNOWN>";
 	}
@@ -2904,6 +3006,8 @@ static void scx_ops_disable_workfn(struct kthread_work *work)
 	if (scx_ops.exit)
 		SCX_CALL_OP(SCX_KF_UNLOCKED, exit, ei);

+	cancel_delayed_work_sync(&scx_watchdog_work);
+
 	/*
 	 * Delete the kobject from the hierarchy eagerly in addition to just
 	 * dropping a reference. Otherwise, if the object is deleted
@@ -3026,6 +3130,7 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)
 {
 	struct scx_task_iter sti;
 	struct task_struct *p;
+	unsigned long timeout;
 	int i, ret;

 	mutex_lock(&scx_ops_enable_mutex);
@@ -3103,6 +3208,16 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)
 		goto err_disable;
 	}

+	if (ops->timeout_ms)
+		timeout = msecs_to_jiffies(ops->timeout_ms);
+	else
+		timeout = SCX_WATCHDOG_MAX_TIMEOUT;
+
+	WRITE_ONCE(scx_watchdog_timeout, timeout);
+	WRITE_ONCE(scx_watchdog_timestamp, jiffies);
+	queue_delayed_work(system_unbound_wq, &scx_watchdog_work,
+			   scx_watchdog_timeout / 2);
+
 	/*
 	 * Lock out forks before opening the floodgate so that they don't wander
 	 * into the operations prematurely.
@@ -3413,6 +3528,12 @@ static int bpf_scx_init_member(const struct btf_type *t,
 		if (ret == 0)
 			return -EINVAL;
 		return 1;
+	case offsetof(struct sched_ext_ops, timeout_ms):
+		if (msecs_to_jiffies(*(u32 *)(udata + moff)) >
+		    SCX_WATCHDOG_MAX_TIMEOUT)
+			return -E2BIG;
+		ops->timeout_ms = *(u32 *)(udata + moff);
+		return 1;
 	}

 	return 0;
@@ -3569,6 +3690,7 @@ void __init init_sched_ext_class(void)
 	}

 	register_sysrq_key('S', &sysrq_sched_ext_reset_op);
+	INIT_DELAYED_WORK(&scx_watchdog_work, scx_watchdog_workfn);
 }


diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 9c5a2d928281..56fcdb0b2c05 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -29,6 +29,7 @@ static inline bool task_on_scx(const struct task_struct *p)
 	return scx_enabled() && p->sched_class == &ext_sched_class;
 }

+void scx_tick(struct rq *rq);
 void init_scx_entity(struct sched_ext_entity *scx);
 void scx_pre_fork(struct task_struct *p);
 int scx_fork(struct task_struct *p);
@@ -66,6 +67,7 @@ static inline const struct sched_class *next_active_class(const struct sched_cla
 #define scx_enabled()		false
 #define scx_switched_all()	false

+static inline void scx_tick(struct rq *rq) {}
 static inline void scx_pre_fork(struct task_struct *p) {}
 static inline int scx_fork(struct task_struct *p) { return 0; }
 static inline void scx_post_fork(struct task_struct *p) {}
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 976a2693da71..8beae08dfdc7 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -29,6 +29,8 @@ enum consts {
 char _license[] SEC("license") = "GPL";

 const volatile u64 slice_ns = SCX_SLICE_DFL;
+const volatile u32 stall_user_nth;
+const volatile u32 stall_kernel_nth;
 const volatile u32 dsp_batch;

 u32 test_error_cnt;
@@ -129,11 +131,20 @@ static int weight_to_idx(u32 weight)

 void BPF_STRUCT_OPS(qmap_enqueue, struct task_struct *p, u64 enq_flags)
 {
+	static u32 user_cnt, kernel_cnt;
 	struct task_ctx *tctx;
 	u32 pid = p->pid;
 	int idx = weight_to_idx(p->scx.weight);
 	void *ring;

+	if (p->flags & PF_KTHREAD) {
+		if (stall_kernel_nth && !(++kernel_cnt % stall_kernel_nth))
+			return;
+	} else {
+		if (stall_user_nth && !(++user_cnt % stall_user_nth))
+			return;
+	}
+
 	if (test_error_cnt && !--test_error_cnt)
 		scx_bpf_error("test triggering error");

@@ -261,4 +272,5 @@ SCX_OPS_DEFINE(qmap_ops,
 	       .init_task		= (void *)qmap_init_task,
 	       .init			= (void *)qmap_init,
 	       .exit			= (void *)qmap_exit,
+	       .timeout_ms		= 5000U,
 	       .name			= "qmap");
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index 7c84ade7ecfb..6e9e9726cd62 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -19,10 +19,12 @@ const char help_fmt[] =
 "\n"
 "See the top-level comment in .bpf.c for more details.\n"
 "\n"
-"Usage: %s [-s SLICE_US] [-e COUNT] [-b COUNT] [-p] [-v]\n"
+"Usage: %s [-s SLICE_US] [-e COUNT] [-t COUNT] [-T COUNT] [-b COUNT] [-p] [-v]\n"
 "\n"
 "  -s SLICE_US   Override slice duration\n"
 "  -e COUNT      Trigger scx_bpf_error() after COUNT enqueues\n"
+"  -t COUNT      Stall every COUNT'th user thread\n"
+"  -T COUNT      Stall every COUNT'th kernel thread\n"
 "  -b COUNT      Dispatch upto COUNT tasks together\n"
 "  -p            Switch only tasks on SCHED_EXT policy intead of all\n"
 "  -v            Print libbpf debug messages\n"
@@ -55,7 +57,7 @@ int main(int argc, char **argv)

 	skel = SCX_OPS_OPEN(qmap_ops, scx_qmap);

-	while ((opt = getopt(argc, argv, "s:e:b:pvh")) != -1) {
+	while ((opt = getopt(argc, argv, "s:e:t:T:b:pvh")) != -1) {
 		switch (opt) {
 		case 's':
 			skel->rodata->slice_ns = strtoull(optarg, NULL, 0) * 1000;
@@ -63,6 +65,12 @@ int main(int argc, char **argv)
 		case 'e':
 			skel->bss->test_error_cnt = strtoul(optarg, NULL, 0);
 			break;
+		case 't':
+			skel->rodata->stall_user_nth = strtoul(optarg, NULL, 0);
+			break;
+		case 'T':
+			skel->rodata->stall_kernel_nth = strtoul(optarg, NULL, 0);
+			break;
 		case 'b':
 			skel->rodata->dsp_batch = strtoul(optarg, NULL, 0);
 			break;
--
2.45.2


```

## Implementation Analysis

### Overview

This patch (PATCH 12/30, authored by David Vernet) implements the runnable-task stall watchdog. It addresses the most common failure mode of a buggy BPF scheduler: forgetting to dispatch a task. If any SCX task remains runnable (enqueued but not running) for longer than `scx_watchdog_timeout` jiffies, the watchdog fires `scx_ops_error()`, which triggers an orderly BPF scheduler shutdown and falls all tasks back to CFS.

The implementation has two detection paths: a periodic delayed-work scan (the primary path) and a timer-tick secondary check that detects if the delayed work itself has become stuck (the meta-watchdog).

### Architecture Context

The watchdog is a critical safety layer between the BPF verifier (which catches statically unsafe programs) and sysrq-S (which requires operator intervention). Without it, a BPF scheduler that passes verification but has a logic bug — for example, an `ops.enqueue()` that silently drops tasks of a certain priority — could permanently starve those tasks with no automatic recovery.

The commit message shows two canonical detection scenarios with real kernel stack traces:

1. **Task stall**: `dbus-daemon[953] failed to run for 6.478s` — detected by the delayed-work scan.
2. **Watchdog stall**: `watchdog failed to check in for 5.001s` — detected by the scheduler tick, indicating that ksoftirqd itself is stuck and the delayed work cannot run.

The second scenario is particularly subtle: if the BPF scheduler is so broken that it starves ksoftirqd, the delayed work can never fire. The timer-tick meta-watchdog catches exactly this case.

### Code Walkthrough

**`sched_ext_entity.runnable_at` — the per-task timestamp**

```c
/* include/linux/sched/ext.h */
unsigned long   runnable_at;
```

```c
/* init/init_task.c */
.runnable_at = INITIAL_JIFFIES,
```

Every `sched_ext_entity` gains an `unsigned long runnable_at` field. This records the jiffies value at which the task most recently became runnable. It is initialized to `INITIAL_JIFFIES` (not zero) to avoid a false positive immediately after boot when jiffies is small.

**`SCX_TASK_RESET_RUNNABLE_AT` — the lazy timestamp update**

The timestamp is not updated immediately when a task is re-enqueued after running. Instead, a flag `SCX_TASK_RESET_RUNNABLE_AT` is set in `clr_task_runnable(p, true)` when a task is removed from the runnable list because it started executing:

```c
/* in set_next_task_scx() — task is about to run */
clr_task_runnable(p, true);   /* sets SCX_TASK_RESET_RUNNABLE_AT */
```

When the task later returns to the runnable list (via `set_task_runnable()`), the flag is checked:

```c
if (p->scx.flags & SCX_TASK_RESET_RUNNABLE_AT) {
    p->scx.runnable_at = jiffies;
    p->scx.flags &= ~SCX_TASK_RESET_RUNNABLE_AT;
}
```

This lazy update design means `runnable_at` is stamped at the moment the task actually becomes runnable again, not at the moment it finished running. This is the correct semantics: we want to know "how long has this task been waiting to run" not "when did it last run."

By contrast, `ops_dequeue()` calls `clr_task_runnable(p, false)` — dequeue without resetting the flag. This is because dequeue is a temporary removal (e.g., for migration), not a "task ran" event. The timestamp should not be refreshed.

**The global watchdog state**

```c
static unsigned long scx_watchdog_timeout;
static unsigned long scx_watchdog_timestamp = INITIAL_JIFFIES;
static struct delayed_work scx_watchdog_work;
```

`scx_watchdog_timeout` is set at BPF scheduler load time from `ops->timeout_ms` (or defaults to `SCX_WATCHDOG_MAX_TIMEOUT = 30 * HZ` if `timeout_ms` is zero). `scx_watchdog_timestamp` records when the delayed work last ran — this is what the meta-watchdog checks.

**`check_rq_for_timeouts()` — per-CPU scan**

```c
rq_lock_irqsave(rq, &rf);
list_for_each_entry(p, &rq->scx.runnable_list, scx.runnable_node) {
    unsigned long last_runnable = p->scx.runnable_at;
    if (unlikely(time_after(jiffies, last_runnable + scx_watchdog_timeout))) {
        scx_ops_error_kind(SCX_EXIT_ERROR_STALL,
                           "%s[%d] failed to run for %u.%03us", ...);
        break;
    }
}
rq_unlock_irqrestore(rq, &rf);
```

The function acquires the runqueue lock and walks `rq->scx.runnable_list` — the list of SCX tasks that are currently runnable on this CPU. It uses `time_after()` rather than a direct comparison to correctly handle jiffies wraparound. The `break` after the first timed-out task is correct: `scx_ops_error_kind()` will trigger scheduler shutdown asynchronously, so there is no point scanning further.

Note that this function holds the runqueue lock while scanning, which is safe because the list can only be modified under the runqueue lock. However, this also means the function must complete quickly — it cannot sleep or do I/O.

**`scx_watchdog_workfn()` — the delayed work function**

```c
static void scx_watchdog_workfn(struct work_struct *work)
{
    WRITE_ONCE(scx_watchdog_timestamp, jiffies);

    for_each_online_cpu(cpu) {
        if (unlikely(check_rq_for_timeouts(cpu_rq(cpu))))
            break;
        cond_resched();
    }
    queue_delayed_work(system_unbound_wq, to_delayed_work(work),
                       scx_watchdog_timeout / 2);
}
```

The work function updates `scx_watchdog_timestamp` first (before scanning), so that if the scan takes a long time, the timestamp accurately reflects when the watchdog was last active. The scan calls `cond_resched()` between CPUs to avoid monopolizing the kworker thread and to allow the BPF scheduler to make progress if it can.

The work is re-queued every `scx_watchdog_timeout / 2` jiffies. Using half the timeout ensures the watchdog can detect a stall within the timeout period even if one iteration runs just before the stall begins.

The work runs on `system_unbound_wq`, which is not bound to a specific CPU. This is important: a bound work queue could end up waiting for a CPU that is itself starved by the buggy BPF scheduler.

**`scx_tick()` — the meta-watchdog**

```c
void scx_tick(struct rq *rq)
{
    unsigned long last_check;

    if (!scx_enabled())
        return;

    last_check = READ_ONCE(scx_watchdog_timestamp);
    if (unlikely(time_after(jiffies,
                            last_check + READ_ONCE(scx_watchdog_timeout)))) {
        scx_ops_error_kind(SCX_EXIT_ERROR_STALL,
                           "watchdog failed to check in for %u.%03us", ...);
    }
    update_other_load_avgs(rq);
}
```

`scx_tick()` is called from `sched_tick()` on every scheduler tick on every CPU. It checks whether `scx_watchdog_timestamp` was updated within `scx_watchdog_timeout` jiffies. If not, the watchdog work itself is stuck, and the meta-watchdog triggers `scx_ops_error()`.

Note that `update_other_load_avgs(rq)` was previously in `task_tick_scx()`. This refactoring moves load average updates into `scx_tick()` so they happen regardless of whether the current task is an SCX task — load averages should be updated on every tick, not just when an SCX task is running.

**BPF scheduler API: `ops.timeout_ms`**

```c
/* struct sched_ext_ops */
u32 timeout_ms;
```

BPF schedulers can set `timeout_ms` to request a shorter watchdog timeout than the 30-second default. This is useful for testing (scx_qmap sets it to 5000ms) and for latency-sensitive schedulers that should detect stalls quickly. The maximum is `SCX_WATCHDOG_MAX_TIMEOUT = 30 * HZ`; attempts to set a larger value return `-E2BIG` from `bpf_scx_init_member()`.

**`scx_ops_enable()` — watchdog startup**

```c
WRITE_ONCE(scx_watchdog_timeout, timeout);
WRITE_ONCE(scx_watchdog_timestamp, jiffies);
queue_delayed_work(system_unbound_wq, &scx_watchdog_work,
                   scx_watchdog_timeout / 2);
```

The watchdog is armed as part of `scx_ops_enable()`, after the BPF scheduler has been verified and initialized but before tasks are migrated to SCX. The timestamp is pre-set to `jiffies` so that the very first tick does not see a stale value.

**`scx_ops_disable_workfn()` — watchdog shutdown**

```c
cancel_delayed_work_sync(&scx_watchdog_work);
```

When the BPF scheduler is disabled, the watchdog work is cancelled synchronously before the scheduler state is torn down. `cancel_delayed_work_sync()` blocks until any currently-executing iteration of the work function completes. This is necessary to avoid `scx_watchdog_workfn()` accessing freed scheduler state after teardown.

**`scx_qmap` test harness additions**

The `scx_qmap` example scheduler gains `stall_user_nth` and `stall_kernel_nth` variables, settable from userspace via `-t` and `-T` flags. When set, `qmap_enqueue()` deliberately drops every Nth user or kernel task by returning without calling `scx_bpf_dispatch()`:

```c
if (p->flags & PF_KTHREAD) {
    if (stall_kernel_nth && !(++kernel_cnt % stall_kernel_nth))
        return;   /* intentional stall — watchdog should fire */
}
```

This is a deliberate test vector for the watchdog. scx_qmap also sets `.timeout_ms = 5000U` so that tests run with a 5-second timeout rather than the 30-second default, making CI runs faster.

### Key Concepts Introduced

**`runnable_list` as the watchdog's data source**: Every SCX task that is runnable (enqueued in a DSQ or in BPF-side data structures awaiting dispatch) is also on its runqueue's `scx.runnable_list`. The watchdog iterates this list, not the DSQs themselves, because DSQs are scheduler-private and can span multiple CPUs. The `runnable_list` provides a CPU-local view of all tasks that should be making progress.

**Dual-path detection (work + tick)**: The design deliberately redundancy: the delayed work catches the common case of a task being dropped, and the ticker catches the pathological case of the work queue itself being blocked. Without the ticker, a BPF scheduler that starves ksoftirqd would defeat the primary watchdog.

**`SCX_EXIT_ERROR_STALL` vs `SCX_EXIT_SYSRQ`**: Stall detection triggers `scx_ops_error_kind(SCX_EXIT_ERROR_STALL, ...)`, not `scx_ops_disable(SCX_EXIT_SYSRQ)`. The `ERROR` prefix matters: it signals to the BPF scheduler's userspace binary that a fault occurred, enabling it to log diagnostic information and potentially restart with a safer configuration.

### Why This Matters for Maintainers

**The `clr_task_runnable(p, false)` vs `clr_task_runnable(p, true)` distinction is an invariant**: `true` (reset the timestamp on next enqueue) must be used only when the task actually ran — `set_next_task_scx()`. `false` must be used for temporary removals — `ops_dequeue()`. Breaking this distinction causes either false watchdog fires (reset too eagerly) or missed stalls (reset too late).

**`cancel_delayed_work_sync` ordering**: The cancel must happen in `scx_ops_disable_workfn()` before any sched_ext per-task state is freed. If moved later, there is a race where the watchdog work fires after `scx_watchdog_timeout` has been zeroed but before the tasks' `scx.runnable_node` has been removed from the runnable list, causing a list walk on partially-freed state.

**`system_unbound_wq` is not optional**: If the watchdog work were queued on a bound work queue or the default `system_wq`, a BPF scheduler that starves all work queues on a particular CPU could prevent the watchdog from running on that CPU. `system_unbound_wq` workers can migrate.

**`timeout_ms = 0` means "use the default"**: The `bpf_scx_init_member()` validation path allows `timeout_ms = 0` (zero is valid and means "use `SCX_WATCHDOG_MAX_TIMEOUT`"). This is checked explicitly in `scx_ops_enable()`:
```c
if (ops->timeout_ms)
    timeout = msecs_to_jiffies(ops->timeout_ms);
else
    timeout = SCX_WATCHDOG_MAX_TIMEOUT;
```
Reviewers should be careful that this zero-means-default semantic is not accidentally changed.

### Connection to Other Patches

This patch and PATCH 11/30 (patch-10.md, sysrq-S) complete the safety layer described in the cover letter (patch-08.md). Together they ensure:

- No BPF scheduler can starve tasks indefinitely without automatic detection (this patch).
- Any operator can manually terminate a misbehaving BPF scheduler without a reboot (patch-10.md).

PATCH 19/30 later extends the watchdog to handle the case where `ops.dispatch()` loops without making progress — a different kind of liveness failure where tasks are being dispatched but the dispatch loop itself is spinning.

The `scx_qmap` test harness additions here (stall flags, 5-second timeout) are used by the selftests added in PATCH 30/30 to provide regression coverage for the watchdog functionality.

