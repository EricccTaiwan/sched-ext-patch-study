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

### What This Email Addresses

Jon Hunter (NVIDIA) reports that `make mrproper` is failing on linux-next builds that don't have a BTF-enabled kernel image available. The error message is:

```
Makefile:83: *** Cannot find a vmlinux for VMLINUX_BTF at any of
"../../vmlinux /sys/kernel/btf/vmlinux /boot/vmlinux-4.15.0-136-generic". Stop.
Makefile:192: recipe for target 'sched_ext_clean' failed
```

Jon bisected it to commit `2a52ca7c9896` ("sched_ext: Add scx_simple and scx_example_qmap example schedulers"), which added a `tools_clean` target to the top-level Makefile. Jon confirms that reverting that commit fixes the build.

### Why This Bug Exists

The sched_ext BPF example schedulers require BTF (BPF Type Format) information extracted from a running kernel's vmlinux image. When the examples were added to `tools/sched_ext/`, their Makefile included logic to find a vmlinux for VMLINUX_BTF — this is needed to build the BPF skeletons.

The bug is that this BTF-finding logic runs even during `sched_ext_clean`, which is invoked by `mrproper`. Clean targets should never have build requirements — they exist to delete artifacts, not build them. A `make mrproper` on a fresh checkout (or on a machine without any kernel installed) should always succeed.

The root cause is a Makefile design error: the `sched_ext_clean` target inherited the full `tools/sched_ext/Makefile` dependency resolution, including the VMLINUX_BTF search, even though clean targets don't need it.

### Why This Matters for sched_ext

This failure mode is particularly visible to people doing automated kernel builds and CI — exactly the audience that tests linux-next. NVIDIA's build farm hit it immediately. The failure is also confusing because `mrproper` is supposed to be the most reliable "start from scratch" target, and failing at that level suggests broken infrastructure.

More broadly, adding `tools/` subtree targets to the top-level `mrproper` without verifying that those targets are unconditionally safe is a category of Makefile mistake that can affect any developer whose machine doesn't meet the build environment assumptions.

### What the Community Decided

Tejun responded quickly with a fix (patch-37.md): drop the `tools_clean` target from the top-level Makefile entirely, removing `sched_ext` from `mrproper`'s dependency chain. Jon confirmed the fix works (patch-38.md).

### Design Insights Revealed

This bug reveals a tension in sched_ext's placement: the BPF scheduler tools live under `tools/sched_ext/` (user-space build), but the kernel build system (`Makefile`) tried to integrate them into the standard `mrproper` target. That integration was premature — the tools have their own build requirements (BTF-enabled kernel) that the kernel build system cannot guarantee are met.

The fix defers the question of how to properly integrate tools-side cleaning with the kernel's top-level Makefile. Tejun notes in the fix: "The offending Makefile line is shared across BPF targets under tools/. Let's revisit them later."

### What Maintainers Should Know

When adding `tools/` subdirectory targets to the top-level Linux Makefile (especially to `mrproper`), verify that those targets are unconditionally safe: they must not require any external dependencies (no vmlinux, no running kernel, no installed headers). Clean targets that fail on fresh checkouts are a CI-breaking change and will be reported quickly by build farm operators. If a `tools/` clean target has requirements, it should be in the tools' own Makefile, invocable explicitly, but not wired into the kernel's top-level clean targets.

