# [PATCH 11/30] sched_ext: Add sysrq-S which disables the BPF scheduler

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-12-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-12-tj@kernel.org)

## Commit Message

```text
This enables the admin to abort the BPF scheduler and revert to CFS anytime.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 drivers/tty/sysrq.c         |  1 +
 kernel/sched/build_policy.c |  1 +
 kernel/sched/ext.c          | 20 ++++++++++++++++++++
 3 files changed, 22 insertions(+)

diff --git a/drivers/tty/sysrq.c b/drivers/tty/sysrq.c
index e5974b8239c9..167e877b8bef 100644
--- a/drivers/tty/sysrq.c
+++ b/drivers/tty/sysrq.c
@@ -531,6 +531,7 @@ static const struct sysrq_key_op *sysrq_key_table[62] = {
 	NULL,				/* P */
 	NULL,				/* Q */
 	&sysrq_replay_logs_op,		/* R */
+	/* S: May be registered by sched_ext for resetting */
 	NULL,				/* S */
 	NULL,				/* T */
 	NULL,				/* U */
diff --git a/kernel/sched/build_policy.c b/kernel/sched/build_policy.c
index f0c148fcd2df..9223c49ddcf3 100644
--- a/kernel/sched/build_policy.c
+++ b/kernel/sched/build_policy.c
@@ -32,6 +32,7 @@
 #include <linux/suspend.h>
 #include <linux/tsacct_kern.h>
 #include <linux/vtime.h>
+#include <linux/sysrq.h>
 #include <linux/percpu-rwsem.h>
 
 #include <uapi/linux/sched/types.h>
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 49b115f5b052..1f5d80df263a 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -20,6 +20,7 @@ enum scx_exit_kind {
 	SCX_EXIT_UNREG = 64,	/* user-space initiated unregistration */
 	SCX_EXIT_UNREG_BPF,	/* BPF-initiated unregistration */
 	SCX_EXIT_UNREG_KERN,	/* kernel-initiated unregistration */
+	SCX_EXIT_SYSRQ,		/* requested by 'S' sysrq */
 
 	SCX_EXIT_ERROR = 1024,	/* runtime error, error msg contains details */
 	SCX_EXIT_ERROR_BPF,	/* ERROR but triggered through scx_bpf_error() */
@@ -2776,6 +2777,8 @@ static const char *scx_exit_reason(enum scx_exit_kind kind)
 		return "Scheduler unregistered from BPF";
 	case SCX_EXIT_UNREG_KERN:
 		return "Scheduler unregistered from the main kernel";
+	case SCX_EXIT_SYSRQ:
+		return "disabled by sysrq-S";
 	case SCX_EXIT_ERROR:
 		return "runtime error";
 	case SCX_EXIT_ERROR_BPF:
@@ -3526,6 +3529,21 @@ static struct bpf_struct_ops bpf_sched_ext_ops = {
  * System integration and init.
  */
 
+static void sysrq_handle_sched_ext_reset(u8 key)
+{
+	if (scx_ops_helper)
+		scx_ops_disable(SCX_EXIT_SYSRQ);
+	else
+		pr_info("sched_ext: BPF scheduler not yet used\n");
+}
+
+static const struct sysrq_key_op sysrq_sched_ext_reset_op = {
+	.handler	= sysrq_handle_sched_ext_reset,
+	.help_msg	= "reset-sched-ext(S)",
+	.action_msg	= "Disable sched_ext and revert all tasks to CFS",
+	.enable_mask	= SYSRQ_ENABLE_RTNICE,
+};
+
 void __init init_sched_ext_class(void)
 {
 	s32 cpu, v;
@@ -3549,6 +3567,8 @@ void __init init_sched_ext_class(void)
 		init_dsq(&rq->scx.local_dsq, SCX_DSQ_LOCAL);
 		INIT_LIST_HEAD(&rq->scx.runnable_list);
 	}
+
+	register_sysrq_key('S', &sysrq_sched_ext_reset_op);
 }
 
 
-- 
2.45.2
```

## Diff

