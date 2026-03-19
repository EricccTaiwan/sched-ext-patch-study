# [PATCH 03/30] sched: Add sched_class->reweight_task()

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-4-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-4-tj@kernel.org)

## Commit Message

```text
Currently, during a task weight change, sched core directly calls
reweight_task() defined in fair.c if @p is on CFS. Let's make it a proper
sched_class operation instead. CFS's reweight_task() is renamed to
reweight_task_fair() and now called through sched_class.

While it turns a direct call into an indirect one, set_load_weight() isn't
called from a hot path and this change shouldn't cause any noticeable
difference. This will be used to implement reweight_task for a new BPF
extensible sched_class so that it can keep its cached task weight
up-to-date.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 kernel/sched/core.c  | 4 ++--
 kernel/sched/fair.c  | 3 ++-
 kernel/sched/sched.h | 4 ++--
 3 files changed, 6 insertions(+), 5 deletions(-)

diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 095604490c26..48f9d00d0666 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -1343,8 +1343,8 @@ void set_load_weight(struct task_struct *p, bool update_load)
 	 * SCHED_OTHER tasks have to update their load when changing their
 	 * weight
 	 */
-	if (update_load && p->sched_class == &fair_sched_class) {
-		reweight_task(p, prio);
+	if (update_load && p->sched_class->reweight_task) {
+		p->sched_class->reweight_task(task_rq(p), p, prio);
 	} else {
 		load->weight = scale_load(sched_prio_to_weight[prio]);
 		load->inv_weight = sched_prio_to_wmult[prio];
diff --git a/kernel/sched/fair.c b/kernel/sched/fair.c
index 41b58387023d..18ecd4f908e4 100644
--- a/kernel/sched/fair.c
+++ b/kernel/sched/fair.c
@@ -3835,7 +3835,7 @@ static void reweight_entity(struct cfs_rq *cfs_rq, struct sched_entity *se,
 	}
 }
 
-void reweight_task(struct task_struct *p, int prio)
+static void reweight_task_fair(struct rq *rq, struct task_struct *p, int prio)
 {
 	struct sched_entity *se = &p->se;
 	struct cfs_rq *cfs_rq = cfs_rq_of(se);
@@ -13221,6 +13221,7 @@ DEFINE_SCHED_CLASS(fair) = {
 	.task_tick		= task_tick_fair,
 	.task_fork		= task_fork_fair,
 
+	.reweight_task		= reweight_task_fair,
 	.prio_changed		= prio_changed_fair,
 	.switched_from		= switched_from_fair,
 	.switched_to		= switched_to_fair,
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 62fd8bc6fd08..a2399ccf259a 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -2324,6 +2324,8 @@ struct sched_class {
 	 */
 	void (*switched_from)(struct rq *this_rq, struct task_struct *task);
 	void (*switched_to)  (struct rq *this_rq, struct task_struct *task);
+	void (*reweight_task)(struct rq *this_rq, struct task_struct *task,
+			      int newprio);
 	void (*prio_changed) (struct rq *this_rq, struct task_struct *task,
 			      int oldprio);
 
@@ -2509,8 +2511,6 @@ extern void init_sched_dl_class(void);
 extern void init_sched_rt_class(void);
 extern void init_sched_fair_class(void);
 
-extern void reweight_task(struct task_struct *p, int prio);
-
 extern void resched_curr(struct rq *rq);
 extern void resched_cpu(int cpu);
 
-- 
2.45.2
```

## Diff

```diff
---
 kernel/sched/core.c  | 4 ++--
 kernel/sched/fair.c  | 3 ++-
 kernel/sched/sched.h | 4 ++--
 3 files changed, 6 insertions(+), 5 deletions(-)

diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 095604490c26..48f9d00d0666 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -1343,8 +1343,8 @@ void set_load_weight(struct task_struct *p, bool update_load)
 	 * SCHED_OTHER tasks have to update their load when changing their
 	 * weight
 	 */
-	if (update_load && p->sched_class == &fair_sched_class) {
-		reweight_task(p, prio);
+	if (update_load && p->sched_class->reweight_task) {
+		p->sched_class->reweight_task(task_rq(p), p, prio);
 	} else {
 		load->weight = scale_load(sched_prio_to_weight[prio]);
 		load->inv_weight = sched_prio_to_wmult[prio];
diff --git a/kernel/sched/fair.c b/kernel/sched/fair.c
index 41b58387023d..18ecd4f908e4 100644
--- a/kernel/sched/fair.c
+++ b/kernel/sched/fair.c
@@ -3835,7 +3835,7 @@ static void reweight_entity(struct cfs_rq *cfs_rq, struct sched_entity *se,
 	}
 }

-void reweight_task(struct task_struct *p, int prio)
+static void reweight_task_fair(struct rq *rq, struct task_struct *p, int prio)
 {
 	struct sched_entity *se = &p->se;
 	struct cfs_rq *cfs_rq = cfs_rq_of(se);
@@ -13221,6 +13221,7 @@ DEFINE_SCHED_CLASS(fair) = {
 	.task_tick		= task_tick_fair,
 	.task_fork		= task_fork_fair,

+	.reweight_task		= reweight_task_fair,
 	.prio_changed		= prio_changed_fair,
 	.switched_from		= switched_from_fair,
 	.switched_to		= switched_to_fair,
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 62fd8bc6fd08..a2399ccf259a 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -2324,6 +2324,8 @@ struct sched_class {
 	 */
 	void (*switched_from)(struct rq *this_rq, struct task_struct *task);
 	void (*switched_to)  (struct rq *this_rq, struct task_struct *task);
+	void (*reweight_task)(struct rq *this_rq, struct task_struct *task,
+			      int newprio);
 	void (*prio_changed) (struct rq *this_rq, struct task_struct *task,
 			      int oldprio);

@@ -2509,8 +2511,6 @@ extern void init_sched_dl_class(void);
 extern void init_sched_rt_class(void);
 extern void init_sched_fair_class(void);

-extern void reweight_task(struct task_struct *p, int prio);
-
 extern void resched_curr(struct rq *rq);
 extern void resched_cpu(int cpu);

--
2.45.2


```

