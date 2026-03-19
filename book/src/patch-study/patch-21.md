# [PATCH 22/30] sched_ext: Track tasks that are subjects of the in-flight SCX operation

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-23-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-23-tj@kernel.org)

## Commit Message

```text
When some SCX operations are in flight, it is known that the subject task's
rq lock is held throughout which makes it safe to access certain fields of
the task - e.g. its current task_group. We want to add SCX kfunc helpers
that can make use of this guarantee - e.g. to help determining the currently
associated CPU cgroup from the task's current task_group.

As it'd be dangerous call such a helper on a task which isn't rq lock
protected, the helper should be able to verify the input task and reject
accordingly. This patch adds sched_ext_entity.kf_tasks[] that track the
tasks which are currently being operated on by a terminal SCX operation. The
new SCX_CALL_OP_[2]TASK[_RET]() can be used when invoking SCX operations
which take tasks as arguments and the scx_kf_allowed_on_arg_tasks() can be
used by kfunc helpers to verify the input task status.

Note that as sched_ext_entity.kf_tasks[] can't handle nesting, the tracking
is currently only limited to terminal SCX operations. If needed in the
future, this restriction can be removed by moving the tracking to the task
side with a couple per-task counters.

v2: Updated to reflect the addition of SCX_KF_SELECT_CPU.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
---
 include/linux/sched/ext.h |  2 +
 kernel/sched/ext.c        | 91 +++++++++++++++++++++++++++++++--------
 2 files changed, 76 insertions(+), 17 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index 6f1a4977e9f8..74341dbc6a19 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -106,6 +106,7 @@ enum scx_kf_mask {
 
 	__SCX_KF_RQ_LOCKED	= SCX_KF_DISPATCH |
 				  SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU | SCX_KF_REST,
+	__SCX_KF_TERMINAL	= SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU | SCX_KF_REST,
 };
 
 /*
@@ -120,6 +121,7 @@ struct sched_ext_entity {
 	s32			sticky_cpu;
 	s32			holding_cpu;
 	u32			kf_mask;	/* see scx_kf_mask above */
+	struct task_struct	*kf_tasks[2];	/* see SCX_CALL_OP_TASK() */
 	atomic_long_t		ops_state;
 
 	struct list_head	runnable_node;	/* rq->scx.runnable_list */
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index ce32fc6b05cd..838a96cb10ea 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -817,6 +817,47 @@ do {										\
 	__ret;									\
 })
 
+/*
+ * Some kfuncs are allowed only on the tasks that are subjects of the
+ * in-progress scx_ops operation for, e.g., locking guarantees. To enforce such
+ * restrictions, the following SCX_CALL_OP_*() variants should be used when
+ * invoking scx_ops operations that take task arguments. These can only be used
+ * for non-nesting operations due to the way the tasks are tracked.
+ *
+ * kfuncs which can only operate on such tasks can in turn use
+ * scx_kf_allowed_on_arg_tasks() to test whether the invocation is allowed on
+ * the specific task.
+ */
+#define SCX_CALL_OP_TASK(mask, op, task, args...)				\
+do {										\
+	BUILD_BUG_ON((mask) & ~__SCX_KF_TERMINAL);				\
+	current->scx.kf_tasks[0] = task;					\
+	SCX_CALL_OP(mask, op, task, ##args);					\
+	current->scx.kf_tasks[0] = NULL;					\
+} while (0)
+
+#define SCX_CALL_OP_TASK_RET(mask, op, task, args...)				\
+({										\
+	__typeof__(scx_ops.op(task, ##args)) __ret;				\
+	BUILD_BUG_ON((mask) & ~__SCX_KF_TERMINAL);				\
+	current->scx.kf_tasks[0] = task;					\
+	__ret = SCX_CALL_OP_RET(mask, op, task, ##args);			\
+	current->scx.kf_tasks[0] = NULL;					\
+	__ret;									\
+})
+
+#define SCX_CALL_OP_2TASKS_RET(mask, op, task0, task1, args...)			\
+({										\
+	__typeof__(scx_ops.op(task0, task1, ##args)) __ret;			\
+	BUILD_BUG_ON((mask) & ~__SCX_KF_TERMINAL);				\
+	current->scx.kf_tasks[0] = task0;					\
+	current->scx.kf_tasks[1] = task1;					\
+	__ret = SCX_CALL_OP_RET(mask, op, task0, task1, ##args);		\
+	current->scx.kf_tasks[0] = NULL;					\
+	current->scx.kf_tasks[1] = NULL;					\
+	__ret;									\
+})
+
 /* @mask is constant, always inline to cull unnecessary branches */
 static __always_inline bool scx_kf_allowed(u32 mask)
 {
@@ -846,6 +887,22 @@ static __always_inline bool scx_kf_allowed(u32 mask)
 	return true;
 }
 
+/* see SCX_CALL_OP_TASK() */
+static __always_inline bool scx_kf_allowed_on_arg_tasks(u32 mask,
+							struct task_struct *p)
+{
+	if (!scx_kf_allowed(mask))
+		return false;
+
+	if (unlikely((p != current->scx.kf_tasks[0] &&
+		      p != current->scx.kf_tasks[1]))) {
+		scx_ops_error("called on a task not being operated on");
+		return false;
+	}
+
+	return true;
+}
+
 
 /*
  * SCX task iterator.
@@ -1342,7 +1399,7 @@ static void do_enqueue_task(struct rq *rq, struct task_struct *p, u64 enq_flags,
 	WARN_ON_ONCE(*ddsp_taskp);
 	*ddsp_taskp = p;
 
-	SCX_CALL_OP(SCX_KF_ENQUEUE, enqueue, p, enq_flags);
+	SCX_CALL_OP_TASK(SCX_KF_ENQUEUE, enqueue, p, enq_flags);
 
 	*ddsp_taskp = NULL;
 	if (p->scx.ddsp_dsq_id != SCX_DSQ_INVALID)
@@ -1427,7 +1484,7 @@ static void enqueue_task_scx(struct rq *rq, struct task_struct *p, int enq_flags
 	add_nr_running(rq, 1);
 
 	if (SCX_HAS_OP(runnable))
-		SCX_CALL_OP(SCX_KF_REST, runnable, p, enq_flags);
+		SCX_CALL_OP_TASK(SCX_KF_REST, runnable, p, enq_flags);
 
 	do_enqueue_task(rq, p, enq_flags, sticky_cpu);
 }
@@ -1453,7 +1510,7 @@ static void ops_dequeue(struct task_struct *p, u64 deq_flags)
 		BUG();
 	case SCX_OPSS_QUEUED:
 		if (SCX_HAS_OP(dequeue))
-			SCX_CALL_OP(SCX_KF_REST, dequeue, p, deq_flags);
+			SCX_CALL_OP_TASK(SCX_KF_REST, dequeue, p, deq_flags);
 
 		if (atomic_long_try_cmpxchg(&p->scx.ops_state, &opss,
 					    SCX_OPSS_NONE))
@@ -1502,11 +1559,11 @@ static void dequeue_task_scx(struct rq *rq, struct task_struct *p, int deq_flags
 	 */
 	if (SCX_HAS_OP(stopping) && task_current(rq, p)) {
 		update_curr_scx(rq);
-		SCX_CALL_OP(SCX_KF_REST, stopping, p, false);
+		SCX_CALL_OP_TASK(SCX_KF_REST, stopping, p, false);
 	}
 
 	if (SCX_HAS_OP(quiescent))
-		SCX_CALL_OP(SCX_KF_REST, quiescent, p, deq_flags);
+		SCX_CALL_OP_TASK(SCX_KF_REST, quiescent, p, deq_flags);
 
 	if (deq_flags & SCX_DEQ_SLEEP)
 		p->scx.flags |= SCX_TASK_DEQD_FOR_SLEEP;
@@ -1525,7 +1582,7 @@ static void yield_task_scx(struct rq *rq)
 	struct task_struct *p = rq->curr;
 
 	if (SCX_HAS_OP(yield))
-		SCX_CALL_OP_RET(SCX_KF_REST, yield, p, NULL);
+		SCX_CALL_OP_2TASKS_RET(SCX_KF_REST, yield, p, NULL);
 	else
 		p->scx.slice = 0;
 }
@@ -1535,7 +1592,7 @@ static bool yield_to_task_scx(struct rq *rq, struct task_struct *to)
 	struct task_struct *from = rq->curr;
 
 	if (SCX_HAS_OP(yield))
-		return SCX_CALL_OP_RET(SCX_KF_REST, yield, from, to);
+		return SCX_CALL_OP_2TASKS_RET(SCX_KF_REST, yield, from, to);
 	else
 		return false;
 }
@@ -2091,7 +2148,7 @@ static void set_next_task_scx(struct rq *rq, struct task_struct *p, bool first)
 
 	/* see dequeue_task_scx() on why we skip when !QUEUED */
 	if (SCX_HAS_OP(running) && (p->scx.flags & SCX_TASK_QUEUED))
-		SCX_CALL_OP(SCX_KF_REST, running, p);
+		SCX_CALL_OP_TASK(SCX_KF_REST, running, p);
 
 	clr_task_runnable(p, true);
 
@@ -2155,7 +2212,7 @@ static void put_prev_task_scx(struct rq *rq, struct task_struct *p)
 
 	/* see dequeue_task_scx() on why we skip when !QUEUED */
 	if (SCX_HAS_OP(stopping) && (p->scx.flags & SCX_TASK_QUEUED))
-		SCX_CALL_OP(SCX_KF_REST, stopping, p, true);
+		SCX_CALL_OP_TASK(SCX_KF_REST, stopping, p, true);
 
 	/*
 	 * If we're being called from put_prev_task_balance(), balance_scx() may
@@ -2377,8 +2434,8 @@ static int select_task_rq_scx(struct task_struct *p, int prev_cpu, int wake_flag
 		WARN_ON_ONCE(*ddsp_taskp);
 		*ddsp_taskp = p;
 
-		cpu = SCX_CALL_OP_RET(SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU,
-				      select_cpu, p, prev_cpu, wake_flags);
+		cpu = SCX_CALL_OP_TASK_RET(SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU,
+					   select_cpu, p, prev_cpu, wake_flags);
 		*ddsp_taskp = NULL;
 		if (ops_cpu_valid(cpu, "from ops.select_cpu()"))
 			return cpu;
@@ -2411,8 +2468,8 @@ static void set_cpus_allowed_scx(struct task_struct *p,
 	 * designation pointless. Cast it away when calling the operation.
 	 */
 	if (SCX_HAS_OP(set_cpumask))
-		SCX_CALL_OP(SCX_KF_REST, set_cpumask, p,
-			    (struct cpumask *)p->cpus_ptr);
+		SCX_CALL_OP_TASK(SCX_KF_REST, set_cpumask, p,
+				 (struct cpumask *)p->cpus_ptr);
 }
 
 static void reset_idle_masks(void)
@@ -2647,7 +2704,7 @@ static void scx_ops_enable_task(struct task_struct *p)
 	 */
 	set_task_scx_weight(p);
 	if (SCX_HAS_OP(enable))
-		SCX_CALL_OP(SCX_KF_REST, enable, p);
+		SCX_CALL_OP_TASK(SCX_KF_REST, enable, p);
 	scx_set_task_state(p, SCX_TASK_ENABLED);
 
 	if (SCX_HAS_OP(set_weight))
@@ -2801,7 +2858,7 @@ static void reweight_task_scx(struct rq *rq, struct task_struct *p, int newprio)
 
 	set_task_scx_weight(p);
 	if (SCX_HAS_OP(set_weight))
-		SCX_CALL_OP(SCX_KF_REST, set_weight, p, p->scx.weight);
+		SCX_CALL_OP_TASK(SCX_KF_REST, set_weight, p, p->scx.weight);
 }
 
 static void prio_changed_scx(struct rq *rq, struct task_struct *p, int oldprio)
@@ -2817,8 +2874,8 @@ static void switching_to_scx(struct rq *rq, struct task_struct *p)
 	 * different scheduler class. Keep the BPF scheduler up-to-date.
 	 */
 	if (SCX_HAS_OP(set_cpumask))
-		SCX_CALL_OP(SCX_KF_REST, set_cpumask, p,
-			    (struct cpumask *)p->cpus_ptr);
+		SCX_CALL_OP_TASK(SCX_KF_REST, set_cpumask, p,
+				 (struct cpumask *)p->cpus_ptr);
 }
 
 static void switched_from_scx(struct rq *rq, struct task_struct *p)
-- 
2.45.2
```

