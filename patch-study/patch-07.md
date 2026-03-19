# [PATCH 07/30] sched: Add normal_policy()

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-8-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-8-tj@kernel.org)

## Commit Message

```text
A new BPF extensible sched_class will need to dynamically change how a task
picks its sched_class. For example, if the loaded BPF scheduler progs fail,
the tasks will be forced back on CFS even if the task's policy is set to the
new sched_class. To support such mapping, add normal_policy() which wraps
testing for %SCHED_NORMAL. This doesn't cause any behavior changes.

v2: Update the description with more details on the expected use.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 kernel/sched/fair.c  | 2 +-
 kernel/sched/sched.h | 7 ++++++-
 2 files changed, 7 insertions(+), 2 deletions(-)

diff --git a/kernel/sched/fair.c b/kernel/sched/fair.c
index 715d7c1f55df..d59537416865 100644
--- a/kernel/sched/fair.c
+++ b/kernel/sched/fair.c
@@ -8391,7 +8391,7 @@ static void check_preempt_wakeup_fair(struct rq *rq, struct task_struct *p, int
 	 * Batch and idle tasks do not preempt non-idle tasks (their preemption
 	 * is driven by the tick):
 	 */
-	if (unlikely(p->policy != SCHED_NORMAL) || !sched_feat(WAKEUP_PREEMPTION))
+	if (unlikely(!normal_policy(p->policy)) || !sched_feat(WAKEUP_PREEMPTION))
 		return;
 
 	find_matching_se(&se, &pse);
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index a5a4f59151db..25660dc9f639 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -192,9 +192,14 @@ static inline int idle_policy(int policy)
 	return policy == SCHED_IDLE;
 }
 
+static inline int normal_policy(int policy)
+{
+	return policy == SCHED_NORMAL;
+}
+
 static inline int fair_policy(int policy)
 {
-	return policy == SCHED_NORMAL || policy == SCHED_BATCH;
+	return normal_policy(policy) || policy == SCHED_BATCH;
 }
 
 static inline int rt_policy(int policy)
-- 
2.45.2
```

## Diff

```diff
---
 kernel/sched/fair.c  | 2 +-
 kernel/sched/sched.h | 7 ++++++-
 2 files changed, 7 insertions(+), 2 deletions(-)

diff --git a/kernel/sched/fair.c b/kernel/sched/fair.c
index 715d7c1f55df..d59537416865 100644
--- a/kernel/sched/fair.c
+++ b/kernel/sched/fair.c
@@ -8391,7 +8391,7 @@ static void check_preempt_wakeup_fair(struct rq *rq, struct task_struct *p, int
 	 * Batch and idle tasks do not preempt non-idle tasks (their preemption
 	 * is driven by the tick):
 	 */
-	if (unlikely(p->policy != SCHED_NORMAL) || !sched_feat(WAKEUP_PREEMPTION))
+	if (unlikely(!normal_policy(p->policy)) || !sched_feat(WAKEUP_PREEMPTION))
 		return;

 	find_matching_se(&se, &pse);
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index a5a4f59151db..25660dc9f639 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -192,9 +192,14 @@ static inline int idle_policy(int policy)
 	return policy == SCHED_IDLE;
 }

+static inline int normal_policy(int policy)
+{
+	return policy == SCHED_NORMAL;
+}
+
 static inline int fair_policy(int policy)
 {
-	return policy == SCHED_NORMAL || policy == SCHED_BATCH;
+	return normal_policy(policy) || policy == SCHED_BATCH;
 }

 static inline int rt_policy(int policy)
--
2.45.2


```

## Implementation Analysis

### High-Level Analysis
A new BPF extensible sched_class will need to dynamically change how a task

### Detailed Walkthrough
1. File: `kernel/sched/fair.c`
   Hunk: `@@ -8391,7 +8391,7 @@ static void check_preempt_wakeup_fair(struct rq *rq, struct task_struct *p, int`
   Before
   ```text
   if (unlikely(p->policy != SCHED_NORMAL) || !sched_feat(WAKEUP_PREEMPTION))
   ```
   After
   ```text
   if (unlikely(!normal_policy(p->policy)) || !sched_feat(WAKEUP_PREEMPTION))
   ```
2. File: `kernel/sched/sched.h`
   Hunk: `@@ -192,9 +192,14 @@ static inline int idle_policy(int policy)`
   Before
   ```text
   return policy == SCHED_NORMAL || policy == SCHED_BATCH;
   -
   ```
   After
   ```text
   static inline int normal_policy(int policy)
   {
   return policy == SCHED_NORMAL;
   ```

### sched_ext Context
This patch incrementally improves scheduler internals so subsequent sched_ext patches can compose with less fragility.

