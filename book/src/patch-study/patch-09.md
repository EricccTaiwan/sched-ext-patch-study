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

### Overview

This patch (PATCH 08/30) establishes the compile-time scaffolding for sched_ext without implementing any real behavior. Every function added here is either an empty stub or a `#error "NOT IMPLEMENTED YET"` guard. The patch exists specifically to let reviewers verify that the hook sites in the rest of the kernel are correct before the large `ext.c` implementation lands in the next patch (PATCH 09/30).

This is a standard kernel technique for large patch series: split the "where do we hook in" question from the "what does the hook do" question so each can be reviewed independently.

### Architecture Context

sched_ext needs hook points in four areas of the kernel that this patch touches:

1. **Task lifecycle** (`kernel/fork.c`): sched_ext must track every task from creation to destruction to manage its `sched_ext_entity` embedded in `task_struct`.

2. **Scheduler selection** (`kernel/sched/core.c`): The scheduler core has fast-path optimizations that assume only CFS tasks exist. sched_ext must disable those optimizations when it is active.

3. **Class iteration** (`kernel/sched/core.c`): When sched_ext is loaded, `ext_sched_class` must participate in the class-priority walk; when it is not loaded, it must be invisible with zero overhead.

4. **Idle CPU tracking** (`kernel/sched/idle.c`): sched_ext needs to know which CPUs are idle in order to implement `ops.select_cpu()` efficiently. The idle entry/exit hooks feed a per-CPU idle mask that the BPF scheduler can query.

### Code Walkthrough

**`include/linux/sched/ext.h` — the public header**

```c
#ifdef CONFIG_SCHED_CLASS_EXT
#error "NOT IMPLEMENTED YET"
#else
static inline void sched_ext_free(struct task_struct *p) {}
#endif
```

The `#ifdef CONFIG_SCHED_CLASS_EXT` branch is intentionally broken. This forces any build with `CONFIG_SCHED_CLASS_EXT=y` to fail until PATCH 09/30 replaces the `#error` with real declarations. The `!CONFIG` branch provides the no-op `sched_ext_free()` that `__put_task_struct()` will call unconditionally, so the call site in `kernel/fork.c` compiles cleanly in all configurations.

**`kernel/sched/ext.h` — the internal header**

```c
#define scx_enabled()           false
static inline void scx_pre_fork(struct task_struct *p) {}
static inline int scx_fork(struct task_struct *p) { return 0; }
static inline void scx_post_fork(struct task_struct *p) {}
static inline void scx_cancel_fork(struct task_struct *p) {}
static inline void init_sched_ext_class(void) {}
#define for_each_active_class   for_each_class
#define for_balance_class_range for_class_range
```

When `CONFIG_SCHED_CLASS_EXT=n`, `scx_enabled()` is a compile-time `false`, which lets the compiler eliminate every branch guarded by it. The `for_each_active_class` and `for_balance_class_range` macros fall back to the existing `for_each_class` and `for_class_range` macros respectively, preserving existing behavior.

When `CONFIG_SCHED_CLASS_EXT=y` (and `CONFIG_SMP=y`), there is a second `#error "NOT IMPLEMENTED YET"` block for `scx_update_idle()`. This function will ultimately notify sched_ext when a CPU transitions into or out of idle, feeding the idle-CPU tracking mechanism.

**`kernel/fork.c` — task destruction hook**

```c
sched_ext_free(tsk);
io_uring_free(tsk);
```

`sched_ext_free()` is placed before `io_uring_free()` and `cgroup_free()` in `__put_task_struct()`. This ordering matters in the real implementation: sched_ext needs to clean up its per-task state (remove from DSQ, call `ops.disable()`) before the task's cgroup reference is dropped, because `ops.disable()` may read cgroup information.

**`kernel/sched/core.c` — fork lifecycle hooks**

The fork path acquires four new hook calls:

```c
scx_pre_fork(p);           /* in sched_fork(), before class assignment */
/* ... class assignment ... */
out_cancel:
    scx_cancel_fork(p);    /* on error in sched_fork() */

return scx_fork(p);        /* replaces return 0 in sched_cgroup_fork() */

scx_cancel_fork(p);        /* in sched_cancel_fork() */
scx_post_fork(p);          /* in sched_post_fork() */
```

The fork sequence is: `sched_fork()` → `sched_cgroup_fork()` → `sched_post_fork()`. sched_ext needs to know about a task early (in `scx_pre_fork`) to initialize its `sched_ext_entity`, must be able to propagate failure (the `return scx_fork(p)` that now allows `sched_cgroup_fork` to fail), and must clean up if the fork is cancelled at any point.

The reason `sched_fork()` gains a `goto out_cancel` structure instead of early returns is precisely to guarantee `scx_cancel_fork()` is always called on the error path — a classic resource-cleanup pattern applied to scheduler state.

**`kernel/sched/core.c` — scheduling fast-path bypass**

