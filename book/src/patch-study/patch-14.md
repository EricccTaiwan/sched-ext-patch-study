# [PATCH 16/30] tools/sched_ext: Add scx_show_state.py

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-17-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-17-tj@kernel.org)

## Commit Message

```text
There are states which are interesting but don't quite fit the interface
exposed under /sys/kernel/sched_ext. Add tools/scx_show_state.py to show
them.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
---
 tools/sched_ext/scx_show_state.py | 39 +++++++++++++++++++++++++++++++
 1 file changed, 39 insertions(+)
 create mode 100644 tools/sched_ext/scx_show_state.py

diff --git a/tools/sched_ext/scx_show_state.py b/tools/sched_ext/scx_show_state.py
new file mode 100644
index 000000000000..d457d2a74e1e
--- /dev/null
+++ b/tools/sched_ext/scx_show_state.py
@@ -0,0 +1,39 @@
+#!/usr/bin/env drgn
+#
+# Copyright (C) 2024 Tejun Heo <tj@kernel.org>
+# Copyright (C) 2024 Meta Platforms, Inc. and affiliates.
+
+desc = """
+This is a drgn script to show the current sched_ext state.
+For more info on drgn, visit https://github.com/osandov/drgn.
+"""
+
+import drgn
+import sys
+
+def err(s):
+    print(s, file=sys.stderr, flush=True)
+    sys.exit(1)
+
+def read_int(name):
+    return int(prog[name].value_())
+
+def read_atomic(name):
+    return prog[name].counter.value_()
+
+def read_static_key(name):
+    return prog[name].key.enabled.counter.value_()
+
+def ops_state_str(state):
+    return prog['scx_ops_enable_state_str'][state].string_().decode()
+
+ops = prog['scx_ops']
+enable_state = read_atomic("scx_ops_enable_state_var")
+
+print(f'ops           : {ops.name.string_().decode()}')
+print(f'enabled       : {read_static_key("__scx_ops_enabled")}')
+print(f'switching_all : {read_int("scx_switching_all")}')
+print(f'switched_all  : {read_static_key("__scx_switched_all")}')
+print(f'enable_state  : {ops_state_str(enable_state)} ({enable_state})')
+print(f'bypass_depth  : {read_atomic("scx_ops_bypass_depth")}')
+print(f'nr_rejected   : {read_atomic("scx_nr_rejected")}')
-- 
2.45.2
```

## Diff

```diff
---
 tools/sched_ext/scx_show_state.py | 39 +++++++++++++++++++++++++++++++
 1 file changed, 39 insertions(+)
 create mode 100644 tools/sched_ext/scx_show_state.py

diff --git a/tools/sched_ext/scx_show_state.py b/tools/sched_ext/scx_show_state.py
new file mode 100644
index 000000000000..d457d2a74e1e
--- /dev/null
+++ b/tools/sched_ext/scx_show_state.py
@@ -0,0 +1,39 @@
+#!/usr/bin/env drgn
+#
+# Copyright (C) 2024 Tejun Heo <tj@kernel.org>
+# Copyright (C) 2024 Meta Platforms, Inc. and affiliates.
+
+desc = """
+This is a drgn script to show the current sched_ext state.
+For more info on drgn, visit https://github.com/osandov/drgn.
+"""
+
+import drgn
+import sys
+
+def err(s):
+    print(s, file=sys.stderr, flush=True)
+    sys.exit(1)
+
+def read_int(name):
+    return int(prog[name].value_())
+
+def read_atomic(name):
+    return prog[name].counter.value_()
+
+def read_static_key(name):
+    return prog[name].key.enabled.counter.value_()
+
+def ops_state_str(state):
+    return prog['scx_ops_enable_state_str'][state].string_().decode()
+
+ops = prog['scx_ops']
+enable_state = read_atomic("scx_ops_enable_state_var")
+
+print(f'ops           : {ops.name.string_().decode()}')
+print(f'enabled       : {read_static_key("__scx_ops_enabled")}')
+print(f'switching_all : {read_int("scx_switching_all")}')
+print(f'switched_all  : {read_static_key("__scx_switched_all")}')
+print(f'enable_state  : {ops_state_str(enable_state)} ({enable_state})')
+print(f'bypass_depth  : {read_atomic("scx_ops_bypass_depth")}')
+print(f'nr_rejected   : {read_atomic("scx_nr_rejected")}')
--
2.45.2


```

## Implementation Analysis

### Overview

Some critical sched_ext runtime state is not exposed through the sysfs interface at `/sys/kernel/sched_ext` and must be read directly from kernel memory. This patch adds `tools/sched_ext/scx_show_state.py`, a drgn script that reads live kernel state and displays a snapshot of the sched_ext subsystem: which BPF scheduler is loaded, its enable state, whether it is running in full-switch mode, the bypass depth, and how many tasks have been rejected due to the `disallow` flag.

### Code Walkthrough

**`tools/sched_ext/scx_show_state.py` — full file**

