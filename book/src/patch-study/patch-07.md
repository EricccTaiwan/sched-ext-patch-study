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

### Overview

This patch adds a `normal_policy()` inline helper that returns true when a scheduling policy is `SCHED_NORMAL`, mirroring the existing `idle_policy()`, `fair_policy()`, and `rt_policy()` helpers. It is a tiny change that unifies the policy-test pattern and specifically enables sched_ext to check whether a task belongs to `SCHED_NORMAL` — the policy that sched_ext will claim when a BPF scheduler is loaded — as distinct from `SCHED_BATCH` and `SCHED_IDLE`, which CFS handles but which cannot use sched_ext.

### Background: The Linux Scheduler Class Hierarchy

Linux defines several scheduling policies that userspace can assign to a task:

| Policy | Class | Meaning |
|---|---|---|
| `SCHED_NORMAL` (0) | fair or ext | Normal timesharing tasks |
| `SCHED_FIFO` (1) | rt | Real-time FIFO |
| `SCHED_RR` (2) | rt | Real-time round-robin |
| `SCHED_BATCH` (3) | fair | Batch/CPU-bound, no wakeup preemption |
| `SCHED_IDLE` (5) | fair | Very low priority; not related to idle class |
| `SCHED_DEADLINE` (6) | dl | EDF deadline tasks |
| `SCHED_EXT` (7) | ext | BPF-extensible scheduler |

`fair_policy()` currently encompasses both `SCHED_NORMAL` and `SCHED_BATCH` because both run under CFS. The distinction matters for wakeup preemption: `SCHED_BATCH` tasks intentionally do not trigger preemption on wakeup (they want to run in long bursts). `check_preempt_wakeup_fair()` already tested for `p->policy != SCHED_NORMAL` specifically to skip batch tasks.

sched_ext only accepts `SCHED_NORMAL` tasks (or tasks explicitly assigned `SCHED_EXT`). When a BPF scheduler is loaded, `SCHED_NORMAL` tasks will be redirected to `ext_sched_class` instead of `fair_sched_class`. `SCHED_BATCH` and `SCHED_IDLE` tasks stay in CFS. The ext class code therefore needs a clean way to ask "is this task a normal-policy task?" without testing the raw integer constant everywhere.

### The Problem Being Solved

Before this patch, the kernel had a family of policy-test helpers:

```c
static inline int idle_policy(int policy)  { return policy == SCHED_IDLE; }
static inline int fair_policy(int policy)  { return policy == SCHED_NORMAL || policy == SCHED_BATCH; }
static inline int rt_policy(int policy)    { return policy == SCHED_FIFO || policy == SCHED_RR; }
static inline int dl_policy(int policy)    { return policy == SCHED_DEADLINE; }
```

There was no `normal_policy()`. Code that specifically needed `SCHED_NORMAL` (not `SCHED_BATCH`) had to test `p->policy != SCHED_NORMAL` directly, as `check_preempt_wakeup_fair()` did. For sched_ext, which must frequently check whether a task is eligible for the ext class, having to hardcode `== SCHED_NORMAL` every time is fragile — if the set of policies considered "normal" ever changes, every site must be updated manually.

### Code Walkthrough

**`kernel/sched/sched.h`** — `normal_policy()` is added and `fair_policy()` is updated to use it:

```c
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
```

`normal_policy()` is placed immediately before `fair_policy()`, and `fair_policy()` is updated to delegate to it. This makes the relationship explicit: `fair_policy` is a superset of `normal_policy`. The insertion point (after `idle_policy`, before `fair_policy`) keeps the helpers in policy-hierarchy order.

**`kernel/sched/fair.c`** — one existing open-coded test is updated to use the helper:

```c
-	if (unlikely(p->policy != SCHED_NORMAL) || !sched_feat(WAKEUP_PREEMPTION))
+	if (unlikely(!normal_policy(p->policy)) || !sched_feat(WAKEUP_PREEMPTION))
```

This is in `check_preempt_wakeup_fair()`, which decides whether a waking task should preempt the current task. `SCHED_BATCH` tasks should not trigger wakeup preemption; only `SCHED_NORMAL` tasks should. The semantics are identical — this is purely a style improvement.

### Why sched_ext Needs This

When the ext class implements its task-to-class mapping logic, it must determine whether a given task should use `ext_sched_class` or stay with `fair_sched_class`. The rule is: tasks with `SCHED_NORMAL` policy are eligible for ext; tasks with `SCHED_BATCH` or `SCHED_IDLE` policy remain in CFS even when a BPF scheduler is loaded.

The ext class implementation calls `normal_policy(p->policy)` rather than `p->policy == SCHED_NORMAL` to express this intent. Having `fair_policy()` also call `normal_policy()` internally ensures that if the definition of "normal" is ever extended (e.g., if `SCHED_EXT` is treated as a superset of `SCHED_NORMAL` for some purposes), only `normal_policy()` needs updating.

### Connection to Other Patches

This is the last of the seven preparatory patches. It does not depend on any of the earlier six patches in the series. The sched_ext class implementation later in the series uses `normal_policy()` in its task-class assignment logic — specifically in the function that decides whether a newly-forked or policy-changed task should go to the ext class or fall back to CFS.

### Key Data Structures / Functions Modified

- **`normal_policy()`** (`kernel/sched/sched.h`): New inline helper. Returns true if `policy == SCHED_NORMAL`. The single authoritative definition of what "normal policy" means.
- **`fair_policy()`** (`kernel/sched/sched.h`): Updated to call `normal_policy()` internally. Now expresses that CFS handles normal tasks (via `normal_policy`) and batch tasks.
- **`check_preempt_wakeup_fair()`** (`kernel/sched/fair.c`): The CFS wakeup-preemption check. Updated to call `normal_policy()` instead of testing `p->policy != SCHED_NORMAL` directly.

