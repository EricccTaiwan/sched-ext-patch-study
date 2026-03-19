# Re: [PATCH 29/30] sched_ext: Documentation: scheduler: Document extensible scheduler class

**View on Lore**: [https://lore.kernel.org/all/ZnLLAWbryU0-aqX1@archie.me](https://lore.kernel.org/all/ZnLLAWbryU0-aqX1@archie.me)

## Commit Message

```text
On Tue, Jun 18, 2024 at 11:17:44AM -1000, Tejun Heo wrote:
> Add Documentation/scheduler/sched-ext.rst which gives a high-level overview
> and pointers to the examples.
> 

LGTM, thanks!

Reviewed-by: Bagas Sanjaya <bagasdotme@gmail.com>

-- 
An old man doll... just what I always wanted! - Clara
```

## Diff

```diff
-----BEGIN PGP SIGNATURE-----

iHUEABYKAB0WIQSSYQ6Cy7oyFNCHrUH2uYlJVVFOowUCZnLK/AAKCRD2uYlJVVFO
o/m3AQDvlkShSHUwxaqKX5DV/HcD2PbL5R+9f+zPNpLRV5IVSwEAqHcCISspS8dU
UWAGJ9pJNmfVZ9sLaGeXH4uN2TvS0wU=
=ciJC
-----END PGP SIGNATURE-----

--QTBRT25tDLXH91dy--

```

## Implementation Analysis

### What This Email Addresses

This is a review acknowledgment from Bagas Sanjaya for PATCH 29/30, which adds `Documentation/scheduler/sched-ext.rst` — the official in-kernel documentation for the sched_ext framework.

The email is minimal: Bagas confirms the documentation patch looks good ("LGTM") and provides a `Reviewed-by` tag. The PGP signature at the bottom is standard practice for kernel contributors asserting the review's authenticity.

### Why Documentation Matters for a New Scheduler Class

Adding a new scheduler class to the Linux kernel is a significant ABI and API commitment. Kernel documentation in `Documentation/scheduler/` sets expectations for downstream users, distro packagers, and future contributors about:

- What sched_ext is and why it exists
- How to write a BPF scheduler
- Where to find the example schedulers
- The lifecycle of a BPF scheduler (load, run, unload, error handling)

A `Reviewed-by` from a documentation maintainer (Bagas Sanjaya maintains Linux kernel documentation) carries specific weight: it signals that the documentation is technically clear, well-formatted, and follows kernel documentation conventions (reStructuredText, appropriate cross-references, etc.).

### What the Community Decided

The documentation patch was accepted as-is. No changes were requested. This is the expected outcome for documentation that accompanied a working implementation with multiple prior review rounds — by v7 of the patch series, the design was stable and the docs reflected it accurately.

### Design Insights Revealed

The existence of this dedicated documentation patch — rather than inline comments alone — reflects the sched_ext team's philosophy that BPF schedulers are meant to be written by people who are not kernel scheduler experts. The documentation provides the high-level mental model needed to write a scheduler without needing to read the kernel source directly.

### What Maintainers Should Know

A `Reviewed-by` on a documentation patch from a doc maintainer is part of the normal merge checklist for new subsystems. When reviewing future sched_ext patches that add new ops or change BPF interfaces, check whether `Documentation/scheduler/sched-ext.rst` has been updated accordingly. Interface changes without documentation updates are a common review failure mode.

