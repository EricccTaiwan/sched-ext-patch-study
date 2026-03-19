# [PATCH 08/30] sched_ext: Add boilerplate for extensible scheduler class

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-9-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-9-tj@kernel.org)

## Commit Message

```text
This adds dummy implementations of sched_ext interfaces which interact with
the scheduler core and hook them in the correct places. As they're all
dummies, this doesn't cause any behavior changes. This is split out to help
reviewing.

v2: balance_scx_on_up() dropped. This will be handled in sched_ext proper.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 include/linux/sched/ext.h | 12 ++++++++++++
 kernel/fork.c             |  2 ++
 kernel/sched/core.c       | 32 ++++++++++++++++++++++++--------
 kernel/sched/ext.h        | 24 ++++++++++++++++++++++++
 kernel/sched/idle.c       |  2 ++
 kernel/sched/sched.h      |  2 ++
 6 files changed, 66 insertions(+), 8 deletions(-)
 create mode 100644 include/linux/sched/ext.h
 create mode 100644 kernel/sched/ext.h

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
new file mode 100644
index 000000000000..a05dfcf533b0
--- /dev/null
+++ b/include/linux/sched/ext.h
@@ -0,0 +1,12 @@
+/* SPDX-License-Identifier: GPL-2.0 */
+#ifndef _LINUX_SCHED_EXT_H
+#define _LINUX_SCHED_EXT_H
+
+#ifdef CONFIG_SCHED_CLASS_EXT
+#error "NOT IMPLEMENTED YET"
+#else	/* !CONFIG_SCHED_CLASS_EXT */
+
+static inline void sched_ext_free(struct task_struct *p) {}
+
+#endif	/* CONFIG_SCHED_CLASS_EXT */
+#endif	/* _LINUX_SCHED_EXT_H */
diff --git a/kernel/fork.c b/kernel/fork.c
index e601fdf787c3..741d962db0d9 100644
--- a/kernel/fork.c
+++ b/kernel/fork.c
@@ -23,6 +23,7 @@
 #include <linux/sched/task.h>
 #include <linux/sched/task_stack.h>
 #include <linux/sched/cputime.h>
+#include <linux/sched/ext.h>
 #include <linux/seq_file.h>
 #include <linux/rtmutex.h>
 #include <linux/init.h>
@@ -971,6 +972,7 @@ void __put_task_struct(struct task_struct *tsk)
 	WARN_ON(refcount_read(&tsk->usage));
 	WARN_ON(tsk == current);
 
+	sched_ext_free(tsk);
 	io_uring_free(tsk);
 	cgroup_free(tsk);
 	task_numa_free(tsk, true);
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 0bfbceebc4e9..d8c963fea9eb 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -4559,6 +4559,8 @@ late_initcall(sched_core_sysctl_init);
  */
 int sched_fork(unsigned long clone_flags, struct task_struct *p)
 {
+	int ret;
+
 	__sched_fork(clone_flags, p);
 	/*
 	 * We mark the process as NEW here. This guarantees that
@@ -4595,12 +4597,16 @@ int sched_fork(unsigned long clone_flags, struct task_struct *p)
 		p->sched_reset_on_fork = 0;
 	}
 
-	if (dl_prio(p->prio))
-		return -EAGAIN;
-	else if (rt_prio(p->prio))
+	scx_pre_fork(p);
+
+	if (dl_prio(p->prio)) {
+		ret = -EAGAIN;
+		goto out_cancel;
+	} else if (rt_prio(p->prio)) {
 		p->sched_class = &rt_sched_class;
-	else
+	} else {
 		p->sched_class = &fair_sched_class;
+	}
 
 	init_entity_runnable_average(&p->se);
 
@@ -4618,6 +4624,10 @@ int sched_fork(unsigned long clone_flags, struct task_struct *p)
 	RB_CLEAR_NODE(&p->pushable_dl_tasks);
 #endif
 	return 0;
+
+out_cancel:
+	scx_cancel_fork(p);
+	return ret;
 }
 
 int sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
@@ -4648,16 +4658,18 @@ int sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
 		p->sched_class->task_fork(p);
 	raw_spin_unlock_irqrestore(&p->pi_lock, flags);
 
-	return 0;
+	return scx_fork(p);
 }
 
 void sched_cancel_fork(struct task_struct *p)
 {
+	scx_cancel_fork(p);
 }
 
 void sched_post_fork(struct task_struct *p)
 {
 	uclamp_post_fork(p);
+	scx_post_fork(p);
 }
 
 unsigned long to_ratio(u64 period, u64 runtime)
@@ -5800,7 +5812,7 @@ static void put_prev_task_balance(struct rq *rq, struct task_struct *prev,
 	 * We can terminate the balance pass as soon as we know there is
 	 * a runnable task of @class priority or higher.
 	 */
-	for_class_range(class, prev->sched_class, &idle_sched_class) {
+	for_balance_class_range(class, prev->sched_class, &idle_sched_class) {
 		if (class->balance(rq, prev, rf))
 			break;
 	}
@@ -5818,6 +5830,9 @@ __pick_next_task(struct rq *rq, struct task_struct *prev, struct rq_flags *rf)
 	const struct sched_class *class;
 	struct task_struct *p;
 
+	if (scx_enabled())
+		goto restart;
+
 	/*
 	 * Optimization: we know that if all tasks are in the fair class we can
 	 * call that function directly, but only if the @prev task wasn't of a
@@ -5858,7 +5873,7 @@ __pick_next_task(struct rq *rq, struct task_struct *prev, struct rq_flags *rf)
 	if (prev->dl_server)
 		prev->dl_server = NULL;
 
-	for_each_class(class) {
+	for_each_active_class(class) {
 		p = class->pick_next_task(rq);
 		if (p)
 			return p;
@@ -5891,7 +5906,7 @@ static inline struct task_struct *pick_task(struct rq *rq)
 	const struct sched_class *class;
 	struct task_struct *p;
 
-	for_each_class(class) {
+	for_each_active_class(class) {
 		p = class->pick_task(rq);
 		if (p)
 			return p;
@@ -8355,6 +8370,7 @@ void __init sched_init(void)
 	balance_push_set(smp_processor_id(), false);
 #endif
 	init_sched_fair_class();
+	init_sched_ext_class();
 
 	psi_init();
 
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
new file mode 100644
index 000000000000..6a93c4825339
--- /dev/null
+++ b/kernel/sched/ext.h
@@ -0,0 +1,24 @@
+/* SPDX-License-Identifier: GPL-2.0 */
+
+#ifdef CONFIG_SCHED_CLASS_EXT
+#error "NOT IMPLEMENTED YET"
+#else	/* CONFIG_SCHED_CLASS_EXT */
+
+#define scx_enabled()		false
+
+static inline void scx_pre_fork(struct task_struct *p) {}
+static inline int scx_fork(struct task_struct *p) { return 0; }
+static inline void scx_post_fork(struct task_struct *p) {}
+static inline void scx_cancel_fork(struct task_struct *p) {}
+static inline void init_sched_ext_class(void) {}
+
+#define for_each_active_class		for_each_class
+#define for_balance_class_range		for_class_range
+
+#endif	/* CONFIG_SCHED_CLASS_EXT */
+
+#if defined(CONFIG_SCHED_CLASS_EXT) && defined(CONFIG_SMP)
+#error "NOT IMPLEMENTED YET"
+#else
+static inline void scx_update_idle(struct rq *rq, bool idle) {}
+#endif
diff --git a/kernel/sched/idle.c b/kernel/sched/idle.c
index 6e78d071beb5..c7a218123b7a 100644
--- a/kernel/sched/idle.c
+++ b/kernel/sched/idle.c
@@ -452,11 +452,13 @@ static void wakeup_preempt_idle(struct rq *rq, struct task_struct *p, int flags)
 
 static void put_prev_task_idle(struct rq *rq, struct task_struct *prev)
 {
+	scx_update_idle(rq, false);
 }
 
 static void set_next_task_idle(struct rq *rq, struct task_struct *next, bool first)
 {
 	update_idle_core(rq);
+	scx_update_idle(rq, true);
 	schedstat_inc(rq->sched_goidle);
 }
 
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 25660dc9f639..c52ad5fdd096 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -3658,4 +3658,6 @@ static inline void balance_callbacks(struct rq *rq, struct balance_callback *hea
 
 #endif
 
+#include "ext.h"
+
 #endif /* _KERNEL_SCHED_SCHED_H */
-- 
2.45.2
```

