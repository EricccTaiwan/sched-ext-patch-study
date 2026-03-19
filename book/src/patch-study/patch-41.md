# Re: [PATCH 09/30] sched_ext: Implement BPF extensible scheduler class

**View on Lore**: [https://lore.kernel.org/all/ZrPKZMvrl6kGFzo-@slm.duckdns.org](https://lore.kernel.org/all/ZrPKZMvrl6kGFzo-@slm.duckdns.org)

## Commit Message

```text
Hello, Phil.

On Wed, Aug 07, 2024 at 03:11:08PM -0400, Phil Auld wrote:
> On Tue, Jun 18, 2024 at 11:17:24AM -1000 Tejun Heo wrote:
> > Implement a new scheduler class sched_ext (SCX), which allows scheduling
> > policies to be implemented as BPF programs to achieve the following:
> > 
> 
> I looks like this is slated for v6.12 now?  That would be good. My initial
> experimentation with scx has been positive.

Yeap and great to hear.

> I just picked one email, not completely randomly.
> 
> > - Both enable and disable paths are a bit complicated. The enable path
> >   switches all tasks without blocking to avoid issues which can arise from
> >   partially switched states (e.g. the switching task itself being starved).
> >   The disable path can't trust the BPF scheduler at all, so it also has to
> >   guarantee forward progress without blocking. See scx_ops_enable() and
> >   scx_ops_disable_workfn().
> 
> I think, from a supportability point of view, there needs to be a pr_info, at least,
> in each of these places, enable and disable, with the name of the scx scheduler. It
> looks like there is at least a pr_error for when one gets ejected due to misbehavior.
> But there needs to be a record of when such is loaded and unloaded.

Sure, that's not difficult. Will do so soon.

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

This is Tejun's reply to Phil Auld's review of PATCH 09/30 (patch-40.md). Tejun responds to both points Phil raised:

1. **v6.12 timeline**: Tejun confirms ("Yeap") and acknowledges Phil's positive experimentation.

2. **pr_info for load/unload**: Tejun accepts the feedback without qualification — "Sure, that's not difficult. Will do so soon." This means the pr_info additions will be included in the revision submitted for 6.12, not deferred.

### Significance of Immediate Acceptance

The speed and completeness of Tejun's acceptance matters. He doesn't argue for deferring this to a follow-up patch, doesn't ask for clarification, and doesn't propose a narrower version of the change. He simply agrees to do it. This is the appropriate response when a reviewer identifies a missing operational feature that:

- Is clearly correct (logging lifecycle events is unambiguously right)
- Has no design controversy (nobody argues against knowing when things load/unload)
- Is low-risk to implement (pr_info calls don't affect scheduling behavior)

For a patch series that has been through 7 iterations and is at the finish line for 6.12 merging, committing to this change rather than merging without it is a sign of good maintainer judgment — better to get it right now than ship without it.

### The Timeline Context

This email is dated August 7, 2024 — nearly two months after the patch series was originally posted (June 18, 2024). The 6.12 merge window is approaching, and Phil is reviewing the patch series relatively late. Tejun's "will do so soon" reflects awareness that there's limited time but the change is simple enough to fit in.

### What the Community Decided

Tejun committed to adding the pr_info calls. Phil explicitly offered to write the patch himself but was happy to let Tejun handle it (patch-42.md). The change was to be made before the 6.12 merge.

### Design Insights Revealed

The exchange highlights a principle about when to include observability in a patch series versus adding it as follow-up work:

- **During development**: Focus on correctness, correctness, correctness. Logging can wait.
- **Before merge**: Add the minimum observability needed for production use. Load/unload logging for a runtime-loadable subsystem meets this bar.
- **After merge**: Add richer observability, tracing, and debugging hooks as the community identifies specific needs.

The pr_info additions Tejun committed to fit squarely in the "before merge" category — they are necessary for the feature to be usable in production without surprise.

### What Maintainers Should Know

When you commit to a review feedback item with "will do so soon," follow through before the merge window closes. Reviewers who see their feedback addressed build trust in the maintainer process; reviewers who see accepted feedback silently dropped lose confidence. In this case, adding the pr_info calls is also a factual promise (not just a policy commitment), and the kernel community will remember if a maintainer's "will do so soon" doesn't appear in the final commit.