The script uses [drgn](https://github.com/osandov/drgn), a programmable Linux kernel debugger that reads live kernel memory from a running system. It requires no kernel modules or BPF programs — drgn reads directly from `/proc/kcore` (or a kernel core dump).

```python
#!/usr/bin/env drgn

def read_int(name):
    return int(prog[name].value_())

def read_atomic(name):
    return prog[name].counter.value_()

def read_static_key(name):
    return prog[name].key.enabled.counter.value_()

def ops_state_str(state):
    return prog['scx_ops_enable_state_str'][state].string_().decode()

ops = prog['scx_ops']
enable_state = read_atomic("scx_ops_enable_state_var")

print(f'ops           : {ops.name.string_().decode()}')
print(f'enabled       : {read_static_key("__scx_ops_enabled")}')
print(f'switching_all : {read_int("scx_switching_all")}')
print(f'switched_all  : {read_static_key("__scx_switched_all")}')
print(f'enable_state  : {ops_state_str(enable_state)} ({enable_state})')
print(f'bypass_depth  : {read_atomic("scx_ops_bypass_depth")}')
print(f'nr_rejected   : {read_atomic("scx_nr_rejected")}')
```

Each field maps directly to a kernel variable:

- **`ops.name`**: The `name` field of the currently registered `sched_ext_ops` struct — tells you which BPF scheduler is loaded.
- **`__scx_ops_enabled`**: A static key (jump label) that is `1` when any BPF scheduler is active. This is the fast-path check used in the hot scheduling path.
- **`scx_switching_all`**: Whether the BPF scheduler is running in "switch all" mode (all tasks use SCHED_EXT, not just those with explicit SCHED_EXT policy).
- **`__scx_switched_all`**: A static key that is `1` when switch-all mode is fully active (distinct from `scx_switching_all` which is the intent; `__scx_switched_all` reflects the actual active state).
- **`scx_ops_enable_state_var`**: The current `enum scx_ops_enable_state` value (PREPPING, ENABLING, ENABLED, DISABLING, DISABLED). Reading this as an atomic counter and mapping through `scx_ops_enable_state_str[]` gives the human-readable state.
- **`scx_ops_bypass_depth`**: How deeply the bypass mode is nested. Non-zero means the BPF scheduler is bypassed (e.g., during CPU hotplug or PM operations) and the system is running with built-in fallback behavior.
- **`scx_nr_rejected`**: Count of tasks rejected from SCHED_EXT due to `p->scx.disallow` since the last BPF scheduler load. Added by PATCH 13/30.

### Key Concepts

- **drgn vs. debugfs**: This tool reads kernel variables that are not exposed via `/sys/kernel/sched_ext`. The sysfs interface only exposes `state`, `switch_all`, and `nr_rejected`. The drgn script can access any kernel symbol, making it more flexible for debugging scenarios where intermediate state matters.
- **Static keys** (`read_static_key()`): sched_ext uses static branch/jump labels for performance-critical checks like `scx_enabled()`. A static key's runtime value is stored in `key.enabled.counter` — this is the internal implementation detail that drgn must access since these are not simple variables.
- **Atomic variables** (`read_atomic()`): `scx_ops_enable_state_var`, `scx_ops_bypass_depth`, and `scx_nr_rejected` are `atomic_t`/`atomic_long_t` — drgn reads `.counter.value_()` for these.
- **`bypass_depth` as a debugging signal**: A non-zero `bypass_depth` when a BPF scheduler should be active indicates the system is in a transitional or suspended state. If `bypass_depth` stays non-zero indefinitely, it suggests a bypass entry/exit imbalance bug.

### Locking and Concurrency Notes

This is a read-only userspace tool that accesses kernel memory without any synchronization. All values read may be transiently inconsistent with each other (e.g., `enable_state` might be ENABLED while `enabled` is 0 during a transition). This is acceptable for a diagnostic snapshot tool. The script should be used to get a general picture of system state, not as a definitive single-point-in-time snapshot.

### Why Maintainers Need to Know This

- **Use this tool to verify BPF scheduler load**: After loading a BPF scheduler, run `sudo python scx_show_state.py` to confirm `ops`, `enabled`, and `enable_state` all match expectations. A mismatch between `scx_switching_all` and `switched_all` indicates the mode transition is not yet complete.
- **`bypass_depth > 0` indicates suppressed scheduling**: If users report that a BPF scheduler is loaded but not making scheduling decisions, check `bypass_depth`. A stuck bypass is a known failure mode during PM suspend/resume sequences.
- **`nr_rejected` monitors disallow policy**: If you have a BPF scheduler that uses `p->scx.disallow`, watch `nr_rejected` to confirm the policy is working. A value of 0 when you expect rejections means the `disallow` flag is not being set correctly.
- **Tool depends on kernel symbol names**: If kernel variables are renamed or restructured, this script will break. It is tied to the internal variable names of a specific kernel version. Users should ensure the drgn script matches their kernel.

### Connection to Other Patches

- **PATCH 13/30** introduced `scx_nr_rejected` — this tool is the first way to read that counter without grep-ing `/sys/kernel/sched_ext/nr_rejected`.
- **PATCH 15/30** introduced the debug dump mechanism for error exits; this tool complements it by showing the live state *before* an error occurs.
- The `scx_ops_enable_state_str[]` array read by this tool was made available outside `CONFIG_SCHED_DEBUG` in PATCH 14/30, which is a prerequisite for this script to work on production kernels without debug config.

