# [PATCH 24/30] sched_ext: Implement sched_ext_ops.cpu_acquire/release()

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-25-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-25-tj@kernel.org)

## Commit Message

```text
From: David Vernet <dvernet@meta.com>

Scheduler classes are strictly ordered and when a higher priority class has
tasks to run, the lower priority ones lose access to the CPU. Being able to
monitor and act on these events are necessary for use cases includling
strict core-scheduling and latency management.

This patch adds two operations ops.cpu_acquire() and .cpu_release(). The
former is invoked when a CPU becomes available to the BPF scheduler and the
opposite for the latter. This patch also implements
scx_bpf_reenqueue_local() which can be called from .cpu_release() to trigger
requeueing of all tasks in the local dsq of the CPU so that the tasks can be
reassigned to other available CPUs.

scx_pair is updated to use .cpu_acquire/release() along with
%SCX_KICK_WAIT to make the pair scheduling guarantee strict even when a CPU
is preempted by a higher priority scheduler class.

scx_qmap is updated to use .cpu_acquire/release() to empty the local
dsq of a preempted CPU. A similar approach can be adopted by BPF schedulers
that want to have a tight control over latency.

v4: Use the new SCX_KICK_IDLE to wake up a CPU after re-enqueueing.

v3: Drop the const qualifier from scx_cpu_release_args.task. BPF enforces
    access control through the verifier, so the qualifier isn't actually
    operative and only gets in the way when interacting with various
    helpers.

v2: Add p->scx.kf_mask annotation to allow calling scx_bpf_reenqueue_local()
    from ops.cpu_release() nested inside ops.init() and other sleepable
    operations.

Signed-off-by: David Vernet <dvernet@meta.com>
Reviewed-by: Tejun Heo <tj@kernel.org>
Signed-off-by: Tejun Heo <tj@kernel.org>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 include/linux/sched/ext.h                |   4 +-
 kernel/sched/ext.c                       | 198 ++++++++++++++++++++++-
 kernel/sched/ext.h                       |   2 +
 kernel/sched/sched.h                     |   1 +
 tools/sched_ext/include/scx/common.bpf.h |   1 +
 tools/sched_ext/scx_qmap.bpf.c           |  37 ++++-
 tools/sched_ext/scx_qmap.c               |   4 +-
 7 files changed, 240 insertions(+), 7 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index 74341dbc6a19..21c627337e01 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -98,13 +98,15 @@ enum scx_kf_mask {
 	SCX_KF_UNLOCKED		= 0,	  /* not sleepable, not rq locked */
 	/* all non-sleepables may be nested inside SLEEPABLE */
 	SCX_KF_SLEEPABLE	= 1 << 0, /* sleepable init operations */
+	/* ENQUEUE and DISPATCH may be nested inside CPU_RELEASE */
+	SCX_KF_CPU_RELEASE	= 1 << 1, /* ops.cpu_release() */
 	/* ops.dequeue (in REST) may be nested inside DISPATCH */
 	SCX_KF_DISPATCH		= 1 << 2, /* ops.dispatch() */
 	SCX_KF_ENQUEUE		= 1 << 3, /* ops.enqueue() and ops.select_cpu() */
 	SCX_KF_SELECT_CPU	= 1 << 4, /* ops.select_cpu() */
 	SCX_KF_REST		= 1 << 5, /* other rq-locked operations */
 
-	__SCX_KF_RQ_LOCKED	= SCX_KF_DISPATCH |
+	__SCX_KF_RQ_LOCKED	= SCX_KF_CPU_RELEASE | SCX_KF_DISPATCH |
 				  SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU | SCX_KF_REST,
 	__SCX_KF_TERMINAL	= SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU | SCX_KF_REST,
 };
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 1ca3067b4e0a..686dab6ab592 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -110,6 +110,32 @@ struct scx_exit_task_args {
 	bool cancelled;
 };
 
+enum scx_cpu_preempt_reason {
+	/* next task is being scheduled by &sched_class_rt */
+	SCX_CPU_PREEMPT_RT,
+	/* next task is being scheduled by &sched_class_dl */
+	SCX_CPU_PREEMPT_DL,
+	/* next task is being scheduled by &sched_class_stop */
+	SCX_CPU_PREEMPT_STOP,
+	/* unknown reason for SCX being preempted */
+	SCX_CPU_PREEMPT_UNKNOWN,
+};
+
+/*
+ * Argument container for ops->cpu_acquire(). Currently empty, but may be
+ * expanded in the future.
+ */
+struct scx_cpu_acquire_args {};
+
+/* argument container for ops->cpu_release() */
+struct scx_cpu_release_args {
+	/* the reason the CPU was preempted */
+	enum scx_cpu_preempt_reason reason;
+
+	/* the task that's going to be scheduled on the CPU */
+	struct task_struct	*task;
+};
+
 /*
  * Informational context provided to dump operations.
  */
@@ -335,6 +361,28 @@ struct sched_ext_ops {
 	 */
 	void (*update_idle)(s32 cpu, bool idle);
 
+	/**
+	 * cpu_acquire - A CPU is becoming available to the BPF scheduler
+	 * @cpu: The CPU being acquired by the BPF scheduler.
+	 * @args: Acquire arguments, see the struct definition.
+	 *
+	 * A CPU that was previously released from the BPF scheduler is now once
+	 * again under its control.
+	 */
+	void (*cpu_acquire)(s32 cpu, struct scx_cpu_acquire_args *args);
+
+	/**
+	 * cpu_release - A CPU is taken away from the BPF scheduler
+	 * @cpu: The CPU being released by the BPF scheduler.
+	 * @args: Release arguments, see the struct definition.
+	 *
+	 * The specified CPU is no longer under the control of the BPF
+	 * scheduler. This could be because it was preempted by a higher
+	 * priority sched_class, though there may be other reasons as well. The
+	 * caller should consult @args->reason to determine the cause.
+	 */
+	void (*cpu_release)(s32 cpu, struct scx_cpu_release_args *args);
+
 	/**
 	 * init_task - Initialize a task to run in a BPF scheduler
 	 * @p: task to initialize for BPF scheduling
@@ -487,6 +535,17 @@ enum scx_enq_flags {
 	 */
 	SCX_ENQ_PREEMPT		= 1LLU << 32,
 
+	/*
+	 * The task being enqueued was previously enqueued on the current CPU's
+	 * %SCX_DSQ_LOCAL, but was removed from it in a call to the
+	 * bpf_scx_reenqueue_local() kfunc. If bpf_scx_reenqueue_local() was
+	 * invoked in a ->cpu_release() callback, and the task is again
+	 * dispatched back to %SCX_LOCAL_DSQ by this current ->enqueue(), the
+	 * task will not be scheduled on the CPU until at least the next invocation
+	 * of the ->cpu_acquire() callback.
+	 */
+	SCX_ENQ_REENQ		= 1LLU << 40,
+
 	/*
 	 * The task being enqueued is the only task available for the cpu. By
 	 * default, ext core keeps executing such tasks but when
@@ -625,6 +684,7 @@ static bool scx_warned_zero_slice;
 
 static DEFINE_STATIC_KEY_FALSE(scx_ops_enq_last);
 static DEFINE_STATIC_KEY_FALSE(scx_ops_enq_exiting);
+DEFINE_STATIC_KEY_FALSE(scx_ops_cpu_preempt);
 static DEFINE_STATIC_KEY_FALSE(scx_builtin_idle_enabled);
 
 struct static_key_false scx_has_op[SCX_OPI_END] =
@@ -887,6 +947,12 @@ static __always_inline bool scx_kf_allowed(u32 mask)
 	 * inside ops.dispatch(). We don't need to check the SCX_KF_SLEEPABLE
 	 * boundary thanks to the above in_interrupt() check.
 	 */
+	if (unlikely(highest_bit(mask) == SCX_KF_CPU_RELEASE &&
+		     (current->scx.kf_mask & higher_bits(SCX_KF_CPU_RELEASE)))) {
+		scx_ops_error("cpu_release kfunc called from a nested operation");
+		return false;
+	}
+
 	if (unlikely(highest_bit(mask) == SCX_KF_DISPATCH &&
 		     (current->scx.kf_mask & higher_bits(SCX_KF_DISPATCH)))) {
 		scx_ops_error("dispatch kfunc called from a nested operation");
@@ -2070,6 +2136,19 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 	lockdep_assert_rq_held(rq);
 	rq->scx.flags |= SCX_RQ_BALANCING;
 
+	if (static_branch_unlikely(&scx_ops_cpu_preempt) &&
+	    unlikely(rq->scx.cpu_released)) {
+		/*
+		 * If the previous sched_class for the current CPU was not SCX,
+		 * notify the BPF scheduler that it again has control of the
+		 * core. This callback complements ->cpu_release(), which is
+		 * emitted in scx_next_task_picked().
+		 */
+		if (SCX_HAS_OP(cpu_acquire))
+			SCX_CALL_OP(0, cpu_acquire, cpu_of(rq), NULL);
+		rq->scx.cpu_released = false;
+	}
+
 	if (prev_on_scx) {
 		WARN_ON_ONCE(prev->scx.flags & SCX_TASK_BAL_KEEP);
 		update_curr_scx(rq);
@@ -2077,7 +2156,9 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 		/*
 		 * If @prev is runnable & has slice left, it has priority and
 		 * fetching more just increases latency for the fetched tasks.
-		 * Tell put_prev_task_scx() to put @prev on local_dsq.
+		 * Tell put_prev_task_scx() to put @prev on local_dsq. If the
+		 * BPF scheduler wants to handle this explicitly, it should
+		 * implement ->cpu_released().
 		 *
 		 * See scx_ops_disable_workfn() for the explanation on the
 		 * bypassing test.
@@ -2297,6 +2378,20 @@ static struct task_struct *pick_next_task_scx(struct rq *rq)
 	return p;
 }
 
+static enum scx_cpu_preempt_reason
+preempt_reason_from_class(const struct sched_class *class)
+{
+#ifdef CONFIG_SMP
+	if (class == &stop_sched_class)
+		return SCX_CPU_PREEMPT_STOP;
+#endif
+	if (class == &dl_sched_class)
+		return SCX_CPU_PREEMPT_DL;
+	if (class == &rt_sched_class)
+		return SCX_CPU_PREEMPT_RT;
+	return SCX_CPU_PREEMPT_UNKNOWN;
+}
+
 void scx_next_task_picked(struct rq *rq, struct task_struct *p,
 			  const struct sched_class *active)
 {
@@ -2312,6 +2407,40 @@ void scx_next_task_picked(struct rq *rq, struct task_struct *p,
 	 */
 	smp_store_release(&rq->scx.pnt_seq, rq->scx.pnt_seq + 1);
 #endif
+	if (!static_branch_unlikely(&scx_ops_cpu_preempt))
+		return;
+
+	/*
+	 * The callback is conceptually meant to convey that the CPU is no
+	 * longer under the control of SCX. Therefore, don't invoke the
+	 * callback if the CPU is is staying on SCX, or going idle (in which
+	 * case the SCX scheduler has actively decided not to schedule any
+	 * tasks on the CPU).
+	 */
+	if (likely(active >= &ext_sched_class))
+		return;
+
+	/*
+	 * At this point we know that SCX was preempted by a higher priority
+	 * sched_class, so invoke the ->cpu_release() callback if we have not
+	 * done so already. We only send the callback once between SCX being
+	 * preempted, and it regaining control of the CPU.
+	 *
+	 * ->cpu_release() complements ->cpu_acquire(), which is emitted the
+	 *  next time that balance_scx() is invoked.
+	 */
+	if (!rq->scx.cpu_released) {
+		if (SCX_HAS_OP(cpu_release)) {
+			struct scx_cpu_release_args args = {
+				.reason = preempt_reason_from_class(active),
+				.task = p,
+			};
+
+			SCX_CALL_OP(SCX_KF_CPU_RELEASE,
+				    cpu_release, cpu_of(rq), &args);
+		}
+		rq->scx.cpu_released = true;
+	}
 }
 
 #ifdef CONFIG_SMP
@@ -3398,6 +3527,7 @@ static void scx_ops_disable_workfn(struct kthread_work *work)
 		static_branch_disable_cpuslocked(&scx_has_op[i]);
 	static_branch_disable_cpuslocked(&scx_ops_enq_last);
 	static_branch_disable_cpuslocked(&scx_ops_enq_exiting);
+	static_branch_disable_cpuslocked(&scx_ops_cpu_preempt);
 	static_branch_disable_cpuslocked(&scx_builtin_idle_enabled);
 	synchronize_rcu();
 
@@ -3699,9 +3829,10 @@ static void scx_dump_state(struct scx_exit_info *ei, size_t dump_len)
 		seq_buf_init(&ns, buf, avail);
 
 		dump_newline(&ns);
-		dump_line(&ns, "CPU %-4d: nr_run=%u flags=0x%x ops_qseq=%lu pnt_seq=%lu",
+		dump_line(&ns, "CPU %-4d: nr_run=%u flags=0x%x cpu_rel=%d ops_qseq=%lu pnt_seq=%lu",
 			  cpu, rq->scx.nr_running, rq->scx.flags,
-			  rq->scx.ops_qseq, rq->scx.pnt_seq);
+			  rq->scx.cpu_released, rq->scx.ops_qseq,
+			  rq->scx.pnt_seq);
 		dump_line(&ns, "          curr=%s[%d] class=%ps",
 			  rq->curr->comm, rq->curr->pid,
 			  rq->curr->sched_class);
@@ -3942,6 +4073,8 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)
 
 	if (ops->flags & SCX_OPS_ENQ_EXITING)
 		static_branch_enable_cpuslocked(&scx_ops_enq_exiting);
+	if (scx_ops.cpu_acquire || scx_ops.cpu_release)
+		static_branch_enable_cpuslocked(&scx_ops_cpu_preempt);
 
 	if (!ops->update_idle || (ops->flags & SCX_OPS_KEEP_BUILTIN_IDLE)) {
 		reset_idle_masks();
@@ -4318,6 +4451,8 @@ static bool yield_stub(struct task_struct *from, struct task_struct *to) { retur
 static void set_weight_stub(struct task_struct *p, u32 weight) {}
 static void set_cpumask_stub(struct task_struct *p, const struct cpumask *mask) {}
 static void update_idle_stub(s32 cpu, bool idle) {}
+static void cpu_acquire_stub(s32 cpu, struct scx_cpu_acquire_args *args) {}
+static void cpu_release_stub(s32 cpu, struct scx_cpu_release_args *args) {}
 static s32 init_task_stub(struct task_struct *p, struct scx_init_task_args *args) { return -EINVAL; }
 static void exit_task_stub(struct task_struct *p, struct scx_exit_task_args *args) {}
 static void enable_stub(struct task_struct *p) {}
@@ -4338,6 +4473,8 @@ static struct sched_ext_ops __bpf_ops_sched_ext_ops = {
 	.set_weight = set_weight_stub,
 	.set_cpumask = set_cpumask_stub,
 	.update_idle = update_idle_stub,
+	.cpu_acquire = cpu_acquire_stub,
+	.cpu_release = cpu_release_stub,
 	.init_task = init_task_stub,
 	.exit_task = exit_task_stub,
 	.enable = enable_stub,
@@ -4870,6 +5007,59 @@ static const struct btf_kfunc_id_set scx_kfunc_set_dispatch = {
 
 __bpf_kfunc_start_defs();
 
+/**
+ * scx_bpf_reenqueue_local - Re-enqueue tasks on a local DSQ
+ *
+ * Iterate over all of the tasks currently enqueued on the local DSQ of the
+ * caller's CPU, and re-enqueue them in the BPF scheduler. Returns the number of
+ * processed tasks. Can only be called from ops.cpu_release().
+ */
+__bpf_kfunc u32 scx_bpf_reenqueue_local(void)
+{
+	u32 nr_enqueued, i;
+	struct rq *rq;
+
+	if (!scx_kf_allowed(SCX_KF_CPU_RELEASE))
+		return 0;
+
+	rq = cpu_rq(smp_processor_id());
+	lockdep_assert_rq_held(rq);
+
+	/*
+	 * Get the number of tasks on the local DSQ before iterating over it to
+	 * pull off tasks. The enqueue callback below can signal that it wants
+	 * the task to stay on the local DSQ, and we want to prevent the BPF
+	 * scheduler from causing us to loop indefinitely.
+	 */
+	nr_enqueued = rq->scx.local_dsq.nr;
+	for (i = 0; i < nr_enqueued; i++) {
+		struct task_struct *p;
+
+		p = first_local_task(rq);
+		WARN_ON_ONCE(atomic_long_read(&p->scx.ops_state) !=
+			     SCX_OPSS_NONE);
+		WARN_ON_ONCE(!(p->scx.flags & SCX_TASK_QUEUED));
+		WARN_ON_ONCE(p->scx.holding_cpu != -1);
+		dispatch_dequeue(rq, p);
+		do_enqueue_task(rq, p, SCX_ENQ_REENQ, -1);
+	}
+
+	return nr_enqueued;
+}
+
+__bpf_kfunc_end_defs();
+
+BTF_KFUNCS_START(scx_kfunc_ids_cpu_release)
+BTF_ID_FLAGS(func, scx_bpf_reenqueue_local)
+BTF_KFUNCS_END(scx_kfunc_ids_cpu_release)
+
+static const struct btf_kfunc_id_set scx_kfunc_set_cpu_release = {
+	.owner			= THIS_MODULE,
+	.set			= &scx_kfunc_ids_cpu_release,
+};
+
+__bpf_kfunc_start_defs();
+
 /**
  * scx_bpf_kick_cpu - Trigger reschedule on a CPU
  * @cpu: cpu to kick
@@ -5379,6 +5569,8 @@ static int __init scx_init(void)
 					     &scx_kfunc_set_enqueue_dispatch)) ||
 	    (ret = register_btf_kfunc_id_set(BPF_PROG_TYPE_STRUCT_OPS,
 					     &scx_kfunc_set_dispatch)) ||
+	    (ret = register_btf_kfunc_id_set(BPF_PROG_TYPE_STRUCT_OPS,
+					     &scx_kfunc_set_cpu_release)) ||
 	    (ret = register_btf_kfunc_id_set(BPF_PROG_TYPE_STRUCT_OPS,
 					     &scx_kfunc_set_any)) ||
 	    (ret = register_btf_kfunc_id_set(BPF_PROG_TYPE_TRACING,
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 0aeb1fda1794..4ebd1c2478f1 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -24,6 +24,8 @@ DECLARE_STATIC_KEY_FALSE(__scx_switched_all);
 #define scx_enabled()		static_branch_unlikely(&__scx_ops_enabled)
 #define scx_switched_all()	static_branch_unlikely(&__scx_switched_all)
 
+DECLARE_STATIC_KEY_FALSE(scx_ops_cpu_preempt);
+
 static inline bool task_on_scx(const struct task_struct *p)
 {
 	return scx_enabled() && p->sched_class == &ext_sched_class;
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 734206e13897..147d18cf01ce 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -737,6 +737,7 @@ struct scx_rq {
 	u64			extra_enq_flags;	/* see move_task_to_local_dsq() */
 	u32			nr_running;
 	u32			flags;
+	bool			cpu_released;
 	cpumask_var_t		cpus_to_kick;
 	cpumask_var_t		cpus_to_kick_if_idle;
 	cpumask_var_t		cpus_to_preempt;
diff --git a/tools/sched_ext/include/scx/common.bpf.h b/tools/sched_ext/include/scx/common.bpf.h
index 421118bc56ff..8686f84497db 100644
--- a/tools/sched_ext/include/scx/common.bpf.h
+++ b/tools/sched_ext/include/scx/common.bpf.h
@@ -34,6 +34,7 @@ void scx_bpf_dispatch(struct task_struct *p, u64 dsq_id, u64 slice, u64 enq_flag
 u32 scx_bpf_dispatch_nr_slots(void) __ksym;
 void scx_bpf_dispatch_cancel(void) __ksym;
 bool scx_bpf_consume(u64 dsq_id) __ksym;
+u32 scx_bpf_reenqueue_local(void) __ksym;
 void scx_bpf_kick_cpu(s32 cpu, u64 flags) __ksym;
 s32 scx_bpf_dsq_nr_queued(u64 dsq_id) __ksym;
 void scx_bpf_destroy_dsq(u64 dsq_id) __ksym;
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 879fc9c788e5..4a87377558c8 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -11,6 +11,8 @@
  *
  * - BPF-side queueing using PIDs.
  * - Sleepable per-task storage allocation using ops.prep_enable().
+ * - Using ops.cpu_release() to handle a higher priority scheduling class taking
+ *   the CPU away.
  *
  * This scheduler is primarily for demonstration and testing of sched_ext
  * features and unlikely to be useful for actual workloads.
@@ -90,7 +92,7 @@ struct {
 } cpu_ctx_stor SEC(".maps");
 
 /* Statistics */
-u64 nr_enqueued, nr_dispatched, nr_dequeued;
+u64 nr_enqueued, nr_dispatched, nr_reenqueued, nr_dequeued;
 
 s32 BPF_STRUCT_OPS(qmap_select_cpu, struct task_struct *p,
 		   s32 prev_cpu, u64 wake_flags)
@@ -164,6 +166,22 @@ void BPF_STRUCT_OPS(qmap_enqueue, struct task_struct *p, u64 enq_flags)
 		return;
 	}
 
+	/*
+	 * If the task was re-enqueued due to the CPU being preempted by a
+	 * higher priority scheduling class, just re-enqueue the task directly
+	 * on the global DSQ. As we want another CPU to pick it up, find and
+	 * kick an idle CPU.
+	 */
+	if (enq_flags & SCX_ENQ_REENQ) {
+		s32 cpu;
+
+		scx_bpf_dispatch(p, SHARED_DSQ, 0, enq_flags);
+		cpu = scx_bpf_pick_idle_cpu(p->cpus_ptr, 0);
+		if (cpu >= 0)
+			scx_bpf_kick_cpu(cpu, SCX_KICK_IDLE);
+		return;
+	}
+
 	ring = bpf_map_lookup_elem(&queue_arr, &idx);
 	if (!ring) {
 		scx_bpf_error("failed to find ring %d", idx);
@@ -257,6 +275,22 @@ void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
 	}
 }
 
+void BPF_STRUCT_OPS(qmap_cpu_release, s32 cpu, struct scx_cpu_release_args *args)
+{
+	u32 cnt;
+
+	/*
+	 * Called when @cpu is taken by a higher priority scheduling class. This
+	 * makes @cpu no longer available for executing sched_ext tasks. As we
+	 * don't want the tasks in @cpu's local dsq to sit there until @cpu
+	 * becomes available again, re-enqueue them into the global dsq. See
+	 * %SCX_ENQ_REENQ handling in qmap_enqueue().
+	 */
+	cnt = scx_bpf_reenqueue_local();
+	if (cnt)
+		__sync_fetch_and_add(&nr_reenqueued, cnt);
+}
+
 s32 BPF_STRUCT_OPS(qmap_init_task, struct task_struct *p,
 		   struct scx_init_task_args *args)
 {
@@ -339,6 +373,7 @@ SCX_OPS_DEFINE(qmap_ops,
 	       .enqueue			= (void *)qmap_enqueue,
 	       .dequeue			= (void *)qmap_dequeue,
 	       .dispatch		= (void *)qmap_dispatch,
+	       .cpu_release		= (void *)qmap_cpu_release,
 	       .init_task		= (void *)qmap_init_task,
 	       .dump			= (void *)qmap_dump,
 	       .dump_cpu		= (void *)qmap_dump_cpu,
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index 594147a710a8..2a97421afe9a 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -112,9 +112,9 @@ int main(int argc, char **argv)
 		long nr_enqueued = skel->bss->nr_enqueued;
 		long nr_dispatched = skel->bss->nr_dispatched;
 
-		printf("stats  : enq=%lu dsp=%lu delta=%ld deq=%"PRIu64"\n",
+		printf("stats  : enq=%lu dsp=%lu delta=%ld reenq=%"PRIu64" deq=%"PRIu64"\n",
 		       nr_enqueued, nr_dispatched, nr_enqueued - nr_dispatched,
-		       skel->bss->nr_dequeued);
+		       skel->bss->nr_reenqueued, skel->bss->nr_dequeued);
 		fflush(stdout);
 		sleep(1);
 	}
-- 
2.45.2
```