## Diff

```diff
---
 include/linux/sched/ext.h | 12 ++++++++++++
 kernel/fork.c             |  2 ++
 kernel/sched/core.c       | 32 ++++++++++++++++++++++++--------
 kernel/sched/ext.h        | 24 ++++++++++++++++++++++++
 kernel/sched/idle.c       |  2 ++
 kernel/sched/sched.h      |  2 ++
 6 files changed, 66 insertions(+), 8 deletions(-)
 create mode 100644 include/linux/sched/ext.h
 create mode 100644 kernel/sched/ext.h

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
new file mode 100644
index 000000000000..a05dfcf533b0
--- /dev/null
+++ b/include/linux/sched/ext.h
@@ -0,0 +1,12 @@
+/* SPDX-License-Identifier: GPL-2.0 */
+#ifndef _LINUX_SCHED_EXT_H
+#define _LINUX_SCHED_EXT_H
+
+#ifdef CONFIG_SCHED_CLASS_EXT
+#error "NOT IMPLEMENTED YET"
+#else	/* !CONFIG_SCHED_CLASS_EXT */
+
+static inline void sched_ext_free(struct task_struct *p) {}
+
+#endif	/* CONFIG_SCHED_CLASS_EXT */
+#endif	/* _LINUX_SCHED_EXT_H */
diff --git a/kernel/fork.c b/kernel/fork.c
index e601fdf787c3..741d962db0d9 100644
--- a/kernel/fork.c
+++ b/kernel/fork.c
@@ -23,6 +23,7 @@
 #include <linux/sched/task.h>
 #include <linux/sched/task_stack.h>
 #include <linux/sched/cputime.h>
+#include <linux/sched/ext.h>
 #include <linux/seq_file.h>
 #include <linux/rtmutex.h>
 #include <linux/init.h>
@@ -971,6 +972,7 @@ void __put_task_struct(struct task_struct *tsk)
 	WARN_ON(refcount_read(&tsk->usage));
 	WARN_ON(tsk == current);

+	sched_ext_free(tsk);
 	io_uring_free(tsk);
 	cgroup_free(tsk);
 	task_numa_free(tsk, true);
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 0bfbceebc4e9..d8c963fea9eb 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -4559,6 +4559,8 @@ late_initcall(sched_core_sysctl_init);
  */
 int sched_fork(unsigned long clone_flags, struct task_struct *p)
 {
+	int ret;
+
 	__sched_fork(clone_flags, p);
 	/*
 	 * We mark the process as NEW here. This guarantees that
@@ -4595,12 +4597,16 @@ int sched_fork(unsigned long clone_flags, struct task_struct *p)
 		p->sched_reset_on_fork = 0;
 	}

-	if (dl_prio(p->prio))
-		return -EAGAIN;
-	else if (rt_prio(p->prio))
+	scx_pre_fork(p);
+
+	if (dl_prio(p->prio)) {
+		ret = -EAGAIN;
+		goto out_cancel;
+	} else if (rt_prio(p->prio)) {
 		p->sched_class = &rt_sched_class;
-	else
+	} else {
 		p->sched_class = &fair_sched_class;
+	}

 	init_entity_runnable_average(&p->se);

@@ -4618,6 +4624,10 @@ int sched_fork(unsigned long clone_flags, struct task_struct *p)
 	RB_CLEAR_NODE(&p->pushable_dl_tasks);
 #endif
 	return 0;
+
+out_cancel:
+	scx_cancel_fork(p);
+	return ret;
 }

 int sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
@@ -4648,16 +4658,18 @@ int sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
 		p->sched_class->task_fork(p);
 	raw_spin_unlock_irqrestore(&p->pi_lock, flags);

-	return 0;
+	return scx_fork(p);
 }

 void sched_cancel_fork(struct task_struct *p)
 {
+	scx_cancel_fork(p);
 }

 void sched_post_fork(struct task_struct *p)
 {
 	uclamp_post_fork(p);
+	scx_post_fork(p);
 }

 unsigned long to_ratio(u64 period, u64 runtime)
@@ -5800,7 +5812,7 @@ static void put_prev_task_balance(struct rq *rq, struct task_struct *prev,
 	 * We can terminate the balance pass as soon as we know there is
 	 * a runnable task of @class priority or higher.
 	 */
-	for_class_range(class, prev->sched_class, &idle_sched_class) {
+	for_balance_class_range(class, prev->sched_class, &idle_sched_class) {
 		if (class->balance(rq, prev, rf))
 			break;
 	}
@@ -5818,6 +5830,9 @@ __pick_next_task(struct rq *rq, struct task_struct *prev, struct rq_flags *rf)
 	const struct sched_class *class;
 	struct task_struct *p;

+	if (scx_enabled())
+		goto restart;
+
 	/*
 	 * Optimization: we know that if all tasks are in the fair class we can
 	 * call that function directly, but only if the @prev task wasn't of a
@@ -5858,7 +5873,7 @@ __pick_next_task(struct rq *rq, struct task_struct *prev, struct rq_flags *rf)
 	if (prev->dl_server)
 		prev->dl_server = NULL;

-	for_each_class(class) {
+	for_each_active_class(class) {
 		p = class->pick_next_task(rq);
 		if (p)
 			return p;
@@ -5891,7 +5906,7 @@ static inline struct task_struct *pick_task(struct rq *rq)
 	const struct sched_class *class;
 	struct task_struct *p;

-	for_each_class(class) {
+	for_each_active_class(class) {
 		p = class->pick_task(rq);
 		if (p)
 			return p;
@@ -8355,6 +8370,7 @@ void __init sched_init(void)
 	balance_push_set(smp_processor_id(), false);
 #endif
 	init_sched_fair_class();
+	init_sched_ext_class();

 	psi_init();

diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
new file mode 100644
index 000000000000..6a93c4825339
--- /dev/null
+++ b/kernel/sched/ext.h
@@ -0,0 +1,24 @@
+/* SPDX-License-Identifier: GPL-2.0 */
+
+#ifdef CONFIG_SCHED_CLASS_EXT
+#error "NOT IMPLEMENTED YET"
+#else	/* CONFIG_SCHED_CLASS_EXT */
+
+#define scx_enabled()		false
+
+static inline void scx_pre_fork(struct task_struct *p) {}
+static inline int scx_fork(struct task_struct *p) { return 0; }
+static inline void scx_post_fork(struct task_struct *p) {}
+static inline void scx_cancel_fork(struct task_struct *p) {}
+static inline void init_sched_ext_class(void) {}
+
+#define for_each_active_class		for_each_class
+#define for_balance_class_range		for_class_range
+
+#endif	/* CONFIG_SCHED_CLASS_EXT */
+
+#if defined(CONFIG_SCHED_CLASS_EXT) && defined(CONFIG_SMP)
+#error "NOT IMPLEMENTED YET"
+#else
+static inline void scx_update_idle(struct rq *rq, bool idle) {}
+#endif
diff --git a/kernel/sched/idle.c b/kernel/sched/idle.c
index 6e78d071beb5..c7a218123b7a 100644
--- a/kernel/sched/idle.c
+++ b/kernel/sched/idle.c
@@ -452,11 +452,13 @@ static void wakeup_preempt_idle(struct rq *rq, struct task_struct *p, int flags)

 static void put_prev_task_idle(struct rq *rq, struct task_struct *prev)
 {
+	scx_update_idle(rq, false);
 }

 static void set_next_task_idle(struct rq *rq, struct task_struct *next, bool first)
 {
 	update_idle_core(rq);
+	scx_update_idle(rq, true);
 	schedstat_inc(rq->sched_goidle);
 }

diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 25660dc9f639..c52ad5fdd096 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -3658,4 +3658,6 @@ static inline void balance_callbacks(struct rq *rq, struct balance_callback *hea

 #endif

+#include "ext.h"
+
 #endif /* _KERNEL_SCHED_SCHED_H */
--
2.45.2


```

