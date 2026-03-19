# Community Follow-Up (Patches 32–42)

## Overview

The story of sched_ext does not end with the submission of the v7 patchset. After a patchset
of this scale is sent to LKML (Linux Kernel Mailing List), it enters a period of community
review and post-merge stabilization. Patches 32–42 capture this post-submission phase: the
review threads, the bugs discovered by the community, the fixes applied, and the discussion
threads that shaped the final merged form of specific patches.

For a kernel maintainer, understanding this phase is as important as understanding the
implementation itself. The post-submission review is where the kernel community's collected
knowledge is applied to a new feature, and the issues raised reveal both the quality of the
original implementation and the standards the community holds for scheduler code. The bug
reports (particularly the NVIDIA-reported Makefile issue) demonstrate the kinds of integration
problems that only surface when a large, diverse user base exercises the code.

This group divides into three subgroups:
- **Patches 32–35**: Community review of specific patches (documentation and `switching_to()`).
- **Patches 36–38**: NVIDIA-reported Makefile bug and its fix.
- **Patches 39–42**: Community review of the core implementation (patch 09/30).

## Why This Phase Matters

Most study of kernel patches focuses on the diff — the code that was added or changed. But
the review discussion attached to each patch often contains more information than the diff
itself:

- **Why alternatives were rejected.** The reviewer asks "why not X?" and the author explains
  the tradeoff. This reasoning is not in the code.
- **Edge cases the original author missed.** A reviewer points out a scenario the author
  didn't consider, leading to a fix or a documentation clarification.
- **Implicit assumptions made explicit.** The community's questions reveal that something the
  author considered obvious needs to be stated explicitly in comments or documentation.
- **Integration bugs.** A third party (like NVIDIA) discovers a bug in a tooling file that
  the scheduler developers didn't test because they use different build workflows.

For a maintainer of sched_ext, the community follow-up phase provides the historical context
needed to understand why the code is the way it is, and why certain changes that might appear
to be improvements are actually inadvisable.

## Key Concepts

### PATCHES 32–33 — Documentation Review

The review of `Documentation/scheduler/sched-ext.rst` (patch 29) generated several comment
threads. Common categories of documentation review feedback in the kernel community:

**Precision of callback timing descriptions.** Reviewers asked for clarification on exactly
when callbacks like `ops.runnable()` vs `ops.enqueue()` are called, and whether the
distinction matters for BPF programs that only implement one but not the other. The resulting
discussion led to tightened language in the documentation about the ordering guarantees.

**Error message accuracy.** Some error condition descriptions were ambiguous — for example,
"dispatch to invalid DSQ" could mean the DSQ ID doesn't exist, or the DSQ was destroyed, or
the BPF program doesn't have permission. Reviewers pushed for precise enumeration of each
error condition and the specific exit reason string each produces.

**Example code correctness.** The example code snippets in the documentation were reviewed
for correctness against the actual API. Small discrepancies (wrong argument order, missing
flags) were caught and corrected. This is particularly important because documentation code
examples are often copied verbatim by users, amplifying any errors.

**Coverage of race conditions.** Reviewers asked whether the documentation adequately covered
the race conditions that BPF scheduler authors must handle — particularly around task migration
and the in_op_task serialization. The review led to a section explicitly documenting these
races and how `in_op_task` protects against them.

For a maintainer, documentation review comments are a direct window into what the community
finds confusing or underspecified. Recurring questions about the same topic signal that the
documentation needs restructuring, not just additional words.

### PATCH 34 — Review of switching_to()

The `switching_to()` callback (patch 04) received particular scrutiny during post-submission
review because it is a change to the core scheduler infrastructure that affects all scheduler
classes, not just sched_ext. The concerns raised:

**Ordering guarantees under concurrent migration.** The review asked: what happens if a task
is being migrated to a new CPU at the same time as `switching_to()` is called? The original
implementation held the runqueue lock during `switching_to()`, which prevents the migration
from completing until `switching_to()` returns. Reviewers verified this was intentional and
that the lock ordering was correct.

**Performance impact on non-SCX paths.** `switching_to()` is called for all class transitions,
not just transitions into the ext class. Reviewers checked whether the new hook added any
overhead on the CFS-to-RT or RT-to-CFS paths (common class transitions that happen on every
`sched_setscheduler()` call on an RT system). The implementation correctly no-ops these cases
with a single branch that checks whether the new class is `ext_sched_class`.