## Diff

```diff
---
 include/linux/sched/ext.h                |   4 +-
 kernel/sched/ext.c                       | 198 ++++++++++++++++++++++-
 kernel/sched/ext.h                       |   2 +
 kernel/sched/sched.h                     |   1 +
 tools/sched_ext/include/scx/common.bpf.h |   1 +
 tools/sched_ext/scx_qmap.bpf.c           |  37 ++++-
 tools/sched_ext/scx_qmap.c               |   4 +-
 7 files changed, 240 insertions(+), 7 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index 74341dbc6a19..21c627337e01 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -98,13 +98,15 @@ enum scx_kf_mask {
 	SCX_KF_UNLOCKED		= 0,	  /* not sleepable, not rq locked */
 	/* all non-sleepables may be nested inside SLEEPABLE */
 	SCX_KF_SLEEPABLE	= 1 << 0, /* sleepable init operations */
+	/* ENQUEUE and DISPATCH may be nested inside CPU_RELEASE */
+	SCX_KF_CPU_RELEASE	= 1 << 1, /* ops.cpu_release() */
 	/* ops.dequeue (in REST) may be nested inside DISPATCH */
 	SCX_KF_DISPATCH		= 1 << 2, /* ops.dispatch() */
 	SCX_KF_ENQUEUE		= 1 << 3, /* ops.enqueue() and ops.select_cpu() */
 	SCX_KF_SELECT_CPU	= 1 << 4, /* ops.select_cpu() */
 	SCX_KF_REST		= 1 << 5, /* other rq-locked operations */

-	__SCX_KF_RQ_LOCKED	= SCX_KF_DISPATCH |
+	__SCX_KF_RQ_LOCKED	= SCX_KF_CPU_RELEASE | SCX_KF_DISPATCH |
 				  SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU | SCX_KF_REST,
 	__SCX_KF_TERMINAL	= SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU | SCX_KF_REST,
 };
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 1ca3067b4e0a..686dab6ab592 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -110,6 +110,32 @@ struct scx_exit_task_args {
 	bool cancelled;
 };

+enum scx_cpu_preempt_reason {
+	/* next task is being scheduled by &sched_class_rt */
+	SCX_CPU_PREEMPT_RT,
+	/* next task is being scheduled by &sched_class_dl */
+	SCX_CPU_PREEMPT_DL,
+	/* next task is being scheduled by &sched_class_stop */
+	SCX_CPU_PREEMPT_STOP,
+	/* unknown reason for sched_ext being preempted */
+	SCX_CPU_PREEMPT_UNKNOWN,
+};
+
+/*
+ * Argument container for ops->cpu_acquire(). Currently empty, but may be
+ * expanded in the future.
+ */
+struct scx_cpu_acquire_args {};
+
+/* argument container for ops->cpu_release() */
+struct scx_cpu_release_args {
+	/* the reason the CPU was preempted */
+	enum scx_cpu_preempt_reason reason;
+
+	/* the task that's going to be scheduled on the CPU */
+	struct task_struct	*task;
+};
+
 /*
  * Informational context provided to dump operations.
  */
@@ -335,6 +361,28 @@ struct sched_ext_ops {
 	 */
 	void (*update_idle)(s32 cpu, bool idle);

+	/**
+	 * cpu_acquire - A CPU is becoming available to the BPF scheduler
+	 * @cpu: The CPU being acquired by the BPF scheduler.
+	 * @args: Acquire arguments, see the struct definition.
+	 *
+	 * A CPU that was previously released from the BPF scheduler is now once
+	 * again under its control.
+	 */
+	void (*cpu_acquire)(s32 cpu, struct scx_cpu_acquire_args *args);
+
+	/**
+	 * cpu_release - A CPU is taken away from the BPF scheduler
+	 * @cpu: The CPU being released by the BPF scheduler.
+	 * @args: Release arguments, see the struct definition.
+	 *
+	 * The specified CPU is no longer under the control of the BPF
+	 * scheduler. This could be because it was preempted by a higher
+	 * priority sched_class, though there may be other reasons as well. The
+	 * caller should consult @args->reason to determine the cause.
+	 */
+	void (*cpu_release)(s32 cpu, struct scx_cpu_release_args *args);
+
 	/**
 	 * init_task - Initialize a task to run in a BPF scheduler
 	 * @p: task to initialize for BPF scheduling
@@ -487,6 +535,17 @@ enum scx_enq_flags {
 	 */
 	SCX_ENQ_PREEMPT		= 1LLU << 32,

+	/*
+	 * The task being enqueued was previously enqueued on the current CPU's
+	 * %SCX_DSQ_LOCAL, but was removed from it in a call to the
+	 * bpf_scx_reenqueue_local() kfunc. If bpf_scx_reenqueue_local() was
+	 * invoked in a ->cpu_release() callback, and the task is again
+	 * dispatched back to %SCX_LOCAL_DSQ by this current ->enqueue(), the
+	 * task will not be scheduled on the CPU until at least the next invocation
+	 * of the ->cpu_acquire() callback.
+	 */
+	SCX_ENQ_REENQ		= 1LLU << 40,
+
 	/*
 	 * The task being enqueued is the only task available for the cpu. By
 	 * default, ext core keeps executing such tasks but when
@@ -625,6 +684,7 @@ static bool scx_warned_zero_slice;

 static DEFINE_STATIC_KEY_FALSE(scx_ops_enq_last);
 static DEFINE_STATIC_KEY_FALSE(scx_ops_enq_exiting);
+DEFINE_STATIC_KEY_FALSE(scx_ops_cpu_preempt);
 static DEFINE_STATIC_KEY_FALSE(scx_builtin_idle_enabled);

 struct static_key_false scx_has_op[SCX_OPI_END] =
@@ -887,6 +947,12 @@ static __always_inline bool scx_kf_allowed(u32 mask)
 	 * inside ops.dispatch(). We don't need to check the SCX_KF_SLEEPABLE
 	 * boundary thanks to the above in_interrupt() check.
 	 */
+	if (unlikely(highest_bit(mask) == SCX_KF_CPU_RELEASE &&
+		     (current->scx.kf_mask & higher_bits(SCX_KF_CPU_RELEASE)))) {
+		scx_ops_error("cpu_release kfunc called from a nested operation");
+		return false;
+	}
+
 	if (unlikely(highest_bit(mask) == SCX_KF_DISPATCH &&
 		     (current->scx.kf_mask & higher_bits(SCX_KF_DISPATCH)))) {
 		scx_ops_error("dispatch kfunc called from a nested operation");
@@ -2070,6 +2136,19 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 	lockdep_assert_rq_held(rq);
 	rq->scx.flags |= SCX_RQ_BALANCING;

+	if (static_branch_unlikely(&scx_ops_cpu_preempt) &&
+	    unlikely(rq->scx.cpu_released)) {
+		/*
+		 * If the previous sched_class for the current CPU was not sched_ext,
+		 * notify the BPF scheduler that it again has control of the
+		 * core. This callback complements ->cpu_release(), which is
+		 * emitted in scx_next_task_picked().
+		 */
+		if (SCX_HAS_OP(cpu_acquire))
+			SCX_CALL_OP(0, cpu_acquire, cpu_of(rq), NULL);
+		rq->scx.cpu_released = false;
+	}
+
 	if (prev_on_scx) {
 		WARN_ON_ONCE(prev->scx.flags & SCX_TASK_BAL_KEEP);
 		update_curr_scx(rq);
@@ -2077,7 +2156,9 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 		/*
 		 * If @prev is runnable & has slice left, it has priority and
 		 * fetching more just increases latency for the fetched tasks.
-		 * Tell put_prev_task_scx() to put @prev on local_dsq.
+		 * Tell put_prev_task_scx() to put @prev on local_dsq. If the
+		 * BPF scheduler wants to handle this explicitly, it should
+		 * implement ->cpu_released().
 		 *
 		 * See scx_ops_disable_workfn() for the explanation on the
 		 * bypassing test.
@@ -2297,6 +2378,20 @@ static struct task_struct *pick_next_task_scx(struct rq *rq)
 	return p;
 }

+static enum scx_cpu_preempt_reason
+preempt_reason_from_class(const struct sched_class *class)
+{
+#ifdef CONFIG_SMP
+	if (class == &stop_sched_class)
+		return SCX_CPU_PREEMPT_STOP;
+#endif
+	if (class == &dl_sched_class)
+		return SCX_CPU_PREEMPT_DL;
+	if (class == &rt_sched_class)
+		return SCX_CPU_PREEMPT_RT;
+	return SCX_CPU_PREEMPT_UNKNOWN;
+}
+
 void scx_next_task_picked(struct rq *rq, struct task_struct *p,
 			  const struct sched_class *active)
 {
@@ -2312,6 +2407,40 @@ void scx_next_task_picked(struct rq *rq, struct task_struct *p,
 	 */
 	smp_store_release(&rq->scx.pnt_seq, rq->scx.pnt_seq + 1);
 #endif
+	if (!static_branch_unlikely(&scx_ops_cpu_preempt))
+		return;
+
+	/*
+	 * The callback is conceptually meant to convey that the CPU is no
+	 * longer under the control of sched_ext. Therefore, don't invoke the
+	 * callback if the CPU is is staying on sched_ext, or going idle (in which
+	 * case the sched_ext scheduler has actively decided not to schedule any
+	 * tasks on the CPU).
+	 */
+	if (likely(active >= &ext_sched_class))
+		return;
+
+	/*
+	 * At this point we know that sched_ext was preempted by a higher priority
+	 * sched_class, so invoke the ->cpu_release() callback if we have not
+	 * done so already. We only send the callback once between sched_ext being
+	 * preempted, and it regaining control of the CPU.
+	 *
+	 * ->cpu_release() complements ->cpu_acquire(), which is emitted the
+	 *  next time that balance_scx() is invoked.
+	 */
+	if (!rq->scx.cpu_released) {
+		if (SCX_HAS_OP(cpu_release)) {
+			struct scx_cpu_release_args args = {
+				.reason = preempt_reason_from_class(active),
+				.task = p,
+			};
+
+			SCX_CALL_OP(SCX_KF_CPU_RELEASE,
+				    cpu_release, cpu_of(rq), &args);
+		}
+		rq->scx.cpu_released = true;
+	}
 }

 #ifdef CONFIG_SMP
@@ -3398,6 +3527,7 @@ static void scx_ops_disable_workfn(struct kthread_work *work)
 		static_branch_disable_cpuslocked(&scx_has_op[i]);
 	static_branch_disable_cpuslocked(&scx_ops_enq_last);
 	static_branch_disable_cpuslocked(&scx_ops_enq_exiting);
+	static_branch_disable_cpuslocked(&scx_ops_cpu_preempt);
 	static_branch_disable_cpuslocked(&scx_builtin_idle_enabled);
 	synchronize_rcu();

@@ -3699,9 +3829,10 @@ static void scx_dump_state(struct scx_exit_info *ei, size_t dump_len)
 		seq_buf_init(&ns, buf, avail);

 		dump_newline(&ns);
-		dump_line(&ns, "CPU %-4d: nr_run=%u flags=0x%x ops_qseq=%lu pnt_seq=%lu",
+		dump_line(&ns, "CPU %-4d: nr_run=%u flags=0x%x cpu_rel=%d ops_qseq=%lu pnt_seq=%lu",
 			  cpu, rq->scx.nr_running, rq->scx.flags,
-			  rq->scx.ops_qseq, rq->scx.pnt_seq);
+			  rq->scx.cpu_released, rq->scx.ops_qseq,
+			  rq->scx.pnt_seq);
 		dump_line(&ns, "          curr=%s[%d] class=%ps",
 			  rq->curr->comm, rq->curr->pid,
 			  rq->curr->sched_class);
@@ -3942,6 +4073,8 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)

 	if (ops->flags & SCX_OPS_ENQ_EXITING)
 		static_branch_enable_cpuslocked(&scx_ops_enq_exiting);
+	if (scx_ops.cpu_acquire || scx_ops.cpu_release)
+		static_branch_enable_cpuslocked(&scx_ops_cpu_preempt);

 	if (!ops->update_idle || (ops->flags & SCX_OPS_KEEP_BUILTIN_IDLE)) {
 		reset_idle_masks();
@@ -4318,6 +4451,8 @@ static bool yield_stub(struct task_struct *from, struct task_struct *to) { retur
 static void set_weight_stub(struct task_struct *p, u32 weight) {}
 static void set_cpumask_stub(struct task_struct *p, const struct cpumask *mask) {}
 static void update_idle_stub(s32 cpu, bool idle) {}
+static void cpu_acquire_stub(s32 cpu, struct scx_cpu_acquire_args *args) {}
+static void cpu_release_stub(s32 cpu, struct scx_cpu_release_args *args) {}
 static s32 init_task_stub(struct task_struct *p, struct scx_init_task_args *args) { return -EINVAL; }
 static void exit_task_stub(struct task_struct *p, struct scx_exit_task_args *args) {}
 static void enable_stub(struct task_struct *p) {}
@@ -4338,6 +4473,8 @@ static struct sched_ext_ops __bpf_ops_sched_ext_ops = {
 	.set_weight = set_weight_stub,
 	.set_cpumask = set_cpumask_stub,
 	.update_idle = update_idle_stub,
+	.cpu_acquire = cpu_acquire_stub,
+	.cpu_release = cpu_release_stub,
 	.init_task = init_task_stub,
 	.exit_task = exit_task_stub,
 	.enable = enable_stub,
@@ -4870,6 +5007,59 @@ static const struct btf_kfunc_id_set scx_kfunc_set_dispatch = {

 __bpf_kfunc_start_defs();

+/**
+ * scx_bpf_reenqueue_local - Re-enqueue tasks on a local DSQ
+ *
+ * Iterate over all of the tasks currently enqueued on the local DSQ of the
+ * caller's CPU, and re-enqueue them in the BPF scheduler. Returns the number of
+ * processed tasks. Can only be called from ops.cpu_release().
+ */
+__bpf_kfunc u32 scx_bpf_reenqueue_local(void)
+{
+	u32 nr_enqueued, i;
+	struct rq *rq;
+
+	if (!scx_kf_allowed(SCX_KF_CPU_RELEASE))
+		return 0;
+
+	rq = cpu_rq(smp_processor_id());
+	lockdep_assert_rq_held(rq);
+
+	/*
+	 * Get the number of tasks on the local DSQ before iterating over it to
+	 * pull off tasks. The enqueue callback below can signal that it wants
+	 * the task to stay on the local DSQ, and we want to prevent the BPF
+	 * scheduler from causing us to loop indefinitely.
+	 */
+	nr_enqueued = rq->scx.local_dsq.nr;
+	for (i = 0; i < nr_enqueued; i++) {
+		struct task_struct *p;
+
+		p = first_local_task(rq);
+		WARN_ON_ONCE(atomic_long_read(&p->scx.ops_state) !=
+			     SCX_OPSS_NONE);
+		WARN_ON_ONCE(!(p->scx.flags & SCX_TASK_QUEUED));
+		WARN_ON_ONCE(p->scx.holding_cpu != -1);
+		dispatch_dequeue(rq, p);
+		do_enqueue_task(rq, p, SCX_ENQ_REENQ, -1);
+	}
+
+	return nr_enqueued;
+}
+
+__bpf_kfunc_end_defs();
+
+BTF_KFUNCS_START(scx_kfunc_ids_cpu_release)
+BTF_ID_FLAGS(func, scx_bpf_reenqueue_local)
+BTF_KFUNCS_END(scx_kfunc_ids_cpu_release)
+
+static const struct btf_kfunc_id_set scx_kfunc_set_cpu_release = {
+	.owner			= THIS_MODULE,
+	.set			= &scx_kfunc_ids_cpu_release,
+};
+
+__bpf_kfunc_start_defs();
+
 /**
  * scx_bpf_kick_cpu - Trigger reschedule on a CPU
  * @cpu: cpu to kick
@@ -5379,6 +5569,8 @@ static int __init scx_init(void)
 					     &scx_kfunc_set_enqueue_dispatch)) ||
 	    (ret = register_btf_kfunc_id_set(BPF_PROG_TYPE_STRUCT_OPS,
 					     &scx_kfunc_set_dispatch)) ||
+	    (ret = register_btf_kfunc_id_set(BPF_PROG_TYPE_STRUCT_OPS,
+					     &scx_kfunc_set_cpu_release)) ||
 	    (ret = register_btf_kfunc_id_set(BPF_PROG_TYPE_STRUCT_OPS,
 					     &scx_kfunc_set_any)) ||
 	    (ret = register_btf_kfunc_id_set(BPF_PROG_TYPE_TRACING,
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 0aeb1fda1794..4ebd1c2478f1 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -24,6 +24,8 @@ DECLARE_STATIC_KEY_FALSE(__scx_switched_all);
 #define scx_enabled()		static_branch_unlikely(&__scx_ops_enabled)
 #define scx_switched_all()	static_branch_unlikely(&__scx_switched_all)

+DECLARE_STATIC_KEY_FALSE(scx_ops_cpu_preempt);
+
 static inline bool task_on_scx(const struct task_struct *p)
 {
 	return scx_enabled() && p->sched_class == &ext_sched_class;
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 734206e13897..147d18cf01ce 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -737,6 +737,7 @@ struct scx_rq {
 	u64			extra_enq_flags;	/* see move_task_to_local_dsq() */
 	u32			nr_running;
 	u32			flags;
+	bool			cpu_released;
 	cpumask_var_t		cpus_to_kick;
 	cpumask_var_t		cpus_to_kick_if_idle;
 	cpumask_var_t		cpus_to_preempt;
diff --git a/tools/sched_ext/include/scx/common.bpf.h b/tools/sched_ext/include/scx/common.bpf.h
index 421118bc56ff..8686f84497db 100644
--- a/tools/sched_ext/include/scx/common.bpf.h
+++ b/tools/sched_ext/include/scx/common.bpf.h
@@ -34,6 +34,7 @@ void scx_bpf_dispatch(struct task_struct *p, u64 dsq_id, u64 slice, u64 enq_flag
 u32 scx_bpf_dispatch_nr_slots(void) __ksym;
 void scx_bpf_dispatch_cancel(void) __ksym;
 bool scx_bpf_consume(u64 dsq_id) __ksym;
+u32 scx_bpf_reenqueue_local(void) __ksym;
 void scx_bpf_kick_cpu(s32 cpu, u64 flags) __ksym;
 s32 scx_bpf_dsq_nr_queued(u64 dsq_id) __ksym;
 void scx_bpf_destroy_dsq(u64 dsq_id) __ksym;
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 879fc9c788e5..4a87377558c8 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -11,6 +11,8 @@
  *
  * - BPF-side queueing using PIDs.
  * - Sleepable per-task storage allocation using ops.prep_enable().
+ * - Using ops.cpu_release() to handle a higher priority scheduling class taking
+ *   the CPU away.
  *
  * This scheduler is primarily for demonstration and testing of sched_ext
  * features and unlikely to be useful for actual workloads.
@@ -90,7 +92,7 @@ struct {
 } cpu_ctx_stor SEC(".maps");

 /* Statistics */
-u64 nr_enqueued, nr_dispatched, nr_dequeued;
+u64 nr_enqueued, nr_dispatched, nr_reenqueued, nr_dequeued;

 s32 BPF_STRUCT_OPS(qmap_select_cpu, struct task_struct *p,
 		   s32 prev_cpu, u64 wake_flags)
@@ -164,6 +166,22 @@ void BPF_STRUCT_OPS(qmap_enqueue, struct task_struct *p, u64 enq_flags)
 		return;
 	}

+	/*
+	 * If the task was re-enqueued due to the CPU being preempted by a
+	 * higher priority scheduling class, just re-enqueue the task directly
+	 * on the global DSQ. As we want another CPU to pick it up, find and
+	 * kick an idle CPU.
+	 */
+	if (enq_flags & SCX_ENQ_REENQ) {
+		s32 cpu;
+
+		scx_bpf_dispatch(p, SHARED_DSQ, 0, enq_flags);
+		cpu = scx_bpf_pick_idle_cpu(p->cpus_ptr, 0);
+		if (cpu >= 0)
+			scx_bpf_kick_cpu(cpu, SCX_KICK_IDLE);
+		return;
+	}
+
 	ring = bpf_map_lookup_elem(&queue_arr, &idx);
 	if (!ring) {
 		scx_bpf_error("failed to find ring %d", idx);
@@ -257,6 +275,22 @@ void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
 	}
 }

+void BPF_STRUCT_OPS(qmap_cpu_release, s32 cpu, struct scx_cpu_release_args *args)
+{
+	u32 cnt;
+
+	/*
+	 * Called when @cpu is taken by a higher priority scheduling class. This
+	 * makes @cpu no longer available for executing sched_ext tasks. As we
+	 * don't want the tasks in @cpu's local dsq to sit there until @cpu
+	 * becomes available again, re-enqueue them into the global dsq. See
+	 * %SCX_ENQ_REENQ handling in qmap_enqueue().
+	 */
+	cnt = scx_bpf_reenqueue_local();
+	if (cnt)
+		__sync_fetch_and_add(&nr_reenqueued, cnt);
+}
+
 s32 BPF_STRUCT_OPS(qmap_init_task, struct task_struct *p,
 		   struct scx_init_task_args *args)
 {
@@ -339,6 +373,7 @@ SCX_OPS_DEFINE(qmap_ops,
 	       .enqueue			= (void *)qmap_enqueue,
 	       .dequeue			= (void *)qmap_dequeue,
 	       .dispatch		= (void *)qmap_dispatch,
+	       .cpu_release		= (void *)qmap_cpu_release,
 	       .init_task		= (void *)qmap_init_task,
 	       .dump			= (void *)qmap_dump,
 	       .dump_cpu		= (void *)qmap_dump_cpu,
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index 594147a710a8..2a97421afe9a 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -112,9 +112,9 @@ int main(int argc, char **argv)
 		long nr_enqueued = skel->bss->nr_enqueued;
 		long nr_dispatched = skel->bss->nr_dispatched;

-		printf("stats  : enq=%lu dsp=%lu delta=%ld deq=%"PRIu64"\n",
+		printf("stats  : enq=%lu dsp=%lu delta=%ld reenq=%"PRIu64" deq=%"PRIu64"\n",
 		       nr_enqueued, nr_dispatched, nr_enqueued - nr_dispatched,
-		       skel->bss->nr_dequeued);
+		       skel->bss->nr_reenqueued, skel->bss->nr_dequeued);
 		fflush(stdout);
 		sleep(1);
 	}
--
2.45.2


```

