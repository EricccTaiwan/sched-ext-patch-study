# [PATCH 14/30] sched_ext: Print sched_ext info when dumping stack

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-15-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-15-tj@kernel.org)

## Commit Message

```text
From: David Vernet <void@manifault.com>

It would be useful to see what the sched_ext scheduler state is, and what
scheduler is running, when we're dumping a task's stack. This patch
therefore adds a new print_scx_info() function that's called in the same
context as print_worker_info() and print_stop_info(). An example dump
follows.

  BUG: kernel NULL pointer dereference, address: 0000000000000999
  #PF: supervisor write access in kernel mode
  #PF: error_code(0x0002) - not-present page
  PGD 0 P4D 0
  Oops: 0002 [#1] PREEMPT SMP
  CPU: 13 PID: 2047 Comm: insmod Tainted: G           O       6.6.0-work-10323-gb58d4cae8e99-dirty #34
  Hardware name: QEMU Standard PC (i440FX + PIIX, 1996), BIOS unknown 2/2/2022
  Sched_ext: qmap (enabled+all), task: runnable_at=-17ms
  RIP: 0010:init_module+0x9/0x1000 [test_module]
  ...

v3: - scx_ops_enable_state_str[] definition moved to an earlier patch as
      it's now used by core implementation.

    - Convert jiffy delta to msecs using jiffies_to_msecs() instead of
      multiplying by (HZ / MSEC_PER_SEC). The conversion is implemented in
      jiffies_delta_msecs().

v2: - We are now using scx_ops_enable_state_str[] outside
      CONFIG_SCHED_DEBUG. Move it outside of CONFIG_SCHED_DEBUG and to the
      top. This was reported by Changwoo and Andrea.

Signed-off-by: David Vernet <void@manifault.com>
Reported-by: Changwoo Min <changwoo@igalia.com>
Reported-by: Andrea Righi <andrea.righi@canonical.com>
Signed-off-by: Tejun Heo <tj@kernel.org>
---
 include/linux/sched/ext.h |  2 ++
 kernel/sched/core.c       |  1 +
 kernel/sched/ext.c        | 53 +++++++++++++++++++++++++++++++++++++++
 lib/dump_stack.c          |  1 +
 4 files changed, 57 insertions(+)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index ea7c501ac819..85fb5dc725ef 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -155,10 +155,12 @@ struct sched_ext_entity {
 };
 
 void sched_ext_free(struct task_struct *p);
+void print_scx_info(const char *log_lvl, struct task_struct *p);
 
 #else	/* !CONFIG_SCHED_CLASS_EXT */
 
 static inline void sched_ext_free(struct task_struct *p) {}
+static inline void print_scx_info(const char *log_lvl, struct task_struct *p) {}
 
 #endif	/* CONFIG_SCHED_CLASS_EXT */
 #endif	/* _LINUX_SCHED_EXT_H */
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index f4365becdc13..1a3144c80af8 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -7486,6 +7486,7 @@ void sched_show_task(struct task_struct *p)
 
 	print_worker_info(KERN_INFO, p);
 	print_stop_info(KERN_INFO, p);
+	print_scx_info(KERN_INFO, p);
 	show_stack(p, NULL, KERN_INFO);
 	put_task_stack(p);
 }
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 8ff30b80e862..6f4de29d7372 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -586,6 +586,14 @@ static __printf(3, 4) void scx_ops_exit_kind(enum scx_exit_kind kind,
 
 #define SCX_HAS_OP(op)	static_branch_likely(&scx_has_op[SCX_OP_IDX(op)])
 
+static long jiffies_delta_msecs(unsigned long at, unsigned long now)
+{
+	if (time_after(at, now))
+		return jiffies_to_msecs(at - now);
+	else
+		return -(long)jiffies_to_msecs(now - at);
+}
+
 /* if the highest set bit is N, return a mask with bits [N+1, 31] set */
 static u32 higher_bits(u32 flags)
 {
@@ -3715,6 +3723,51 @@ static const struct sysrq_key_op sysrq_sched_ext_reset_op = {
 	.enable_mask	= SYSRQ_ENABLE_RTNICE,
 };
 
+/**
+ * print_scx_info - print out sched_ext scheduler state
+ * @log_lvl: the log level to use when printing
+ * @p: target task
+ *
+ * If a sched_ext scheduler is enabled, print the name and state of the
+ * scheduler. If @p is on sched_ext, print further information about the task.
+ *
+ * This function can be safely called on any task as long as the task_struct
+ * itself is accessible. While safe, this function isn't synchronized and may
+ * print out mixups or garbages of limited length.
+ */
+void print_scx_info(const char *log_lvl, struct task_struct *p)
+{
+	enum scx_ops_enable_state state = scx_ops_enable_state();
+	const char *all = READ_ONCE(scx_switching_all) ? "+all" : "";
+	char runnable_at_buf[22] = "?";
+	struct sched_class *class;
+	unsigned long runnable_at;
+
+	if (state == SCX_OPS_DISABLED)
+		return;
+
+	/*
+	 * Carefully check if the task was running on sched_ext, and then
+	 * carefully copy the time it's been runnable, and its state.
+	 */
+	if (copy_from_kernel_nofault(&class, &p->sched_class, sizeof(class)) ||
+	    class != &ext_sched_class) {
+		printk("%sSched_ext: %s (%s%s)", log_lvl, scx_ops.name,
+		       scx_ops_enable_state_str[state], all);
+		return;
+	}
+
+	if (!copy_from_kernel_nofault(&runnable_at, &p->scx.runnable_at,
+				      sizeof(runnable_at)))
+		scnprintf(runnable_at_buf, sizeof(runnable_at_buf), "%+ldms",
+			  jiffies_delta_msecs(runnable_at, jiffies));
+
+	/* print everything onto one line to conserve console space */
+	printk("%sSched_ext: %s (%s%s), task: runnable_at=%s",
+	       log_lvl, scx_ops.name, scx_ops_enable_state_str[state], all,
+	       runnable_at_buf);
+}
+
 void __init init_sched_ext_class(void)
 {
 	s32 cpu, v;
diff --git a/lib/dump_stack.c b/lib/dump_stack.c
index 222c6d6c8281..9581ef4efec5 100644
--- a/lib/dump_stack.c
+++ b/lib/dump_stack.c
@@ -68,6 +68,7 @@ void dump_stack_print_info(const char *log_lvl)
 
 	print_worker_info(log_lvl, current);
 	print_stop_info(log_lvl, current);
+	print_scx_info(log_lvl, current);
 }
 
 /**
-- 
2.45.2
```

