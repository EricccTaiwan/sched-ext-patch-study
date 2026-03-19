# [PATCH 27/30] sched_ext: Implement core-sched support

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-28-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-28-tj@kernel.org)

## Commit Message

```text
The core-sched support is composed of the following parts:

- task_struct->scx.core_sched_at is added. This is a timestamp which can be
  used to order tasks. Depending on whether the BPF scheduler implements
  custom ordering, it tracks either global FIFO ordering of all tasks or
  local-DSQ ordering within the dispatched tasks on a CPU.

- prio_less() is updated to call scx_prio_less() when comparing SCX tasks.
  scx_prio_less() calls ops.core_sched_before() if available or uses the
  core_sched_at timestamp. For global FIFO ordering, the BPF scheduler
  doesn't need to do anything. Otherwise, it should implement
  ops.core_sched_before() which reflects the ordering.

- When core-sched is enabled, balance_scx() balances all SMT siblings so
  that they all have tasks dispatched if necessary before pick_task_scx() is
  called. pick_task_scx() picks between the current task and the first
  dispatched task on the local DSQ based on availability and the
  core_sched_at timestamps. Note that FIFO ordering is expected among the
  already dispatched tasks whether running or on the local DSQ, so this path
  always compares core_sched_at instead of calling into
  ops.core_sched_before().

qmap_core_sched_before() is added to scx_qmap. It scales the
distances from the heads of the queues to compare the tasks across different
priority queues and seems to behave as expected.

v3: Fixed build error when !CONFIG_SCHED_SMT reported by Andrea Righi.

v2: Sched core added the const qualifiers to prio_less task arguments.
    Explicitly drop them for ops.core_sched_before() task arguments. BPF
    enforces access control through the verifier, so the qualifier isn't
    actually operative and only gets in the way when interacting with
    various helpers.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Reviewed-by: Josh Don <joshdon@google.com>
Cc: Andrea Righi <andrea.righi@canonical.com>
---
 include/linux/sched/ext.h      |   3 +
 kernel/Kconfig.preempt         |   2 +-
 kernel/sched/core.c            |  10 +-
 kernel/sched/ext.c             | 250 +++++++++++++++++++++++++++++++--
 kernel/sched/ext.h             |   5 +
 tools/sched_ext/scx_qmap.bpf.c |  91 +++++++++++-
 tools/sched_ext/scx_qmap.c     |   5 +-
 7 files changed, 346 insertions(+), 20 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index 21c627337e01..3db7b32b2d1d 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -129,6 +129,9 @@ struct sched_ext_entity {
 	struct list_head	runnable_node;	/* rq->scx.runnable_list */
 	unsigned long		runnable_at;
 
+#ifdef CONFIG_SCHED_CORE
+	u64			core_sched_at;	/* see scx_prio_less() */
+#endif
 	u64			ddsp_dsq_id;
 	u64			ddsp_enq_flags;
 
diff --git a/kernel/Kconfig.preempt b/kernel/Kconfig.preempt
index 39ecfc2b5a1c..7dde5e424ac3 100644
--- a/kernel/Kconfig.preempt
+++ b/kernel/Kconfig.preempt
@@ -135,7 +135,7 @@ config SCHED_CORE
 
 config SCHED_CLASS_EXT
 	bool "Extensible Scheduling Class"
-	depends on BPF_SYSCALL && BPF_JIT && !SCHED_CORE
+	depends on BPF_SYSCALL && BPF_JIT
 	help
 	  This option enables a new scheduler class sched_ext (SCX), which
 	  allows scheduling policies to be implemented as BPF programs to
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index c798c847d57e..5eec6639773b 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -169,7 +169,10 @@ static inline int __task_prio(const struct task_struct *p)
 	if (p->sched_class == &idle_sched_class)
 		return MAX_RT_PRIO + NICE_WIDTH; /* 140 */
 
-	return MAX_RT_PRIO + MAX_NICE; /* 120, squash fair */
+	if (task_on_scx(p))
+		return MAX_RT_PRIO + MAX_NICE + 1; /* 120, squash ext */
+
+	return MAX_RT_PRIO + MAX_NICE; /* 119, squash fair */
 }
 
 /*
@@ -198,6 +201,11 @@ static inline bool prio_less(const struct task_struct *a,
 	if (pa == MAX_RT_PRIO + MAX_NICE)	/* fair */
 		return cfs_prio_less(a, b, in_fi);
 
+#ifdef CONFIG_SCHED_CLASS_EXT
+	if (pa == MAX_RT_PRIO + MAX_NICE + 1)	/* ext */
+		return scx_prio_less(a, b, in_fi);
+#endif
+
 	return false;
 }
 
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 26616cd0c5df..1feb690be9d8 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -344,6 +344,24 @@ struct sched_ext_ops {
 	 */
 	bool (*yield)(struct task_struct *from, struct task_struct *to);
 
+	/**
+	 * core_sched_before - Task ordering for core-sched
+	 * @a: task A
+	 * @b: task B
+	 *
+	 * Used by core-sched to determine the ordering between two tasks. See
+	 * Documentation/admin-guide/hw-vuln/core-scheduling.rst for details on
+	 * core-sched.
+	 *
+	 * Both @a and @b are runnable and may or may not currently be queued on
+	 * the BPF scheduler. Should return %true if @a should run before @b.
+	 * %false if there's no required ordering or @b should run before @a.
+	 *
+	 * If not specified, the default is ordering them according to when they
+	 * became runnable.
+	 */
+	bool (*core_sched_before)(struct task_struct *a, struct task_struct *b);
+
 	/**
 	 * set_weight - Set task weight
 	 * @p: task to set weight for
@@ -625,6 +643,14 @@ enum scx_enq_flags {
 enum scx_deq_flags {
 	/* expose select DEQUEUE_* flags as enums */
 	SCX_DEQ_SLEEP		= DEQUEUE_SLEEP,
+
+	/* high 32bits are SCX specific */
+
+	/*
+	 * The generic core-sched layer decided to execute the task even though
+	 * it hasn't been dispatched yet. Dequeue from the BPF side.
+	 */
+	SCX_DEQ_CORE_SCHED_EXEC	= 1LLU << 32,
 };
 
 enum scx_pick_idle_cpu_flags {
@@ -1260,6 +1286,49 @@ static int ops_sanitize_err(const char *ops_name, s32 err)
 	return -EPROTO;
 }
 
+/**
+ * touch_core_sched - Update timestamp used for core-sched task ordering
+ * @rq: rq to read clock from, must be locked
+ * @p: task to update the timestamp for
+ *
+ * Update @p->scx.core_sched_at timestamp. This is used by scx_prio_less() to
+ * implement global or local-DSQ FIFO ordering for core-sched. Should be called
+ * when a task becomes runnable and its turn on the CPU ends (e.g. slice
+ * exhaustion).
+ */
+static void touch_core_sched(struct rq *rq, struct task_struct *p)
+{
+#ifdef CONFIG_SCHED_CORE
+	/*
+	 * It's okay to update the timestamp spuriously. Use
+	 * sched_core_disabled() which is cheaper than enabled().
+	 */
+	if (!sched_core_disabled())
+		p->scx.core_sched_at = rq_clock_task(rq);
+#endif
+}
+
+/**
+ * touch_core_sched_dispatch - Update core-sched timestamp on dispatch
+ * @rq: rq to read clock from, must be locked
+ * @p: task being dispatched
+ *
+ * If the BPF scheduler implements custom core-sched ordering via
+ * ops.core_sched_before(), @p->scx.core_sched_at is used to implement FIFO
+ * ordering within each local DSQ. This function is called from dispatch paths
+ * and updates @p->scx.core_sched_at if custom core-sched ordering is in effect.
+ */
+static void touch_core_sched_dispatch(struct rq *rq, struct task_struct *p)
+{
+	lockdep_assert_rq_held(rq);
+	assert_clock_updated(rq);
+
+#ifdef CONFIG_SCHED_CORE
+	if (SCX_HAS_OP(core_sched_before))
+		touch_core_sched(rq, p);
+#endif
+}
+
 static void update_curr_scx(struct rq *rq)
 {
 	struct task_struct *curr = rq->curr;
@@ -1275,8 +1344,11 @@ static void update_curr_scx(struct rq *rq)
 	account_group_exec_runtime(curr, delta_exec);
 	cgroup_account_cputime(curr, delta_exec);
 
-	if (curr->scx.slice != SCX_SLICE_INF)
+	if (curr->scx.slice != SCX_SLICE_INF) {
 		curr->scx.slice -= min(curr->scx.slice, delta_exec);
+		if (!curr->scx.slice)
+			touch_core_sched(rq, curr);
+	}
 }
 
 static void dsq_mod_nr(struct scx_dispatch_q *dsq, s32 delta)
@@ -1469,6 +1541,8 @@ static void direct_dispatch(struct task_struct *p, u64 enq_flags)
 {
 	struct scx_dispatch_q *dsq;
 
+	touch_core_sched_dispatch(task_rq(p), p);
+
 	enq_flags |= (p->scx.ddsp_enq_flags | SCX_ENQ_CLEAR_OPSS);
 	dsq = find_dsq_for_dispatch(task_rq(p), p->scx.ddsp_dsq_id, p);
 	dispatch_enqueue(dsq, p, enq_flags);
@@ -1550,12 +1624,19 @@ static void do_enqueue_task(struct rq *rq, struct task_struct *p, u64 enq_flags,
 	return;
 
 local:
+	/*
+	 * For task-ordering, slice refill must be treated as implying the end
+	 * of the current slice. Otherwise, the longer @p stays on the CPU, the
+	 * higher priority it becomes from scx_prio_less()'s POV.
+	 */
+	touch_core_sched(rq, p);
 	p->scx.slice = SCX_SLICE_DFL;
 local_norefill:
 	dispatch_enqueue(&rq->scx.local_dsq, p, enq_flags);
 	return;
 
 global:
+	touch_core_sched(rq, p);	/* see the comment in local: */
 	p->scx.slice = SCX_SLICE_DFL;
 	dispatch_enqueue(&scx_dsq_global, p, enq_flags);
 }
@@ -1619,6 +1700,9 @@ static void enqueue_task_scx(struct rq *rq, struct task_struct *p, int enq_flags
 	if (SCX_HAS_OP(runnable))
 		SCX_CALL_OP_TASK(SCX_KF_REST, runnable, p, enq_flags);
 
+	if (enq_flags & SCX_ENQ_WAKEUP)
+		touch_core_sched(rq, p);
+
 	do_enqueue_task(rq, p, enq_flags, sticky_cpu);
 }
 
@@ -2106,6 +2190,7 @@ static void finish_dispatch(struct rq *rq, struct rq_flags *rf,
 	struct scx_dispatch_q *dsq;
 	unsigned long opss;
 
+	touch_core_sched_dispatch(rq, p);
 retry:
 	/*
 	 * No need for _acquire here. @p is accessed only after a successful
@@ -2183,8 +2268,8 @@ static void flush_dispatch_buf(struct rq *rq, struct rq_flags *rf)
 	dspc->cursor = 0;
 }
 
-static int balance_scx(struct rq *rq, struct task_struct *prev,
-		       struct rq_flags *rf)
+static int balance_one(struct rq *rq, struct task_struct *prev,
+		       struct rq_flags *rf, bool local)
 {
 	struct scx_dsp_ctx *dspc = this_cpu_ptr(scx_dsp_ctx);
 	bool prev_on_scx = prev->sched_class == &ext_sched_class;
@@ -2208,7 +2293,7 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 	}
 
 	if (prev_on_scx) {
-		WARN_ON_ONCE(prev->scx.flags & SCX_TASK_BAL_KEEP);
+		WARN_ON_ONCE(local && (prev->scx.flags & SCX_TASK_BAL_KEEP));
 		update_curr_scx(rq);
 
 		/*
@@ -2220,10 +2305,16 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 		 *
 		 * See scx_ops_disable_workfn() for the explanation on the
 		 * bypassing test.
+		 *
+		 * When balancing a remote CPU for core-sched, there won't be a
+		 * following put_prev_task_scx() call and we don't own
+		 * %SCX_TASK_BAL_KEEP. Instead, pick_task_scx() will test the
+		 * same conditions later and pick @rq->curr accordingly.
 		 */
 		if ((prev->scx.flags & SCX_TASK_QUEUED) &&
 		    prev->scx.slice && !scx_ops_bypassing()) {
-			prev->scx.flags |= SCX_TASK_BAL_KEEP;
+			if (local)
+				prev->scx.flags |= SCX_TASK_BAL_KEEP;
 			goto has_tasks;
 		}
 	}
@@ -2285,10 +2376,56 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 	return has_tasks;
 }
 
+static int balance_scx(struct rq *rq, struct task_struct *prev,
+		       struct rq_flags *rf)
+{
+	int ret;
+
+	ret = balance_one(rq, prev, rf, true);
+
+#ifdef CONFIG_SCHED_SMT
+	/*
+	 * When core-sched is enabled, this ops.balance() call will be followed
+	 * by put_prev_scx() and pick_task_scx() on this CPU and pick_task_scx()
+	 * on the SMT siblings. Balance the siblings too.
+	 */
+	if (sched_core_enabled(rq)) {
+		const struct cpumask *smt_mask = cpu_smt_mask(cpu_of(rq));
+		int scpu;
+
+		for_each_cpu_andnot(scpu, smt_mask, cpumask_of(cpu_of(rq))) {
+			struct rq *srq = cpu_rq(scpu);
+			struct rq_flags srf;
+			struct task_struct *sprev = srq->curr;
+
+			/*
+			 * While core-scheduling, rq lock is shared among
+			 * siblings but the debug annotations and rq clock
+			 * aren't. Do pinning dance to transfer the ownership.
+			 */
+			WARN_ON_ONCE(__rq_lockp(rq) != __rq_lockp(srq));
+			rq_unpin_lock(rq, rf);
+			rq_pin_lock(srq, &srf);
+
+			update_rq_clock(srq);
+			balance_one(srq, sprev, &srf, false);
+
+			rq_unpin_lock(srq, &srf);
+			rq_repin_lock(rq, rf);
+		}
+	}
+#endif
+	return ret;
+}
+
 static void set_next_task_scx(struct rq *rq, struct task_struct *p, bool first)
 {
 	if (p->scx.flags & SCX_TASK_QUEUED) {
-		WARN_ON_ONCE(atomic_long_read(&p->scx.ops_state) != SCX_OPSS_NONE);
+		/*
+		 * Core-sched might decide to execute @p before it is
+		 * dispatched. Call ops_dequeue() to notify the BPF scheduler.
+		 */
+		ops_dequeue(p, SCX_DEQ_CORE_SCHED_EXEC);
 		dispatch_dequeue(rq, p);
 	}
 
@@ -2379,7 +2516,8 @@ static void put_prev_task_scx(struct rq *rq, struct task_struct *p)
 		/*
 		 * If @p has slice left and balance_scx() didn't tag it for
 		 * keeping, @p is getting preempted by a higher priority
-		 * scheduler class. Leave it at the head of the local DSQ.
+		 * scheduler class or core-sched forcing a different task. Leave
+		 * it at the head of the local DSQ.
 		 */
 		if (p->scx.slice && !scx_ops_bypassing()) {
 			dispatch_enqueue(&rq->scx.local_dsq, p, SCX_ENQ_HEAD);
@@ -2436,6 +2574,84 @@ static struct task_struct *pick_next_task_scx(struct rq *rq)
 	return p;
 }
 
+#ifdef CONFIG_SCHED_CORE
+/**
+ * scx_prio_less - Task ordering for core-sched
+ * @a: task A
+ * @b: task B
+ *
+ * Core-sched is implemented as an additional scheduling layer on top of the
+ * usual sched_class'es and needs to find out the expected task ordering. For
+ * SCX, core-sched calls this function to interrogate the task ordering.
+ *
+ * Unless overridden by ops.core_sched_before(), @p->scx.core_sched_at is used
+ * to implement the default task ordering. The older the timestamp, the higher
+ * prority the task - the global FIFO ordering matching the default scheduling
+ * behavior.
+ *
+ * When ops.core_sched_before() is enabled, @p->scx.core_sched_at is used to
+ * implement FIFO ordering within each local DSQ. See pick_task_scx().
+ */
+bool scx_prio_less(const struct task_struct *a, const struct task_struct *b,
+		   bool in_fi)
+{
+	/*
+	 * The const qualifiers are dropped from task_struct pointers when
+	 * calling ops.core_sched_before(). Accesses are controlled by the
+	 * verifier.
+	 */
+	if (SCX_HAS_OP(core_sched_before) && !scx_ops_bypassing())
+		return SCX_CALL_OP_2TASKS_RET(SCX_KF_REST, core_sched_before,
+					      (struct task_struct *)a,
+					      (struct task_struct *)b);
+	else
+		return time_after64(a->scx.core_sched_at, b->scx.core_sched_at);
+}
+
+/**
+ * pick_task_scx - Pick a candidate task for core-sched
+ * @rq: rq to pick the candidate task from
+ *
+ * Core-sched calls this function on each SMT sibling to determine the next
+ * tasks to run on the SMT siblings. balance_one() has been called on all
+ * siblings and put_prev_task_scx() has been called only for the current CPU.
+ *
+ * As put_prev_task_scx() hasn't been called on remote CPUs, we can't just look
+ * at the first task in the local dsq. @rq->curr has to be considered explicitly
+ * to mimic %SCX_TASK_BAL_KEEP.
+ */
+static struct task_struct *pick_task_scx(struct rq *rq)
+{
+	struct task_struct *curr = rq->curr;
+	struct task_struct *first = first_local_task(rq);
+
+	if (curr->scx.flags & SCX_TASK_QUEUED) {
+		/* is curr the only runnable task? */
+		if (!first)
+			return curr;
+
+		/*
+		 * Does curr trump first? We can always go by core_sched_at for
+		 * this comparison as it represents global FIFO ordering when
+		 * the default core-sched ordering is used and local-DSQ FIFO
+		 * ordering otherwise.
+		 *
+		 * We can have a task with an earlier timestamp on the DSQ. For
+		 * example, when a current task is preempted by a sibling
+		 * picking a different cookie, the task would be requeued at the
+		 * head of the local DSQ with an earlier timestamp than the
+		 * core-sched picked next task. Besides, the BPF scheduler may
+		 * dispatch any tasks to the local DSQ anytime.
+		 */
+		if (curr->scx.slice && time_before64(curr->scx.core_sched_at,
+						     first->scx.core_sched_at))
+			return curr;
+	}
+
+	return first;	/* this may be %NULL */
+}
+#endif	/* CONFIG_SCHED_CORE */
+
 static enum scx_cpu_preempt_reason
 preempt_reason_from_class(const struct sched_class *class)
 {
@@ -2843,13 +3059,15 @@ static void task_tick_scx(struct rq *rq, struct task_struct *curr, int queued)
 	update_curr_scx(rq);
 
 	/*
-	 * While bypassing, always resched as we can't trust the slice
-	 * management.
+	 * While disabling, always resched and refresh core-sched timestamp as
+	 * we can't trust the slice management or ops.core_sched_before().
 	 */
-	if (scx_ops_bypassing())
+	if (scx_ops_bypassing()) {
 		curr->scx.slice = 0;
-	else if (SCX_HAS_OP(tick))
+		touch_core_sched(rq, curr);
+	} else if (SCX_HAS_OP(tick)) {
 		SCX_CALL_OP(SCX_KF_REST, tick, curr);
+	}
 
 	if (!curr->scx.slice)
 		resched_curr(rq);
@@ -3203,6 +3421,10 @@ DEFINE_SCHED_CLASS(ext) = {
 	.rq_offline		= rq_offline_scx,
 #endif
 
+#ifdef CONFIG_SCHED_CORE
+	.pick_task		= pick_task_scx,
+#endif
+
 	.task_tick		= task_tick_scx,
 
 	.switching_to		= switching_to_scx,
@@ -3416,12 +3638,14 @@ bool task_should_scx(struct task_struct *p)
  *
  * c. balance_scx() never sets %SCX_TASK_BAL_KEEP as the slice value can't be
  *    trusted. Whenever a tick triggers, the running task is rotated to the tail
- *    of the queue.
+ *    of the queue with core_sched_at touched.
  *
  * d. pick_next_task() suppresses zero slice warning.
  *
  * e. scx_bpf_kick_cpu() is disabled to avoid irq_work malfunction during PM
  *    operations.
+ *
+ * f. scx_prio_less() reverts to the default core_sched_at order.
  */
 static void scx_ops_bypass(bool bypass)
 {
@@ -4583,6 +4807,7 @@ static void running_stub(struct task_struct *p) {}
 static void stopping_stub(struct task_struct *p, bool runnable) {}
 static void quiescent_stub(struct task_struct *p, u64 deq_flags) {}
 static bool yield_stub(struct task_struct *from, struct task_struct *to) { return false; }
+static bool core_sched_before_stub(struct task_struct *a, struct task_struct *b) { return false; }
 static void set_weight_stub(struct task_struct *p, u32 weight) {}
 static void set_cpumask_stub(struct task_struct *p, const struct cpumask *mask) {}
 static void update_idle_stub(s32 cpu, bool idle) {}
@@ -4607,6 +4832,7 @@ static struct sched_ext_ops __bpf_ops_sched_ext_ops = {
 	.stopping = stopping_stub,
 	.quiescent = quiescent_stub,
 	.yield = yield_stub,
+	.core_sched_before = core_sched_before_stub,
 	.set_weight = set_weight_stub,
 	.set_cpumask = set_cpumask_stub,
 	.update_idle = update_idle_stub,
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 037f9acdf443..6555878c5da3 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -70,6 +70,11 @@ static inline const struct sched_class *next_active_class(const struct sched_cla
 	for_active_class_range(class, (prev_class) > &ext_sched_class ?		\
 			       &ext_sched_class : (prev_class), (end_class))
 
+#ifdef CONFIG_SCHED_CORE
+bool scx_prio_less(const struct task_struct *a, const struct task_struct *b,
+		   bool in_fi);
+#endif
+
 #else	/* CONFIG_SCHED_CLASS_EXT */
 
 #define scx_enabled()		false
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 619078355bf5..c75c70d6a8eb 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -13,6 +13,7 @@
  * - Sleepable per-task storage allocation using ops.prep_enable().
  * - Using ops.cpu_release() to handle a higher priority scheduling class taking
  *   the CPU away.
+ * - Core-sched support.
  *
  * This scheduler is primarily for demonstration and testing of sched_ext
  * features and unlikely to be useful for actual workloads.
@@ -67,9 +68,21 @@ struct {
 	},
 };
 
+/*
+ * Per-queue sequence numbers to implement core-sched ordering.
+ *
+ * Tail seq is assigned to each queued task and incremented. Head seq tracks the
+ * sequence number of the latest dispatched task. The distance between the a
+ * task's seq and the associated queue's head seq is called the queue distance
+ * and used when comparing two tasks for ordering. See qmap_core_sched_before().
+ */
+static u64 core_sched_head_seqs[5];
+static u64 core_sched_tail_seqs[5];
+
 /* Per-task scheduling context */
 struct task_ctx {
 	bool	force_local;	/* Dispatch directly to local_dsq */
+	u64	core_sched_seq;
 };
 
 struct {
@@ -93,6 +106,7 @@ struct {
 
 /* Statistics */
 u64 nr_enqueued, nr_dispatched, nr_reenqueued, nr_dequeued;
+u64 nr_core_sched_execed;
 
 s32 BPF_STRUCT_OPS(qmap_select_cpu, struct task_struct *p,
 		   s32 prev_cpu, u64 wake_flags)
@@ -159,8 +173,18 @@ void BPF_STRUCT_OPS(qmap_enqueue, struct task_struct *p, u64 enq_flags)
 		return;
 	}
 
-	/* Is select_cpu() is telling us to enqueue locally? */
-	if (tctx->force_local) {
+	/*
+	 * All enqueued tasks must have their core_sched_seq updated for correct
+	 * core-sched ordering, which is why %SCX_OPS_ENQ_LAST is specified in
+	 * qmap_ops.flags.
+	 */
+	tctx->core_sched_seq = core_sched_tail_seqs[idx]++;
+
+	/*
+	 * If qmap_select_cpu() is telling us to or this is the last runnable
+	 * task on the CPU, enqueue locally.
+	 */
+	if (tctx->force_local || (enq_flags & SCX_ENQ_LAST)) {
 		tctx->force_local = false;
 		scx_bpf_dispatch(p, SCX_DSQ_LOCAL, slice_ns, enq_flags);
 		return;
@@ -204,6 +228,19 @@ void BPF_STRUCT_OPS(qmap_enqueue, struct task_struct *p, u64 enq_flags)
 void BPF_STRUCT_OPS(qmap_dequeue, struct task_struct *p, u64 deq_flags)
 {
 	__sync_fetch_and_add(&nr_dequeued, 1);
+	if (deq_flags & SCX_DEQ_CORE_SCHED_EXEC)
+		__sync_fetch_and_add(&nr_core_sched_execed, 1);
+}
+
+static void update_core_sched_head_seq(struct task_struct *p)
+{
+	struct task_ctx *tctx = bpf_task_storage_get(&task_ctx_stor, p, 0, 0);
+	int idx = weight_to_idx(p->scx.weight);
+
+	if (tctx)
+		core_sched_head_seqs[idx] = tctx->core_sched_seq;
+	else
+		scx_bpf_error("task_ctx lookup failed");
 }
 
 void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
@@ -258,6 +295,7 @@ void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
 			if (!p)
 				continue;
 
+			update_core_sched_head_seq(p);
 			__sync_fetch_and_add(&nr_dispatched, 1);
 			scx_bpf_dispatch(p, SHARED_DSQ, slice_ns, 0);
 			bpf_task_release(p);
@@ -275,6 +313,49 @@ void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
 	}
 }
 
+/*
+ * The distance from the head of the queue scaled by the weight of the queue.
+ * The lower the number, the older the task and the higher the priority.
+ */
+static s64 task_qdist(struct task_struct *p)
+{
+	int idx = weight_to_idx(p->scx.weight);
+	struct task_ctx *tctx;
+	s64 qdist;
+
+	tctx = bpf_task_storage_get(&task_ctx_stor, p, 0, 0);
+	if (!tctx) {
+		scx_bpf_error("task_ctx lookup failed");
+		return 0;
+	}
+
+	qdist = tctx->core_sched_seq - core_sched_head_seqs[idx];
+
+	/*
+	 * As queue index increments, the priority doubles. The queue w/ index 3
+	 * is dispatched twice more frequently than 2. Reflect the difference by
+	 * scaling qdists accordingly. Note that the shift amount needs to be
+	 * flipped depending on the sign to avoid flipping priority direction.
+	 */
+	if (qdist >= 0)
+		return qdist << (4 - idx);
+	else
+		return qdist << idx;
+}
+
+/*
+ * This is called to determine the task ordering when core-sched is picking
+ * tasks to execute on SMT siblings and should encode about the same ordering as
+ * the regular scheduling path. Use the priority-scaled distances from the head
+ * of the queues to compare the two tasks which should be consistent with the
+ * dispatch path behavior.
+ */
+bool BPF_STRUCT_OPS(qmap_core_sched_before,
+		    struct task_struct *a, struct task_struct *b)
+{
+	return task_qdist(a) > task_qdist(b);
+}
+
 void BPF_STRUCT_OPS(qmap_cpu_release, s32 cpu, struct scx_cpu_release_args *args)
 {
 	u32 cnt;
@@ -354,8 +435,8 @@ void BPF_STRUCT_OPS(qmap_dump_task, struct scx_dump_ctx *dctx, struct task_struc
 	if (!(taskc = bpf_task_storage_get(&task_ctx_stor, p, 0, 0)))
 		return;
 
-	scx_bpf_dump("QMAP: force_local=%d",
-		     taskc->force_local);
+	scx_bpf_dump("QMAP: force_local=%d core_sched_seq=%llu",
+		     taskc->force_local, taskc->core_sched_seq);
 }
 
 /*
@@ -428,6 +509,7 @@ SCX_OPS_DEFINE(qmap_ops,
 	       .enqueue			= (void *)qmap_enqueue,
 	       .dequeue			= (void *)qmap_dequeue,
 	       .dispatch		= (void *)qmap_dispatch,
+	       .core_sched_before	= (void *)qmap_core_sched_before,
 	       .cpu_release		= (void *)qmap_cpu_release,
 	       .init_task		= (void *)qmap_init_task,
 	       .dump			= (void *)qmap_dump,
@@ -437,5 +519,6 @@ SCX_OPS_DEFINE(qmap_ops,
 	       .cpu_offline		= (void *)qmap_cpu_offline,
 	       .init			= (void *)qmap_init,
 	       .exit			= (void *)qmap_exit,
+	       .flags			= SCX_OPS_ENQ_LAST,
 	       .timeout_ms		= 5000U,
 	       .name			= "qmap");
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index 920fb54f9c77..bc36ec4f88a7 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -112,9 +112,10 @@ int main(int argc, char **argv)
 		long nr_enqueued = skel->bss->nr_enqueued;
 		long nr_dispatched = skel->bss->nr_dispatched;
 
-		printf("stats  : enq=%lu dsp=%lu delta=%ld reenq=%"PRIu64" deq=%"PRIu64"\n",
+		printf("stats  : enq=%lu dsp=%lu delta=%ld reenq=%"PRIu64" deq=%"PRIu64" core=%"PRIu64"\n",
 		       nr_enqueued, nr_dispatched, nr_enqueued - nr_dispatched,
-		       skel->bss->nr_reenqueued, skel->bss->nr_dequeued);
+		       skel->bss->nr_reenqueued, skel->bss->nr_dequeued,
+		       skel->bss->nr_core_sched_execed);
 		fflush(stdout);
 		sleep(1);
 	}
-- 
2.45.2
```

