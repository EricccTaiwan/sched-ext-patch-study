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

### High-Level Analysis
On 25/06/2024 02:58, Tejun Heo wrote:

### Detailed Walkthrough
1. Scope
   ```text
   On 25/06/2024 02:58, Tejun Heo wrote:
   ```
2. Code visibility
   ```text
   This markdown entry does not contain a parseable inline diff block.
   ```
3. How to interpret
   ```text
   Treat this entry as narrative/review context and rely on neighboring patch files
   for concrete line-level implementation deltas.
   ```

### sched_ext Context
Follow-up review threads are useful for understanding why specific sched_ext design choices were accepted, revised, or deferred.