## Implementation Analysis

### Overview

This patch (authored by David Vernet) introduces `ops.cpu_acquire()` and `ops.cpu_release()` — a pair of callbacks that let the BPF scheduler track when it gains and loses exclusive use of a CPU. When a higher-priority sched_class (RT, DL, stop) preempts sched_ext on a CPU, `cpu_release()` is called with the reason and the preempting task. When sched_ext regains the CPU, `cpu_acquire()` is called. It also introduces `scx_bpf_reenqueue_local()`, callable only from `cpu_release()`, which ejects all tasks from the local DSQ back into the BPF scheduler so they can be picked up by other CPUs rather than waiting.

### Code Walkthrough

**New argument structures** (`kernel/sched/ext.c`):

```c
enum scx_cpu_preempt_reason {
    SCX_CPU_PREEMPT_RT,
    SCX_CPU_PREEMPT_DL,
    SCX_CPU_PREEMPT_STOP,
    SCX_CPU_PREEMPT_UNKNOWN,
};

struct scx_cpu_acquire_args {};   /* empty, extensible */
struct scx_cpu_release_args {
    enum scx_cpu_preempt_reason reason;
    struct task_struct *task;     /* the preempting task */
};
```

The `scx_cpu_acquire_args` struct is intentionally empty now but reserved for future expansion. The release args tell the BPF scheduler both why it lost the CPU and which task is taking it.