## Implementation Analysis

### Purpose
This patch establishes the foundational infrastructure for the sched_ext scheduler class by introducing:
1. **Header files** for sched_ext declarations (public and private)
2. **Hook points** in the task lifecycle (fork, exit)
3. **Macros and stubs** for sched_ext-enabled and disabled configurations
4. **Integration points** in scheduler's critical paths

### Key Changes

#### 1. Public Header: `include/linux/sched/ext.h`
- Defines the public sched_ext interface exposed to the rest of the kernel
- When `CONFIG_SCHED_CLASS_EXT` is disabled, provides dummy inline functions
- `sched_ext_free(struct task_struct *p)` - cleanup hook called from `__put_task_struct()`
- Allows the kernel to be compiled without sched_ext support with zero overhead

#### 2. Private Header: `kernel/sched/ext.h`
- Internal sched_ext scheduler implementation declarations
- **Conditionally enabled features**:
  - `scx_enabled()` - Boolean to check if BPF scheduler is active
  - `scx_pre_fork(p)` - Pre-fork hook for sched_ext initialization
  - `scx_fork(p)` - Main fork hook returning error code
  - `scx_post_fork(p)` - Post-fork setup
  - `scx_cancel_fork(p)` - Cleanup if fork fails
  - `init_sched_ext_class()` - Early initialization