## Diff

```diff
---
 include/linux/sched/ext.h |  2 +
 kernel/sched/ext.c        | 91 +++++++++++++++++++++++++++++++--------
 2 files changed, 76 insertions(+), 17 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index 6f1a4977e9f8..74341dbc6a19 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -106,6 +106,7 @@ enum scx_kf_mask {

 	__SCX_KF_RQ_LOCKED	= SCX_KF_DISPATCH |
 				  SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU | SCX_KF_REST,
+	__SCX_KF_TERMINAL	= SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU | SCX_KF_REST,
 };

 /*
@@ -120,6 +121,7 @@ struct sched_ext_entity {
 	s32			sticky_cpu;
 	s32			holding_cpu;
 	u32			kf_mask;	/* see scx_kf_mask above */
+	struct task_struct	*kf_tasks[2];	/* see SCX_CALL_OP_TASK() */
 	atomic_long_t		ops_state;

 	struct list_head	runnable_node;	/* rq->scx.runnable_list */
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index ce32fc6b05cd..838a96cb10ea 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -817,6 +817,47 @@ do {										\
 	__ret;									\
 })

+/*
+ * Some kfuncs are allowed only on the tasks that are subjects of the
+ * in-progress scx_ops operation for, e.g., locking guarantees. To enforce such
+ * restrictions, the following SCX_CALL_OP_*() variants should be used when
+ * invoking scx_ops operations that take task arguments. These can only be used
+ * for non-nesting operations due to the way the tasks are tracked.
+ *
+ * kfuncs which can only operate on such tasks can in turn use
+ * scx_kf_allowed_on_arg_tasks() to test whether the invocation is allowed on
+ * the specific task.
+ */
+#define SCX_CALL_OP_TASK(mask, op, task, args...)				\
+do {										\
+	BUILD_BUG_ON((mask) & ~__SCX_KF_TERMINAL);				\
+	current->scx.kf_tasks[0] = task;					\
+	SCX_CALL_OP(mask, op, task, ##args);					\
+	current->scx.kf_tasks[0] = NULL;					\
+} while (0)
+
+#define SCX_CALL_OP_TASK_RET(mask, op, task, args...)				\
+({										\
+	__typeof__(scx_ops.op(task, ##args)) __ret;				\
+	BUILD_BUG_ON((mask) & ~__SCX_KF_TERMINAL);				\
+	current->scx.kf_tasks[0] = task;					\
+	__ret = SCX_CALL_OP_RET(mask, op, task, ##args);			\
+	current->scx.kf_tasks[0] = NULL;					\
+	__ret;									\
+})
+
+#define SCX_CALL_OP_2TASKS_RET(mask, op, task0, task1, args...)			\
+({										\
+	__typeof__(scx_ops.op(task0, task1, ##args)) __ret;			\
+	BUILD_BUG_ON((mask) & ~__SCX_KF_TERMINAL);				\
+	current->scx.kf_tasks[0] = task0;					\
+	current->scx.kf_tasks[1] = task1;					\
+	__ret = SCX_CALL_OP_RET(mask, op, task0, task1, ##args);		\
+	current->scx.kf_tasks[0] = NULL;					\
+	current->scx.kf_tasks[1] = NULL;					\
+	__ret;									\
+})
+
 /* @mask is constant, always inline to cull unnecessary branches */
 static __always_inline bool scx_kf_allowed(u32 mask)
 {
@@ -846,6 +887,22 @@ static __always_inline bool scx_kf_allowed(u32 mask)
 	return true;
 }

+/* see SCX_CALL_OP_TASK() */
+static __always_inline bool scx_kf_allowed_on_arg_tasks(u32 mask,
+							struct task_struct *p)
+{
+	if (!scx_kf_allowed(mask))
+		return false;
+
+	if (unlikely((p != current->scx.kf_tasks[0] &&
+		      p != current->scx.kf_tasks[1]))) {
+		scx_ops_error("called on a task not being operated on");
+		return false;
+	}
+
+	return true;
+}
+

 /*
  * sched_ext task iterator.
@@ -1342,7 +1399,7 @@ static void do_enqueue_task(struct rq *rq, struct task_struct *p, u64 enq_flags,
 	WARN_ON_ONCE(*ddsp_taskp);
 	*ddsp_taskp = p;

-	SCX_CALL_OP(SCX_KF_ENQUEUE, enqueue, p, enq_flags);
+	SCX_CALL_OP_TASK(SCX_KF_ENQUEUE, enqueue, p, enq_flags);

 	*ddsp_taskp = NULL;
 	if (p->scx.ddsp_dsq_id != SCX_DSQ_INVALID)
@@ -1427,7 +1484,7 @@ static void enqueue_task_scx(struct rq *rq, struct task_struct *p, int enq_flags
 	add_nr_running(rq, 1);

 	if (SCX_HAS_OP(runnable))
-		SCX_CALL_OP(SCX_KF_REST, runnable, p, enq_flags);
+		SCX_CALL_OP_TASK(SCX_KF_REST, runnable, p, enq_flags);

 	do_enqueue_task(rq, p, enq_flags, sticky_cpu);
 }
@@ -1453,7 +1510,7 @@ static void ops_dequeue(struct task_struct *p, u64 deq_flags)
 		BUG();
 	case SCX_OPSS_QUEUED:
 		if (SCX_HAS_OP(dequeue))
-			SCX_CALL_OP(SCX_KF_REST, dequeue, p, deq_flags);
+			SCX_CALL_OP_TASK(SCX_KF_REST, dequeue, p, deq_flags);

 		if (atomic_long_try_cmpxchg(&p->scx.ops_state, &opss,
 					    SCX_OPSS_NONE))
@@ -1502,11 +1559,11 @@ static void dequeue_task_scx(struct rq *rq, struct task_struct *p, int deq_flags
 	 */
 	if (SCX_HAS_OP(stopping) && task_current(rq, p)) {
 		update_curr_scx(rq);
-		SCX_CALL_OP(SCX_KF_REST, stopping, p, false);
+		SCX_CALL_OP_TASK(SCX_KF_REST, stopping, p, false);
 	}

 	if (SCX_HAS_OP(quiescent))
-		SCX_CALL_OP(SCX_KF_REST, quiescent, p, deq_flags);
+		SCX_CALL_OP_TASK(SCX_KF_REST, quiescent, p, deq_flags);

 	if (deq_flags & SCX_DEQ_SLEEP)
 		p->scx.flags |= SCX_TASK_DEQD_FOR_SLEEP;
@@ -1525,7 +1582,7 @@ static void yield_task_scx(struct rq *rq)
 	struct task_struct *p = rq->curr;

 	if (SCX_HAS_OP(yield))
-		SCX_CALL_OP_RET(SCX_KF_REST, yield, p, NULL);
+		SCX_CALL_OP_2TASKS_RET(SCX_KF_REST, yield, p, NULL);
 	else
 		p->scx.slice = 0;
 }
@@ -1535,7 +1592,7 @@ static bool yield_to_task_scx(struct rq *rq, struct task_struct *to)
 	struct task_struct *from = rq->curr;

 	if (SCX_HAS_OP(yield))
-		return SCX_CALL_OP_RET(SCX_KF_REST, yield, from, to);
+		return SCX_CALL_OP_2TASKS_RET(SCX_KF_REST, yield, from, to);
 	else
 		return false;
 }
@@ -2091,7 +2148,7 @@ static void set_next_task_scx(struct rq *rq, struct task_struct *p, bool first)

 	/* see dequeue_task_scx() on why we skip when !QUEUED */
 	if (SCX_HAS_OP(running) && (p->scx.flags & SCX_TASK_QUEUED))
-		SCX_CALL_OP(SCX_KF_REST, running, p);
+		SCX_CALL_OP_TASK(SCX_KF_REST, running, p);

 	clr_task_runnable(p, true);

@@ -2155,7 +2212,7 @@ static void put_prev_task_scx(struct rq *rq, struct task_struct *p)

 	/* see dequeue_task_scx() on why we skip when !QUEUED */
 	if (SCX_HAS_OP(stopping) && (p->scx.flags & SCX_TASK_QUEUED))
-		SCX_CALL_OP(SCX_KF_REST, stopping, p, true);
+		SCX_CALL_OP_TASK(SCX_KF_REST, stopping, p, true);

 	/*
 	 * If we're being called from put_prev_task_balance(), balance_scx() may
@@ -2377,8 +2434,8 @@ static int select_task_rq_scx(struct task_struct *p, int prev_cpu, int wake_flag
 		WARN_ON_ONCE(*ddsp_taskp);
 		*ddsp_taskp = p;

-		cpu = SCX_CALL_OP_RET(SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU,
-				      select_cpu, p, prev_cpu, wake_flags);
+		cpu = SCX_CALL_OP_TASK_RET(SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU,
+					   select_cpu, p, prev_cpu, wake_flags);
 		*ddsp_taskp = NULL;
 		if (ops_cpu_valid(cpu, "from ops.select_cpu()"))
 			return cpu;
@@ -2411,8 +2468,8 @@ static void set_cpus_allowed_scx(struct task_struct *p,
 	 * designation pointless. Cast it away when calling the operation.
 	 */
 	if (SCX_HAS_OP(set_cpumask))
-		SCX_CALL_OP(SCX_KF_REST, set_cpumask, p,
-			    (struct cpumask *)p->cpus_ptr);
+		SCX_CALL_OP_TASK(SCX_KF_REST, set_cpumask, p,
+				 (struct cpumask *)p->cpus_ptr);
 }

 static void reset_idle_masks(void)
@@ -2647,7 +2704,7 @@ static void scx_ops_enable_task(struct task_struct *p)
 	 */
 	set_task_scx_weight(p);
 	if (SCX_HAS_OP(enable))
-		SCX_CALL_OP(SCX_KF_REST, enable, p);
+		SCX_CALL_OP_TASK(SCX_KF_REST, enable, p);
 	scx_set_task_state(p, SCX_TASK_ENABLED);

 	if (SCX_HAS_OP(set_weight))
@@ -2801,7 +2858,7 @@ static void reweight_task_scx(struct rq *rq, struct task_struct *p, int newprio)

 	set_task_scx_weight(p);
 	if (SCX_HAS_OP(set_weight))
-		SCX_CALL_OP(SCX_KF_REST, set_weight, p, p->scx.weight);
+		SCX_CALL_OP_TASK(SCX_KF_REST, set_weight, p, p->scx.weight);
 }

 static void prio_changed_scx(struct rq *rq, struct task_struct *p, int oldprio)
@@ -2817,8 +2874,8 @@ static void switching_to_scx(struct rq *rq, struct task_struct *p)
 	 * different scheduler class. Keep the BPF scheduler up-to-date.
 	 */
 	if (SCX_HAS_OP(set_cpumask))
-		SCX_CALL_OP(SCX_KF_REST, set_cpumask, p,
-			    (struct cpumask *)p->cpus_ptr);
+		SCX_CALL_OP_TASK(SCX_KF_REST, set_cpumask, p,
+				 (struct cpumask *)p->cpus_ptr);
 }

 static void switched_from_scx(struct rq *rq, struct task_struct *p)
--
2.45.2


```