## Diff

```diff
---
 include/linux/sched/ext.h |  2 ++
 kernel/sched/core.c       |  1 +
 kernel/sched/ext.c        | 53 +++++++++++++++++++++++++++++++++++++++
 lib/dump_stack.c          |  1 +
 4 files changed, 57 insertions(+)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index ea7c501ac819..85fb5dc725ef 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -155,10 +155,12 @@ struct sched_ext_entity {
 };

 void sched_ext_free(struct task_struct *p);
+void print_scx_info(const char *log_lvl, struct task_struct *p);

 #else	/* !CONFIG_SCHED_CLASS_EXT */

 static inline void sched_ext_free(struct task_struct *p) {}
+static inline void print_scx_info(const char *log_lvl, struct task_struct *p) {}

 #endif	/* CONFIG_SCHED_CLASS_EXT */
 #endif	/* _LINUX_SCHED_EXT_H */
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index f4365becdc13..1a3144c80af8 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -7486,6 +7486,7 @@ void sched_show_task(struct task_struct *p)

 	print_worker_info(KERN_INFO, p);
 	print_stop_info(KERN_INFO, p);
+	print_scx_info(KERN_INFO, p);
 	show_stack(p, NULL, KERN_INFO);
 	put_task_stack(p);
 }
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 8ff30b80e862..6f4de29d7372 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -586,6 +586,14 @@ static __printf(3, 4) void scx_ops_exit_kind(enum scx_exit_kind kind,

 #define SCX_HAS_OP(op)	static_branch_likely(&scx_has_op[SCX_OP_IDX(op)])

+static long jiffies_delta_msecs(unsigned long at, unsigned long now)
+{
+	if (time_after(at, now))
+		return jiffies_to_msecs(at - now);
+	else
+		return -(long)jiffies_to_msecs(now - at);
+}
+
 /* if the highest set bit is N, return a mask with bits [N+1, 31] set */
 static u32 higher_bits(u32 flags)
 {
@@ -3715,6 +3723,51 @@ static const struct sysrq_key_op sysrq_sched_ext_reset_op = {
 	.enable_mask	= SYSRQ_ENABLE_RTNICE,
 };

+/**
+ * print_scx_info - print out sched_ext scheduler state
+ * @log_lvl: the log level to use when printing
+ * @p: target task
+ *
+ * If a sched_ext scheduler is enabled, print the name and state of the
+ * scheduler. If @p is on sched_ext, print further information about the task.
+ *
+ * This function can be safely called on any task as long as the task_struct
+ * itself is accessible. While safe, this function isn't synchronized and may
+ * print out mixups or garbages of limited length.
+ */
+void print_scx_info(const char *log_lvl, struct task_struct *p)
+{
+	enum scx_ops_enable_state state = scx_ops_enable_state();
+	const char *all = READ_ONCE(scx_switching_all) ? "+all" : "";
+	char runnable_at_buf[22] = "?";
+	struct sched_class *class;
+	unsigned long runnable_at;
+
+	if (state == SCX_OPS_DISABLED)
+		return;
+
+	/*
+	 * Carefully check if the task was running on sched_ext, and then
+	 * carefully copy the time it's been runnable, and its state.
+	 */
+	if (copy_from_kernel_nofault(&class, &p->sched_class, sizeof(class)) ||
+	    class != &ext_sched_class) {
+		printk("%sSched_ext: %s (%s%s)", log_lvl, scx_ops.name,
+		       scx_ops_enable_state_str[state], all);
+		return;
+	}
+
+	if (!copy_from_kernel_nofault(&runnable_at, &p->scx.runnable_at,
+				      sizeof(runnable_at)))
+		scnprintf(runnable_at_buf, sizeof(runnable_at_buf), "%+ldms",
+			  jiffies_delta_msecs(runnable_at, jiffies));
+
+	/* print everything onto one line to conserve console space */
+	printk("%sSched_ext: %s (%s%s), task: runnable_at=%s",
+	       log_lvl, scx_ops.name, scx_ops_enable_state_str[state], all,
+	       runnable_at_buf);
+}
+
 void __init init_sched_ext_class(void)
 {
 	s32 cpu, v;
diff --git a/lib/dump_stack.c b/lib/dump_stack.c
index 222c6d6c8281..9581ef4efec5 100644
--- a/lib/dump_stack.c
+++ b/lib/dump_stack.c
@@ -68,6 +68,7 @@ void dump_stack_print_info(const char *log_lvl)

 	print_worker_info(log_lvl, current);
 	print_stop_info(log_lvl, current);
+	print_scx_info(log_lvl, current);
 }

 /**
--
2.45.2


```

