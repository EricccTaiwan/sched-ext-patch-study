# [PATCH 20/30] sched_ext: Add task state tracking operations

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-21-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-21-tj@kernel.org)

## Commit Message

```text
Being able to track the task runnable and running state transitions are
useful for a variety of purposes including latency tracking and load factor
calculation.

Currently, BPF schedulers don't have a good way of tracking these
transitions. Becoming runnable can be determined from ops.enqueue() but
becoming quiescent can only be inferred from the lack of subsequent enqueue.
Also, as the local dsq can have multiple tasks and some events are handled
in the sched_ext core, it's difficult to determine when a given task starts
and stops executing.

This patch adds sched_ext_ops.runnable(), .running(), .stopping() and
.quiescent() operations to track the task runnable and running state
transitions. They're mostly self explanatory; however, we want to ensure
that running <-> stopping transitions are always contained within runnable
<-> quiescent transitions which is a bit different from how the scheduler
core behaves. This adds a bit of complication. See the comment in
dequeue_task_scx().

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 kernel/sched/ext.c | 105 +++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 105 insertions(+)

diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 89bcca84d6b5..2e652f7b8f54 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -214,6 +214,72 @@ struct sched_ext_ops {
 	 */
 	void (*tick)(struct task_struct *p);
 
+	/**
+	 * runnable - A task is becoming runnable on its associated CPU
+	 * @p: task becoming runnable
+	 * @enq_flags: %SCX_ENQ_*
+	 *
+	 * This and the following three functions can be used to track a task's
+	 * execution state transitions. A task becomes ->runnable() on a CPU,
+	 * and then goes through one or more ->running() and ->stopping() pairs
+	 * as it runs on the CPU, and eventually becomes ->quiescent() when it's
+	 * done running on the CPU.
+	 *
+	 * @p is becoming runnable on the CPU because it's
+	 *
+	 * - waking up (%SCX_ENQ_WAKEUP)
+	 * - being moved from another CPU
+	 * - being restored after temporarily taken off the queue for an
+	 *   attribute change.
+	 *
+	 * This and ->enqueue() are related but not coupled. This operation
+	 * notifies @p's state transition and may not be followed by ->enqueue()
+	 * e.g. when @p is being dispatched to a remote CPU, or when @p is
+	 * being enqueued on a CPU experiencing a hotplug event. Likewise, a
+	 * task may be ->enqueue()'d without being preceded by this operation
+	 * e.g. after exhausting its slice.
+	 */
+	void (*runnable)(struct task_struct *p, u64 enq_flags);
+
+	/**
+	 * running - A task is starting to run on its associated CPU
+	 * @p: task starting to run
+	 *
+	 * See ->runnable() for explanation on the task state notifiers.
+	 */
+	void (*running)(struct task_struct *p);
+
+	/**
+	 * stopping - A task is stopping execution
+	 * @p: task stopping to run
+	 * @runnable: is task @p still runnable?
+	 *
+	 * See ->runnable() for explanation on the task state notifiers. If
+	 * !@runnable, ->quiescent() will be invoked after this operation
+	 * returns.
+	 */
+	void (*stopping)(struct task_struct *p, bool runnable);
+
+	/**
+	 * quiescent - A task is becoming not runnable on its associated CPU
+	 * @p: task becoming not runnable
+	 * @deq_flags: %SCX_DEQ_*
+	 *
+	 * See ->runnable() for explanation on the task state notifiers.
+	 *
+	 * @p is becoming quiescent on the CPU because it's
+	 *
+	 * - sleeping (%SCX_DEQ_SLEEP)
+	 * - being moved to another CPU
+	 * - being temporarily taken off the queue for an attribute change
+	 *   (%SCX_DEQ_SAVE)
+	 *
+	 * This and ->dequeue() are related but not coupled. This operation
+	 * notifies @p's state transition and may not be preceded by ->dequeue()
+	 * e.g. when @p is being dispatched to a remote CPU.
+	 */
+	void (*quiescent)(struct task_struct *p, u64 deq_flags);
+
 	/**
 	 * yield - Yield CPU
 	 * @from: yielding task
@@ -1359,6 +1425,9 @@ static void enqueue_task_scx(struct rq *rq, struct task_struct *p, int enq_flags
 	rq->scx.nr_running++;
 	add_nr_running(rq, 1);
 
+	if (SCX_HAS_OP(runnable))
+		SCX_CALL_OP(SCX_KF_REST, runnable, p, enq_flags);
+
 	do_enqueue_task(rq, p, enq_flags, sticky_cpu);
 }
 
@@ -1418,6 +1487,26 @@ static void dequeue_task_scx(struct rq *rq, struct task_struct *p, int deq_flags
 
 	ops_dequeue(p, deq_flags);
 
+	/*
+	 * A currently running task which is going off @rq first gets dequeued
+	 * and then stops running. As we want running <-> stopping transitions
+	 * to be contained within runnable <-> quiescent transitions, trigger
+	 * ->stopping() early here instead of in put_prev_task_scx().
+	 *
+	 * @p may go through multiple stopping <-> running transitions between
+	 * here and put_prev_task_scx() if task attribute changes occur while
+	 * balance_scx() leaves @rq unlocked. However, they don't contain any
+	 * information meaningful to the BPF scheduler and can be suppressed by
+	 * skipping the callbacks if the task is !QUEUED.
+	 */
+	if (SCX_HAS_OP(stopping) && task_current(rq, p)) {
+		update_curr_scx(rq);
+		SCX_CALL_OP(SCX_KF_REST, stopping, p, false);
+	}
+
+	if (SCX_HAS_OP(quiescent))
+		SCX_CALL_OP(SCX_KF_REST, quiescent, p, deq_flags);
+
 	if (deq_flags & SCX_DEQ_SLEEP)
 		p->scx.flags |= SCX_TASK_DEQD_FOR_SLEEP;
 	else
@@ -1999,6 +2088,10 @@ static void set_next_task_scx(struct rq *rq, struct task_struct *p, bool first)
 
 	p->se.exec_start = rq_clock_task(rq);
 
+	/* see dequeue_task_scx() on why we skip when !QUEUED */
+	if (SCX_HAS_OP(running) && (p->scx.flags & SCX_TASK_QUEUED))
+		SCX_CALL_OP(SCX_KF_REST, running, p);
+
 	clr_task_runnable(p, true);
 }
 
@@ -2037,6 +2130,10 @@ static void put_prev_task_scx(struct rq *rq, struct task_struct *p)
 
 	update_curr_scx(rq);
 
+	/* see dequeue_task_scx() on why we skip when !QUEUED */
+	if (SCX_HAS_OP(stopping) && (p->scx.flags & SCX_TASK_QUEUED))
+		SCX_CALL_OP(SCX_KF_REST, stopping, p, true);
+
 	/*
 	 * If we're being called from put_prev_task_balance(), balance_scx() may
 	 * have decided that @p should keep running.
@@ -4081,6 +4178,10 @@ static s32 select_cpu_stub(struct task_struct *p, s32 prev_cpu, u64 wake_flags)
 static void enqueue_stub(struct task_struct *p, u64 enq_flags) {}
 static void dequeue_stub(struct task_struct *p, u64 enq_flags) {}
 static void dispatch_stub(s32 prev_cpu, struct task_struct *p) {}
+static void runnable_stub(struct task_struct *p, u64 enq_flags) {}
+static void running_stub(struct task_struct *p) {}
+static void stopping_stub(struct task_struct *p, bool runnable) {}
+static void quiescent_stub(struct task_struct *p, u64 deq_flags) {}
 static bool yield_stub(struct task_struct *from, struct task_struct *to) { return false; }
 static void set_weight_stub(struct task_struct *p, u32 weight) {}
 static void set_cpumask_stub(struct task_struct *p, const struct cpumask *mask) {}
@@ -4097,6 +4198,10 @@ static struct sched_ext_ops __bpf_ops_sched_ext_ops = {
 	.enqueue = enqueue_stub,
 	.dequeue = dequeue_stub,
 	.dispatch = dispatch_stub,
+	.runnable = runnable_stub,
+	.running = running_stub,
+	.stopping = stopping_stub,
+	.quiescent = quiescent_stub,
 	.yield = yield_stub,
 	.set_weight = set_weight_stub,
 	.set_cpumask = set_cpumask_stub,
-- 
2.45.2
```