## Implementation Analysis

### Overview

Some sched_ext kfuncs need stronger guarantees than just "we're inside an SCX operation" — they need to know that a specific task's `rq->lock` is held. For example, a future kfunc that reads a task's current cgroup assignment needs to guarantee the task cannot be migrated between CPUs while it's being read. This requires the rq holding the task to remain locked during the operation.

This patch establishes an in-flight task tracking mechanism: when certain "terminal" SCX operations are running for a task, the task pointer is stored in `current->scx.kf_tasks[]`. A new set of `SCX_CALL_OP_TASK()` macros handle this bookkeeping. kfuncs that require this guarantee use `scx_kf_allowed_on_arg_tasks()` to verify their input task is currently tracked as in-flight.

### Code Walkthrough

**`include/linux/sched/ext.h` — new field and mask**

```c
// New internal kf_mask value
__SCX_KF_TERMINAL = SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU | SCX_KF_REST,

// New field in sched_ext_entity
struct task_struct *kf_tasks[2];  /* see SCX_CALL_OP_TASK() */
```

`__SCX_KF_TERMINAL` identifies the set of operations where task-specific kfuncs are permitted. It includes enqueue, select_cpu, and all REST operations — these are the operations that take a task argument and where the rq lock is held. The `kf_tasks[2]` array holds up to two task pointers (for yield which takes two tasks).