**Ops definitions** added to `struct sched_ext_ops`:
```c
void (*cpu_acquire)(s32 cpu, struct scx_cpu_acquire_args *args);
void (*cpu_release)(s32 cpu, struct scx_cpu_release_args *args);
```

**SCX_KF_CPU_RELEASE** added to `enum scx_kf_mask` (`include/linux/sched/ext.h`):
```c
SCX_KF_CPU_RELEASE = 1 << 1,   /* ops.cpu_release() */
__SCX_KF_RQ_LOCKED = SCX_KF_CPU_RELEASE | SCX_KF_DISPATCH | ...
```
This gives `cpu_release()` its own kfunc permission slot. It is rq-locked and allows ENQUEUE and DISPATCH to be called nested inside it, but not other CPU_RELEASE calls.

**`rq->scx.cpu_released` flag** (`kernel/sched/sched.h`):
```c
bool cpu_released;
```
Per-rq boolean tracking whether sched_ext has already fired `cpu_release()` for this preemption event. This prevents duplicate callbacks between preemption and the next `balance_scx()` call.

**Where `cpu_release()` fires** — `scx_next_task_picked()` in `ext.c`:
```c
if (!rq->scx.cpu_released) {
    if (SCX_HAS_OP(cpu_release)) {
        struct scx_cpu_release_args args = {
            .reason = preempt_reason_from_class(active),
            .task = p,
        };
        SCX_CALL_OP(SCX_KF_CPU_RELEASE, cpu_release, cpu_of(rq), &args);
    }
    rq->scx.cpu_released = true;
}
```
This fires only when `active < &ext_sched_class` (a higher-priority class is taking over), not when sched_ext continues or the CPU goes idle.

