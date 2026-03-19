# Re: [PATCH 04/30] sched: Add sched_class->switching_to() and expose check_class_changing/changed()

**View on Lore**: [https://lore.kernel.org/all/20240621165327.GA51310@lorien.usersys.redhat.com](https://lore.kernel.org/all/20240621165327.GA51310@lorien.usersys.redhat.com)

## Commit Message

```text
On Tue, Jun 18, 2024 at 11:17:19AM -1000 Tejun Heo wrote:
> When a task switches to a new sched_class, the prev and new classes are
> notified through ->switched_from() and ->switched_to(), respectively, after
> the switching is done.
> 
> A new BPF extensible sched_class will have callbacks that allow the BPF
> scheduler to keep track of relevant task states (like priority and cpumask).
> Those callbacks aren't called while a task is on a different sched_class.
> When a task comes back, we wanna tell the BPF progs the up-to-date state

"wanna" ?   How about "want to"?

That makes me wanna stop reading right there... :)


> before the task gets enqueued, so we need a hook which is called before the
> switching is committed.
> 
> This patch adds ->switching_to() which is called during sched_class switch
> through check_class_changing() before the task is restored. Also, this patch
> exposes check_class_changing/changed() in kernel/sched/sched.h. They will be
> used by the new BPF extensible sched_class to implement implicit sched_class
> switching which is used e.g. when falling back to CFS when the BPF scheduler
> fails or unloads.
> 
> This is a prep patch and doesn't cause any behavior changes. The new
> operation and exposed functions aren't used yet.
> 
> v3: Refreshed on top of tip:sched/core.
> 
> v2: Improve patch description w/ details on planned use.
> 
> Signed-off-by: Tejun Heo <tj@kernel.org>
> Reviewed-by: David Vernet <dvernet@meta.com>
> Acked-by: Josh Don <joshdon@google.com>
> Acked-by: Hao Luo <haoluo@google.com>
> Acked-by: Barret Rhoden <brho@google.com>
> ---
>  kernel/sched/core.c     | 12 ++++++++++++
>  kernel/sched/sched.h    |  3 +++
>  kernel/sched/syscalls.c |  1 +
>  3 files changed, 16 insertions(+)
> 
> diff --git a/kernel/sched/core.c b/kernel/sched/core.c
> index 48f9d00d0666..b088fbeaf26d 100644
> --- a/kernel/sched/core.c
> +++ b/kernel/sched/core.c
> @@ -2035,6 +2035,17 @@ inline int task_curr(const struct task_struct *p)
>  	return cpu_curr(task_cpu(p)) == p;
>  }
>  
> +/*
> + * ->switching_to() is called with the pi_lock and rq_lock held and must not
> + * mess with locking.
> + */
> +void check_class_changing(struct rq *rq, struct task_struct *p,
> +			  const struct sched_class *prev_class)
> +{
> +	if (prev_class != p->sched_class && p->sched_class->switching_to)
> +		p->sched_class->switching_to(rq, p);
> +}

Does this really need wrapper? The compiler may help but it doesn't seem to
but you're doing a function call and passing in prev_class just to do a
simple check.  I guess it's not really a fast path. Just seemed like overkill.

I guess I did read past the commit message ...


Cheers,
Phil



> +
>  /*
>   * switched_from, switched_to and prio_changed must _NOT_ drop rq->lock,
>   * use the balance_callback list if you want balancing.
> @@ -7021,6 +7032,7 @@ void rt_mutex_setprio(struct task_struct *p, struct task_struct *pi_task)
>  	}
>  
>  	__setscheduler_prio(p, prio);
> +	check_class_changing(rq, p, prev_class);
>  
>  	if (queued)
>  		enqueue_task(rq, p, queue_flag);
> diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
> index a2399ccf259a..0ed4271cedf5 100644
> --- a/kernel/sched/sched.h
> +++ b/kernel/sched/sched.h
> @@ -2322,6 +2322,7 @@ struct sched_class {
>  	 * cannot assume the switched_from/switched_to pair is serialized by
>  	 * rq->lock. They are however serialized by p->pi_lock.
>  	 */
> +	void (*switching_to) (struct rq *this_rq, struct task_struct *task);
>  	void (*switched_from)(struct rq *this_rq, struct task_struct *task);
>  	void (*switched_to)  (struct rq *this_rq, struct task_struct *task);
>  	void (*reweight_task)(struct rq *this_rq, struct task_struct *task,
> @@ -3608,6 +3609,8 @@ extern void set_load_weight(struct task_struct *p, bool update_load);
>  extern void enqueue_task(struct rq *rq, struct task_struct *p, int flags);
>  extern void dequeue_task(struct rq *rq, struct task_struct *p, int flags);
>  
> +extern void check_class_changing(struct rq *rq, struct task_struct *p,
> +				 const struct sched_class *prev_class);
>  extern void check_class_changed(struct rq *rq, struct task_struct *p,
>  				const struct sched_class *prev_class,
>  				int oldprio);
> diff --git a/kernel/sched/syscalls.c b/kernel/sched/syscalls.c
> index ae1b42775ef9..cf189bc3dd18 100644
> --- a/kernel/sched/syscalls.c
> +++ b/kernel/sched/syscalls.c
> @@ -797,6 +797,7 @@ int __sched_setscheduler(struct task_struct *p,
>  		__setscheduler_prio(p, newprio);
>  	}
>  	__setscheduler_uclamp(p, attr);
> +	check_class_changing(rq, p, prev_class);
>  
>  	if (queued) {
>  		/*
> -- 
> 2.45.2
> 
> 

-- 
```

## Diff

```diff
No diff found.
```

## Implementation Analysis

### What This Email Addresses

This is Phil Auld's initial review of PATCH 04/30, which adds `sched_class->switching_to()` and exposes `check_class_changing/changed()`. Phil raises two separate issues in one email:

1. **A style nit in the commit message**: The word "wanna" in Tejun's commit message description. Phil flags it with some humor ("That makes me wanna stop reading right there...") but the underlying point is serious: kernel commit messages are permanent record and informal contractions are out of place.

2. **A technical question about the `check_class_changing()` wrapper**: Phil questions whether the wrapper function is necessary. The implementation is only four lines: check if the class changed, then call `switching_to` if it exists. Phil wonders if the compiler overhead of the function call and the `prev_class` parameter passing is justified for what amounts to a trivial guard.

### The Technical Question in Depth

The `check_class_changing()` function Phil questions:

```c
void check_class_changing(struct rq *rq, struct task_struct *p,
                           const struct sched_class *prev_class)
{
    if (prev_class != p->sched_class && p->sched_class->switching_to)
        p->sched_class->switching_to(rq, p);
}
```

Phil's concern: this function just wraps a pointer comparison and an optional function call. Why not inline it at both call sites (`rt_mutex_setprio` and `__sched_setscheduler`) rather than creating a dedicated wrapper?

This is a legitimate question about code organization vs. performance. The scheduler's hot paths are sensitive to unnecessary function calls. However, Phil himself hedges: "I guess it's not really a fast path."

### Why This Matters for sched_ext Design

The `switching_to()` callback is critical to sched_ext's correctness. When a task switches back to SCX from another class, the BPF scheduler needs to be told the task's current state (weight, cpumask, etc.) *before* the task gets enqueued. The existing `switched_to()` callback fires *after* the switch is committed — too late for BPF to set up per-task state that influences the first scheduling decision.

The wrapper exists to mirror the existing `check_class_changed()` pattern, keeping the class-switching notification code symmetric and readable.

### What the Community Decided

Tejun acknowledged the "wanna" typo and promised to fix it. On the wrapper question, Tejun's response (in patch-34.md) appeals to symmetry with `check_class_changed()` — a design consistency argument rather than a performance one.

### Design Insights Revealed

This thread illustrates two kinds of review feedback that maintainers will regularly receive:
- **Style feedback** (easy to fix, just do it)
- **"Is this necessary?" structural feedback** (requires justification, not just correction)

The symmetry argument Tejun uses is a common and valid justification in the kernel: keeping analogous operations structured identically reduces cognitive overhead when reading the code, even if each individual instance is slightly over-engineered.

### What Maintainers Should Know

When adding new lifecycle hooks to `sched_class`, follow the existing pattern for how those hooks are called. The kernel uses wrapper functions (`check_class_changing`, `check_class_changed`) rather than open-coding the "did the class change?" guard at every call site. This centralizes the logic and ensures future changes (e.g., adding tracing or a new condition) only need to happen in one place.