**`kernel/sched/ext.c` — three new call-op macros**

```c
#define SCX_CALL_OP_TASK(mask, op, task, args...)
do {
    BUILD_BUG_ON((mask) & ~__SCX_KF_TERMINAL);
    current->scx.kf_tasks[0] = task;
    SCX_CALL_OP(mask, op, task, ##args);
    current->scx.kf_tasks[0] = NULL;
} while (0)

#define SCX_CALL_OP_TASK_RET(mask, op, task, args...)
({
    __typeof__(scx_ops.op(task, ##args)) __ret;
    BUILD_BUG_ON((mask) & ~__SCX_KF_TERMINAL);
    current->scx.kf_tasks[0] = task;
    __ret = SCX_CALL_OP_RET(mask, op, task, ##args);
    current->scx.kf_tasks[0] = NULL;
    __ret;
})

#define SCX_CALL_OP_2TASKS_RET(mask, op, task0, task1, args...)
({
    BUILD_BUG_ON((mask) & ~__SCX_KF_TERMINAL);
    current->scx.kf_tasks[0] = task0;
    current->scx.kf_tasks[1] = task1;
    __ret = SCX_CALL_OP_RET(mask, op, task0, task1, ##args);
    current->scx.kf_tasks[0] = NULL;
    current->scx.kf_tasks[1] = NULL;
    __ret;
})
```