## Diff

```diff
---
 include/linux/sched/ext.h      |   3 +
 kernel/Kconfig.preempt         |   2 +-
 kernel/sched/core.c            |  10 +-
 kernel/sched/ext.c             | 250 +++++++++++++++++++++++++++++++--
 kernel/sched/ext.h             |   5 +
 tools/sched_ext/scx_qmap.bpf.c |  91 +++++++++++-
 tools/sched_ext/scx_qmap.c     |   5 +-
 7 files changed, 346 insertions(+), 20 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index 21c627337e01..3db7b32b2d1d 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -129,6 +129,9 @@ struct sched_ext_entity {
 	struct list_head	runnable_node;	/* rq->scx.runnable_list */
 	unsigned long		runnable_at;

+#ifdef CONFIG_SCHED_CORE
+	u64			core_sched_at;	/* see scx_prio_less() */
+#endif
 	u64			ddsp_dsq_id;
 	u64			ddsp_enq_flags;

diff --git a/kernel/Kconfig.preempt b/kernel/Kconfig.preempt
index 39ecfc2b5a1c..7dde5e424ac3 100644
--- a/kernel/Kconfig.preempt
+++ b/kernel/Kconfig.preempt
@@ -135,7 +135,7 @@ config SCHED_CORE

 config SCHED_CLASS_EXT
 	bool "Extensible Scheduling Class"
-	depends on BPF_SYSCALL && BPF_JIT && !SCHED_CORE
+	depends on BPF_SYSCALL && BPF_JIT
 	help
 	  This option enables a new scheduler class sched_ext (sched_ext), which
 	  allows scheduling policies to be implemented as BPF programs to
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index c798c847d57e..5eec6639773b 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -169,7 +169,10 @@ static inline int __task_prio(const struct task_struct *p)
 	if (p->sched_class == &idle_sched_class)
 		return MAX_RT_PRIO + NICE_WIDTH; /* 140 */

-	return MAX_RT_PRIO + MAX_NICE; /* 120, squash fair */
+	if (task_on_scx(p))
+		return MAX_RT_PRIO + MAX_NICE + 1; /* 120, squash ext */
+
+	return MAX_RT_PRIO + MAX_NICE; /* 119, squash fair */
 }

 /*
@@ -198,6 +201,11 @@ static inline bool prio_less(const struct task_struct *a,
 	if (pa == MAX_RT_PRIO + MAX_NICE)	/* fair */
 		return cfs_prio_less(a, b, in_fi);

+#ifdef CONFIG_SCHED_CLASS_EXT
+	if (pa == MAX_RT_PRIO + MAX_NICE + 1)	/* ext */
+		return scx_prio_less(a, b, in_fi);
+#endif
+
 	return false;
 }

diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 26616cd0c5df..1feb690be9d8 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -344,6 +344,24 @@ struct sched_ext_ops {
 	 */
 	bool (*yield)(struct task_struct *from, struct task_struct *to);

+	/**
+	 * core_sched_before - Task ordering for core-sched
+	 * @a: task A
+	 * @b: task B
+	 *
+	 * Used by core-sched to determine the ordering between two tasks. See
+	 * Documentation/admin-guide/hw-vuln/core-scheduling.rst for details on
+	 * core-sched.
+	 *
+	 * Both @a and @b are runnable and may or may not currently be queued on
+	 * the BPF scheduler. Should return %true if @a should run before @b.
+	 * %false if there's no required ordering or @b should run before @a.
+	 *
+	 * If not specified, the default is ordering them according to when they
+	 * became runnable.
+	 */
+	bool (*core_sched_before)(struct task_struct *a, struct task_struct *b);
+
 	/**
 	 * set_weight - Set task weight
 	 * @p: task to set weight for
@@ -625,6 +643,14 @@ enum scx_enq_flags {
 enum scx_deq_flags {
 	/* expose select DEQUEUE_* flags as enums */
 	SCX_DEQ_SLEEP		= DEQUEUE_SLEEP,
+
+	/* high 32bits are sched_ext specific */
+
+	/*
+	 * The generic core-sched layer decided to execute the task even though
+	 * it hasn't been dispatched yet. Dequeue from the BPF side.
+	 */
+	SCX_DEQ_CORE_SCHED_EXEC	= 1LLU << 32,
 };

 enum scx_pick_idle_cpu_flags {
@@ -1260,6 +1286,49 @@ static int ops_sanitize_err(const char *ops_name, s32 err)
 	return -EPROTO;
 }

+/**
+ * touch_core_sched - Update timestamp used for core-sched task ordering
+ * @rq: rq to read clock from, must be locked
+ * @p: task to update the timestamp for
+ *
+ * Update @p->scx.core_sched_at timestamp. This is used by scx_prio_less() to
+ * implement global or local-DSQ FIFO ordering for core-sched. Should be called
+ * when a task becomes runnable and its turn on the CPU ends (e.g. slice
+ * exhaustion).
+ */
+static void touch_core_sched(struct rq *rq, struct task_struct *p)
+{
+#ifdef CONFIG_SCHED_CORE
+	/*
+	 * It's okay to update the timestamp spuriously. Use
+	 * sched_core_disabled() which is cheaper than enabled().
+	 */
+	if (!sched_core_disabled())
+		p->scx.core_sched_at = rq_clock_task(rq);
+#endif
+}
+
+/**
+ * touch_core_sched_dispatch - Update core-sched timestamp on dispatch
+ * @rq: rq to read clock from, must be locked
+ * @p: task being dispatched
+ *
+ * If the BPF scheduler implements custom core-sched ordering via
+ * ops.core_sched_before(), @p->scx.core_sched_at is used to implement FIFO
+ * ordering within each local DSQ. This function is called from dispatch paths
+ * and updates @p->scx.core_sched_at if custom core-sched ordering is in effect.
+ */
+static void touch_core_sched_dispatch(struct rq *rq, struct task_struct *p)
+{
+	lockdep_assert_rq_held(rq);
+	assert_clock_updated(rq);
+
+#ifdef CONFIG_SCHED_CORE
+	if (SCX_HAS_OP(core_sched_before))
+		touch_core_sched(rq, p);
+#endif
+}
+
 static void update_curr_scx(struct rq *rq)
 {
 	struct task_struct *curr = rq->curr;
@@ -1275,8 +1344,11 @@ static void update_curr_scx(struct rq *rq)
 	account_group_exec_runtime(curr, delta_exec);
 	cgroup_account_cputime(curr, delta_exec);

-	if (curr->scx.slice != SCX_SLICE_INF)
+	if (curr->scx.slice != SCX_SLICE_INF) {
 		curr->scx.slice -= min(curr->scx.slice, delta_exec);
+		if (!curr->scx.slice)
+			touch_core_sched(rq, curr);
+	}
 }

 static void dsq_mod_nr(struct scx_dispatch_q *dsq, s32 delta)
@@ -1469,6 +1541,8 @@ static void direct_dispatch(struct task_struct *p, u64 enq_flags)
 {
 	struct scx_dispatch_q *dsq;

+	touch_core_sched_dispatch(task_rq(p), p);
+
 	enq_flags |= (p->scx.ddsp_enq_flags | SCX_ENQ_CLEAR_OPSS);
 	dsq = find_dsq_for_dispatch(task_rq(p), p->scx.ddsp_dsq_id, p);
 	dispatch_enqueue(dsq, p, enq_flags);
@@ -1550,12 +1624,19 @@ static void do_enqueue_task(struct rq *rq, struct task_struct *p, u64 enq_flags,
 	return;

 local:
+	/*
+	 * For task-ordering, slice refill must be treated as implying the end
+	 * of the current slice. Otherwise, the longer @p stays on the CPU, the
+	 * higher priority it becomes from scx_prio_less()'s POV.
+	 */
+	touch_core_sched(rq, p);
 	p->scx.slice = SCX_SLICE_DFL;
 local_norefill:
 	dispatch_enqueue(&rq->scx.local_dsq, p, enq_flags);
 	return;

 global:
+	touch_core_sched(rq, p);	/* see the comment in local: */
 	p->scx.slice = SCX_SLICE_DFL;
 	dispatch_enqueue(&scx_dsq_global, p, enq_flags);
 }
@@ -1619,6 +1700,9 @@ static void enqueue_task_scx(struct rq *rq, struct task_struct *p, int enq_flags
 	if (SCX_HAS_OP(runnable))
 		SCX_CALL_OP_TASK(SCX_KF_REST, runnable, p, enq_flags);

+	if (enq_flags & SCX_ENQ_WAKEUP)
+		touch_core_sched(rq, p);
+
 	do_enqueue_task(rq, p, enq_flags, sticky_cpu);
 }

@@ -2106,6 +2190,7 @@ static void finish_dispatch(struct rq *rq, struct rq_flags *rf,
 	struct scx_dispatch_q *dsq;
 	unsigned long opss;

+	touch_core_sched_dispatch(rq, p);
 retry:
 	/*
 	 * No need for _acquire here. @p is accessed only after a successful
@@ -2183,8 +2268,8 @@ static void flush_dispatch_buf(struct rq *rq, struct rq_flags *rf)
 	dspc->cursor = 0;
 }

-static int balance_scx(struct rq *rq, struct task_struct *prev,
-		       struct rq_flags *rf)
+static int balance_one(struct rq *rq, struct task_struct *prev,
+		       struct rq_flags *rf, bool local)
 {
 	struct scx_dsp_ctx *dspc = this_cpu_ptr(scx_dsp_ctx);
 	bool prev_on_scx = prev->sched_class == &ext_sched_class;
@@ -2208,7 +2293,7 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 	}

 	if (prev_on_scx) {
-		WARN_ON_ONCE(prev->scx.flags & SCX_TASK_BAL_KEEP);
+		WARN_ON_ONCE(local && (prev->scx.flags & SCX_TASK_BAL_KEEP));
 		update_curr_scx(rq);

 		/*
@@ -2220,10 +2305,16 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 		 *
 		 * See scx_ops_disable_workfn() for the explanation on the
 		 * bypassing test.
+		 *
+		 * When balancing a remote CPU for core-sched, there won't be a
+		 * following put_prev_task_scx() call and we don't own
+		 * %SCX_TASK_BAL_KEEP. Instead, pick_task_scx() will test the
+		 * same conditions later and pick @rq->curr accordingly.
 		 */
 		if ((prev->scx.flags & SCX_TASK_QUEUED) &&
 		    prev->scx.slice && !scx_ops_bypassing()) {
-			prev->scx.flags |= SCX_TASK_BAL_KEEP;
+			if (local)
+				prev->scx.flags |= SCX_TASK_BAL_KEEP;
 			goto has_tasks;
 		}
 	}
@@ -2285,10 +2376,56 @@ static int balance_scx(struct rq *rq, struct task_struct *prev,
 	return has_tasks;
 }

+static int balance_scx(struct rq *rq, struct task_struct *prev,
+		       struct rq_flags *rf)
+{
+	int ret;
+
+	ret = balance_one(rq, prev, rf, true);
+
+#ifdef CONFIG_SCHED_SMT
+	/*
+	 * When core-sched is enabled, this ops.balance() call will be followed
+	 * by put_prev_scx() and pick_task_scx() on this CPU and pick_task_scx()
+	 * on the SMT siblings. Balance the siblings too.
+	 */
+	if (sched_core_enabled(rq)) {
+		const struct cpumask *smt_mask = cpu_smt_mask(cpu_of(rq));
+		int scpu;
+
+		for_each_cpu_andnot(scpu, smt_mask, cpumask_of(cpu_of(rq))) {
+			struct rq *srq = cpu_rq(scpu);
+			struct rq_flags srf;
+			struct task_struct *sprev = srq->curr;
+
+			/*
+			 * While core-scheduling, rq lock is shared among
+			 * siblings but the debug annotations and rq clock
+			 * aren't. Do pinning dance to transfer the ownership.
+			 */
+			WARN_ON_ONCE(__rq_lockp(rq) != __rq_lockp(srq));
+			rq_unpin_lock(rq, rf);
+			rq_pin_lock(srq, &srf);
+
+			update_rq_clock(srq);
+			balance_one(srq, sprev, &srf, false);
+
+			rq_unpin_lock(srq, &srf);
+			rq_repin_lock(rq, rf);
+		}
+	}
+#endif
+	return ret;
+}
+
 static void set_next_task_scx(struct rq *rq, struct task_struct *p, bool first)
 {
 	if (p->scx.flags & SCX_TASK_QUEUED) {
-		WARN_ON_ONCE(atomic_long_read(&p->scx.ops_state) != SCX_OPSS_NONE);
+		/*
+		 * Core-sched might decide to execute @p before it is
+		 * dispatched. Call ops_dequeue() to notify the BPF scheduler.
+		 */
+		ops_dequeue(p, SCX_DEQ_CORE_SCHED_EXEC);
 		dispatch_dequeue(rq, p);
 	}

@@ -2379,7 +2516,8 @@ static void put_prev_task_scx(struct rq *rq, struct task_struct *p)
 		/*
 		 * If @p has slice left and balance_scx() didn't tag it for
 		 * keeping, @p is getting preempted by a higher priority
-		 * scheduler class. Leave it at the head of the local DSQ.
+		 * scheduler class or core-sched forcing a different task. Leave
+		 * it at the head of the local DSQ.
 		 */
 		if (p->scx.slice && !scx_ops_bypassing()) {
 			dispatch_enqueue(&rq->scx.local_dsq, p, SCX_ENQ_HEAD);
@@ -2436,6 +2574,84 @@ static struct task_struct *pick_next_task_scx(struct rq *rq)
 	return p;
 }

+#ifdef CONFIG_SCHED_CORE
+/**
+ * scx_prio_less - Task ordering for core-sched
+ * @a: task A
+ * @b: task B
+ *
+ * Core-sched is implemented as an additional scheduling layer on top of the
+ * usual sched_class'es and needs to find out the expected task ordering. For
+ * sched_ext, core-sched calls this function to interrogate the task ordering.
+ *
+ * Unless overridden by ops.core_sched_before(), @p->scx.core_sched_at is used
+ * to implement the default task ordering. The older the timestamp, the higher
+ * prority the task - the global FIFO ordering matching the default scheduling
+ * behavior.
+ *
+ * When ops.core_sched_before() is enabled, @p->scx.core_sched_at is used to
+ * implement FIFO ordering within each local DSQ. See pick_task_scx().
+ */
+bool scx_prio_less(const struct task_struct *a, const struct task_struct *b,
+		   bool in_fi)
+{
+	/*
+	 * The const qualifiers are dropped from task_struct pointers when
+	 * calling ops.core_sched_before(). Accesses are controlled by the
+	 * verifier.
+	 */
+	if (SCX_HAS_OP(core_sched_before) && !scx_ops_bypassing())
+		return SCX_CALL_OP_2TASKS_RET(SCX_KF_REST, core_sched_before,
+					      (struct task_struct *)a,
+					      (struct task_struct *)b);
+	else
+		return time_after64(a->scx.core_sched_at, b->scx.core_sched_at);
+}
+
+/**
+ * pick_task_scx - Pick a candidate task for core-sched
+ * @rq: rq to pick the candidate task from
+ *
+ * Core-sched calls this function on each SMT sibling to determine the next
+ * tasks to run on the SMT siblings. balance_one() has been called on all
+ * siblings and put_prev_task_scx() has been called only for the current CPU.
+ *
+ * As put_prev_task_scx() hasn't been called on remote CPUs, we can't just look
+ * at the first task in the local dsq. @rq->curr has to be considered explicitly
+ * to mimic %SCX_TASK_BAL_KEEP.
+ */
+static struct task_struct *pick_task_scx(struct rq *rq)
+{
+	struct task_struct *curr = rq->curr;
+	struct task_struct *first = first_local_task(rq);
+
+	if (curr->scx.flags & SCX_TASK_QUEUED) {
+		/* is curr the only runnable task? */
+		if (!first)
+			return curr;
+
+		/*
+		 * Does curr trump first? We can always go by core_sched_at for
+		 * this comparison as it represents global FIFO ordering when
+		 * the default core-sched ordering is used and local-DSQ FIFO
+		 * ordering otherwise.
+		 *
+		 * We can have a task with an earlier timestamp on the DSQ. For
+		 * example, when a current task is preempted by a sibling
+		 * picking a different cookie, the task would be requeued at the
+		 * head of the local DSQ with an earlier timestamp than the
+		 * core-sched picked next task. Besides, the BPF scheduler may
+		 * dispatch any tasks to the local DSQ anytime.
+		 */
+		if (curr->scx.slice && time_before64(curr->scx.core_sched_at,
+						     first->scx.core_sched_at))
+			return curr;
+	}
+
+	return first;	/* this may be %NULL */
+}
+#endif	/* CONFIG_SCHED_CORE */
+
 static enum scx_cpu_preempt_reason
 preempt_reason_from_class(const struct sched_class *class)
 {
@@ -2843,13 +3059,15 @@ static void task_tick_scx(struct rq *rq, struct task_struct *curr, int queued)
 	update_curr_scx(rq);

 	/*
-	 * While bypassing, always resched as we can't trust the slice
-	 * management.
+	 * While disabling, always resched and refresh core-sched timestamp as
+	 * we can't trust the slice management or ops.core_sched_before().
 	 */
-	if (scx_ops_bypassing())
+	if (scx_ops_bypassing()) {
 		curr->scx.slice = 0;
-	else if (SCX_HAS_OP(tick))
+		touch_core_sched(rq, curr);
+	} else if (SCX_HAS_OP(tick)) {
 		SCX_CALL_OP(SCX_KF_REST, tick, curr);
+	}

 	if (!curr->scx.slice)
 		resched_curr(rq);
@@ -3203,6 +3421,10 @@ DEFINE_SCHED_CLASS(ext) = {
 	.rq_offline		= rq_offline_scx,
 #endif

+#ifdef CONFIG_SCHED_CORE
+	.pick_task		= pick_task_scx,
+#endif
+
 	.task_tick		= task_tick_scx,

 	.switching_to		= switching_to_scx,
@@ -3416,12 +3638,14 @@ bool task_should_scx(struct task_struct *p)
  *
  * c. balance_scx() never sets %SCX_TASK_BAL_KEEP as the slice value can't be
  *    trusted. Whenever a tick triggers, the running task is rotated to the tail
- *    of the queue.
+ *    of the queue with core_sched_at touched.
  *
  * d. pick_next_task() suppresses zero slice warning.
  *
  * e. scx_bpf_kick_cpu() is disabled to avoid irq_work malfunction during PM
  *    operations.
+ *
+ * f. scx_prio_less() reverts to the default core_sched_at order.
  */
 static void scx_ops_bypass(bool bypass)
 {
@@ -4583,6 +4807,7 @@ static void running_stub(struct task_struct *p) {}
 static void stopping_stub(struct task_struct *p, bool runnable) {}
 static void quiescent_stub(struct task_struct *p, u64 deq_flags) {}
 static bool yield_stub(struct task_struct *from, struct task_struct *to) { return false; }
+static bool core_sched_before_stub(struct task_struct *a, struct task_struct *b) { return false; }
 static void set_weight_stub(struct task_struct *p, u32 weight) {}
 static void set_cpumask_stub(struct task_struct *p, const struct cpumask *mask) {}
 static void update_idle_stub(s32 cpu, bool idle) {}
@@ -4607,6 +4832,7 @@ static struct sched_ext_ops __bpf_ops_sched_ext_ops = {
 	.stopping = stopping_stub,
 	.quiescent = quiescent_stub,
 	.yield = yield_stub,
+	.core_sched_before = core_sched_before_stub,
 	.set_weight = set_weight_stub,
 	.set_cpumask = set_cpumask_stub,
 	.update_idle = update_idle_stub,
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 037f9acdf443..6555878c5da3 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -70,6 +70,11 @@ static inline const struct sched_class *next_active_class(const struct sched_cla
 	for_active_class_range(class, (prev_class) > &ext_sched_class ?		\
 			       &ext_sched_class : (prev_class), (end_class))

+#ifdef CONFIG_SCHED_CORE
+bool scx_prio_less(const struct task_struct *a, const struct task_struct *b,
+		   bool in_fi);
+#endif
+
 #else	/* CONFIG_SCHED_CLASS_EXT */

 #define scx_enabled()		false
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 619078355bf5..c75c70d6a8eb 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -13,6 +13,7 @@
  * - Sleepable per-task storage allocation using ops.prep_enable().
  * - Using ops.cpu_release() to handle a higher priority scheduling class taking
  *   the CPU away.
+ * - Core-sched support.
  *
  * This scheduler is primarily for demonstration and testing of sched_ext
  * features and unlikely to be useful for actual workloads.
@@ -67,9 +68,21 @@ struct {
 	},
 };

+/*
+ * Per-queue sequence numbers to implement core-sched ordering.
+ *
+ * Tail seq is assigned to each queued task and incremented. Head seq tracks the
+ * sequence number of the latest dispatched task. The distance between the a
+ * task's seq and the associated queue's head seq is called the queue distance
+ * and used when comparing two tasks for ordering. See qmap_core_sched_before().
+ */
+static u64 core_sched_head_seqs[5];
+static u64 core_sched_tail_seqs[5];
+
 /* Per-task scheduling context */
 struct task_ctx {
 	bool	force_local;	/* Dispatch directly to local_dsq */
+	u64	core_sched_seq;
 };

 struct {
@@ -93,6 +106,7 @@ struct {

 /* Statistics */
 u64 nr_enqueued, nr_dispatched, nr_reenqueued, nr_dequeued;
+u64 nr_core_sched_execed;

 s32 BPF_STRUCT_OPS(qmap_select_cpu, struct task_struct *p,
 		   s32 prev_cpu, u64 wake_flags)
@@ -159,8 +173,18 @@ void BPF_STRUCT_OPS(qmap_enqueue, struct task_struct *p, u64 enq_flags)
 		return;
 	}

-	/* Is select_cpu() is telling us to enqueue locally? */
-	if (tctx->force_local) {
+	/*
+	 * All enqueued tasks must have their core_sched_seq updated for correct
+	 * core-sched ordering, which is why %SCX_OPS_ENQ_LAST is specified in
+	 * qmap_ops.flags.
+	 */
+	tctx->core_sched_seq = core_sched_tail_seqs[idx]++;
+
+	/*
+	 * If qmap_select_cpu() is telling us to or this is the last runnable
+	 * task on the CPU, enqueue locally.
+	 */
+	if (tctx->force_local || (enq_flags & SCX_ENQ_LAST)) {
 		tctx->force_local = false;
 		scx_bpf_dispatch(p, SCX_DSQ_LOCAL, slice_ns, enq_flags);
 		return;
@@ -204,6 +228,19 @@ void BPF_STRUCT_OPS(qmap_enqueue, struct task_struct *p, u64 enq_flags)
 void BPF_STRUCT_OPS(qmap_dequeue, struct task_struct *p, u64 deq_flags)
 {
 	__sync_fetch_and_add(&nr_dequeued, 1);
+	if (deq_flags & SCX_DEQ_CORE_SCHED_EXEC)
+		__sync_fetch_and_add(&nr_core_sched_execed, 1);
+}
+
+static void update_core_sched_head_seq(struct task_struct *p)
+{
+	struct task_ctx *tctx = bpf_task_storage_get(&task_ctx_stor, p, 0, 0);
+	int idx = weight_to_idx(p->scx.weight);
+
+	if (tctx)
+		core_sched_head_seqs[idx] = tctx->core_sched_seq;
+	else
+		scx_bpf_error("task_ctx lookup failed");
 }

 void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
@@ -258,6 +295,7 @@ void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
 			if (!p)
 				continue;

+			update_core_sched_head_seq(p);
 			__sync_fetch_and_add(&nr_dispatched, 1);
 			scx_bpf_dispatch(p, SHARED_DSQ, slice_ns, 0);
 			bpf_task_release(p);
@@ -275,6 +313,49 @@ void BPF_STRUCT_OPS(qmap_dispatch, s32 cpu, struct task_struct *prev)
 	}
 }

+/*
+ * The distance from the head of the queue scaled by the weight of the queue.
+ * The lower the number, the older the task and the higher the priority.
+ */
+static s64 task_qdist(struct task_struct *p)
+{
+	int idx = weight_to_idx(p->scx.weight);
+	struct task_ctx *tctx;
+	s64 qdist;
+
+	tctx = bpf_task_storage_get(&task_ctx_stor, p, 0, 0);
+	if (!tctx) {
+		scx_bpf_error("task_ctx lookup failed");
+		return 0;
+	}
+
+	qdist = tctx->core_sched_seq - core_sched_head_seqs[idx];
+
+	/*
+	 * As queue index increments, the priority doubles. The queue w/ index 3
+	 * is dispatched twice more frequently than 2. Reflect the difference by
+	 * scaling qdists accordingly. Note that the shift amount needs to be
+	 * flipped depending on the sign to avoid flipping priority direction.
+	 */
+	if (qdist >= 0)
+		return qdist << (4 - idx);
+	else
+		return qdist << idx;
+}
+
+/*
+ * This is called to determine the task ordering when core-sched is picking
+ * tasks to execute on SMT siblings and should encode about the same ordering as
+ * the regular scheduling path. Use the priority-scaled distances from the head
+ * of the queues to compare the two tasks which should be consistent with the
+ * dispatch path behavior.
+ */
+bool BPF_STRUCT_OPS(qmap_core_sched_before,
+		    struct task_struct *a, struct task_struct *b)
+{
+	return task_qdist(a) > task_qdist(b);
+}
+
 void BPF_STRUCT_OPS(qmap_cpu_release, s32 cpu, struct scx_cpu_release_args *args)
 {
 	u32 cnt;
@@ -354,8 +435,8 @@ void BPF_STRUCT_OPS(qmap_dump_task, struct scx_dump_ctx *dctx, struct task_struc
 	if (!(taskc = bpf_task_storage_get(&task_ctx_stor, p, 0, 0)))
 		return;

-	scx_bpf_dump("QMAP: force_local=%d",
-		     taskc->force_local);
+	scx_bpf_dump("QMAP: force_local=%d core_sched_seq=%llu",
+		     taskc->force_local, taskc->core_sched_seq);
 }

 /*
@@ -428,6 +509,7 @@ SCX_OPS_DEFINE(qmap_ops,
 	       .enqueue			= (void *)qmap_enqueue,
 	       .dequeue			= (void *)qmap_dequeue,
 	       .dispatch		= (void *)qmap_dispatch,
+	       .core_sched_before	= (void *)qmap_core_sched_before,
 	       .cpu_release		= (void *)qmap_cpu_release,
 	       .init_task		= (void *)qmap_init_task,
 	       .dump			= (void *)qmap_dump,
@@ -437,5 +519,6 @@ SCX_OPS_DEFINE(qmap_ops,
 	       .cpu_offline		= (void *)qmap_cpu_offline,
 	       .init			= (void *)qmap_init,
 	       .exit			= (void *)qmap_exit,
+	       .flags			= SCX_OPS_ENQ_LAST,
 	       .timeout_ms		= 5000U,
 	       .name			= "qmap");
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index 920fb54f9c77..bc36ec4f88a7 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -112,9 +112,10 @@ int main(int argc, char **argv)
 		long nr_enqueued = skel->bss->nr_enqueued;
 		long nr_dispatched = skel->bss->nr_dispatched;

-		printf("stats  : enq=%lu dsp=%lu delta=%ld reenq=%"PRIu64" deq=%"PRIu64"\n",
+		printf("stats  : enq=%lu dsp=%lu delta=%ld reenq=%"PRIu64" deq=%"PRIu64" core=%"PRIu64"\n",
 		       nr_enqueued, nr_dispatched, nr_enqueued - nr_dispatched,
-		       skel->bss->nr_reenqueued, skel->bss->nr_dequeued);
+		       skel->bss->nr_reenqueued, skel->bss->nr_dequeued,
+		       skel->bss->nr_core_sched_execed);
 		fflush(stdout);
 		sleep(1);
 	}
--
2.45.2


```

