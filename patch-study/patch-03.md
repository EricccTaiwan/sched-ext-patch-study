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

This patch continues the theme of refactoring the scheduler core to be more modular and extensible, again in preparation for the BPF-based scheduler. It transforms a direct function call into a more generic, class-based dispatch.

The key changes are:

1.  **Introduction of `sched_class->reweight_task`:**
    -   A new function pointer, `reweight_task`, is added to the `struct sched_class` in `include/linux/sched/sched.h`. This allows each scheduling class to provide its own implementation for how to handle a task's weight change.

2.  **Refactoring in `kernel/sched/core.c`:**
    -   In the `set_load_weight` function, the direct call to `reweight_task(p, prio)` is replaced with a call through the `sched_class` structure: `p->sched_class->reweight_task(task_rq(p), p, prio)`.
    -   This change makes `set_load_weight` agnostic of the specific scheduling class. It simply invokes the `reweight_task` method of the task's current scheduler class.

3.  **Changes in `kernel/sched/fair.c`:**
    -   The `reweight_task` function is renamed to `reweight_task_fair` to better reflect that it's the implementation for the Completely Fair Scheduler (CFS).
    -   The `fair_sched_class` structure is updated to point its `reweight_task` member to the new `reweight_task_fair` function.

This is a classic example of converting a direct call to a virtual function call in an object-oriented style. It decouples the scheduler core from the implementation details of the CFS scheduler, making it possible for other scheduling classes (like the future BPF one) to implement their own `reweight_task` logic. This is essential for the BPF scheduler to manage its own task weight accounting.

