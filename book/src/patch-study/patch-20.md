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

### Overview

BPF schedulers need accurate per-task timing data to implement policies like load balancing, latency-aware scheduling, or utilization-based admission. Before this patch, a BPF scheduler could detect when a task became runnable (from `ops.enqueue()`) but had no direct way to know when it started executing, when it stopped, or when it went to sleep. This patch adds four state-transition callbacks — `ops.runnable()`, `ops.running()`, `ops.stopping()`, and `ops.quiescent()` — that together form a complete task lifecycle notification system.

### Code Walkthrough

**New callbacks in `sched_ext_ops`**

```c
void (*runnable)(struct task_struct *p, u64 enq_flags);
void (*running)(struct task_struct *p);
void (*stopping)(struct task_struct *p, bool runnable);
void (*quiescent)(struct task_struct *p, u64 deq_flags);
```

The four callbacks describe a two-level state machine:
- Outer level: **runnable** ↔ **quiescent** (is the task on a run queue?)
- Inner level: **running** ↔ **stopping** (is the task currently executing on a CPU?)

The invariant sched_ext enforces is: `running ↔ stopping` transitions are always contained within `runnable ↔ quiescent` transitions. This is a stronger guarantee than the raw scheduler provides and requires special handling in `dequeue_task_scx()`.

**`enqueue_task_scx()` → `ops.runnable()`**

```c
static void enqueue_task_scx(struct rq *rq, struct task_struct *p, int enq_flags)
{
    ...
    rq->scx.nr_running++;
    add_nr_running(rq, 1);

    if (SCX_HAS_OP(runnable))
        SCX_CALL_OP_TASK(SCX_KF_REST, runnable, p, enq_flags);

    do_enqueue_task(rq, p, enq_flags, sticky_cpu);
}
```

Called before `do_enqueue_task()` so the BPF scheduler sees the task enter its runnable state before any dispatch decisions are made. `enq_flags` carries context: `SCX_ENQ_WAKEUP` if the task is waking from sleep, or nothing if it is being moved from another CPU.

**`dequeue_task_scx()` → `ops.stopping()` (early) + `ops.quiescent()`**

This is the trickiest part of the patch:

```c
static void dequeue_task_scx(struct rq *rq, struct task_struct *p, int deq_flags)
{
    ...
    ops_dequeue(p, deq_flags);

    /*
     * A currently running task which is going off @rq first gets dequeued
     * and then stops running. As we want running <-> stopping transitions
     * to be contained within runnable <-> quiescent transitions, trigger
     * ->stopping() early here instead of in put_prev_task_scx().
     */
    if (SCX_HAS_OP(stopping) && task_current(rq, p)) {
        update_curr_scx(rq);
        SCX_CALL_OP_TASK(SCX_KF_REST, stopping, p, false);
    }

    if (SCX_HAS_OP(quiescent))
        SCX_CALL_OP_TASK(SCX_KF_REST, quiescent, p, deq_flags);
    ...
}
```

The kernel's normal ordering is: dequeue the task, then (when another task is selected) call `put_prev_task()`. For the state machine invariant, `quiescent` must come AFTER `stopping`. If the task is currently running (`task_current(rq, p)`), `stopping` must be fired here — in `dequeue_task_scx()` — before `quiescent`, not later in `put_prev_task_scx()`. This produces the correct sequence: `stopping(false)` → `quiescent()`.

**`set_next_task_scx()` → `ops.running()`**

```c
static void set_next_task_scx(struct rq *rq, struct task_struct *p, bool first)
{
    ...
    /* see dequeue_task_scx() on why we skip when !QUEUED */
    if (SCX_HAS_OP(running) && (p->scx.flags & SCX_TASK_QUEUED))
        SCX_CALL_OP_TASK(SCX_KF_REST, running, p);

    clr_task_runnable(p, true);
}
```

`ops.running()` is called when a task is about to start executing (selected as the next task). The `SCX_TASK_QUEUED` guard is explained by the dequeue early-`stopping()` logic: if a task was dequeued (and thus had `stopping(false)` fired) but the kernel still calls `set_next_task_scx()` for it during balance races, the `!QUEUED` guard prevents a spurious `running()` call after `stopping()`.

**`put_prev_task_scx()` → `ops.stopping(runnable=true)`**

```c
static void put_prev_task_scx(struct rq *rq, struct task_struct *p)
{
    ...
    /* see dequeue_task_scx() on why we skip when !QUEUED */
    if (SCX_HAS_OP(stopping) && (p->scx.flags & SCX_TASK_QUEUED))
        SCX_CALL_OP_TASK(SCX_KF_REST, stopping, p, true);
    ...
}
```

`ops.stopping(p, runnable=true)` is fired when a task yields the CPU but is still runnable (will be re-enqueued). The `runnable` parameter tells the BPF scheduler whether to expect a follow-up `quiescent()` (when `runnable=false`) or not.