## Implementation Analysis

### Overview

Linux core scheduling (`CONFIG_SCHED_CORE`) is a security feature that prevents side-channel attacks (Spectre MDS variants) by ensuring that SMT sibling hyperthreads only run tasks from the same trust group (identified by a "cookie"). Prior to this patch, `SCHED_CLASS_EXT` had `!SCHED_CORE` as a Kconfig dependency — they were mutually exclusive. This patch lifts that restriction and integrates sched_ext fully with core scheduling.

The integration has three parts: (1) a new `core_sched_at` timestamp per task for ordering, (2) an optional `ops.core_sched_before()` callback for BPF-custom ordering, and (3) a modified `balance_scx()` that also balances SMT siblings and a new `pick_task_scx()` hook for the core-sched pick path.

### Code Walkthrough

**Kconfig dependency change** (`kernel/Kconfig.preempt`):
```
- depends on BPF_SYSCALL && BPF_JIT && !SCHED_CORE
+ depends on BPF_SYSCALL && BPF_JIT
```
The mutual exclusion is removed. Both features can now be enabled simultaneously.

**`core_sched_at` timestamp** (`include/linux/sched/ext.h`):
```c
#ifdef CONFIG_SCHED_CORE
u64 core_sched_at;  /* see scx_prio_less() */
#endif
```
Added to `struct sched_ext_entity`. This timestamp records when a task last "renewed" its position in the scheduling order. Older timestamps mean higher priority in the default ordering.