- **Macro redefinitions**:
  - `for_each_active_class` - Iterate only active scheduler classes (sched_ext when enabled)
  - `for_balance_class_range` - Balance operations skip disabled classes

#### 3. Task Fork Integration (`kernel/fork.c`)
- Adds `#include <linux/sched/ext.h>`
- Inserts `sched_ext_free(tsk)` into `__put_task_struct()` during task destruction
- Ensures sched_ext can clean up any task-specific resources

#### 4. Scheduler Core Integration (`kernel/sched/core.c`)
Major modifications to support sched_ext hooks:

**In `sched_fork()`**:
- Wraps the fork sequence with `scx_pre_fork()` and error handling
- Changed simple returns to error handling with `goto out_cancel` label
- If deadline priority check fails, calls `scx_cancel_fork()` for cleanup
- New exit path that invokes `scx_cancel_fork()` on failure

**In `sched_cgroup_fork()`**:
- Returns result of `scx_fork()` instead of hardcoded 0
- Allows sched_ext to validate/reject cgroup assignments

**In `sched_cancel_fork()` and `sched_post_fork()`**:
- Added `scx_cancel_fork()` call in cancel path
- Added `scx_post_fork()` call in post-fork path
- Enables sched_ext to hook all fork lifecycle stages

**In `__pick_next_task()`**:
- Early check: `if (scx_enabled()) goto restart;`
- If sched_ext is active, bypasses CFS optimization and uses generic class iteration
- Allows sched_ext to make scheduling decisions