```diff
---
 drivers/tty/sysrq.c         |  1 +
 kernel/sched/build_policy.c |  1 +
 kernel/sched/ext.c          | 20 ++++++++++++++++++++
 3 files changed, 22 insertions(+)

diff --git a/drivers/tty/sysrq.c b/drivers/tty/sysrq.c
index e5974b8239c9..167e877b8bef 100644
--- a/drivers/tty/sysrq.c
+++ b/drivers/tty/sysrq.c
@@ -531,6 +531,7 @@ static const struct sysrq_key_op *sysrq_key_table[62] = {
 	NULL,				/* P */
 	NULL,				/* Q */
 	&sysrq_replay_logs_op,		/* R */
+	/* S: May be registered by sched_ext for resetting */
 	NULL,				/* S */
 	NULL,				/* T */
 	NULL,				/* U */
diff --git a/kernel/sched/build_policy.c b/kernel/sched/build_policy.c
index f0c148fcd2df..9223c49ddcf3 100644
--- a/kernel/sched/build_policy.c
+++ b/kernel/sched/build_policy.c
@@ -32,6 +32,7 @@
 #include <linux/suspend.h>
 #include <linux/tsacct_kern.h>
 #include <linux/vtime.h>
+#include <linux/sysrq.h>
 #include <linux/percpu-rwsem.h>

 #include <uapi/linux/sched/types.h>
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 49b115f5b052..1f5d80df263a 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -20,6 +20,7 @@ enum scx_exit_kind {
 	SCX_EXIT_UNREG = 64,	/* user-space initiated unregistration */
 	SCX_EXIT_UNREG_BPF,	/* BPF-initiated unregistration */
 	SCX_EXIT_UNREG_KERN,	/* kernel-initiated unregistration */
+	SCX_EXIT_SYSRQ,		/* requested by 'S' sysrq */

 	SCX_EXIT_ERROR = 1024,	/* runtime error, error msg contains details */
 	SCX_EXIT_ERROR_BPF,	/* ERROR but triggered through scx_bpf_error() */
@@ -2776,6 +2777,8 @@ static const char *scx_exit_reason(enum scx_exit_kind kind)
 		return "Scheduler unregistered from BPF";
 	case SCX_EXIT_UNREG_KERN:
 		return "Scheduler unregistered from the main kernel";
+	case SCX_EXIT_SYSRQ:
+		return "disabled by sysrq-S";
 	case SCX_EXIT_ERROR:
 		return "runtime error";
 	case SCX_EXIT_ERROR_BPF:
@@ -3526,6 +3529,21 @@ static struct bpf_struct_ops bpf_sched_ext_ops = {
  * System integration and init.
  */

+static void sysrq_handle_sched_ext_reset(u8 key)
+{
+	if (scx_ops_helper)
+		scx_ops_disable(SCX_EXIT_SYSRQ);
+	else
+		pr_info("sched_ext: BPF scheduler not yet used\n");
+}
+
+static const struct sysrq_key_op sysrq_sched_ext_reset_op = {
+	.handler	= sysrq_handle_sched_ext_reset,
+	.help_msg	= "reset-sched-ext(S)",
+	.action_msg	= "Disable sched_ext and revert all tasks to CFS",
+	.enable_mask	= SYSRQ_ENABLE_RTNICE,
+};
+
 void __init init_sched_ext_class(void)
 {
 	s32 cpu, v;
@@ -3549,6 +3567,8 @@ void __init init_sched_ext_class(void)
 		init_dsq(&rq->scx.local_dsq, SCX_DSQ_LOCAL);
 		INIT_LIST_HEAD(&rq->scx.runnable_list);
 	}
+
+	register_sysrq_key('S', &sysrq_sched_ext_reset_op);
 }


--
2.45.2


```

## Implementation Analysis

### Overview

This patch (PATCH 11/30) adds the sysrq-S escape hatch: pressing `Alt+SysRq+S` on a system running a BPF scheduler calls `scx_ops_disable(SCX_EXIT_SYSRQ)`, which performs an orderly shutdown of the BPF scheduler and migrates all tasks back to CFS. The patch is small (22 lines of meaningful code across three files) but provides a critical operator safety guarantee: no matter how badly a BPF scheduler misbehaves, a human at a console can recover the system without a reboot.