**`touch_core_sched()` and `touch_core_sched_dispatch()`**: Two helper functions that update `core_sched_at`. `touch_core_sched()` is called at task wakeup (`SCX_ENQ_WAKEUP`), slice expiration, and when a task falls back to the local or global DSQ. `touch_core_sched_dispatch()` is called when a task is dispatched, but only if `ops.core_sched_before()` is implemented — in that case, dispatched tasks get a fresh timestamp to maintain local-DSQ FIFO ordering.

**`__task_prio()` extension** (`kernel/sched/core.c`):
```c
if (task_on_scx(p))
    return MAX_RT_PRIO + MAX_NICE + 1; /* squash ext */

return MAX_RT_PRIO + MAX_NICE; /* squash fair */
```
sched_ext tasks get their own priority bucket (120+1=121) distinct from CFS tasks (120). This allows `prio_less()` to dispatch to `scx_prio_less()` specifically for SCX tasks:
```c
if (pa == MAX_RT_PRIO + MAX_NICE + 1)   /* ext */
    return scx_prio_less(a, b, in_fi);
```

**`ops.core_sched_before()`** (`struct sched_ext_ops`):
```c
bool (*core_sched_before)(struct task_struct *a, struct task_struct *b);
```
Optional. If not set, the default ordering uses `core_sched_at` timestamps (global FIFO — older tasks have higher priority). If set, the BPF scheduler provides custom ordering. The const qualifiers on the task pointers are explicitly dropped in `scx_prio_less()` because BPF access is controlled by the verifier, not C qualifiers.

