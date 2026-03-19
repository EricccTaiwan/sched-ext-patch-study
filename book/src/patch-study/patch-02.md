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

### Overview

This patch makes `sched_cgroup_fork()` return an error code instead of `void`, and introduces a new `sched_cancel_fork()` cleanup function. Neither function does anything new yet — `sched_cgroup_fork()` always returns 0 and `sched_cancel_fork()` is empty — but the plumbing through `copy_process()` is wired up correctly so that a later patch can fill them in. The immediate driver is sched_ext's need to allocate per-task BPF state during fork at the point where the task's cgroup association is already known, with a clean rollback path on failure.

### Background: The Linux Scheduler Class Hierarchy

The fork path in the Linux kernel (`copy_process()` in `kernel/fork.c`) calls several scheduler hooks in sequence:

1. `sched_fork()` — called early; initializes the new task's scheduling state, assigns it to the parent's scheduler class.
2. `sched_cgroup_fork()` — called later, after cgroup subsystem state is attached; places the task on a runqueue for the first time.
3. `sched_post_fork()` — called after the task is fully set up.

The key distinction between `sched_fork()` and `sched_cgroup_fork()` is timing: `sched_cgroup_fork()` is called after the task's `sched_task_group` is initialized, meaning the task's cgroup association is finalized. For sched_ext, this is the earliest safe point at which BPF programs can be invoked to prepare per-task state — and the only point where an allocation failure can be reported back to `copy_process()` as a fork failure.

### The Problem Being Solved

Before this patch, `sched_cgroup_fork()` returned `void`. There was no way for the scheduler to signal that fork preparation failed. If sched_ext needed to allocate per-task BPF storage (e.g., task-local data in a BPF map) during the fork path, it had no mechanism to return `-ENOMEM` to userspace and abort the fork. Equally, if `sched_fork()` had allocated resources and then a later step failed, there was no dedicated `sched_cancel_fork()` hook to release those resources.

The existing error label `bad_fork_cleanup_policy` was used as the target for perf event failure, meaning sched_fork state was left in place during that cleanup — which would be wrong once sched_fork can acquire resources that need releasing.

### Code Walkthrough

**`include/linux/sched/task.h`** — the public API changes:

```c
-extern void sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs);
+extern int sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs);
+extern void sched_cancel_fork(struct task_struct *p);
```

`sched_cgroup_fork()` gains an `int` return type. `sched_cancel_fork()` is declared as the undo function for `sched_fork()`.

**`kernel/sched/core.c`** — the implementations:

```c
-void sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
+int sched_cgroup_fork(struct task_struct *p, struct kernel_clone_args *kargs)
 {
     ...
+    return 0;
 }

+void sched_cancel_fork(struct task_struct *p)
+{
+}
```

Both functions are stubs for now. The `return 0` in `sched_cgroup_fork()` means no behavior change.

**`kernel/fork.c`** — `copy_process()` error handling is restructured in three places:

First, the `sched_cgroup_fork()` call site gains error checking:

```c
-	sched_cgroup_fork(p, args);
+	retval = sched_cgroup_fork(p, args);
+	if (retval)
+		goto bad_fork_cancel_cgroup;
```

Second, the cleanup labels are reordered to correctly sequence the teardown. The old `bad_fork_cancel_cgroup` label was reached by both the dying-pidns check and the fatal-signal check. Those two cases must now jump to `bad_fork_core_free` (which runs `sched_core_free` and releases the tasklist lock) before falling through to `bad_fork_cancel_cgroup` (cgroup cleanup). The new label ordering:

```c
-bad_fork_cancel_cgroup:
+bad_fork_core_free:
     sched_core_free(p);
     spin_unlock(&current->sighand->siglock);
     write_unlock_irq(&tasklist_lock);
+bad_fork_cancel_cgroup:
     cgroup_cancel_fork(p, args);
```

Third, a new label is inserted before the perf cleanup to call `sched_cancel_fork()`:

```c
 bad_fork_cleanup_perf:
     perf_event_free_task(p);
+bad_fork_sched_cancel_fork:
+    sched_cancel_fork(p);
 bad_fork_cleanup_policy:
```

The perf event failure path, which previously jumped to `bad_fork_cleanup_policy` (bypassing any sched_fork cleanup), now jumps to `bad_fork_sched_cancel_fork`:

```c
     retval = perf_event_init_task(p, clone_flags);
     if (retval)
-        goto bad_fork_cleanup_policy;
+        goto bad_fork_sched_cancel_fork;
```

This ensures that whenever perf init fails after `sched_fork()` has run, `sched_cancel_fork()` is called — a correct invariant whether or not `sched_cancel_fork()` currently does anything.

### Why sched_ext Needs This

sched_ext tracks every task with per-task BPF storage. That storage must be allocated before the task is visible to the scheduler, but after the task's cgroup is known (so the BPF program can make cgroup-aware decisions during task initialization). `sched_cgroup_fork()` is exactly that window.

If the allocation fails (e.g., out of memory, or the BPF program explicitly rejects the fork), sched_ext must be able to return an error. The `int` return type and the `goto bad_fork_cancel_cgroup` wiring provide this. `sched_cancel_fork()` will later be implemented to free any resources `sched_fork()` allocated, completing the symmetry.

### Connection to Other Patches

This patch depends on nothing earlier in the series. Later sched_ext patches will fill in the bodies of both `sched_cgroup_fork()` and `sched_cancel_fork()` with real allocation and teardown logic. Without this infrastructure, those patches would have nowhere to return errors from and no cleanup hook to call.

### Key Data Structures / Functions Modified

- **`sched_cgroup_fork()`** (`kernel/sched/core.c`, declared in `include/linux/sched/task.h`): Scheduler hook called during `copy_process()` after cgroup state is attached. Changed from `void` to `int`.
- **`sched_cancel_fork()`** (`kernel/sched/core.c`, declared in `include/linux/sched/task.h`): New function; the undo counterpart to `sched_fork()`. Currently empty.
- **`copy_process()`** (`kernel/fork.c`): The main process/thread creation function. Its error-label chain is restructured to correctly invoke `sched_cancel_fork()` on any failure that occurs after `sched_fork()`.
- **`bad_fork_sched_cancel_fork` / `bad_fork_core_free` / `bad_fork_cancel_cgroup`**: Goto labels in `copy_process()` that form the cleanup ladder. Their order determines which cleanup functions run on each failure path.