**In scheduler class iteration**:
- Changed `for_each_class()` to `for_each_active_class()`
- Changed `for_class_range()` to `for_balance_class_range()`
- These macros expand to skip disabled classes

**In `sched_init()`**:
- Added `init_sched_ext_class()` call after CFS initialization
- Enables sched_ext to register itself early in boot

#### 5. Idle Scheduler (`kernel/sched/idle.c`)
- Placeholder changes to support sched_ext initialization (2 lines added)

#### 6. Scheduler Header (`kernel/sched/sched.h`)
- Placeholder declarations for sched_ext structure references

### Design Philosophy

**Zero-Overhead When Disabled**:
- All sched_ext hooks are inline functions that do nothing when `CONFIG_SCHED_CLASS_EXT=n`
- No runtime overhead for kernels compiled without sched_ext support
- Compiler inlines all dummy functions away completely

**Flexible Integration Points**:
- Hooks placed at strategic locations: fork, exit, scheduling, and load balancing
- Allows sched_ext to intercept and modify behavior at each stage
- Maintains existing code paths when sched_ext is not enabled

**Error Handling**:
- Supports fork failure propagation via new error handling in `sched_fork()`
- Enables sched_ext to reject tasks during fork if policy violations detected
- Proper cleanup through `scx_cancel_fork()` when fork fails

