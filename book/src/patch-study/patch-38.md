# Re: [PATCH sched_ext/for-6.11] sched_ext: Drop tools_clean target from the top-level Makefile

**View on Lore**: [https://lore.kernel.org/all/ef376c13-2ca8-4f25-9cbd-fdca37351190@nvidia.com](https://lore.kernel.org/all/ef376c13-2ca8-4f25-9cbd-fdca37351190@nvidia.com)

## Commit Message

```text
On 25/06/2024 02:58, Tejun Heo wrote:
> 2a52ca7c9896 ("sched_ext: Add scx_simple and scx_example_qmap example
> schedulers") added the tools_clean target which is triggered by mrproper.
> The tools_clean target triggers the sched_ext_clean target in tools/. This
> unfortunately makes mrproper fail when no BTF enabled kernel image is found:
> 
>    Makefile:83: *** Cannot find a vmlinux for VMLINUX_BTF at any of "  ../../vmlinux /sys/kernel/btf/vmlinux/boot/vmlinux-4.15.0-136-generic".  Stop.
>    Makefile:192: recipe for target 'sched_ext_clean' failed
>    make[2]: *** [sched_ext_clean] Error 2
>    Makefile:1361: recipe for target 'sched_ext' failed
>    make[1]: *** [sched_ext] Error 2
>    Makefile:240: recipe for target '__sub-make' failed
>    make: *** [__sub-make] Error 2
> 
> Clean targets shouldn't fail like this but also it's really odd for mrproper
> to single out and trigger the sched_ext_clean target when no other clean
> targets under tools/ are triggered.
> 
> Fix builds by dropping the tools_clean target from the top-level Makefile.
> The offending Makefile line is shared across BPF targets under tools/. Let's
> revisit them later.
> 
> Signed-off-by: Tejun Heo <tj@kernel.org>
> Reported-by: Jon Hunter <jonathanh@nvidia.com>
> Link: http://lkml.kernel.org/r/ac065f1f-8754-4626-95db-2c9fcf02567b@nvidia.com
> Fixes: 2a52ca7c9896 ("sched_ext: Add scx_simple and scx_example_qmap example schedulers")
> Cc: David Vernet <void@manifault.com>
> ---
> Jon, this should fix it. I'll route this through sched_ext/for-6.11.
> 
> Thanks.
> 
>   Makefile |    8 +-------
>   1 file changed, 1 insertion(+), 7 deletions(-)
> 
> --- a/Makefile
> +++ b/Makefile
> @@ -1355,12 +1355,6 @@ ifneq ($(wildcard $(resolve_btfids_O)),)
>   	$(Q)$(MAKE) -sC $(srctree)/tools/bpf/resolve_btfids O=$(resolve_btfids_O) clean
>   endif
>   
> -tools-clean-targets := sched_ext
> -PHONY += $(tools-clean-targets)
> -$(tools-clean-targets):
> -	$(Q)$(MAKE) -sC tools $@_clean
> -tools_clean: $(tools-clean-targets)
> -
>   # Clear a bunch of variables before executing the submake
>   ifeq ($(quiet),silent_)
>   tools_silent=s
> @@ -1533,7 +1527,7 @@ PHONY += $(mrproper-dirs) mrproper
>   $(mrproper-dirs):
>   	$(Q)$(MAKE) $(clean)=$(patsubst _mrproper_%,%,$@)
>   
> -mrproper: clean $(mrproper-dirs) tools_clean
> +mrproper: clean $(mrproper-dirs)
>   	$(call cmd,rmfiles)
>   	@find . $(RCS_FIND_IGNORE) \
>   		\( -name '*.rmeta' \) \

Fix it for me!

Tested-by: Jon Hunter <jonathanh@nvidia.com>

Thanks!
Jon

-- 
nvpublic
```

## Diff

```diff
No diff found.
```

## Implementation Analysis

### What This Email Addresses

Jon Hunter (NVIDIA) confirms that Tejun's fix (patch-37.md) resolves the `mrproper` build failure he reported in patch-36.md. The reply is short: "Fix it for me!" followed by a `Tested-by:` tag.

The "Fix it for me!" line is friendly acknowledgment that the fix does exactly what was needed. The `Tested-by:` tag is the formal record.

### The `Tested-by` Tag

A `Tested-by:` tag in a kernel patch has specific meaning: the credited person actually ran the code (or in this case, verified the build) and confirms it behaves correctly. It is distinct from `Reviewed-by` (code reviewed, logic sound) and `Acked-by` (I agree with this approach). For a build fix, `Tested-by` is the most directly meaningful tag: it says "I hit the failure, I applied the fix, the failure is gone."

This is particularly valuable here because Jon's build environment — NVIDIA's farm builders running linux-next on Ubuntu 4.15.0 kernels — was the one that exposed the bug. His confirmation that the fix works in that specific environment closes the loop.

### The Full Bug-Fix Cycle in Context

Reading patches 36, 37, and 38 together shows the complete lifecycle of a build regression fix in the kernel:

- **patch-36**: Jon reports the `mrproper` failure with a precise error message and bisection result (reverts the introducing commit)
- **patch-37**: Tejun produces a minimal fix, routes it through the sched_ext branch, addresses Jon directly
- **patch-38**: Jon confirms the fix works, provides `Tested-by`

The turnaround is fast (reported Jun 21, fix sent Jun 25), which is important for a bug that breaks linux-next for any developer without a BTF-enabled kernel on their machine.

### Design Insights Revealed

This thread demonstrates the value of linux-next as an integration testing surface. The bug was introduced in the main patch series and might not have been caught until after the 6.11 merge window if not for automated build farms like NVIDIA's testing linux-next continuously. For subsystems like sched_ext that integrate with the build system (tools Makefiles, top-level mrproper), having external testers with diverse build environments catches assumptions that the primary developers don't notice because their machines always have the right setup.

### What Maintainers Should Know

When you receive a `Tested-by:` on a fix from the person who reported the original bug, include both the `Reported-by:` and `Tested-by:` tags in the final committed patch. The commit history then shows the complete picture: who found the bug, who fixed it, and who verified the fix. Tejun's fix already includes `Reported-by: Jon Hunter` — the `Tested-by` from this email would be added when the commit is finalized.

