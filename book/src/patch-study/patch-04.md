# [PATCH 04/30] sched: Add sched_class->switching_to() and expose check_class_changing/changed()

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-5-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-5-tj@kernel.org)

## Commit Message

```text
When a task switches to a new sched_class, the prev and new classes are
notified through ->switched_from() and ->switched_to(), respectively, after
the switching is done.

A new BPF extensible sched_class will have callbacks that allow the BPF
scheduler to keep track of relevant task states (like priority and cpumask).
Those callbacks aren't called while a task is on a different sched_class.
When a task comes back, we wanna tell the BPF progs the up-to-date state
before the task gets enqueued, so we need a hook which is called before the
switching is committed.

This patch adds ->switching_to() which is called during sched_class switch
through check_class_changing() before the task is restored. Also, this patch
exposes check_class_changing/changed() in kernel/sched/sched.h. They will be
used by the new BPF extensible sched_class to implement implicit sched_class
switching which is used e.g. when falling back to CFS when the BPF scheduler
fails or unloads.

This is a prep patch and doesn't cause any behavior changes. The new
operation and exposed functions aren't used yet.

v3: Refreshed on top of tip:sched/core.

v2: Improve patch description w/ details on planned use.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 kernel/sched/core.c     | 12 ++++++++++++
 kernel/sched/sched.h    |  3 +++
 kernel/sched/syscalls.c |  1 +
 3 files changed, 16 insertions(+)

diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 48f9d00d0666..b088fbeaf26d 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -2035,6 +2035,17 @@ inline int task_curr(const struct task_struct *p)
 	return cpu_curr(task_cpu(p)) == p;
 }
 
+/*
+ * ->switching_to() is called with the pi_lock and rq_lock held and must not
+ * mess with locking.
+ */
+void check_class_changing(struct rq *rq, struct task_struct *p,
+			  const struct sched_class *prev_class)
+{
+	if (prev_class != p->sched_class && p->sched_class->switching_to)
+		p->sched_class->switching_to(rq, p);
+}
+
 /*
  * switched_from, switched_to and prio_changed must _NOT_ drop rq->lock,
  * use the balance_callback list if you want balancing.
@@ -7021,6 +7032,7 @@ void rt_mutex_setprio(struct task_struct *p, struct task_struct *pi_task)
 	}
 
 	__setscheduler_prio(p, prio);
+	check_class_changing(rq, p, prev_class);
 
 	if (queued)
 		enqueue_task(rq, p, queue_flag);
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index a2399ccf259a..0ed4271cedf5 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -2322,6 +2322,7 @@ struct sched_class {
 	 * cannot assume the switched_from/switched_to pair is serialized by
 	 * rq->lock. They are however serialized by p->pi_lock.
 	 */
+	void (*switching_to) (struct rq *this_rq, struct task_struct *task);
 	void (*switched_from)(struct rq *this_rq, struct task_struct *task);
 	void (*switched_to)  (struct rq *this_rq, struct task_struct *task);
 	void (*reweight_task)(struct rq *this_rq, struct task_struct *task,
@@ -3608,6 +3609,8 @@ extern void set_load_weight(struct task_struct *p, bool update_load);
 extern void enqueue_task(struct rq *rq, struct task_struct *p, int flags);
 extern void dequeue_task(struct rq *rq, struct task_struct *p, int flags);
 
+extern void check_class_changing(struct rq *rq, struct task_struct *p,
+				 const struct sched_class *prev_class);
 extern void check_class_changed(struct rq *rq, struct task_struct *p,
 				const struct sched_class *prev_class,
 				int oldprio);
diff --git a/kernel/sched/syscalls.c b/kernel/sched/syscalls.c
index ae1b42775ef9..cf189bc3dd18 100644
--- a/kernel/sched/syscalls.c
+++ b/kernel/sched/syscalls.c
@@ -797,6 +797,7 @@ int __sched_setscheduler(struct task_struct *p,
 		__setscheduler_prio(p, newprio);
 	}
 	__setscheduler_uclamp(p, attr);
+	check_class_changing(rq, p, prev_class);
 
 	if (queued) {
 		/*
-- 
2.45.2
```

## Diff