**Where `cpu_acquire()` fires** — `balance_scx()`:
```c
if (static_branch_unlikely(&scx_ops_cpu_preempt) &&
    unlikely(rq->scx.cpu_released)) {
    if (SCX_HAS_OP(cpu_acquire))
        SCX_CALL_OP(0, cpu_acquire, cpu_of(rq), NULL);
    rq->scx.cpu_released = false;
}
```

**`scx_bpf_reenqueue_local()`** — the companion kfunc:
```c
__bpf_kfunc u32 scx_bpf_reenqueue_local(void)
{
    nr_enqueued = rq->scx.local_dsq.nr;
    for (i = 0; i < nr_enqueued; i++) {
        p = first_local_task(rq);
        dispatch_dequeue(rq, p);
        do_enqueue_task(rq, p, SCX_ENQ_REENQ, -1);
    }
    return nr_enqueued;
}
```
The snapshot of `nr` before the loop prevents infinite looping if a BPF scheduler re-dispatches tasks back to local DSQ. Tasks re-enqueued this way are tagged with `SCX_ENQ_REENQ` so the BPF scheduler knows they were ejected by a preemption.

**Static key `scx_ops_cpu_preempt`** (`kernel/sched/ext.h`):
```c
DEFINE_STATIC_KEY_FALSE(scx_ops_cpu_preempt);
```
Enabled only when either `cpu_acquire` or `cpu_release` is set. Guards the hot-path preemption check so schedulers that don't implement these ops pay zero overhead.

