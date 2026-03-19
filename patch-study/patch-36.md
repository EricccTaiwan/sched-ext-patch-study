# Re: [PATCH 10/30] sched_ext: Add scx_simple and scx_example_qmap example schedulers

**View on Lore**: [https://lore.kernel.org/all/ac065f1f-8754-4626-95db-2c9fcf02567b@nvidia.com](https://lore.kernel.org/all/ac065f1f-8754-4626-95db-2c9fcf02567b@nvidia.com)

## Commit Message

```text
Hi Tejun,

On 18/06/2024 22:17, Tejun Heo wrote:
> Add two simple example BPF schedulers - simple and qmap.
> 
> * simple: In terms of scheduling, it behaves identical to not having any
>    operation implemented at all. The two operations it implements are only to
>    improve visibility and exit handling. On certain homogeneous
>    configurations, this actually can perform pretty well.
> 
> * qmap: A fixed five level priority scheduler to demonstrate queueing PIDs
>    on BPF maps for scheduling. While not very practical, this is useful as a
>    simple example and will be used to demonstrate different features.
> 
> v7: - Compat helpers stripped out in prepartion of upstreaming as the
>        upstreamed patchset will be the baselinfe. Utility macros that can be
>        used to implement compat features are kept.
> 
>      - Explicitly disable map autoattach on struct_ops to avoid trying to
>        attach twice while maintaining compatbility with older libbpf.
> 
> v6: - Common header files reorganized and cleaned up. Compat helpers are
>        added to demonstrate how schedulers can maintain backward
>        compatibility with older kernels while making use of newly added
>        features.
> 
>      - simple_select_cpu() added to keep track of the number of local
>        dispatches. This is needed because the default ops.select_cpu()
>        implementation is updated to dispatch directly and won't call
>        ops.enqueue().
> 
>      - Updated to reflect the sched_ext API changes. Switching all tasks is
>        the default behavior now and scx_qmap supports partial switching when
>        `-p` is specified.
> 
>      - tools/sched_ext/Kconfig dropped. This will be included in the doc
>        instead.
> 
> v5: - Improve Makefile. Build artifects are now collected into a separate
>        dir which change be changed. Install and help targets are added and
>        clean actually cleans everything.
> 
>      - MEMBER_VPTR() improved to improve access to structs. ARRAY_ELEM_PTR()
>        and RESIZEABLE_ARRAY() are added to support resizable arrays in .bss.
> 
>      - Add scx_common.h which provides common utilities to user code such as
>        SCX_BUG[_ON]() and RESIZE_ARRAY().
> 
>      - Use SCX_BUG[_ON]() to simplify error handling.
> 
> v4: - Dropped _example prefix from scheduler names.
> 
> v3: - Rename scx_example_dummy to scx_example_simple and restructure a bit
>        to ease later additions. Comment updates.
> 
>      - Added declarations for BPF inline iterators. In the future, hopefully,
>        these will be consolidated into a generic BPF header so that they
>        don't need to be replicated here.
> 
> v2: - Updated with the generic BPF cpumask helpers.
> 
> Signed-off-by: Tejun Heo <tj@kernel.org>
> Reviewed-by: David Vernet <dvernet@meta.com>
> Acked-by: Josh Don <joshdon@google.com>
> Acked-by: Hao Luo <haoluo@google.com>
> Acked-by: Barret Rhoden <brho@google.com>


Our farm builders are currently failing to build -next and I am seeing the following error ...

f76698bd9a8c (HEAD -> refs/heads/buildbrain-branch, refs/remotes/m/master) Add linux-next specific files for 20240621
build-linux.sh: kernel_build - make mrproper
Makefile:83: *** Cannot find a vmlinux for VMLINUX_BTF at any of "  ../../vmlinux /sys/kernel/btf/vmlinux /boot/vmlinux-4.15.0-136-generic".  Stop.
Makefile:192: recipe for target 'sched_ext_clean' failed
make[2]: *** [sched_ext_clean] Error 2
Makefile:1361: recipe for target 'sched_ext' failed
make[1]: *** [sched_ext] Error 2
Makefile:240: recipe for target '__sub-make' failed
make: *** [__sub-make] Error 2

Reverting this change fixes the build. Any thoughts on what is happening here?

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
Hi Tejun,

### Detailed Walkthrough
1. Scope
   ```text
   Hi Tejun,
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
