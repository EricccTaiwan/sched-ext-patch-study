# Re: [PATCH 04/30] sched: Add sched_class->switching_to() and expose check_class_changing/changed()

**View on Lore**: [https://lore.kernel.org/all/ZnXSFrn6wNqk21GS@slm.duckdns.org](https://lore.kernel.org/all/ZnXSFrn6wNqk21GS@slm.duckdns.org)

## Commit Message

```text
Hello, Phil.

On Fri, Jun 21, 2024 at 12:53:27PM -0400, Phil Auld wrote:
> > A new BPF extensible sched_class will have callbacks that allow the BPF
> > scheduler to keep track of relevant task states (like priority and cpumask).
> > Those callbacks aren't called while a task is on a different sched_class.
> > When a task comes back, we wanna tell the BPF progs the up-to-date state
> 
> "wanna" ?   How about "want to"?
> 
> That makes me wanna stop reading right there... :)

Sorry about that. Have been watching for it recently but this log was
written a while ago, so...

> > +/*
> > + * ->switching_to() is called with the pi_lock and rq_lock held and must not
> > + * mess with locking.
> > + */
> > +void check_class_changing(struct rq *rq, struct task_struct *p,
> > +			  const struct sched_class *prev_class)
> > +{
> > +	if (prev_class != p->sched_class && p->sched_class->switching_to)
> > +		p->sched_class->switching_to(rq, p);
> > +}
> 
> Does this really need wrapper? The compiler may help but it doesn't seem to
> but you're doing a function call and passing in prev_class just to do a
> simple check.  I guess it's not really a fast path. Just seemed like overkill.

This doesn't really matter either way but wouldn't it look weird if it's not
symmetric with check_class_changed()?

Thanks.

-- 
tejun
```

## Diff

```diff
No diff found.
```

## Implementation Analysis

### What This Email Addresses

This is Tejun's reply to Phil Auld's review of PATCH 04/30. Tejun responds to both points Phil raised:

1. **On "wanna"**: Tejun simply apologizes and acknowledges the fix is needed. The commit message was written earlier and wasn't caught before sending. This is common in long-running patch series where the commit messages are drafted well before the final submission.

2. **On the `check_class_changing()` wrapper**: Tejun's justification is symmetry with `check_class_changed()`. The question "wouldn't it look weird if it's not symmetric?" is rhetorical — the answer is yes. In kernel code, consistency between analogous mechanisms is a strong convention.

### The Symmetry Argument Explained

The existing code has:

```c
void check_class_changed(struct rq *rq, struct task_struct *p,
                          const struct sched_class *prev_class, int oldprio)
```

This fires *after* the class switch completes and calls `switched_from()` on the old class and `switched_to()` on the new class. It has been in the kernel for years.

The new `check_class_changing()` mirrors it structurally:
- Same call convention (rq, task, prev_class)
- Same placement at class-change call sites
- Only difference: fires *before* the switch commits and calls `switching_to()` on the new class

Tejun's point is that a reader familiar with `check_class_changed()` will immediately understand `check_class_changing()` without needing to think about it. Asymmetry — e.g., open-coding one but wrapping the other — would require the reader to ask "why is this different?" without a good answer.

### What the Community Decided

Phil accepted the symmetry argument in his follow-up (patch-35.md): "Fair enough. It was just a thought." The wrapper stays. The "wanna" typo gets fixed in the next revision.

### Design Insights Revealed

This exchange shows how Tejun approaches design review: he doesn't dismiss the question but provides the actual reason for the choice. The reason here is not performance or correctness but readability and consistency — both of which are first-class concerns in scheduler code that will be read and maintained for years.

### What Maintainers Should Know

When reviewing sched_ext patches that add new `sched_class` callbacks, look for whether the invocation pattern is consistent with existing callbacks. New hooks that are called differently from established patterns (e.g., some wrapped, some inlined) introduce cognitive overhead and invite "why?" questions that slow down review. Consistent patterns reduce review friction.