**scx_qmap example** (`tools/sched_ext/scx_qmap.bpf.c`):
```c
void BPF_STRUCT_OPS(qmap_cpu_release, s32 cpu, struct scx_cpu_release_args *args)
{
    cnt = scx_bpf_reenqueue_local();
    if (cnt)
        __sync_fetch_and_add(&nr_reenqueued, cnt);
}
```
In `qmap_enqueue()`, tasks with `SCX_ENQ_REENQ` are dispatched to the global SHARED_DSQ and an idle CPU is kicked to pick them up immediately.

**Debugging**: `cpu_rel=%d` added to `scx_dump_state()` output so the cpu_released field is visible in crash dumps.

### Key Concepts

- **`ops.cpu_acquire(cpu, args)`**: Called from `balance_scx()` when sched_ext resumes control of a CPU that had been preempted. The args struct is currently empty.
- **`ops.cpu_release(cpu, args)`**: Called from `scx_next_task_picked()` when a higher-priority class takes the CPU. `args->reason` is one of `SCX_CPU_PREEMPT_RT/DL/STOP/UNKNOWN` and `args->task` is the preempting task.
- **`SCX_ENQ_REENQ`** (`1LLU << 40`): Flag on tasks that were ejected from local DSQ via `scx_bpf_reenqueue_local()`. If a scheduler dispatches such a task back to local DSQ, the kernel will not schedule it until the next `cpu_acquire()`.
- **`scx_ops_cpu_preempt` static key**: Zero-overhead guard for the preemption tracking code path. Only active when the BPF scheduler implements either callback.
- **`preempt_reason_from_class()`**: Maps the active `sched_class*` pointer to a `scx_cpu_preempt_reason` enum value by comparing against `&stop_sched_class`, `&dl_sched_class`, and `&rt_sched_class`.