These macros wrap `SCX_CALL_OP()` and `SCX_CALL_OP_RET()`. Before the BPF callback executes, the task pointer(s) are stored in `current->scx.kf_tasks[]`. After the callback returns, the slots are cleared. The `BUILD_BUG_ON` ensures these macros are only used with terminal operations.

**`kernel/sched/ext.c` — `scx_kf_allowed_on_arg_tasks()`**

```c
static __always_inline bool scx_kf_allowed_on_arg_tasks(u32 mask,
                                                         struct task_struct *p)
{
    if (!scx_kf_allowed(mask)) return false;

    if (unlikely(p != current->scx.kf_tasks[0] &&
                 p != current->scx.kf_tasks[1])) {
        scx_ops_error("called on a task not being operated on");
        return false;
    }

    return true;
}
```

A kfunc uses this helper to validate that `p` is currently the subject of an in-flight operation. If not, `scx_ops_error()` is called (which eventually kills the BPF scheduler) and false is returned. This is the enforcement mechanism — kfuncs that need rq-lock protection call this before accessing protected fields.

**Pervasive call-site updates**

Every `SCX_CALL_OP()` and `SCX_CALL_OP_RET()` that passes a task argument is replaced with the corresponding `SCX_CALL_OP_TASK()` variant:

- `do_enqueue_task()` → `SCX_CALL_OP_TASK(SCX_KF_ENQUEUE, enqueue, p, enq_flags)`
- `enqueue_task_scx()` → `SCX_CALL_OP_TASK(SCX_KF_REST, runnable, p, enq_flags)`
- `ops_dequeue()` → `SCX_CALL_OP_TASK(SCX_KF_REST, dequeue, p, deq_flags)`
- `dequeue_task_scx()` → `SCX_CALL_OP_TASK(SCX_KF_REST, stopping, p, false/true)`
- `dequeue_task_scx()` → `SCX_CALL_OP_TASK(SCX_KF_REST, quiescent, p, deq_flags)`
- `yield_task_scx()` → `SCX_CALL_OP_2TASKS_RET(SCX_KF_REST, yield, p, NULL)`
- `yield_to_task_scx()` → `SCX_CALL_OP_2TASKS_RET(SCX_KF_REST, yield, from, to)`
- `set_next_task_scx()` → `SCX_CALL_OP_TASK(SCX_KF_REST, running, p)`
- `put_prev_task_scx()` → `SCX_CALL_OP_TASK(SCX_KF_REST, stopping, p, true)`
- `select_task_rq_scx()` → `SCX_CALL_OP_TASK_RET(SCX_KF_ENQUEUE | SCX_KF_SELECT_CPU, select_cpu, p, prev_cpu, wake_flags)`
- `set_cpus_allowed_scx()` → `SCX_CALL_OP_TASK(SCX_KF_REST, set_cpumask, p, ...)`
- `scx_ops_enable_task()` → `SCX_CALL_OP_TASK(SCX_KF_REST, enable, p)`
- `reweight_task_scx()` → `SCX_CALL_OP_TASK(SCX_KF_REST, set_weight, p, ...)`
- `switching_to_scx()` → `SCX_CALL_OP_TASK(SCX_KF_REST, set_cpumask, p, ...)`