**Stub functions**

```c
static void runnable_stub(struct task_struct *p, u64 enq_flags) {}
static void running_stub(struct task_struct *p) {}
static void stopping_stub(struct task_struct *p, bool runnable) {}
static void quiescent_stub(struct task_struct *p, u64 deq_flags) {}
```

Added to `__bpf_ops_sched_ext_ops` (the dummy ops used for BPF verifier type checking). These ensure the BPF verifier knows the correct function signatures for these callbacks.

### Key Concepts

- **State machine invariant**: `running` ↔ `stopping` transitions are always nested within `runnable` ↔ `quiescent`. This is enforced by triggering `stopping(false)` early in `dequeue_task_scx()` when a currently-running task is dequeued.
- **`stopping(p, runnable)` semantics**: The `runnable` bool tells the BPF scheduler what comes next. `runnable=true` means the task is preempted or yielded but stays on the run queue — no `quiescent()` will follow. `runnable=false` means the task is leaving the run queue — `quiescent()` will follow immediately.
- **`SCX_TASK_QUEUED` guard**: Both `ops.running()` and `ops.stopping(runnable=true)` check `SCX_TASK_QUEUED`. If the task is not queued (was already dequeued, which triggered early `stopping(false)`), these callbacks are skipped. This prevents duplicate `stopping` calls.
- **Decoupling from `enqueue`/`dequeue`**: The comment in `ops.runnable()` documentation is explicit: `runnable()` and `enqueue()` are related but NOT coupled. A task can become `runnable()` without a subsequent `enqueue()` (e.g., dispatched to a remote CPU's local DSQ directly), and a task can be `enqueue()`d without a preceding `runnable()` (e.g., after exhausting its slice, which doesn't re-enter the runnable notification path).

### Locking and Concurrency Notes

- `ops.runnable()` is called from `enqueue_task_scx()` with `rq->lock` held. The BPF callback runs in `SCX_KF_REST` context.
- `ops.quiescent()` is called from `dequeue_task_scx()` with `rq->lock` held.
- `ops.running()` is called from `set_next_task_scx()` with `rq->lock` held.
- `ops.stopping()` is called from both `dequeue_task_scx()` (the early path) and `put_prev_task_scx()`, both with `rq->lock` held.
- All four callbacks are called under `rq->lock`. BPF schedulers using these callbacks for per-task accounting must use lock-free data structures (BPF spinlocks or per-CPU data) to avoid deadlock.
- The `SCX_CALL_OP_TASK()` macro (introduced by PATCH 22/30) is used here — it sets `current->scx.kf_tasks[0] = p` before the call, enabling kfuncs that require the task to be "in-flight" to verify the task argument.

### Why Maintainers Need to Know This

- **The early `stopping()` in `dequeue_task_scx()` is subtle**: New contributors often miss the comment explaining why `stopping(false)` fires during `dequeue` rather than during `put_prev_task`. The reason is the invariant: `quiescent` must come last. If `stopping` fired in `put_prev_task_scx` as it would naturally, the order would be `quiescent` → `stopping`, violating the contract.
- **`runnable()` ≠ `enqueue()`: use both for accurate accounting**: A task being migrated (pulled from another CPU) triggers `runnable()` without triggering `enqueue()`. A BPF scheduler tracking queue depth via `enqueue()`/`dequeue()` will miscount tasks that are migrated. Use `runnable()`/`quiescent()` for task-count accounting and `enqueue()`/`dequeue()` for dispatch queue accounting.
- **`stopping(runnable=false)` followed by `quiescent()` is the sleep notification**: When a task calls `sleep()` or blocks on I/O, the sequence is `stopping(false)` then `quiescent(SCX_DEQ_SLEEP)`. A BPF scheduler tracking sleeping tasks should check `deq_flags & SCX_DEQ_SLEEP` in `quiescent()`.
- **`scx_central` in PATCH 21/30 uses `running`/`stopping` for timer-based preemption**: The `cpu_started_at[]` array records when each CPU's current task started running (in `ops.running()`) and clears it when the task stops (in `ops.stopping()`). The BPF timer compares `bpf_ktime_get_ns()` against `started_at + slice_ns` to decide which CPUs to preempt.

### Connection to Other Patches

- **PATCH 22/30** replaces `SCX_CALL_OP()` with `SCX_CALL_OP_TASK()` for all callbacks that take a task argument, including all four introduced here. This enables task-specific kfuncs to verify their input task.
- **PATCH 21/30** (`scx_central` tickless) is the first real user of `ops.running()` and `ops.stopping()` in the example schedulers, using them to track per-CPU execution start times for timer-based slice enforcement.
- The `enq_flags` passed to `ops.runnable()` and `deq_flags` passed to `ops.quiescent()` use the same flag namespaces (`SCX_ENQ_*` and `SCX_DEQ_*`) established in earlier patches for `ops.enqueue()` and `ops.dequeue()`.