```c
if (scx_enabled())
    goto restart;
```

`__pick_next_task()` has a well-known optimization: if the previous task was a CFS task and no higher-priority tasks exist, it skips the full class walk and calls `fair_sched_class.pick_next_task()` directly. When sched_ext is active this optimization is invalid because an SCX task could be waiting. The `goto restart` forces the full `for_each_active_class()` walk. The `scx_enabled()` check is a static key in the real implementation, so when sched_ext is not loaded the branch is a single no-prediction-needed not-taken jump.

**`kernel/sched/idle.c` — idle tracking hooks**

```c
static void put_prev_task_idle(struct rq *rq, struct task_struct *prev)
{
    scx_update_idle(rq, false);   /* CPU leaving idle */
}

static void set_next_task_idle(struct rq *rq, struct task_struct *next, bool first)
{
    update_idle_core(rq);
    scx_update_idle(rq, true);    /* CPU entering idle */
    schedstat_inc(rq->sched_goidle);
}
```

`put_prev_task_idle` is called when the idle task is being replaced (CPU waking up from idle). `set_next_task_idle` is called when the idle task is being scheduled (CPU going idle). The `true`/`false` arguments tell sched_ext whether to set or clear this CPU's bit in the idle cpumask that BPF schedulers will use for `ops.select_cpu()`.

**`kernel/sched/sched.h` — header inclusion**

```c
#include "ext.h"
```

This single line, added at the very end of `sched.h`, makes all the stubs from `kernel/sched/ext.h` available to all files that include `sched.h` (which is the entire scheduler subsystem). The placement at the end is deliberate: `ext.h` uses types declared earlier in `sched.h`, so it must come last.

### Key Concepts Introduced

**`scx_enabled()` as a static key**: In the stub it is `#define scx_enabled() false`. In the real implementation (PATCH 09/30) it becomes a static key — a runtime-patchable NOP instruction that only costs one cycle when sched_ext is inactive. This is the mechanism that makes the `__pick_next_task()` fast-path bypass zero-cost when no BPF scheduler is loaded.

**The `for_each_active_class` / `for_balance_class_range` macros**: These are the mechanism by which `ext_sched_class` is conditionally included in scheduler class walks. When sched_ext is disabled they expand to the standard macros and incur no overhead. When it is enabled they use a custom iterator that starts from the highest-priority active class and skips `ext_sched_class` if it is being disabled. This is the invariant that guarantees tasks always have a fallback to CFS.

**The four-phase fork lifecycle**: `pre_fork` → `fork` (cgroup path) → `cancel_fork` (error path) → `post_fork`. This decomposition reflects the fact that task creation in the kernel is not atomic — it can fail at multiple points, and any resource acquired during fork must be releasable from any failure point.

### Why This Matters for Maintainers

**The `#error "NOT IMPLEMENTED YET"` pattern**: You will see this in several places. It is not laziness — it is a deliberate device to make a partial implementation fail loudly at compile time rather than silently misbehave at runtime. When reviewing new sched_ext features that follow the same boilerplate pattern, verify that the `#error` guards are replaced atomically with functional code.

**Hook ordering in `__put_task_struct`**: `sched_ext_free()` runs before `cgroup_free()`. Any future change to move these calls must preserve this ordering, because the real `sched_ext_free()` implementation may read cgroup state during `ops.disable()` or `ops.exit_task()`.

**`scx_update_idle()` in the SMP branch**: The stub for `scx_update_idle()` is in a separate `#if defined(CONFIG_SCHED_CLASS_EXT) && defined(CONFIG_SMP)` block. The idle-CPU tracking mechanism is inherently SMP-only (there is nothing to track on a uniprocessor), so this is a correctness constraint, not just a performance optimization.

**The `goto restart` in `__pick_next_task()`**: This is a subtle correctness point. Without it, a system running an SCX scheduler could exhibit rare scheduling pathologies where CFS tasks are selected ahead of higher-priority SCX tasks due to the fast-path optimization. Any change to the scheduling fast path must account for this.

### Connection to Other Patches

This patch is explicitly described in its commit message as "split out to help reviewing." Its sole purpose is to create the correct hook sites so that PATCH 09/30 (the full `ext.c` implementation) can be reviewed as pure logic, not as a mix of hook-site correctness and algorithm correctness.

The `#error "NOT IMPLEMENTED YET"` in `include/linux/sched/ext.h` and `kernel/sched/ext.h` will be replaced by PATCH 09/30, which fills in:
- The full `struct sched_ext_entity` embedded in every `task_struct`
- The real `ext_sched_class` with all `sched_class` callbacks
- The DSQ implementation
- The `scx_ops_enable()` and `scx_ops_disable()` state machine
- The real `scx_enabled()` static key

The `scx_update_idle()` stub (SMP branch) will be replaced with actual idle-cpumask management, which feeds `scx_bpf_select_cpu_dfl()` — the default idle CPU picker available to BPF schedulers.