**`scx_prio_less()`** (`kernel/sched/ext.c`):
```c
bool scx_prio_less(const struct task_struct *a, const struct task_struct *b,
                   bool in_fi)
{
    if (SCX_HAS_OP(core_sched_before) && !scx_ops_bypassing())
        return SCX_CALL_OP_2TASKS_RET(SCX_KF_REST, core_sched_before, ...);
    else
        return time_after64(a->scx.core_sched_at, b->scx.core_sched_at);
}
```
`time_after64(a->ts, b->ts)` returns true if `a`'s timestamp is newer than `b`'s — meaning `a` has less priority. So if `a`'s `core_sched_at` is larger (more recent), `a` yields to `b`.

**`balance_scx()` split** — the old `balance_scx()` becomes `balance_one()` with a `local` boolean parameter, and a new `balance_scx()` wrapper calls `balance_one()` then balances SMT siblings:
```c
if (sched_core_enabled(rq)) {
    for_each_cpu_andnot(scpu, smt_mask, cpumask_of(cpu_of(rq))) {
        rq_unpin_lock(rq, rf);
        rq_pin_lock(srq, &srf);
        balance_one(srq, sprev, &srf, false);
        rq_unpin_lock(srq, &srf);
        rq_repin_lock(rq, rf);
    }
}
```
The rq lock is shared among SMT siblings in core-sched mode. The rq pin/unpin dance transfers debug annotations and clock ownership without dropping the lock.

