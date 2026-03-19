# [PATCH 02/30] sched: Allow sched_cgroup_fork() to fail and introduce sched_cancel_fork()

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-3-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-3-tj@kernel.org)

## Commit Message

```text
A new BPF extensible sched_class will need more control over the forking
process. It wants to be able to fail from sched_cgroup_fork() after the new
task's sched_task_group is initialized so that the loaded BPF program can
prepare the task with its cgroup association is established and reject fork
if e.g. allocation fails.

Allow sched_cgroup_fork() to fail by making it return int instead of void
and adding sched_cancel_fork() to undo sched_fork() in the error path.

sched_cgroup_fork() doesn't fail yet and this patch shouldn't cause any
behavior changes.

v2: Patch description updated to detail the expected use.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 include/linux/sched/task.h |  3 ++-
 kernel/fork.c              | 15 ++++++++++-----
 kernel/sched/core.c        |  8 +++++++-
 3 files changed, 19 insertions(+), 7 deletions(-)

diff --git a/include/linux/sched/task.h b/include/linux/sched/task.h
index d362aacf9f89..4df2f9055587 100644
--- a/include/linux/sched/task.h
+++ b/include/linux/sched/task.h
@@ -63,7 +63,8 @@ extern asmlinkage void schedule_tail(struct task_struct *prev);
 extern void init_idle(struct task_struct *idle, int cpu);
 
 extern int sched_fork(unsigned long clone_flags, struct task_struct *p);
-extern void sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs);
+extern int sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs);
+extern void sched_cancel_fork(struct task_struct *p);
 extern void sched_post_fork(struct task_struct *p);
 extern void sched_dead(struct task_struct *p);
 
diff --git a/kernel/fork.c b/kernel/fork.c
index 99076dbe27d8..e601fdf787c3 100644
--- a/kernel/fork.c
+++ b/kernel/fork.c
@@ -2363,7 +2363,7 @@ __latent_entropy struct task_struct *copy_process(
 
 	retval = perf_event_init_task(p, clone_flags);
 	if (retval)
-		goto bad_fork_cleanup_policy;
+		goto bad_fork_sched_cancel_fork;
 	retval = audit_alloc(p);
 	if (retval)
 		goto bad_fork_cleanup_perf;
@@ -2496,7 +2496,9 @@ __latent_entropy struct task_struct *copy_process(
 	 * cgroup specific, it unconditionally needs to place the task on a
 	 * runqueue.
 	 */
-	sched_cgroup_fork(p, args);
+	retval = sched_cgroup_fork(p, args);
+	if (retval)
+		goto bad_fork_cancel_cgroup;
 
 	/*
 	 * From this point on we must avoid any synchronous user-space
@@ -2542,13 +2544,13 @@ __latent_entropy struct task_struct *copy_process(
 	/* Don't start children in a dying pid namespace */
 	if (unlikely(!(ns_of_pid(pid)->pid_allocated & PIDNS_ADDING))) {
 		retval = -ENOMEM;
-		goto bad_fork_cancel_cgroup;
+		goto bad_fork_core_free;
 	}
 
 	/* Let kill terminate clone/fork in the middle */
 	if (fatal_signal_pending(current)) {
 		retval = -EINTR;
-		goto bad_fork_cancel_cgroup;
+		goto bad_fork_core_free;
 	}
 
 	/* No more failure paths after this point. */
@@ -2622,10 +2624,11 @@ __latent_entropy struct task_struct *copy_process(
 
 	return p;
 
-bad_fork_cancel_cgroup:
+bad_fork_core_free:
 	sched_core_free(p);
 	spin_unlock(&current->sighand->siglock);
 	write_unlock_irq(&tasklist_lock);
+bad_fork_cancel_cgroup:
 	cgroup_cancel_fork(p, args);
 bad_fork_put_pidfd:
 	if (clone_flags & CLONE_PIDFD) {
@@ -2664,6 +2667,8 @@ __latent_entropy struct task_struct *copy_process(
 	audit_free(p);
 bad_fork_cleanup_perf:
 	perf_event_free_task(p);
+bad_fork_sched_cancel_fork:
+	sched_cancel_fork(p);
 bad_fork_cleanup_policy:
 	lockdep_free_task(p);
 #ifdef CONFIG_NUMA
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index b4d4551bc7f2..095604490c26 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -4609,7 +4609,7 @@ int sched_fork(unsigned long clone_flags, struct task_struct *p)
 	return 0;
 }
 
-void sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
+int sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
 {
 	unsigned long flags;
 
@@ -4636,6 +4636,12 @@ void sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
 	if (p->sched_class->task_fork)
 		p->sched_class->task_fork(p);
 	raw_spin_unlock_irqrestore(&p->pi_lock, flags);
+
+	return 0;
+}
+
+void sched_cancel_fork(struct task_struct *p)
+{
 }
 
 void sched_post_fork(struct task_struct *p)
-- 
2.45.2
```

## Diff

