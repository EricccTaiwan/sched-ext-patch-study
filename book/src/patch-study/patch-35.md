# Re: [PATCH 04/30] sched: Add sched_class->switching_to() and expose check_class_changing/changed()

**View on Lore**: [https://lore.kernel.org/all/20240621193223.GB51310@lorien.usersys.redhat.com](https://lore.kernel.org/all/20240621193223.GB51310@lorien.usersys.redhat.com)

## Commit Message

```text
On Fri, Jun 21, 2024 at 09:18:46AM -1000 Tejun Heo wrote:
> Hello, Phil.
> 
> On Fri, Jun 21, 2024 at 12:53:27PM -0400, Phil Auld wrote:
> > > A new BPF extensible sched_class will have callbacks that allow the BPF
> > > scheduler to keep track of relevant task states (like priority and cpumask).
> > > Those callbacks aren't called while a task is on a different sched_class.
> > > When a task comes back, we wanna tell the BPF progs the up-to-date state
> > 
> > "wanna" ?   How about "want to"?
> > 
> > That makes me wanna stop reading right there... :)
> 
> Sorry about that. Have been watching for it recently but this log was
> written a while ago, so...
>
> > > +/*
> > > + * ->switching_to() is called with the pi_lock and rq_lock held and must not
> > > + * mess with locking.
> > > + */
> > > +void check_class_changing(struct rq *rq, struct task_struct *p,
> > > +			  const struct sched_class *prev_class)
> > > +{
> > > +	if (prev_class != p->sched_class && p->sched_class->switching_to)
> > > +		p->sched_class->switching_to(rq, p);
> > > +}
> > 
> > Does this really need wrapper? The compiler may help but it doesn't seem to
> > but you're doing a function call and passing in prev_class just to do a
> > simple check.  I guess it's not really a fast path. Just seemed like overkill.
> 
> This doesn't really matter either way but wouldn't it look weird if it's not
> symmetric with check_class_changed()?

Fair enough.  It was just a thought.


Cheers,
Phil


> 
> Thanks.
> 
> -- 
> tejun
> 

-- 
```

## Diff

```diff
No diff found.
```

## Implementation Analysis

### What This Email Addresses

This is Phil Auld's closing reply in the three-message review thread about PATCH 04/30's `switching_to()` hook and the `check_class_changing()` wrapper. Phil accepts Tejun's symmetry argument with "Fair enough. It was just a thought."

This closes the technical discussion. The wrapper stays, the "wanna" gets fixed in the next revision, and the patch is effectively approved.

### Why This Closing Email Matters

In kernel development, a reviewer withdrawing an objection is a meaningful signal. Phil raised a legitimate question (is the wrapper necessary?) and Tejun gave a concrete reason (symmetry). Phil's acceptance means:

1. No `Requested-by` change is needed — the code stays as written
2. Phil's review can be credited as an approval rather than a blocking concern
3. The thread is cleanly resolved, which matters when the patch maintainer assembles the final series for submission

A thread that ends without explicit resolution can come back during merge window review, where a maintainer might see the unresolved discussion and ask questions again.

### The Full Thread in Context

Reading patches 33, 34, and 35 together shows the complete lifecycle of a minor review concern:

- **patch-33**: Phil raises the style nit and the structural question
- **patch-34**: Tejun acknowledges the typo and defends the structure with the symmetry argument
- **patch-35**: Phil accepts, thread closes cleanly

This is the normal, healthy pattern for kernel code review. Not every question requires a code change — sometimes the right outcome is the reviewer understanding the rationale and being satisfied with it.

### Design Insights Revealed

The `switching_to()` callback itself, which this entire thread is about, exists because sched_ext needs a "pre-switch" notification that no prior scheduler class ever needed. All existing classes know their tasks' state at all times. SCX's BPF scheduler doesn't — its callbacks aren't called while a task is on a different class. So when a task returns to SCX, the BPF program needs to be told the current state *before* the task is placed on a DSQ.

This is a fundamental consequence of sched_ext's architecture: the BPF scheduler is an observer of kernel state, not a first-class participant in it. Keeping it synchronized requires explicit notifications at lifecycle transitions.

### What Maintainers Should Know

When a reviewer raises a question and the author provides a rationale, the reviewer's explicit acknowledgment ("fair enough") is the expected closing for that thread. If a reviewer raises an issue and never follows up after the author responds, the concern is typically considered resolved by the community — but it's better practice to explicitly close it. As a maintainer, you can help by summarizing thread resolutions in your merge or tag messages.

