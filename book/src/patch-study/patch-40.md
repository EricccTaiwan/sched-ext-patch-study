# Re: [PATCH 09/30] sched_ext: Implement BPF extensible scheduler class

**View on Lore**: [https://lore.kernel.org/all/20240807191004.GB47824@pauld.westford.csb](https://lore.kernel.org/all/20240807191004.GB47824@pauld.westford.csb)

## Commit Message

```text
Hi Tejun,

On Tue, Jun 18, 2024 at 11:17:24AM -1000 Tejun Heo wrote:
> Implement a new scheduler class sched_ext (SCX), which allows scheduling
> policies to be implemented as BPF programs to achieve the following:
> 

I looks like this is slated for v6.12 now?  That would be good. My initial
experimentation with scx has been positive.

I just picked one email, not completely randomly.

> - Both enable and disable paths are a bit complicated. The enable path
>   switches all tasks without blocking to avoid issues which can arise from
>   partially switched states (e.g. the switching task itself being starved).
>   The disable path can't trust the BPF scheduler at all, so it also has to
>   guarantee forward progress without blocking. See scx_ops_enable() and
>   scx_ops_disable_workfn().

I think, from a supportability point of view, there needs to be a pr_info, at least,
in each of these places, enable and disable, with the name of the scx scheduler. It
looks like there is at least a pr_error for when one gets ejected due to misbehavior.
But there needs to be a record of when such is loaded and unloaded.


Thoughts?


Cheers,
Phil
```

## Diff

```diff
No diff found.
```

## Implementation Analysis

### What This Email Addresses

Phil Auld reviews PATCH 09/30 — the core sched_ext implementation — with two observations:

1. **Timeline confirmation**: Phil notes the patch appears slated for v6.12 and mentions his initial experimentation with SCX has been positive. This is significant community feedback: a Red Hat engineer who has tested the scheduler in practice and finds it works is meaningful evidence of real-world readiness.

2. **Supportability concern**: Phil raises a substantive operational issue about the `scx_ops_enable()` and `scx_ops_disable_workfn()` paths. He notes that while there is error logging when a BPF scheduler is forcibly ejected due to misbehavior, there is no `pr_info` (informational log message) when a scheduler is successfully loaded or unloaded. His recommendation: at minimum, log the scheduler's name when it loads and when it unloads.

### Why This Matters Operationally

Phil's concern is about supportability in production environments. In a typical Linux production deployment:

- An operator might enable a BPF scheduler as part of a performance optimization
- If the system later experiences scheduling anomalies, the first question is "which BPF scheduler was loaded, and when?"
- Without load/unload logging, this information is lost unless the operator was watching `dmesg` at exactly the right moment

The sched_ext disable path already logs errors when a BPF scheduler misbehaves (`scx_ops_error()` generates a pr_err). But the normal load and unload paths were silent. This asymmetry means you can find out *why* a scheduler crashed, but not *when* it was running.

### The Broader "Observability" Principle

Phil's feedback touches on a general principle in systems software: subsystem lifecycle events should be logged at an appropriate level even when they succeed. For a subsystem as significant as the scheduler, pr_info at load/unload is the minimum bar. This allows:

- Post-incident analysis correlating scheduling changes with system behavior changes
- Audit trails for environments with compliance requirements
- Debugging of unexpected failovers from SCX back to CFS

### What the Community Decided

Tejun accepted the feedback immediately: "Sure, that's not difficult. Will do so soon." (patch-41.md). Phil offered to write the patch himself but deferred to Tejun once Tejun committed to doing it.

### Design Insights Revealed

The `scx_ops_enable()` function in the initial patch series focused on correctness — switching all tasks atomically, setting up data structures, enabling static branches. Operational observability (logging) was a lower priority during development. Phil's review catching this before merge is the right time: adding pr_info calls to lifecycle paths is a non-controversial change that's easy to get right at merge time rather than as a follow-up patch in 6.13.

### What Maintainers Should Know

When reviewing new subsystems, check that lifecycle transitions (init, load, unload, error) are all observable through the kernel log at appropriate severity levels:
- `pr_info`: normal load/unload — "sched_ext: BPF scheduler 'scx_simple' enabled"
- `pr_warn`: unusual but non-fatal conditions
- `pr_err`: forced disable due to error

The sched_ext framework is unique in that it can be loaded and unloaded at runtime, which makes this particularly important — the scheduler is not a static kernel configuration choice.

