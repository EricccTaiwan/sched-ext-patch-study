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

### High-Level Analysis
From: David Vernet <void@manifault.com>

### Detailed Walkthrough
1. File: `include/linux/sched/ext.h`
   Hunk: `@@ -155,10 +155,12 @@ struct sched_ext_entity {`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   void print_scx_info(const char *log_lvl, struct task_struct *p);
   static inline void print_scx_info(const char *log_lvl, struct task_struct *p) {}
   ```
2. File: `kernel/sched/core.c`
   Hunk: `@@ -7486,6 +7486,7 @@ void sched_show_task(struct task_struct *p)`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   print_scx_info(KERN_INFO, p);
   ```
3. File: `kernel/sched/ext.c`
   Hunk: `@@ -586,6 +586,14 @@ static __printf(3, 4) void scx_ops_exit_kind(enum scx_exit_kind kind,`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   static long jiffies_delta_msecs(unsigned long at, unsigned long now)
   {
   if (time_after(at, now))
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```
4. File: `lib/dump_stack.c`
   Hunk: `@@ -68,6 +68,7 @@ void dump_stack_print_info(const char *log_lvl)`
   Before
   ```text
   -
   ```
   After
   ```text
   print_scx_info(log_lvl, current);
   ```

### sched_ext Context
This patch directly expands sched_ext integration points and makes the scheduler core more extensible for BPF-defined policies.