**Interaction with `check_class_changing()`.** Several reviewers noted that the new
`switching_to()` callback, combined with the existing `check_class_changing()` and
`check_class_changed()` callbacks, created three separate notifications for a single class
transition. The discussion resulted in added comments clarifying the distinct purpose of each:
`check_class_changing()` is called with the old class for validation, `switching_to()` is
called on the new class for initialization, and `check_class_changed()` is called after the
transition completes for post-transition actions.

### PATCH 35 — Further switching_to() Discussion

The switching_to() discussion continued across multiple LKML threads. A significant thread
examined the semantic distinction between `switching_to()` and `switched_to()`:

- `switching_to(p)`: Called on the *new* class, with the task still in the *old* class. The
  new class initializes but cannot yet schedule the task.
- `switched_to(p)`: Called on the *new* class, with the task already in the new class and
  potentially enqueued. The new class can now schedule the task.

The subtlety that reviewers focused on: there is a window between `switching_to()` and
`switched_to()` where the task is in transition. If another CPU tries to migrate the task
during this window, it must wait for the transition to complete. The review verified that the
runqueue lock covers this window correctly and that no scheduler-class-specific code accesses
the task's class state without holding the lock.

This discussion is a good example of the kernel community's attention to concurrent correctness:
even when the code appears correct, reviewers ask for explicit verification of every concurrent
access path.

### PATCHES 36–38 — NVIDIA Makefile Bug

These three patches document a bug reported by NVIDIA engineers: `make mrproper` (the kernel's
"clean everything" target) was incorrectly deleting files that should not have been cleaned,
affecting the build workflow for systems with NVIDIA drivers installed alongside a sched_ext
kernel.

**The bug**: The sched_ext BPF skeleton headers (generated from BPF object files in
`tools/sched_ext/`) were placed in a path that `make mrproper` treated as generated output and
deleted. However, some of these files were also referenced by the NVIDIA module build system
(which generates its own headers in a separate build step that runs after the kernel build).
When `mrproper` deleted the sched_ext headers, the subsequent NVIDIA module build failed with
confusing errors about missing headers.

**Why this matters for a maintainer**: Build system bugs are particularly insidious because
they are environment-dependent — they only appear when specific third-party toolchains or build
workflows are used. The NVIDIA report revealed that `make mrproper` had inconsistent semantics:
it was supposed to clean only kernel-generated files, but some sched_ext files straddled the
boundary between "generated" and "source".

**The fix (patches 37–38)**: The fix reclassified the affected sched_ext files as source files
(not generated output) and updated the `.gitignore` and `Makefile` `clean`/`mrproper` rules
accordingly. Patch 38 also adds a regression test: a CI check that verifies `make mrproper`
does not delete files that `git status` reports as untracked (source files that should not be
generated).

**Lessons for maintainers**: When adding tooling files (scripts, skeleton generators, BPF
objects) alongside a kernel feature, the distinction between "source file" and "generated file"
must be explicit in the Makefile. Files that are committed to the repository are source files.
Files that are generated during the build are generated files. Mixing them in the same directory
without explicit rules about which is which creates the class of bug NVIDIA encountered.

