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

### What This Email Addresses

This is Phil Auld's closing reply in the PATCH 09/30 review thread about load/unload logging. Phil thanks Tejun for accepting the feedback, mentions he was ready to offer a patch himself if needed, and closes the thread with "if you are willing to do it that's even better :)".

This closes the three-message thread on PATCH 09/30 (patches 40, 41, 42). The feedback is accepted, the change is committed to, and no further action is needed from Phil.

### The Full Thread in Context

Reading patches 40, 41, and 42 together shows a complete review cycle for a substantive (but non-controversial) feedback item:

- **patch-40**: Phil reviews PATCH 09/30, raises the supportability concern about missing pr_info at load/unload
- **patch-41**: Tejun accepts, commits to adding it
- **patch-42**: Phil acknowledges, closes the thread

The offer to write the patch himself ("I was going to offer a patch but wanted to ask first in case there was history") shows good kernel community etiquette: before sending unsolicited patches to a subsystem, it's polite to ask whether the maintainer has reasons for the current behavior. There might be history — maybe the logging was intentionally omitted, or maybe a larger observability redesign was planned. In this case, there was no such history, and Tejun simply hadn't gotten around to it.

### Why Phil's Offer Matters

Phil's offer to write the patch, even though Tejun ultimately declined it, is meaningful for two reasons:

1. **It accelerates the work**: If Tejun had been slow to follow up, Phil had the option to send a patch directly and Tejun could review and apply it. This is the standard "if you're busy I can help" offer in open source communities.

2. **It demonstrates engagement**: Phil isn't just pointing out a problem and moving on — he's willing to invest time in fixing it. This kind of engaged review is more valuable to maintainers than pure criticism.

### Design Insights Revealed

The PATCH 09/30 review thread (patches 40-42) is notable for what it *doesn't* discuss: the core design of sched_ext itself. By the time of this review, the fundamental architecture — DSQs, sched_ext_ops, the enable/disable paths, the task ownership model — was settled and apparently sound enough that reviewers were looking at operational concerns (logging) rather than architectural ones. This is a sign that the patch series had matured significantly across its 7 revisions.

The fact that Phil's initial experimentation with SCX was "positive" is also meaningful signal: it suggests the implementation is not only theoretically correct but practically usable, which is a high bar for a new scheduler class.

### What Maintainers Should Know

Threads that end with the reporter offering to help are among the healthiest in open source kernel development — they signal that the community is engaged and wants the feature to succeed. As a maintainer, when someone offers to write a patch for missing functionality they identified, it's good practice to either accept the offer (with guidance on style and approach) or commit to a timeline for doing it yourself. Leaving such offers hanging without a response discourages future contributions.

