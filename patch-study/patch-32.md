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

### High-Level Analysis
On Tue, Jun 18, 2024 at 11:17:44AM -1000, Tejun Heo wrote:

### Detailed Walkthrough

### sched_ext Context
This patch directly expands sched_ext integration points and makes the scheduler core more extensible for BPF-defined policies.

