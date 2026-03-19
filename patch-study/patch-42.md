# Re: [PATCH 09/30] sched_ext: Implement BPF extensible scheduler class

**View on Lore**: [https://lore.kernel.org/all/20240807210431.GB80631@pauld.westford.csb](https://lore.kernel.org/all/20240807210431.GB80631@pauld.westford.csb)

## Commit Message

```text
Hi Tejun,

On Wed, Aug 07, 2024 at 09:26:28AM -1000 Tejun Heo wrote:
> Hello, Phil.
> 
> On Wed, Aug 07, 2024 at 03:11:08PM -0400, Phil Auld wrote:
> > On Tue, Jun 18, 2024 at 11:17:24AM -1000 Tejun Heo wrote:
> > > Implement a new scheduler class sched_ext (SCX), which allows scheduling
> > > policies to be implemented as BPF programs to achieve the following:
> > > 
> > 
> > I looks like this is slated for v6.12 now?  That would be good. My initial
> > experimentation with scx has been positive.
> 
> Yeap and great to hear.
> 
> > I just picked one email, not completely randomly.
> > 
> > > - Both enable and disable paths are a bit complicated. The enable path
> > >   switches all tasks without blocking to avoid issues which can arise from
> > >   partially switched states (e.g. the switching task itself being starved).
> > >   The disable path can't trust the BPF scheduler at all, so it also has to
> > >   guarantee forward progress without blocking. See scx_ops_enable() and
> > >   scx_ops_disable_workfn().
> > 
> > I think, from a supportability point of view, there needs to be a pr_info, at least,
> > in each of these places, enable and disable, with the name of the scx scheduler. It
> > looks like there is at least a pr_error for when one gets ejected due to misbehavior.
> > But there needs to be a record of when such is loaded and unloaded.
> 
> Sure, that's not difficult. Will do so soon.

Thanks! That would be helpful.  I was going to offer a patch but wanted to ask first
in case there was history.

But if you are willing to do it that's even better :) 


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

### High-Level Analysis
Hi Tejun,

### Detailed Walkthrough
1. Scope
   ```text
   Hi Tejun,
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