### Architecture Context

The sysrq subsystem is the kernel's last-resort operator interface. It is designed to function even when the system is severely degraded — it bypasses normal kernel locking and work queues and is triggered directly from the interrupt handler for the SysRq key. This makes it suitable as the manual complement to the watchdog (PATCH 12/30), which handles the automated "scheduler appears stuck" case.

The full set of sched_ext safety mechanisms forms a layered defense:

1. **BPF verifier** (static): Prevents obviously unsafe BPF programs from loading.
2. **Callback return value checking** (dynamic): sched_ext validates every value returned from a BPF callback and calls `scx_ops_error()` if invalid.
3. **Watchdog** (automatic runtime): Detects runnable tasks that have not been scheduled for longer than `timeout_ms` and triggers shutdown.
4. **sysrq-S** (manual runtime): Operator-initiated shutdown when the above automatics have not fired but the system is clearly misbehaving.

This patch implements layer 4.

### Code Walkthrough

**`drivers/tty/sysrq.c` — slot reservation**

```c
/* S: May be registered by sched_ext for resetting */
NULL,				/* S */
```

The sysrq key table uses static registration for most keys. sched_ext uses `register_sysrq_key()` instead because `ext.c` is in `kernel/sched/` and cannot directly initialize the `drivers/tty/sysrq.c` table. The comment is added to the existing `NULL` entry so that developers looking at the sysrq table know slot 'S' is intentionally reserved — preventing another subsystem from claiming it.

This is a deliberate documentation-by-comment approach: the slot is not locked in any runtime sense, but the comment establishes ownership so that future maintainers do not inadvertently steal 'S' for an unrelated feature.

**`kernel/sched/build_policy.c` — build system include**

```c
#include <linux/sysrq.h>
```

`build_policy.c` is the translation unit that includes `ext.c` (along with the other policy files like `fair.c`, `rt.c`, etc.) via `#include`. Adding `sysrq.h` here rather than directly in `ext.c` is consistent with how other kernel-wide headers are managed in the scheduler build system — `build_policy.c` owns the external includes so that `ext.c` can focus on scheduler logic.

**`kernel/sched/ext.c` — the handler and registration**

```c
static void sysrq_handle_sched_ext_reset(u8 key)
{
    if (scx_ops_helper)
        scx_ops_disable(SCX_EXIT_SYSRQ);
    else
        pr_info("sched_ext: BPF scheduler not yet used\n");
}

static const struct sysrq_key_op sysrq_sched_ext_reset_op = {
    .handler     = sysrq_handle_sched_ext_reset,
    .help_msg    = "reset-sched-ext(S)",
    .action_msg  = "Disable sched_ext and revert all tasks to CFS",
    .enable_mask = SYSRQ_ENABLE_RTNICE,
};
```

The `scx_ops_helper` check is the correct way to determine whether a BPF scheduler has ever been loaded. `scx_ops_helper` is a kthread created during `scx_ops_enable()` and set to `NULL` when no scheduler is active. Checking it avoids calling `scx_ops_disable()` in an inconsistent state if the key is pressed before any BPF scheduler is loaded, instead printing a diagnostic message.

The `.enable_mask = SYSRQ_ENABLE_RTNICE` field means this sysrq action is restricted to kernels with `CONFIG_MAGIC_SYSRQ_DEFAULT_ENABLE` that includes the RTNICE bit, or to systems where sysrq has been explicitly unlocked via `/proc/sys/kernel/sysrq`. This is a deliberate access control: the ability to forcibly terminate a production BPF scheduler should require explicit administrative intent, not be available to any user who knows the sysrq sequence.

```c
void __init init_sched_ext_class(void)
{
    /* ... per-CPU DSQ init ... */
    register_sysrq_key('S', &sysrq_sched_ext_reset_op);
}
```

Registration happens in `init_sched_ext_class()`, which is called from `sched_init()` early in boot. The handler is therefore always registered from the moment the scheduler subsystem initializes, regardless of whether a BPF scheduler is ever loaded.

