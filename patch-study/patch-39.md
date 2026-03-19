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

### High-Level Analysis
On Tue, Jun 18, 2024 at 11:17:24AM -1000, Tejun Heo wrote:

### Detailed Walkthrough
1. Scope
   ```text
   On Tue, Jun 18, 2024 at 11:17:24AM -1000, Tejun Heo wrote:
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