**`pick_task_scx()`** — the new core-sched hook:
```c
static struct task_struct *pick_task_scx(struct rq *rq)
{
    struct task_struct *curr = rq->curr;
    struct task_struct *first = first_local_task(rq);

    if (curr->scx.flags & SCX_TASK_QUEUED) {
        if (!first)
            return curr;
        if (curr->scx.slice && time_before64(curr->scx.core_sched_at,
                                             first->scx.core_sched_at))
            return curr;
    }
    return first;
}
```
Core-sched calls this on each sibling CPU to get a candidate task, then compares cookie groups across siblings. `put_prev_task_scx()` has only been called on the current CPU, so for remote CPUs `curr` is still running and must be considered explicitly (mimicking `SCX_TASK_BAL_KEEP`).

**`SCX_DEQ_CORE_SCHED_EXEC`** added to `enum scx_deq_flags`:
```c
SCX_DEQ_CORE_SCHED_EXEC = 1LLU << 32,
```
When core-sched decides to execute a task that hasn't been dispatched yet (still in the BPF scheduler's queues), `set_next_task_scx()` calls `ops_dequeue(p, SCX_DEQ_CORE_SCHED_EXEC)` to notify the BPF scheduler. The qmap example counts these events in `nr_core_sched_execed`.

**qmap core-sched implementation**: Uses per-queue sequence numbers (`core_sched_head_seqs`, `core_sched_tail_seqs`) to compute a priority-scaled "queue distance" in `task_qdist()`. The `qmap_core_sched_before()` callback returns true if task `a`'s queue distance is greater than task `b`'s — meaning `a` is further from the head and has lower priority.