## Diff

```diff
---
 kernel/sched/ext.c | 105 +++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 105 insertions(+)

diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 89bcca84d6b5..2e652f7b8f54 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -214,6 +214,72 @@ struct sched_ext_ops {
 	 */
 	void (*tick)(struct task_struct *p);

+	/**
+	 * runnable - A task is becoming runnable on its associated CPU
+	 * @p: task becoming runnable
+	 * @enq_flags: %SCX_ENQ_*
+	 *
+	 * This and the following three functions can be used to track a task's
+	 * execution state transitions. A task becomes ->runnable() on a CPU,
+	 * and then goes through one or more ->running() and ->stopping() pairs
+	 * as it runs on the CPU, and eventually becomes ->quiescent() when it's
+	 * done running on the CPU.
+	 *
+	 * @p is becoming runnable on the CPU because it's
+	 *
+	 * - waking up (%SCX_ENQ_WAKEUP)
+	 * - being moved from another CPU
+	 * - being restored after temporarily taken off the queue for an
+	 *   attribute change.
+	 *
+	 * This and ->enqueue() are related but not coupled. This operation
+	 * notifies @p's state transition and may not be followed by ->enqueue()
+	 * e.g. when @p is being dispatched to a remote CPU, or when @p is
+	 * being enqueued on a CPU experiencing a hotplug event. Likewise, a
+	 * task may be ->enqueue()'d without being preceded by this operation
+	 * e.g. after exhausting its slice.
+	 */
+	void (*runnable)(struct task_struct *p, u64 enq_flags);
+
+	/**
+	 * running - A task is starting to run on its associated CPU
+	 * @p: task starting to run
+	 *
+	 * See ->runnable() for explanation on the task state notifiers.
+	 */
+	void (*running)(struct task_struct *p);
+
+	/**
+	 * stopping - A task is stopping execution
+	 * @p: task stopping to run
+	 * @runnable: is task @p still runnable?
+	 *
+	 * See ->runnable() for explanation on the task state notifiers. If
+	 * !@runnable, ->quiescent() will be invoked after this operation
+	 * returns.
+	 */
+	void (*stopping)(struct task_struct *p, bool runnable);
+
+	/**
+	 * quiescent - A task is becoming not runnable on its associated CPU
+	 * @p: task becoming not runnable
+	 * @deq_flags: %SCX_DEQ_*
+	 *
+	 * See ->runnable() for explanation on the task state notifiers.
+	 *
+	 * @p is becoming quiescent on the CPU because it's
+	 *
+	 * - sleeping (%SCX_DEQ_SLEEP)
+	 * - being moved to another CPU
+	 * - being temporarily taken off the queue for an attribute change
+	 *   (%SCX_DEQ_SAVE)
+	 *
+	 * This and ->dequeue() are related but not coupled. This operation
+	 * notifies @p's state transition and may not be preceded by ->dequeue()
+	 * e.g. when @p is being dispatched to a remote CPU.
+	 */
+	void (*quiescent)(struct task_struct *p, u64 deq_flags);
+
 	/**
 	 * yield - Yield CPU
 	 * @from: yielding task
@@ -1359,6 +1425,9 @@ static void enqueue_task_scx(struct rq *rq, struct task_struct *p, int enq_flags
 	rq->scx.nr_running++;
 	add_nr_running(rq, 1);

+	if (SCX_HAS_OP(runnable))
+		SCX_CALL_OP(SCX_KF_REST, runnable, p, enq_flags);
+
 	do_enqueue_task(rq, p, enq_flags, sticky_cpu);
 }

@@ -1418,6 +1487,26 @@ static void dequeue_task_scx(struct rq *rq, struct task_struct *p, int deq_flags

 	ops_dequeue(p, deq_flags);

+	/*
+	 * A currently running task which is going off @rq first gets dequeued
+	 * and then stops running. As we want running <-> stopping transitions
+	 * to be contained within runnable <-> quiescent transitions, trigger
+	 * ->stopping() early here instead of in put_prev_task_scx().
+	 *
+	 * @p may go through multiple stopping <-> running transitions between
+	 * here and put_prev_task_scx() if task attribute changes occur while
+	 * balance_scx() leaves @rq unlocked. However, they don't contain any
+	 * information meaningful to the BPF scheduler and can be suppressed by
+	 * skipping the callbacks if the task is !QUEUED.
+	 */
+	if (SCX_HAS_OP(stopping) && task_current(rq, p)) {
+		update_curr_scx(rq);
+		SCX_CALL_OP(SCX_KF_REST, stopping, p, false);
+	}
+
+	if (SCX_HAS_OP(quiescent))
+		SCX_CALL_OP(SCX_KF_REST, quiescent, p, deq_flags);
+
 	if (deq_flags & SCX_DEQ_SLEEP)
 		p->scx.flags |= SCX_TASK_DEQD_FOR_SLEEP;
 	else
@@ -1999,6 +2088,10 @@ static void set_next_task_scx(struct rq *rq, struct task_struct *p, bool first)

 	p->se.exec_start = rq_clock_task(rq);

+	/* see dequeue_task_scx() on why we skip when !QUEUED */
+	if (SCX_HAS_OP(running) && (p->scx.flags & SCX_TASK_QUEUED))
+		SCX_CALL_OP(SCX_KF_REST, running, p);
+
 	clr_task_runnable(p, true);
 }

@@ -2037,6 +2130,10 @@ static void put_prev_task_scx(struct rq *rq, struct task_struct *p)

 	update_curr_scx(rq);

+	/* see dequeue_task_scx() on why we skip when !QUEUED */
+	if (SCX_HAS_OP(stopping) && (p->scx.flags & SCX_TASK_QUEUED))
+		SCX_CALL_OP(SCX_KF_REST, stopping, p, true);
+
 	/*
 	 * If we're being called from put_prev_task_balance(), balance_scx() may
 	 * have decided that @p should keep running.
@@ -4081,6 +4178,10 @@ static s32 select_cpu_stub(struct task_struct *p, s32 prev_cpu, u64 wake_flags)
 static void enqueue_stub(struct task_struct *p, u64 enq_flags) {}
 static void dequeue_stub(struct task_struct *p, u64 enq_flags) {}
 static void dispatch_stub(s32 prev_cpu, struct task_struct *p) {}
+static void runnable_stub(struct task_struct *p, u64 enq_flags) {}
+static void running_stub(struct task_struct *p) {}
+static void stopping_stub(struct task_struct *p, bool runnable) {}
+static void quiescent_stub(struct task_struct *p, u64 deq_flags) {}
 static bool yield_stub(struct task_struct *from, struct task_struct *to) { return false; }
 static void set_weight_stub(struct task_struct *p, u32 weight) {}
 static void set_cpumask_stub(struct task_struct *p, const struct cpumask *mask) {}
@@ -4097,6 +4198,10 @@ static struct sched_ext_ops __bpf_ops_sched_ext_ops = {
 	.enqueue = enqueue_stub,
 	.dequeue = dequeue_stub,
 	.dispatch = dispatch_stub,
+	.runnable = runnable_stub,
+	.running = running_stub,
+	.stopping = stopping_stub,
+	.quiescent = quiescent_stub,
 	.yield = yield_stub,
 	.set_weight = set_weight_stub,
 	.set_cpumask = set_cpumask_stub,
--
2.45.2


```

## Implementation Analysis

### High-Level Analysis
Being able to track the task runnable and running state transitions are

### Detailed Walkthrough
1. File: `kernel/sched/ext.c`
   Hunk: `@@ -214,6 +214,72 @@ struct sched_ext_ops {`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   /**
   * runnable - A task is becoming runnable on its associated CPU
   * @p: task becoming runnable
   ```
   Note
   ```text
   Additional hunks continue in this file (6 more section(s)).
   ```

### sched_ext Context
This patch directly expands sched_ext integration points and makes the scheduler core more extensible for BPF-defined policies.