```diff
---
 kernel/sched/core.c     | 12 ++++++++++++
 kernel/sched/sched.h    |  3 +++
 kernel/sched/syscalls.c |  1 +
 3 files changed, 16 insertions(+)

diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 48f9d00d0666..b088fbeaf26d 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -2035,6 +2035,17 @@ inline int task_curr(const struct task_struct *p)
 	return cpu_curr(task_cpu(p)) == p;
 }

+/*
+ * ->switching_to() is called with the pi_lock and rq_lock held and must not
+ * mess with locking.
+ */
+void check_class_changing(struct rq *rq, struct task_struct *p,
+			  const struct sched_class *prev_class)
+{
+	if (prev_class != p->sched_class && p->sched_class->switching_to)
+		p->sched_class->switching_to(rq, p);
+}
+
 /*
  * switched_from, switched_to and prio_changed must _NOT_ drop rq->lock,
  * use the balance_callback list if you want balancing.
@@ -7021,6 +7032,7 @@ void rt_mutex_setprio(struct task_struct *p, struct task_struct *pi_task)
 	}

 	__setscheduler_prio(p, prio);
+	check_class_changing(rq, p, prev_class);

 	if (queued)
 		enqueue_task(rq, p, queue_flag);
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index a2399ccf259a..0ed4271cedf5 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -2322,6 +2322,7 @@ struct sched_class {
 	 * cannot assume the switched_from/switched_to pair is serialized by
 	 * rq->lock. They are however serialized by p->pi_lock.
 	 */
+	void (*switching_to) (struct rq *this_rq, struct task_struct *task);
 	void (*switched_from)(struct rq *this_rq, struct task_struct *task);
 	void (*switched_to)  (struct rq *this_rq, struct task_struct *task);
 	void (*reweight_task)(struct rq *this_rq, struct task_struct *task,
@@ -3608,6 +3609,8 @@ extern void set_load_weight(struct task_struct *p, bool update_load);
 extern void enqueue_task(struct rq *rq, struct task_struct *p, int flags);
 extern void dequeue_task(struct rq *rq, struct task_struct *p, int flags);

+extern void check_class_changing(struct rq *rq, struct task_struct *p,
+				 const struct sched_class *prev_class);
 extern void check_class_changed(struct rq *rq, struct task_struct *p,
 				const struct sched_class *prev_class,
 				int oldprio);
diff --git a/kernel/sched/syscalls.c b/kernel/sched/syscalls.c
index ae1b42775ef9..cf189bc3dd18 100644
--- a/kernel/sched/syscalls.c
+++ b/kernel/sched/syscalls.c
@@ -797,6 +797,7 @@ int __sched_setscheduler(struct task_struct *p,
 		__setscheduler_prio(p, newprio);
 	}
 	__setscheduler_uclamp(p, attr);
+	check_class_changing(rq, p, prev_class);

 	if (queued) {
 		/*
--
2.45.2


```

## Implementation Analysis

### Overview

This patch adds a `switching_to()` callback to the `sched_class` vtable that fires just before a task's class transition is committed, and exposes `check_class_changing()` alongside the already-existing `check_class_changed()` so both can be called from sched_ext's own implicit-switch code paths. The critical distinction from the existing `switched_to()` callback is timing: `switching_to()` fires while both the old and new class identity are known but before the task is enqueued, giving the new class a window to synchronize its state before the task becomes runnable under it.

### Background: The Linux Scheduler Class Hierarchy

When a task moves from one scheduler class to another — for example, from CFS to sched_ext, or from rt back to CFS when an RT mutex is released — the kernel calls a pair of callbacks:

- `switched_from(rq, p)`: called on the **old** class, after the switch is done
- `switched_to(rq, p)`: called on the **new** class, after the switch is done

Both callbacks are called by `check_class_changed()`, which is invoked after `p->sched_class` has already been updated. At this point the task may already be enqueued.

sched_ext maintains callbacks that track per-task state changes: priority, cpumask, etc. While a task is running under a different class, those callbacks are not invoked — sched_ext deliberately does not track tasks that do not belong to it. When a task returns to sched_ext, the BPF program needs to receive a full state sync before it ever sees the task in an enqueue callback, otherwise its view of the task's priority and cpumask will be stale.

`switched_to()` is too late for this: at that point, the task may already be enqueued. What is needed is a hook that fires after `p->sched_class` is updated but before the task is placed on a runqueue — which is what `switching_to()` provides.

### The Problem Being Solved

There was no hook in the class-switch path that ran before the task became runnable under the new class. The two existing hooks (`switched_from`, `switched_to`) both run after the switch is committed and the task may already be on a runqueue. For sched_ext, this creates a race: the BPF program could receive an `enqueue` event before it has had a chance to synchronize the task's priority, cpumask, or other state.

Additionally, sched_ext will implement **implicit class switching**: when the BPF scheduler fails or unloads, tasks that were running under `ext_sched_class` must be silently migrated back to CFS. This migration is triggered from within sched_ext itself, not from `__sched_setscheduler()`. The existing `check_class_changing()` and `check_class_changed()` functions existed but were `static` or module-internal — not exposed in `sched.h` — so sched_ext could not call them directly.