Additionally, the fact that a third-party (NVIDIA), not a kernel developer, discovered this bug
demonstrates that out-of-tree module builds exercise kernel build infrastructure in ways that
in-tree testing does not. Features that ship with kernel tooling (like sched_ext's BPF examples)
must be validated against the full range of build configurations, including external module builds.

### PATCHES 39–42 — Core Implementation Review

The review of the core implementation (patch 09, the ~4000-line main sched_ext patch) generated
the most extensive discussion threads. Key themes:

**DSQ lock ordering.** The core implementation uses several locks: the runqueue lock, per-DSQ
locks, and the `scx_tasks_lock` that protects the global task list. Reviewers spent significant
effort verifying the lock ordering is consistent (no cycles, correct nesting). Patch 39 captures
the review thread that identified a potential lock ordering issue in the DSQ destruction path,
where `scx_bpf_destroy_dsq()` was acquiring locks in a different order than `scx_ops_disable()`
when both ran concurrently.

**The `scx_ops_bypass()` invariant.** The bypass mechanism (patch 26) was reviewed in the
context of the core implementation to verify it was invoked early enough. Reviewers constructed
scenarios where a task could receive a BPF callback during an ongoing `scx_ops_enable()` call
(before bypass mode was cleared), potentially calling BPF helpers on a partially initialized
scheduler state. Patch 40 captures the fix: ensuring bypass mode is cleared as the very last
step of `scx_ops_enable()`, after all data structures are fully initialized.

**Interaction with cgroups.** The `scx_cgroup_*` functions in the core implementation
manage the relationship between sched_ext tasks and cgroup hierarchy changes. Reviewers from
the cgroups maintainer community examined these functions for correct handling of the
cgroup `css_task_iter` locking rules. Patch 41 captures the resulting discussion and a fix
to ensure `scx_cgroup_can_attach()` releases the cgroup lock before calling into BPF code
(which may sleep).

**BPF verifier bypass paths.** A security-focused reviewer examined whether there were any
code paths that allowed BPF programs to bypass the verifier's safety checks — for example,
by calling `scx_bpf_*` helpers from a context the verifier had not authorized. The review
found that the `bpf_prog_type` check in the helper registration was correct and that all
`scx_bpf_*` helpers were only accessible from `BPF_PROG_TYPE_STRUCT_OPS` programs. Patch 42
captures this review and adds a comment in the code explaining why the prog_type restriction
is a security boundary, not just a validation convenience.

## The Post-Submission Process as a Learning Resource

For a maintainer, the community follow-up patches are valuable for reasons beyond the specific
bugs and discussions they contain:

**Pattern recognition for review.** The types of issues raised — lock ordering, bypass
invariants, cgroup locking, build system semantics — are the same issues that arise in any
large scheduler patch. Reading through these threads trains a reviewer to ask the right
questions about future patches.

**The cost of imprecision in documentation.** The documentation review (patches 32–33) shows
that ambiguous language in API documentation leads to user mistakes and follow-up questions.
The investment in precise documentation at merge time pays off in reduced support burden.

**Third-party integration as a test vector.** The NVIDIA build bug (patches 36–38) shows that
user-space tooling shipped with a kernel feature must be tested against third-party build
workflows, not just in-tree builds. Any kernel feature that ships tooling (BPF skeletons,
test programs, Python scripts) should have CI coverage for `mrproper`, `make clean`, and
out-of-tree module builds.

**Security review depth.** The BPF verifier bypass review (patch 42) shows that the kernel
community expects explicit documentation of security boundaries in code comments. "This check
is correct because we only allow X prog_type" is not obvious from the code; stating it as a
comment prevents future refactoring from accidentally removing the check while thinking it is
redundant.

## What to Focus On

**For a maintainer**, the critical lessons from this group:

1. **Every lock acquire has a story.** The lock ordering bug found in patches 39–40 demonstrates
   that even experienced kernel developers can introduce lock ordering issues in complex code.
   When reviewing sched_ext patches that touch the DSQ lock, runqueue lock, or `scx_tasks_lock`,
   draw the lock ordering graph explicitly and verify it is acyclic.

2. **Bypass mode is an invariant, not a hint.** The bypass mode bug (patch 40) — where BPF
   callbacks could be called before bypass mode was properly cleared — shows that the
   enable/disable sequencing of bypass mode is a hard invariant. When reviewing changes to
   `scx_ops_enable()` or `scx_ops_disable_workfn()`, verify that bypass mode transitions
   happen at the exact correct point in the sequence.

3. **Cgroup locking rules are strict.** The cgroup locking fix (patch 41) is a reminder that
   the cgroup subsystem has its own locking rules that are independent of the scheduler's
   locking rules. Any sched_ext code that calls into cgroup code must follow the cgroup
   locking documentation precisely. Calling BPF code (which may sleep via `bpf_spin_lock`) while
   holding a cgroup lock is one specific pattern to watch for.

4. **Makefile semantics for feature tooling.** The NVIDIA bug (patches 36–38) established the
   rule: files committed to the repository are source files and must not be deleted by
   `make mrproper`. When reviewing patches that add tooling files (BPF skeletons, test scripts,
   Python tools), verify that the Makefile correctly classifies them as source vs. generated
   and that `mrproper` behavior is tested.

5. **Security boundary documentation is mandatory.** The BPF verifier boundary review (patch 42)
   established that access control checks must be documented in comments explaining why they
   are security boundaries. When reviewing new `scx_bpf_*` helpers or new BPF prog_type
   allowlists, require explicit comments stating the security intent of each access control check.

6. **Review threads as institutional memory.** The discussions in patches 32–42 will never be
   in the source tree — they live only in LKML archives. For a maintainer, subscribing to
   the `linux-kernel@vger.kernel.org` and `linux-sched@vger.kernel.org` lists and archiving
   the sched_ext review threads is essential for understanding the why behind the what in the
   code. When a future contributor proposes reverting one of the decisions made during this
   review, the archived threads provide the evidence for why that decision was made.