### Key Concepts

- **`core_sched_at` timestamp**: Updated on wakeup, slice expiry, and dispatch (if custom ordering). For default ordering: older timestamp = higher priority = runs first. For custom ordering: used only for FIFO ordering within the local DSQ after dispatch.
- **Two ordering modes**: (1) Default — global FIFO using `core_sched_at`. No BPF change needed. (2) Custom via `ops.core_sched_before()` — BPF defines the ordering. `core_sched_at` is then used only for local-DSQ FIFO within each CPU after dispatch.
- **SMT sibling balancing**: `balance_scx()` now balances all SMT siblings when core-sched is active. This is necessary because core-sched calls `pick_task_scx()` on all siblings simultaneously to find compatible cookie pairs.
- **Cookie matching**: sched_ext itself does not handle cookie assignment or matching. That is the core-sched layer's responsibility. sched_ext only provides ordering via `scx_prio_less()` and candidate task selection via `pick_task_scx()`.

### Locking and Concurrency Notes

- In core-sched mode, SMT siblings share the same rq spinlock (the lock of the "master" CPU in the SMT group). The `rq_unpin_lock/rq_pin_lock` dance in `balance_scx()` is required to safely transfer lock ownership annotations between the per-rq debug state while holding the same underlying lock.
- `scx_prio_less()` is called from `prio_less()` inside the core-sched scheduling path, under rq lock. The `SCX_KF_REST` kfunc set is used for `core_sched_before`, so it runs under rq lock.
- `touch_core_sched()` only updates the timestamp when `!sched_core_disabled()`, using the cheaper `sched_core_disabled()` check (a static key) rather than `sched_core_enabled()`. The comment notes "It's okay to update the timestamp spuriously" — a spurious update causes no harm, just a slightly different ordering.
- The `local` boolean in `balance_one()` gates `SCX_TASK_BAL_KEEP`: only the local CPU sets this flag, because remote CPUs won't have `put_prev_task_scx()` called on them, so `pick_task_scx()` handles their current-task decision instead.

