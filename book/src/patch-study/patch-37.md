# [PATCH sched_ext/for-6.11] sched_ext: Drop tools_clean target from the top-level Makefile

**View on Lore**: [https://lore.kernel.org/all/ZnokS4YL71S61g71@slm.duckdns.org](https://lore.kernel.org/all/ZnokS4YL71S61g71@slm.duckdns.org)

## Commit Message

```text
2a52ca7c9896 ("sched_ext: Add scx_simple and scx_example_qmap example
schedulers") added the tools_clean target which is triggered by mrproper.
The tools_clean target triggers the sched_ext_clean target in tools/. This
unfortunately makes mrproper fail when no BTF enabled kernel image is found:

  Makefile:83: *** Cannot find a vmlinux for VMLINUX_BTF at any of "  ../../vmlinux /sys/kernel/btf/vmlinux/boot/vmlinux-4.15.0-136-generic".  Stop.
  Makefile:192: recipe for target 'sched_ext_clean' failed
  make[2]: *** [sched_ext_clean] Error 2
  Makefile:1361: recipe for target 'sched_ext' failed
  make[1]: *** [sched_ext] Error 2
  Makefile:240: recipe for target '__sub-make' failed
  make: *** [__sub-make] Error 2

Clean targets shouldn't fail like this but also it's really odd for mrproper
to single out and trigger the sched_ext_clean target when no other clean
targets under tools/ are triggered.

Fix builds by dropping the tools_clean target from the top-level Makefile.
The offending Makefile line is shared across BPF targets under tools/. Let's
revisit them later.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reported-by: Jon Hunter <jonathanh@nvidia.com>
Link: http://lkml.kernel.org/r/ac065f1f-8754-4626-95db-2c9fcf02567b@nvidia.com
Fixes: 2a52ca7c9896 ("sched_ext: Add scx_simple and scx_example_qmap example schedulers")
Cc: David Vernet <void@manifault.com>
---
Jon, this should fix it. I'll route this through sched_ext/for-6.11.

Thanks.

 Makefile |    8 +-------
 1 file changed, 1 insertion(+), 7 deletions(-)

--- a/Makefile
+++ b/Makefile
@@ -1355,12 +1355,6 @@ ifneq ($(wildcard $(resolve_btfids_O)),)
 	$(Q)$(MAKE) -sC $(srctree)/tools/bpf/resolve_btfids O=$(resolve_btfids_O) clean
 endif
 
-tools-clean-targets := sched_ext
-PHONY += $(tools-clean-targets)
-$(tools-clean-targets):
-	$(Q)$(MAKE) -sC tools $@_clean
-tools_clean: $(tools-clean-targets)
-
 # Clear a bunch of variables before executing the submake
 ifeq ($(quiet),silent_)
 tools_silent=s
@@ -1533,7 +1527,7 @@ PHONY += $(mrproper-dirs) mrproper
 $(mrproper-dirs):
 	$(Q)$(MAKE) $(clean)=$(patsubst _mrproper_%,%,$@)
 
-mrproper: clean $(mrproper-dirs) tools_clean
+mrproper: clean $(mrproper-dirs)
 	$(call cmd,rmfiles)
 	@find . $(RCS_FIND_IGNORE) \
 		\( -name '*.rmeta' \) \
```

## Diff

```diff
---
Jon, this should fix it. I'll route this through sched_ext/for-6.11.

Thanks.

 Makefile |    8 +-------
 1 file changed, 1 insertion(+), 7 deletions(-)

--- a/Makefile
+++ b/Makefile
@@ -1355,12 +1355,6 @@ ifneq ($(wildcard $(resolve_btfids_O)),)
 	$(Q)$(MAKE) -sC $(srctree)/tools/bpf/resolve_btfids O=$(resolve_btfids_O) clean
 endif

-tools-clean-targets := sched_ext
-PHONY += $(tools-clean-targets)
-$(tools-clean-targets):
-	$(Q)$(MAKE) -sC tools $@_clean
-tools_clean: $(tools-clean-targets)
-
 # Clear a bunch of variables before executing the submake
 ifeq ($(quiet),silent_)
 tools_silent=s
@@ -1533,7 +1527,7 @@ PHONY += $(mrproper-dirs) mrproper
 $(mrproper-dirs):
 	$(Q)$(MAKE) $(clean)=$(patsubst _mrproper_%,%,$@)

-mrproper: clean $(mrproper-dirs) tools_clean
+mrproper: clean $(mrproper-dirs)
 	$(call cmd,rmfiles)
 	@find . $(RCS_FIND_IGNORE) \
 		\( -name '*.rmeta' \) \

```

## Implementation Analysis

### What This Patch Fixes

This is a targeted bug fix for the `mrproper` failure reported by Jon Hunter (NVIDIA) in patch-36.md. The fix is a deletion-only change to the top-level `Makefile`: it removes the `tools_clean` target and the `tools-clean-targets` variable that wired `sched_ext_clean` into `mrproper`.

### Code Analysis

The patch removes two sections from the top-level `Makefile`:

**Section 1 — The `tools_clean` mechanism:**
```makefile
-tools-clean-targets := sched_ext
-PHONY += $(tools-clean-targets)
-$(tools-clean-targets):
-	$(Q)$(MAKE) -sC tools $@_clean
-tools_clean: $(tools-clean-targets)
```

This mechanism defined a variable `tools-clean-targets` containing `sched_ext`, declared it as a PHONY target, and created a rule that would descend into `tools/` and invoke `sched_ext_clean`. The `tools_clean` target aggregated these.

**Section 2 — The `mrproper` dependency:**
```makefile
-mrproper: clean $(mrproper-dirs) tools_clean
+mrproper: clean $(mrproper-dirs)
```

This single line change removes `tools_clean` from `mrproper`'s prerequisite list. Without this, `mrproper` would invoke `tools_clean`, which invokes `sched_ext_clean`, which invokes the full `tools/sched_ext/Makefile`, which requires finding a vmlinux for VMLINUX_BTF — and fails if none exists.

### Why Deletion Is the Right Fix

The correct fix is not to make `sched_ext_clean` tolerate missing BTF (though that would also work) — it's to not call it from `mrproper` at all. The kernel's top-level `mrproper` target is a baseline operation that must work unconditionally. Tying it to tools that have runtime build requirements violates this guarantee.

Tejun's commit message makes an important observation: `mrproper` was singling out the `sched_ext` clean target when "no other clean targets under tools/ are triggered." This inconsistency was itself a red flag — the integration was incomplete and asymmetric compared to other tools.

The comment "The offending Makefile line is shared across BPF targets under tools/" signals that there is a broader issue to address later: other BPF-related tools under `tools/` may have similar Makefile patterns, and a proper integration with the kernel's clean targets will need to be designed more carefully.

### Routing and Urgency

The commit message shows Tejun routing this fix through `sched_ext/for-6.11`, the staging branch for the 6.11 release cycle. This is the correct channel for a fix to a patch that's already in linux-next — it goes through the sched_ext tree rather than waiting for the next merge window. The `Fixes:` tag pointing to the introducing commit (`2a52ca7c9896`) and the `Reported-by:` crediting Jon Hunter follow standard kernel fix conventions.

### What Maintainers Should Know

When a patch from your tree breaks linux-next (especially something as fundamental as `mrproper`), the expected response is:
1. Acknowledge the report quickly
2. Produce a minimal fix — do not refactor unrelated code
3. Route through the appropriate -next branch with a `Fixes:` tag and `Reported-by:` attribution
4. Confirm the fix with the reporter before or shortly after sending

This patch is a model example of that pattern. The fix is surgical (8 lines removed, 1 changed), correctly attributed, and addresses exactly the reported failure mode without scope creep.

When adding new `tools/` subdirectory targets to the top-level `mrproper`, verify that those targets are unconditionally safe: they must not require any external dependencies (no vmlinux, no running kernel, no installed headers).

