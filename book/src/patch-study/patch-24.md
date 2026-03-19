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

### Overview

This patch (PATCH 26/30) adds a power management notifier to sched_ext. When a PM event (suspend, hibernate, restore) is in progress, userspace is frozen. Many BPF schedulers have active userspace components — daemons that provide scheduling hints, load balancing decisions, or topology information. With userspace frozen, these components cannot respond, which can cause scheduling stalls. The fix is simple: bypass the BPF scheduler during PM events, falling back to FIFO behavior, and re-enable it when PM completes.

This is a bypass, not a disable. The BPF program stays loaded; it is just temporarily skipped via the `scx_ops_bypass()` mechanism.

### Code Walkthrough

**The PM notifier handler** (`kernel/sched/ext.c`):

```c
static int scx_pm_handler(struct notifier_block *nb, unsigned long event, void *ptr)
{
    switch (event) {
    case PM_HIBERNATION_PREPARE:
    case PM_SUSPEND_PREPARE:
    case PM_RESTORE_PREPARE:
        scx_ops_bypass(true);
        break;
    case PM_POST_HIBERNATION:
    case PM_POST_SUSPEND:
    case PM_POST_RESTORE:
        scx_ops_bypass(false);
        break;
    }
    return NOTIFY_OK;
}

static struct notifier_block scx_pm_notifier = {
    .notifier_call = scx_pm_handler,
};
```

Three PM event types are handled on each side. `PM_RESTORE_PREPARE` covers the case where a hibernation image is being restored (which also freezes tasks). The POST variants undo the bypass after the PM transition is complete.

**Registration in `scx_init()`**:

```c
ret = register_pm_notifier(&scx_pm_notifier);
if (ret) {
    pr_err("sched_ext: Failed to register PM notifier (%d)\n", ret);
    return ret;
}
```

This is called from the module `__init` function. If registration fails, sched_ext initialization fails entirely. The notifier block is global and static — there is one registration for the lifetime of the kernel module.

**What `scx_ops_bypass(true)` does** (documented in the bypass function's comment in `ext.c`, populated by prior patches):
- Increments `bypass_depth`
- Sets `scx_switching_all = false` so `ops.select_cpu()` returns `-EBUSY` and tasks fall back to CFS dispatch
- Tasks already on SCX local DSQs are rotated out at every tick
- `scx_bpf_kick_cpu()` is disabled to avoid irq_work malfunction during PM operations
- `scx_prio_less()` reverts to default `core_sched_at` ordering (from the core-sched patch)

`bypass_depth` is a counter, not a boolean, so nested bypass calls are safe (e.g., if a future patch adds another bypass condition that can overlap with PM).

### Key Concepts

- **Bypass vs. disable**: Bypass is temporary and leaves the BPF scheduler loaded. The BPF program is not unloaded, BPF maps retain their state, and userspace does not need to reinitialize. When the PM event ends, scheduling resumes exactly where it left off.
- **`PM_RESTORE_PREPARE`**: This is the hibernation restore case, distinct from `PM_HIBERNATION_PREPARE` (saving the image). Both require userspace to be frozen, hence both trigger bypass.
- **`NOTIFY_OK`**: The notifier returns `NOTIFY_OK` unconditionally — if the bypass fails for some reason (which `scx_ops_bypass()` handles internally), the PM event is not blocked.
- **`register_pm_notifier()`**: Part of the kernel's power management notifier chain (`kernel/power/main.c`). Notifiers in this chain are called before and after PM state transitions. The notifier block must remain valid for the lifetime of the module.

### Locking and Concurrency Notes

- `scx_ops_bypass(true/false)` acquires `cpus_read_lock()` internally to safely modify the bypass depth and static keys across all CPUs. PM notifiers are called from process context during the PM transition, so sleeping is allowed.
- The PM notifier fires before userspace is frozen (in the `PREPARE` phase), ensuring that the bypass is active before any userspace scheduler component stops responding.
- `NOTIFY_OK` (not `NOTIFY_STOP` or `NOTIFY_BAD`) means sched_ext does not block or veto the PM transition. It is a pure observer that adjusts its own behavior.

### Integration with Kernel Subsystems

This patch integrates with the kernel's `pm_notifier` chain, registered via `register_pm_notifier()`. The PM notifier infrastructure is in `kernel/power/`. The six event codes handled (`PM_{HIBERNATION,SUSPEND,RESTORE}_PREPARE` and their `POST_` counterparts) cover all major PM transitions that involve freezing userspace tasks.

The choice of `scx_init()` (the module init function) as the registration point ensures the notifier is active for the entire lifetime of the sched_ext module, including before any BPF scheduler is loaded.

### What Maintainers Need to Know

- This is a **transparent bypass** — BPF schedulers do not need to do anything to benefit from it. All schedulers automatically get PM safety.
- The bypass uses `bypass_depth` (a counter), so it is safe to add additional bypass conditions in the future without breaking PM bypass. Each `scx_ops_bypass(true)` must be paired with exactly one `scx_ops_bypass(false)`.
- BPF schedulers with userspace components (daemons, agents) do not need special PM handling code on the BPF side. The bypass handles it at the kernel level.
- **cpufreq transitions are NOT covered** by this patch. The commit message refers specifically to "PM operations" which freeze userspace. cpufreq governor transitions do not freeze userspace and are not intercepted here.
- If `register_pm_notifier()` fails during `scx_init()`, sched_ext will not load at all. This is intentional — failing to register the PM notifier would leave the system potentially vulnerable to PM-induced scheduling stalls.
- During bypass, the `scx_show_state.py` drgn script will show `bypass_depth > 0`.

### Connection to Other Patches

- **Patch 25/30 (cpu_online/offline)**: CPU hotplug also suspends/resumes CPUs. PM events interact with hotplug but are separate kernel mechanisms. The bypass here covers the scheduling correctness problem during PM; hotplug callbacks handle the CPU topology changes.
- **Patch 27/30 (core-sched)**: The bypass disables `ops.core_sched_before()` by making `scx_prio_less()` fall back to default `core_sched_at` ordering. This is explicitly noted as bullet point `f` in the bypass function's comment.
- **The bypass mechanism itself** was introduced in earlier patches in this series. This patch is a consumer of that existing infrastructure.