## Implementation Analysis

### Overview

This patch promotes `reweight_task()` from a CFS-private function called directly by the scheduler core into a proper `sched_class` vtable operation. The core's `set_load_weight()` previously hard-coded a check for `fair_sched_class` before calling the function; now it tests whether the class implements the operation at all and dispatches through the vtable. This is required so that sched_ext can receive notification when a task's nice value (and thus its scheduling weight) changes while the task is running under the ext class.

### Background: The Linux Scheduler Class Hierarchy

The `struct sched_class` in `kernel/sched/sched.h` is a vtable — a set of function pointers that the scheduler core calls to implement scheduling operations. Each scheduling class (stop, dl, rt, fair, idle — and in this series, ext) fills in the operations it supports. Operations that a class does not implement are left as `NULL`, and callers check for `NULL` before invoking them.

When the user changes a task's nice value (via `nice()` or `setpriority()`), the kernel calls `set_load_weight()` to update the task's `load_weight` fields. For a CFS task, the weight also needs to be reflected in the task's position in the red-black tree via `reweight_entity()`. Before this patch, `set_load_weight()` knew it had to call into CFS by checking `p->sched_class == &fair_sched_class` — a hardcoded class comparison that cannot work for a new class like ext.

### The Problem Being Solved

`set_load_weight()` in `kernel/sched/core.c` contained this pattern:

```c
if (update_load && p->sched_class == &fair_sched_class) {
    reweight_task(p, prio);
}
```

This is a direct, class-specific call bypassing the vtable. It breaks in two ways for sched_ext:

1. When a task runs under `ext_sched_class` and the user changes its nice value, `p->sched_class == &fair_sched_class` is false, so `reweight_task()` is never called. The ext scheduler's cached copy of the task weight goes stale.
2. Even if sched_ext wanted to hook into this path, there was no vtable slot for it to fill in.

### Code Walkthrough

**`kernel/sched/sched.h`** — new vtable slot added to `struct sched_class`:

```c
+	void (*reweight_task)(struct rq *this_rq, struct task_struct *task,
+			      int newprio);
```

It is placed after `switched_to` and before `prio_changed`, which are the other class-switch and priority-change callbacks. The signature gains a `struct rq *` parameter compared to the old standalone function — consistent with the convention used by the rest of the vtable.

The old global declaration is removed:

```c
-extern void reweight_task(struct task_struct *p, int prio);
```

**`kernel/sched/core.c`** — the dispatch in `set_load_weight()` is made class-agnostic:

```c
-	if (update_load && p->sched_class == &fair_sched_class) {
-		reweight_task(p, prio);
+	if (update_load && p->sched_class->reweight_task) {
+		p->sched_class->reweight_task(task_rq(p), p, prio);
 	} else {
 		load->weight = scale_load(sched_prio_to_weight[prio]);
 		load->inv_weight = sched_prio_to_wmult[prio];
```

The condition no longer names a specific class. It checks whether the task's current class implements `reweight_task` at all. If it does, it calls through the vtable. The `else` branch (which updates `load->weight` and `load->inv_weight` directly) now runs for any class that does not implement the operation — this covers rt, dl, stop, idle, and initially ext.

**`kernel/sched/fair.c`** — CFS's implementation is renamed and wired into the vtable:

```c
-void reweight_task(struct task_struct *p, int prio)
+static void reweight_task_fair(struct rq *rq, struct task_struct *p, int prio)
```

The function becomes `static` (no longer needs external linkage since it is accessed only through the vtable) and gains the `rq` parameter to match the new signature. It is registered in `DEFINE_SCHED_CLASS(fair)`:

```c
+	.reweight_task		= reweight_task_fair,
```

### Why sched_ext Needs This

When a task's nice value changes while it is under sched_ext, the ext class needs to update its own per-task weight cache so that the BPF program can make correct scheduling decisions (e.g., proportional-share accounting). With this vtable slot, the ext class can implement `reweight_task` and receive the notification. Without it, the ext class would permanently see the weight the task had at the time it joined the ext class, even after the user changed the task's nice value.

The commit message explicitly notes that `set_load_weight()` is not a hot path, so the additional indirection through the vtable has no measurable overhead.

### Connection to Other Patches

This patch is self-contained from the perspective of what it removes. It depends on patch 01 (which restructures the class hierarchy checks) having established that the series is moving toward proper vtable dispatch. The ext class patch later in the series will implement `.reweight_task` using the slot added here. Without this patch, the ext class would receive no notification when a task's weight changes.

### Key Data Structures / Functions Modified

- **`struct sched_class`** (`kernel/sched/sched.h`): The scheduler vtable. Gains a new `reweight_task` function pointer.
- **`set_load_weight()`** (`kernel/sched/core.c`): Called whenever a task's scheduling priority changes (nice value, policy change). The class-specific dispatch for weight updates is made generic here.
- **`reweight_task_fair()`** (`kernel/sched/fair.c`, formerly `reweight_task()`): CFS's implementation of `reweight_task`. Updates a task's `sched_entity` weight in the CFS red-black tree via `reweight_entity()`.
- **`DEFINE_SCHED_CLASS(fair)`** (`kernel/sched/fair.c`): The CFS vtable definition. Gains the `.reweight_task = reweight_task_fair` entry.