```diff
---
 include/linux/sched/task.h |  3 ++-
 kernel/fork.c              | 15 ++++++++++-----
 kernel/sched/core.c        |  8 +++++++-
 3 files changed, 19 insertions(+), 7 deletions(-)

diff --git a/include/linux/sched/task.h b/include/linux/sched/task.h
index d362aacf9f89..4df2f9055587 100644
--- a/include/linux/sched/task.h
+++ b/include/linux/sched/task.h
@@ -63,7 +63,8 @@ extern asmlinkage void schedule_tail(struct task_struct *prev);
 extern void init_idle(struct task_struct *idle, int cpu);

 extern int sched_fork(unsigned long clone_flags, struct task_struct *p);
-extern void sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs);
+extern int sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs);
+extern void sched_cancel_fork(struct task_struct *p);
 extern void sched_post_fork(struct task_struct *p);
 extern void sched_dead(struct task_struct *p);

diff --git a/kernel/fork.c b/kernel/fork.c
index 99076dbe27d8..e601fdf787c3 100644
--- a/kernel/fork.c
+++ b/kernel/fork.c
@@ -2363,7 +2363,7 @@ __latent_entropy struct task_struct *copy_process(

 	retval = perf_event_init_task(p, clone_flags);
 	if (retval)
-		goto bad_fork_cleanup_policy;
+		goto bad_fork_sched_cancel_fork;
 	retval = audit_alloc(p);
 	if (retval)
 		goto bad_fork_cleanup_perf;
@@ -2496,7 +2496,9 @@ __latent_entropy struct task_struct *copy_process(
 	 * cgroup specific, it unconditionally needs to place the task on a
 	 * runqueue.
 	 */
-	sched_cgroup_fork(p, args);
+	retval = sched_cgroup_fork(p, args);
+	if (retval)
+		goto bad_fork_cancel_cgroup;

 	/*
 	 * From this point on we must avoid any synchronous user-space
@@ -2542,13 +2544,13 @@ __latent_entropy struct task_struct *copy_process(
 	/* Don't start children in a dying pid namespace */
 	if (unlikely(!(ns_of_pid(pid)->pid_allocated & PIDNS_ADDING))) {
 		retval = -ENOMEM;
-		goto bad_fork_cancel_cgroup;
+		goto bad_fork_core_free;
 	}

 	/* Let kill terminate clone/fork in the middle */
 	if (fatal_signal_pending(current)) {
 		retval = -EINTR;
-		goto bad_fork_cancel_cgroup;
+		goto bad_fork_core_free;
 	}

 	/* No more failure paths after this point. */
@@ -2622,10 +2624,11 @@ __latent_entropy struct task_struct *copy_process(

 	return p;

-bad_fork_cancel_cgroup:
+bad_fork_core_free:
 	sched_core_free(p);
 	spin_unlock(&current->sighand->siglock);
 	write_unlock_irq(&tasklist_lock);
+bad_fork_cancel_cgroup:
 	cgroup_cancel_fork(p, args);
 bad_fork_put_pidfd:
 	if (clone_flags & CLONE_PIDFD) {
@@ -2664,6 +2667,8 @@ __latent_entropy struct task_struct *copy_process(
 	audit_free(p);
 bad_fork_cleanup_perf:
 	perf_event_free_task(p);
+bad_fork_sched_cancel_fork:
+	sched_cancel_fork(p);
 bad_fork_cleanup_policy:
 	lockdep_free_task(p);
 #ifdef CONFIG_NUMA
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index b4d4551bc7f2..095604490c26 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -4609,7 +4609,7 @@ int sched_fork(unsigned long clone_flags, struct task_struct *p)
 	return 0;
 }

-void sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
+int sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
 {
 	unsigned long flags;

@@ -4636,6 +4636,12 @@ void sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
 	if (p->sched_class->task_fork)
 		p->sched_class->task_fork(p);
 	raw_spin_unlock_irqrestore(&p->pi_lock, flags);
+
+	return 0;
+}
+
+void sched_cancel_fork(struct task_struct *p)
+{
 }

 void sched_post_fork(struct task_struct *p)
--
2.45.2


```

## Implementation Analysis

This patch is a preparatory step for a future BPF-based extensible scheduler. It refactors the process creation path to allow the `sched_cgroup_fork()` function to fail and be gracefully handled.

Here are the key changes:

1.  **`sched_cgroup_fork()` now returns `int`:**
    -   In `include/linux/sched/task.h` and `kernel/sched/core.c`, the function signature of `sched_cgroup_fork()` is changed from `void` to `int`.
    -   For now, it unconditionally returns `0` (success). This is a forward-looking change to allow for failure conditions in later patches.

2.  **Introduction of `sched_cancel_fork()`:**
    -   A new function, `sched_cancel_fork()`, is declared in `include/linux/sched/task.h` and defined as an empty function in `kernel/sched/core.c`.
    -   This function is intended to be the counterpart to `sched_fork()`, cleaning up any scheduler-related resources if the fork process is aborted after `sched_fork()` has been called.

3.  **Error Handling in `copy_process()`:**
    -   In `kernel/fork.c`, the `copy_process` function is modified to handle the potential failure of `sched_cgroup_fork()`.
    -   If `sched_cgroup_fork()` returns an error, the code now jumps to `bad_fork_cancel_cgroup`, which is a new label that leads to the cleanup path.
    -   A new label `bad_fork_sched_cancel_fork` is added, which calls `sched_cancel_fork(p)` to perform the scheduler-specific cleanup.

This patch, by itself, does not change the kernel's behavior. However, it's a crucial infrastructural change that enables more complex and fallible operations within the scheduler's fork path, which will be leveraged by the BPF extensible scheduler.