## Implementation Analysis

### Overview

When a kernel panic, oops, or task stack dump (sysrq-T) occurs, it is extremely useful to know which BPF scheduler is loaded and how that scheduler sees the task being dumped. This patch adds `print_scx_info()`, a function called from the same context as `print_worker_info()` and `print_stop_info()`, that emits sched_ext state as part of the standard stack dump line. The function is explicitly designed to be safe to call without any locks, at any time the `task_struct` pointer is valid, even in oops context.

### Code Walkthrough

**`include/linux/sched/ext.h` — declaration**

Two declarations are added: the real `print_scx_info()` under `CONFIG_SCHED_CLASS_EXT` and a no-op stub when the config is absent. This is the standard pattern for optional scheduler features that get called from `kernel/sched/core.c` regardless of config.

**`kernel/sched/core.c` and `lib/dump_stack.c` — call sites**

```c
// sched_show_task() in core.c — called by sysrq-T and /proc/<pid>/stack
print_worker_info(KERN_INFO, p);
print_stop_info(KERN_INFO, p);
print_scx_info(KERN_INFO, p);   // NEW
show_stack(p, NULL, KERN_INFO);

// dump_stack_print_info() in lib/dump_stack.c — called on oops/panic
print_worker_info(log_lvl, current);
print_stop_info(log_lvl, current);
print_scx_info(log_lvl, current);  // NEW
```

Two call sites are added so that SCX state appears in both task-specific dumps (sysrq-T iterates tasks and calls `sched_show_task()`) and the current-task dump on oops (via `dump_stack_print_info()`).

**`kernel/sched/ext.c` — `jiffies_delta_msecs()` helper**

```c
static long jiffies_delta_msecs(unsigned long at, unsigned long now)
{
    if (time_after(at, now))
        return jiffies_to_msecs(at - now);
    else
        return -(long)jiffies_to_msecs(now - at);
}
```

A signed millisecond delta from a jiffies timestamp. A positive value means the event is in the future; negative means it is in the past. Used to show how long a task has been waiting to run (`runnable_at`).

**`kernel/sched/ext.c` — `print_scx_info()`**