### Integration with Kernel Subsystems

The integration is with `kernel/sched/core.c`'s `__task_prio()` and `prio_less()` functions, which are the entry points for the core-sched task comparison logic. By assigning sched_ext tasks a unique priority bucket and dispatching through `scx_prio_less()`, sched_ext plugs into the existing core-sched comparison framework without requiring modifications to the generic code beyond those two functions.

The `pick_task` sched_class method (`.pick_task = pick_task_scx`) is the other integration point — this is the core-sched API for "give me your best candidate for this CPU."

### What Maintainers Need to Know

- **Opting in to custom ordering**: If your BPF scheduler implements `ops.core_sched_before()`, it must correctly reflect your scheduling order. Inconsistency between `ops.enqueue/dispatch` ordering and `core_sched_before()` ordering will cause SMT imbalance — one sibling will stall waiting for a matching cookie partner.
- **Default ordering (no `core_sched_before`)**: Global FIFO ordering based on when tasks became runnable. This is correct for simple schedulers and requires no BPF code changes.
- **`SCX_DEQ_CORE_SCHED_EXEC`**: When you receive this flag in `ops.dequeue()`, core-sched has decided to run the task even though it was not yet dispatched from your queue. Update any per-queue accounting (e.g., head sequence numbers in qmap) appropriately.
- **`SCX_OPS_ENQ_LAST` in qmap**: The qmap example adds this flag to ensure `ops.enqueue()` is called even for the last runnable task on a CPU. This is required for correct `core_sched_seq` assignment — all tasks must go through enqueue to get a sequence number.
- **Bypass during core-sched**: When `scx_ops_bypass()` is active (PM events, etc.), `scx_prio_less()` falls back to default `core_sched_at` ordering regardless of whether `ops.core_sched_before()` is set. The bypass updates `core_sched_at` at every tick to maintain a consistent ordering.

### Connection to Other Patches

- **Patch 26/30 (PM bypass)**: The bypass explicitly notes that `scx_prio_less()` reverts to default ordering (point `f` in the bypass comment). This patch is what that comment refers to.
- **Patch 24/30 (cpu_acquire/release)**: `cpu_release()` can fire during core-sched scheduling decisions if a higher-priority class preempts. These are orthogonal paths: `cpu_release()` fires in `scx_next_task_picked()`, while core-sched operates in `balance/pick_task`.
- **Patch 25/30 (cpu_online/offline)**: Both the `rq_online_scx` / `rq_offline_scx` hooks from that patch and the `pick_task_scx` hook from this patch are registered in the `ext_sched_class` vtable.

