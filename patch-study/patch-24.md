# [PATCH 26/30] sched_ext: Bypass BPF scheduler while PM events are in progress

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-27-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-27-tj@kernel.org)

## Commit Message

```text
PM operations freeze userspace. Some BPF schedulers have active userspace
component and may misbehave as expected across PM events. While the system
is frozen, nothing too interesting is happening in terms of scheduling and
we can get by just fine with the fallback FIFO behavior. Let's make things
easier by always bypassing the BPF scheduler while PM events are in
progress.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
---
 kernel/sched/ext.c | 34 ++++++++++++++++++++++++++++++++++
 1 file changed, 34 insertions(+)

diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 7c2f2a542b32..26616cd0c5df 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -4825,6 +4825,34 @@ void print_scx_info(const char *log_lvl, struct task_struct *p)
 	       runnable_at_buf);
 }
 
+static int scx_pm_handler(struct notifier_block *nb, unsigned long event, void *ptr)
+{
+	/*
+	 * SCX schedulers often have userspace components which are sometimes
+	 * involved in critial scheduling paths. PM operations involve freezing
+	 * userspace which can lead to scheduling misbehaviors including stalls.
+	 * Let's bypass while PM operations are in progress.
+	 */
+	switch (event) {
+	case PM_HIBERNATION_PREPARE:
+	case PM_SUSPEND_PREPARE:
+	case PM_RESTORE_PREPARE:
+		scx_ops_bypass(true);
+		break;
+	case PM_POST_HIBERNATION:
+	case PM_POST_SUSPEND:
+	case PM_POST_RESTORE:
+		scx_ops_bypass(false);
+		break;
+	}
+
+	return NOTIFY_OK;
+}
+
+static struct notifier_block scx_pm_notifier = {
+	.notifier_call = scx_pm_handler,
+};
+
 void __init init_sched_ext_class(void)
 {
 	s32 cpu, v;
@@ -5729,6 +5757,12 @@ static int __init scx_init(void)
 		return ret;
 	}
 
+	ret = register_pm_notifier(&scx_pm_notifier);
+	if (ret) {
+		pr_err("sched_ext: Failed to register PM notifier (%d)\n", ret);
+		return ret;
+	}
+
 	scx_kset = kset_create_and_add("sched_ext", &scx_uevent_ops, kernel_kobj);
 	if (!scx_kset) {
 		pr_err("sched_ext: Failed to create /sys/kernel/sched_ext\n");
-- 
2.45.2
```

## Diff

```diff
---
 kernel/sched/ext.c | 34 ++++++++++++++++++++++++++++++++++
 1 file changed, 34 insertions(+)

diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 7c2f2a542b32..26616cd0c5df 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -4825,6 +4825,34 @@ void print_scx_info(const char *log_lvl, struct task_struct *p)
 	       runnable_at_buf);
 }

+static int scx_pm_handler(struct notifier_block *nb, unsigned long event, void *ptr)
+{
+	/*
+	 * sched_ext schedulers often have userspace components which are sometimes
+	 * involved in critial scheduling paths. PM operations involve freezing
+	 * userspace which can lead to scheduling misbehaviors including stalls.
+	 * Let's bypass while PM operations are in progress.
+	 */
+	switch (event) {
+	case PM_HIBERNATION_PREPARE:
+	case PM_SUSPEND_PREPARE:
+	case PM_RESTORE_PREPARE:
+		scx_ops_bypass(true);
+		break;
+	case PM_POST_HIBERNATION:
+	case PM_POST_SUSPEND:
+	case PM_POST_RESTORE:
+		scx_ops_bypass(false);
+		break;
+	}
+
+	return NOTIFY_OK;
+}
+
+static struct notifier_block scx_pm_notifier = {
+	.notifier_call = scx_pm_handler,
+};
+
 void __init init_sched_ext_class(void)
 {
 	s32 cpu, v;
@@ -5729,6 +5757,12 @@ static int __init scx_init(void)
 		return ret;
 	}

+	ret = register_pm_notifier(&scx_pm_notifier);
+	if (ret) {
+		pr_err("sched_ext: Failed to register PM notifier (%d)\n", ret);
+		return ret;
+	}
+
 	scx_kset = kset_create_and_add("sched_ext", &scx_uevent_ops, kernel_kobj);
 	if (!scx_kset) {
 		pr_err("sched_ext: Failed to create /sys/kernel/sched_ext\n");
--
2.45.2


```

## Implementation Analysis

### High-Level Analysis
PM operations freeze userspace. Some BPF schedulers have active userspace

### Detailed Walkthrough
1. File: `kernel/sched/ext.c`
   Hunk: `@@ -4825,6 +4825,34 @@ void print_scx_info(const char *log_lvl, struct task_struct *p)`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   static int scx_pm_handler(struct notifier_block *nb, unsigned long event, void *ptr)
   {
   /*
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```

### sched_ext Context
This patch directly expands sched_ext integration points and makes the scheduler core more extensible for BPF-defined policies.