### Locking and Concurrency Notes

- `cpu_release()` is called under rq->lock (it is in `__SCX_KF_RQ_LOCKED`). The kfunc set `scx_kfunc_set_cpu_release` is registered with `BPF_PROG_TYPE_STRUCT_OPS` specifically for this context.
- `cpu_acquire()` is called from `balance_scx()` which also holds rq->lock.
- `scx_bpf_reenqueue_local()` asserts rq is held via `lockdep_assert_rq_held(rq)`. It can only be called from `ops.cpu_release()` — calling it from any other context fails the `scx_kf_allowed(SCX_KF_CPU_RELEASE)` check.
- The `cpu_released` flag is per-rq and protected by rq->lock. Only set to true once per preemption event to prevent duplicate `cpu_release()` calls (e.g., if the preempting class yields and regains control multiple times before sched_ext runs again).
- `SCX_KF_CPU_RELEASE` has a nesting check: attempting to call a CPU_RELEASE kfunc from within a CPU_RELEASE context fails with an error.

### Integration with Kernel Subsystems

The hook point for `cpu_release()` is `scx_next_task_picked()`, which sits in `core.c`'s `pick_next_task()` path immediately after the winning sched_class has been determined. The `active` parameter is the class that won, not the class of the picked task. This is a clean integration point because it is called exactly once per scheduling decision, after all class ordering is resolved.

