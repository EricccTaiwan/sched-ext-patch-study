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

This patch introduces a new hook in the scheduler class switching process. It provides a way for a scheduler class to be notified *before* a task is fully switched to it. This is another preparatory change for the BPF extensible scheduler.

Here's a breakdown of the changes:

1.  **`sched_class->switching_to`:**
    -   A new function pointer, `switching_to`, is added to `struct sched_class` in `include/linux/sched/sched.h`.
    -   This hook is called before a task's scheduler class is changed, allowing the *new* scheduler class to perform any necessary setup.

2.  **`check_class_changing()`:**
    -   A new function `check_class_changing()` is added to `kernel/sched/core.c` and exposed in `kernel/sched/sched.h`.
    -   This function is the one that actually calls the `switching_to` hook if the scheduler class is about to change.
    -   It is called from `rt_mutex_setprio()` and `__sched_setscheduler()`, which are two places where a task's scheduling class can change.

3.  **No Behavior Change (Yet):**
    -   No existing scheduler class implements the `switching_to` hook in this patch.
    -   Therefore, this patch doesn't introduce any functional changes but provides the necessary infrastructure for future patches.

The rationale for this change is to allow the BPF scheduler to be notified when a task is switching to it. This notification happens before the task is enqueued on the runqueue, giving the BPF scheduler a chance to initialize its state for the task. For example, it can update its internal accounting of the task's priority and CPU mask. This is crucial for the BPF scheduler to maintain a consistent view of the tasks it manages.

