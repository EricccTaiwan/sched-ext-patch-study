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

### High-Level Analysis
Hello, Phil.

### Detailed Walkthrough
1. Scope
   ```text
   Hello, Phil.
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