The `cpu_acquire()` hook fires at the top of `balance_scx()`, which is called when sched_ext is the active class again and begins its balance-and-dispatch cycle. This pairing (release on yield, acquire on balance) ensures the BPF scheduler is never surprised by tasks running on CPUs it thinks it owns.

### What Maintainers Need to Know

- The acquire/release pair is **opt-in**: neither callback is required. The static key means non-implementing schedulers pay zero cost. Enable the key by implementing either `cpu_acquire` or `cpu_release` in your ops.
- **Do not dispatch to a CPU's local DSQ from `cpu_release()`** without also calling `scx_bpf_reenqueue_local()` first — tasks left in the local DSQ will sit until the CPU is re-acquired, which may cause latency spikes.
- The `SCX_ENQ_REENQ` flag in `ops.enqueue()` is your signal that the task arrived via `scx_bpf_reenqueue_local()`. Dispatch it to a global or shared DSQ and kick an idle CPU to avoid it being stranded.
- **`scx_bpf_reenqueue_local()` is restricted to `cpu_release()`**. Attempting to call it from `ops.enqueue()`, `ops.dispatch()`, or elsewhere will fail the kfunc permission check and trigger an ops error.
- The `args` pointer passed to `cpu_acquire()` is currently `NULL` (passed as `NULL` in the `SCX_CALL_OP` invocation). This is intentional: the struct is empty. Future patches may populate it.
- Inspect `cpu_rel=%d` in debug dumps to verify whether `cpu_released` is stuck true, which would indicate `balance_scx()` is not being called after a preemption event.

### Connection to Other Patches

- **Patch 23/30 (cpu_online/offline)**: Those callbacks cover permanent CPU topology changes (hotplug). This patch covers transient CPU ownership changes (higher-priority preemption). Together they give BPF schedulers complete visibility into CPU availability.
- **Patch 27/30 (core-sched)**: Core scheduling can also take a CPU away from a sched_ext task. That path goes through `set_next_task_scx()` with `SCX_DEQ_CORE_SCHED_EXEC`, not through `cpu_release()`.
- **Patch 28/30 (vtime DSQs)**: A latency-sensitive BPF scheduler using vtime ordering may want to use `cpu_release()` to drain local DSQs so vtime-ordered tasks are picked up with minimal delay by other CPUs.

