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

### High-Level Analysis
There are states which are interesting but don't quite fit the interface

### Detailed Walkthrough
1. File: `tools/sched_ext/scx_show_state.py`
   Hunk: `@@ -0,0 +1,39 @@`
   Before
   ```text
   -
   ```
   After
   ```text
   #!/usr/bin/env drgn
   #
   # Copyright (C) 2024 Tejun Heo <tj@kernel.org>
   ```

### sched_ext Context
This patch directly expands sched_ext integration points and makes the scheduler core more extensible for BPF-defined policies.