```c
void print_scx_info(const char *log_lvl, struct task_struct *p)
{
    enum scx_ops_enable_state state = scx_ops_enable_state();
    const char *all = READ_ONCE(scx_switching_all) ? "+all" : "";
    char runnable_at_buf[22] = "?";
    struct sched_class *class;
    unsigned long runnable_at;

    if (state == SCX_OPS_DISABLED)
        return;

    if (copy_from_kernel_nofault(&class, &p->sched_class, sizeof(class)) ||
        class != &ext_sched_class) {
        printk("%sSched_ext: %s (%s%s)", log_lvl, scx_ops.name,
               scx_ops_enable_state_str[state], all);
        return;
    }

    if (!copy_from_kernel_nofault(&runnable_at, &p->scx.runnable_at,
                                  sizeof(runnable_at)))
        scnprintf(runnable_at_buf, sizeof(runnable_at_buf), "%+ldms",
                  jiffies_delta_msecs(runnable_at, jiffies));

    printk("%sSched_ext: %s (%s%s), task: runnable_at=%s",
           log_lvl, scx_ops.name, scx_ops_enable_state_str[state], all,
           runnable_at_buf);
}
```

Key design decisions:
- `copy_from_kernel_nofault()` is used instead of direct dereference because this function may be called in contexts where the `task_struct` memory is partially or fully inaccessible (e.g., after a use-after-free or during an oops where memory is in an unknown state). The nofault variant returns an error instead of faulting.
- If the task is not an SCX task, only the scheduler name and state are printed (no per-task fields). This is still useful: you learn which BPF scheduler was loaded and in what state.
- If the task is an SCX task, the `runnable_at` jiffies timestamp is read (again with nofault) and converted to a signed millisecond offset from "now". A value like `-17ms` means the task has been waiting to run for 17 milliseconds.
- Everything is printed on one line to conserve console space in oops output.

### Key Concepts

- **`scx_ops_enable_state_str[]`**: A string array mapping `enum scx_ops_enable_state` values (`SCX_OPS_PREPPING`, `SCX_OPS_ENABLING`, `SCX_OPS_ENABLED`, `SCX_OPS_DISABLING`, `SCX_OPS_DISABLED`) to human-readable names. This array was moved to an earlier patch because it is now needed outside `CONFIG_SCHED_DEBUG`.
- **`scx_switching_all`**: A flag indicating whether all tasks are under the BPF scheduler (vs. only tasks with `SCHED_EXT` policy). The `+all` suffix in the output reflects this.
- **`p->scx.runnable_at`**: A jiffies timestamp set when the task becomes runnable. The delta shown in the dump tells you how long the task has been stuck waiting — critical for diagnosing starvation or dispatch bugs.
- **`copy_from_kernel_nofault()`**: Safe dereference that handles faults gracefully. The comment in the implementation explicitly notes the function is "not synchronized and may print out mixups or garbages of limited length" — this is an acceptable trade-off for a debugging aid.

### Locking and Concurrency Notes

`print_scx_info()` deliberately holds no locks and uses no synchronization. It reads `scx_ops.name`, `scx_ops_enable_state_var`, `scx_switching_all`, and `p->scx.runnable_at` all without protection. The function comment acknowledges this: it may print "mixups or garbages". This is intentional — the function must remain safe to call in any context, including NMI and oops handlers where acquiring locks is forbidden. The `READ_ONCE()` on `scx_switching_all` provides minimal compiler barrier protection without locking.

### Why Maintainers Need to Know This

- **This is the first line of debugging for hung systems**: When a system is unresponsive with a BPF scheduler loaded, sysrq-T will now tell you which scheduler is loaded, its state, and which tasks are stuck waiting. Without this, you would have no kernel-side indication that a BPF scheduler is involved.
- **The example output in the commit message is the expected format**: `Sched_ext: qmap (enabled+all), task: runnable_at=-17ms`. A maintainer reviewing a bug report should look for this line in the oops/sysrq output.
- **`copy_from_kernel_nofault` is the right tool here**: Any future extensions to `print_scx_info()` that read additional task fields should continue using nofault accessors. Direct dereferences in this path are a latent crash risk.
- **State transitions during dump**: Because the function is unsynchronized, it is possible for the state to change (e.g., BPF scheduler being unloaded) between the `scx_ops_enable_state()` read and the `printk`. The output may be stale or inconsistent. This is acceptable.

### Connection to Other Patches

- The `scx_ops_enable_state_str[]` array used here was moved out of `CONFIG_SCHED_DEBUG` gating by an earlier patch precisely because this function needs it in non-debug builds.
- `p->scx.runnable_at` is a field established by the core sched_ext task tracking patches; its purpose as a starvation detection timestamp is directly exploited here for human-readable output.
- The watchdog (PATCH 12) detects starvation and triggers an error exit; `print_scx_info()` provides the complementary operator-facing visibility into how long a task has been waiting, useful for diagnosing watchdog triggers before they escalate.

