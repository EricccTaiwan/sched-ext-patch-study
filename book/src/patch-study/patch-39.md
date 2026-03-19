# Re: [PATCH 09/30] sched_ext: Implement BPF extensible scheduler class

**View on Lore**: [https://lore.kernel.org/all/Zn0joEebAdwjiTyT@gpd](https://lore.kernel.org/all/Zn0joEebAdwjiTyT@gpd)

## Commit Message

```text
On Tue, Jun 18, 2024 at 11:17:24AM -1000, Tejun Heo wrote:
...
> +	/**
> +	 * set_weight - Set task weight
> +	 * @p: task to set weight for
> +	 * @weight: new eight [1..10000]

Small nit: eight -> weight

> +	 *
> +	 * Update @p's weight to @weight.
> +	 */
> +	void (*set_weight)(struct task_struct *p, u32 weight);

-Andrea
```

## Diff

```diff
No diff found.
```

## Implementation Analysis

### What This Email Addresses

Andrea Righi spots a typo in the `sched_ext_ops` kernel-doc comment for the `set_weight` callback:

```c
/**
 * set_weight - Set task weight
 * @p: task to set weight for
 * @weight: new eight [1..10000]   ← "eight" should be "weight"
 *
 * Update @p's weight to @weight.
 */
void (*set_weight)(struct task_struct *p, u32 weight);
```

The word "eight" in the `@weight` parameter description should be "weight". This is a documentation typo that does not affect compilation or behavior.

### Why `set_weight` Matters for sched_ext

The `set_weight` callback was added in v3 of the patch series (noted in the commit message: "ops.set_weight() added to allow BPF schedulers to track weight changes without polling p->scx.weight"). Without this callback, a BPF scheduler that wants to implement weight-aware scheduling has to either poll `p->scx.weight` on every scheduling decision (expensive) or miss updates entirely.

The callback's weight range `[1..10000]` maps to the Linux scheduler's nice-value-derived weight range. Weight 1 is the minimum (nice +19 equivalent), weight 10000 is an approximation of the nice 0 base weight (1024 in the kernel's SCHED_NORMAL scheme), and higher values correspond to negative nice values. BPF schedulers that implement proportional-share or weighted fair queueing need this value.

### What the Community Decided

This is a trivial typo fix — it will be corrected in the next revision of the patch. No design changes are implied.

### Design Insights Revealed

The `set_weight` callback is an example of a pattern repeated throughout `sched_ext_ops`: rather than having BPF schedulers poll task fields directly, sched_ext provides callbacks that notify the BPF scheduler when something changes. This push model is important because:

1. BPF programs cannot safely dereference arbitrary task_struct fields without explicit whitelisting
2. Polling from `ops.dispatch()` or `ops.enqueue()` would add overhead on every scheduling event
3. State changes (weight, cpumask, priority) happen infrequently; push notifications are efficient

The full set of "state notification" callbacks in `sched_ext_ops` includes `set_weight`, `set_cpumask`, and `update_idle`. Understanding that these exist as a group — and why they exist — is essential for writing correct BPF schedulers.

### What Maintainers Should Know

Kernel-doc typos in `sched_ext_ops` callback descriptions are worth catching: those comments are the primary documentation BPF scheduler authors read when implementing a callback. Unlike internal kernel comments, these are part of the public BPF interface documentation and will appear in generated API docs. Reviewers like Andrea Righi who read the kernel-doc carefully are providing genuine value by catching these.