**`enum scx_exit_kind` — new exit code**

```c
SCX_EXIT_SYSRQ,    /* requested by 'S' sysrq */
```

Every BPF scheduler shutdown carries an `scx_exit_kind` value that is passed to `ops.exit()`. The BPF scheduler userspace binary can inspect this to distinguish a normal unload from a watchdog-triggered abort from an operator-triggered sysrq reset. This allows the userspace control plane (e.g., `scx_simple.c`) to log or restart appropriately.

The exit kind value `SCX_EXIT_SYSRQ` sits in the `SCX_EXIT_UNREG` range (64–1023), not the `SCX_EXIT_ERROR` range (1024+). This is semantically important: sysrq-S is an orderly administrative action, not an error. The BPF scheduler did not do anything wrong; the operator decided to terminate it.

### Key Concepts Introduced

**`scx_ops_disable(kind)`**: The central function for shutting down the BPF scheduler. It is asynchronous — it schedules a kthread work item (`scx_ops_disable_workfn`) rather than performing the shutdown inline. This is necessary because `sysrq_handle_sched_ext_reset()` is called in interrupt context where many of the operations required for an orderly shutdown (sleeping, acquiring mutexes, iterating over all tasks) are not safe. The work item runs in a kthread and can safely perform all cleanup.

**`SCX_EXIT_SYSRQ` vs `SCX_EXIT_ERROR_STALL`**: The distinction between these two exit codes is fundamental to how the userspace scheduler binary reacts. `SCX_EXIT_SYSRQ` means "operator asked us to stop" — a clean exit. `SCX_EXIT_ERROR_STALL` means "scheduler was detected as broken" — a fault requiring investigation. BPF schedulers should handle these differently in their `ops.exit()` implementation.

### Why This Matters for Maintainers

**The `scx_ops_helper` NULL check is load-bearing**: The handler must check `scx_ops_helper` before calling `scx_ops_disable()`. Calling `scx_ops_disable()` with no active BPF scheduler would operate on uninitialized state. If this check is ever removed or changed, the exit path in `scx_ops_disable_workfn()` must be audited for use-after-free and null dereference.

**Registration before first use**: The sysrq key is registered in `init_sched_ext_class()` which runs at `late_initcall` time during boot, long before any BPF scheduler could be loaded. This means `sysrq_handle_sched_ext_reset()` is always registered and safe to call. If this registration is moved later (e.g., into `scx_ops_enable()`), there would be a window between boot and the first scheduler load during which pressing sysrq-S would silently do nothing — a regression in the safety guarantee.

**The `enable_mask` constraint**: `SYSRQ_ENABLE_RTNICE` is not the most permissive mask. On a locked-down system (e.g., `kernel.sysrq = 0`), sysrq-S will not work. This is intentional for production security posture, but it means that in environments where sysrq is disabled for security reasons, the watchdog (PATCH 12/30) is the only automated recovery mechanism. Maintainers should document this interaction.

**Interaction with the disable path**: `scx_ops_disable_workfn()` calls `cancel_delayed_work_sync(&scx_watchdog_work)` (added in PATCH 12/30). The ordering matters: the watchdog work must be cancelled before the BPF scheduler state is torn down, otherwise the watchdog could fire on a partially-disabled scheduler and trigger a second, spurious `scx_ops_error()`.

### Connection to Other Patches

This patch is directly paired with PATCH 12/30 (patch-11.md, the watchdog). Together they implement the two recovery modes:

- **sysrq-S** (this patch): Manual, operator-triggered, orderly shutdown with exit kind `SCX_EXIT_SYSRQ`.
- **Watchdog** (PATCH 12/30): Automatic, timer-triggered, error shutdown with exit kind `SCX_EXIT_ERROR_STALL`.

Both ultimately call `scx_ops_disable()` / `scx_ops_error()`, which feeds into `scx_ops_disable_workfn()`. The disable workfn is the single chokepoint for all BPF scheduler shutdown paths, and its correctness is critical to the safety guarantee advertised in the cover letter (patch-08.md).