### Key Concepts

- **`kf_tasks[2]` on `current`**: The tracking is stored on the *calling* CPU's current task (`current`), not on the subject task `p`. This is because the operation runs on the current CPU's context, and `current->scx.kf_tasks[0]` is only valid for the duration of the BPF callback execution on that CPU.
- **Non-nesting restriction**: The comment in the code explicitly states these macros "can only be used for non-nesting operations." If two terminal operations could nest (e.g., one op calling into the scheduler which triggers another op), `kf_tasks[0]` would be overwritten. For now, terminal operations do not nest. If they did, the tracking would need to move to per-task counters.
- **`__SCX_KF_TERMINAL` vs. `__SCX_KF_RQ_LOCKED`**: `__SCX_KF_RQ_LOCKED` includes `SCX_KF_DISPATCH` but `__SCX_KF_TERMINAL` does not. Dispatch operations (`ops.dispatch()`) are called with the rq lock held but do not take a task as the primary argument, so they are not "terminal" in this sense.
- **`BUILD_BUG_ON` as safety net**: The compile-time check `(mask) & ~__SCX_KF_TERMINAL` ensures that `SCX_CALL_OP_TASK()` is never mistakenly used for non-terminal operations (like `SCX_KF_DISPATCH`). This prevents incorrectly signaling to kfuncs that a task is rq-lock protected when it is not.
- **`scx_ops_error()` on violation**: If a kfunc is called with a task that is not `kf_tasks[0]` or `kf_tasks[1]`, the error kills the BPF scheduler. This is intentional — calling such a kfunc on an arbitrary task pointer (not the in-flight subject) would bypass the locking guarantee and is a scheduler bug.