### Code Walkthrough

**`kernel/sched/sched.h`** — new vtable slot:

```c
+	void (*switching_to) (struct rq *this_rq, struct task_struct *task);
 	void (*switched_from)(struct rq *this_rq, struct task_struct *task);
 	void (*switched_to)  (struct rq *this_rq, struct task_struct *task);
```

`switching_to` is inserted immediately before `switched_from` in the vtable, making the trio `switching_to → switched_from → switched_to` read in chronological order. Called with `pi_lock` and `rq_lock` held (as noted in the comment added to `core.c`), so implementations must not acquire locks.

**`kernel/sched/core.c`** — `check_class_changing()` is added:

```c
+void check_class_changing(struct rq *rq, struct task_struct *p,
+			   const struct sched_class *prev_class)
+{
+	if (prev_class != p->sched_class && p->sched_class->switching_to)
+		p->sched_class->switching_to(rq, p);
+}
```

The function checks two things: (1) the class actually changed (comparing `prev_class` to the now-updated `p->sched_class`), and (2) the new class implements `switching_to`. Note that at call time, `p->sched_class` has already been updated to the new class — the new class is calling `switching_to` on itself. `prev_class` is the caller's saved snapshot of the old class pointer.

`check_class_changing()` is then inserted at two sites where a class change can occur:

In `rt_mutex_setprio()` (priority inheritance — a task inherits a higher priority from a lock holder):

```c
 	__setscheduler_prio(p, prio);
+	check_class_changing(rq, p, prev_class);

 	if (queued)
 		enqueue_task(rq, p, queue_flag);
```

In `__sched_setscheduler()` (explicit policy/priority change from syscall):

```c
 	__setscheduler_uclamp(p, attr);
+	check_class_changing(rq, p, prev_class);

 	if (queued) {
```

In both cases, `check_class_changing()` is called after the class pointer is updated but before `enqueue_task()` — precisely the window sched_ext needs.

**`kernel/sched/sched.h`** — both functions are now declared as extern:

```c
+extern void check_class_changing(struct rq *rq, struct task_struct *p,
+				 const struct sched_class *prev_class);
 extern void check_class_changed(struct rq *rq, struct task_struct *p,
 				const struct sched_class *prev_class,
 				int oldprio);
```

Exposing `check_class_changing()` here allows sched_ext (which lives in its own file) to call it during implicit class switches without duplicating the logic.

### Why sched_ext Needs This

When a task re-enters sched_ext (e.g., after being temporarily boosted to a real-time priority via priority inheritance), the BPF program needs to know the task's current state before it can correctly schedule it. `switching_to()` is the hook where sched_ext will call back into the BPF program to push the current priority, cpumask, and any other cached state before the first enqueue. Without this hook, the BPF program would receive an enqueue event for a task whose state it has not seen updated since the task last left the ext class — potentially scheduling it with wrong weight or wrong CPU affinity.

The exposure of `check_class_changing()` in `sched.h` enables sched_ext to trigger the `switching_to` → `switched_from` + `switched_to` sequence correctly during its own implicit class switches (fallback to CFS on BPF program failure).

### Connection to Other Patches

This patch depends on patch 03 having added the `reweight_task` slot, establishing the pattern of adding vtable operations for sched_ext's needs. The sched_ext class implementation later in the series implements `switching_to` to sync BPF task state. `check_class_changing()` will also be called from sched_ext's own class-switch code paths. Without this patch, sched_ext has no pre-enqueue synchronization point.

### Key Data Structures / Functions Modified

- **`struct sched_class`** (`kernel/sched/sched.h`): Gains the `switching_to` function pointer, placed before `switched_from` in declaration order.
- **`check_class_changing()`** (`kernel/sched/core.c`, now exposed in `kernel/sched/sched.h`): Dispatches `switching_to` when a class change is detected. Called after `p->sched_class` is updated but before `enqueue_task()`.
- **`check_class_changed()`** (`kernel/sched/sched.h`): The existing post-switch dispatcher for `switched_from` and `switched_to`. Now declared alongside `check_class_changing()` in the header to make the pair's roles clear.
- **`rt_mutex_setprio()`** (`kernel/sched/core.c`): Handles priority changes due to priority inheritance (PI mutexes). Now calls `check_class_changing()` after updating `p->sched_class`.
- **`__sched_setscheduler()`** (`kernel/sched/syscalls.c`): Handles `sched_setscheduler()` and `sched_setattr()` syscalls. Also now calls `check_class_changing()` after updating `p->sched_class`.