### Locking and Concurrency Notes

- `kf_tasks[]` is written and read on the same CPU (`current`). No cross-CPU locking is required. The writes happen before the BPF callback (inside `SCX_CALL_OP_TASK()`) and the reads happen during the BPF callback (inside kfunc implementations). Since the BPF callback runs inline on the same CPU, there is no race.
- The `kf_tasks[0] = NULL` cleanup after the callback is not strictly needed for correctness (the next `SCX_CALL_OP_TASK()` would overwrite it), but it is good defensive practice: a stale non-NULL pointer would incorrectly pass the `scx_kf_allowed_on_arg_tasks()` check in a subsequent unrelated operation.
- The `kf_tasks[]` array is part of `sched_ext_entity` which is embedded in `task_struct`. This means it is automatically zeroed at task init via `init_scx_entity()`.

### Why Maintainers Need to Know This

- **Every new op that takes a task argument should use `SCX_CALL_OP_TASK()`**: This is now the standard. The old `SCX_CALL_OP()` with a task argument bypasses the tracking. Future additions to `sched_ext_ops` that take task arguments must use the TASK variants, or kfuncs that call `scx_kf_allowed_on_arg_tasks()` will incorrectly reject them.
- **`kf_tasks[2]` limits tracking to two tasks**: The array size of 2 is sufficient for all current operations (the maximum is `yield` which has two task arguments). If a future op takes three or more task arguments, the array must be extended.
- **This enables future task-group/cgroup kfuncs**: The commit message mentions "determining the currently associated CPU cgroup from the task's current task_group." This patch lays the groundwork for such kfuncs, but does not add them. Reviewers of future kfuncs that call `scx_kf_allowed_on_arg_tasks()` should trace back to this patch to understand the guarantee.
- **Non-terminal ops (`SCX_KF_DISPATCH`) cannot use this mechanism**: `ops.dispatch()` does not have a specific task subject — it dispatches for a CPU, not a task. If `dispatch()` wants to look up task-specific protected state, it must use a different mechanism (e.g., looking up tasks from BPF maps with explicit reference counting).

### Connection to Other Patches

- **PATCH 20/30** added `ops.runnable()`, `ops.running()`, `ops.stopping()`, `ops.quiescent()` — all of which are upgraded from `SCX_CALL_OP()` to `SCX_CALL_OP_TASK()` here.
- **PATCH 21/30** (tickless) added the `ops.running()` call in `set_next_task_scx()` — this patch upgrades that call to `SCX_CALL_OP_TASK()`.
- This patch is a prerequisite for any kfunc that needs per-task rq-lock guarantees. Future patches adding cgroup-aware scheduling kfuncs (e.g., reading `task->task_group` safely) depend on `scx_kf_allowed_on_arg_tasks()` established here.

