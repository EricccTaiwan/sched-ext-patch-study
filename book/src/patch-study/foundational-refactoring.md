# Foundational Refactoring (Patches 01–07)

## Overview

Before a single line of sched_ext itself could be written, seven preparatory patches had to reshape
the existing Linux scheduler infrastructure. These patches do not add any new scheduling policy.
They are purely structural: they remove assumptions baked into the scheduler core that would
have made it impossible to insert a new, dynamically loadable scheduler class between
`fair_sched_class` and `idle_sched_class`, and they add hooks that the ext class will call at
specific points in a task's lifecycle.

Understanding these patches deeply is essential for a maintainer because they reveal the implicit
contracts that had accumulated in the scheduler over decades of evolution. Each one exposes a
place where the kernel had encoded assumptions about the set of scheduler classes, and each fix
generalizes that assumption into something extensible. That generalization work is unglamorous
but is the reason sched_ext could be merged cleanly into mainline rather than requiring invasive
surgery to the core scheduler paths.

## Why These Patches Are Needed

The Linux scheduler is organized as a linked list of `sched_class` objects:

```
stop_sched_class → dl_sched_class → rt_sched_class → fair_sched_class → idle_sched_class
```

Each class is a statically allocated `struct sched_class` with function pointers for every
scheduling operation. The kernel traverses this list in priority order—a class only runs tasks
when all higher-priority classes have no runnable work.

sched_ext introduces `ext_sched_class`, which sits between `fair_sched_class` and
`idle_sched_class`. Inserting a new class into this list sounds simple until you examine what
the existing code assumes:

1. **The set of classes is fixed at compile time.** Several validation checks used linker-section
   addresses to compare class priority rather than a dedicated comparison function. These checks
   would silently misorder the new class.

2. **Fork is infallible for scheduling purposes.** `sched_cgroup_fork()` was void. sched_ext
   needs to allocate per-task BPF state during fork, which can fail with `ENOMEM`. Propagating
   that error required making the call site aware that fork-time scheduler initialization can fail.

3. **Priority changes on enqueued tasks are handled internally.** No `sched_class` hook existed
   for the moment a task's weight changes while it is already on a run queue. sched_ext needs to
   notify the BPF program when a task's nice value changes so the BPF program can re-sort its
   own data structures.

4. **Class transitions are managed by fair/rt directly.** When a task moves from one scheduler
   class to another, the old class's `put_prev_task()` and the new class's `enqueue_task()` are
   called, but there was no "you are about to receive this task" notification to the incoming class.
   sched_ext needs to initialize per-task BPF state before the task is enqueued into the ext class.

5. **Cgroup weight conversion and load-average helpers are fair-private.** sched_ext needs to
   expose the same load metrics and weight calculations to BPF programs, requiring these helpers
   to be factored out of `fair.c` into shared code.

## Key Concepts

### PATCH 01 — sched_class_above()

The `sched_class` structures are laid out in a specific order in the kernel's `.data` section.
Historically, code in `kernel/sched/core.c` and `kernel/sched/fair.c` checked class priority by
comparing pointer values directly:

```c
/* OLD, brittle */
if (p->sched_class > &fair_sched_class)
    ...
```

This works only if the linker places the class objects in the expected order and there are no gaps.
Inserting `ext_sched_class` between `fair_sched_class` and `idle_sched_class` would shift pointer
values and break every such comparison.

Patch 01 introduces `sched_class_above(a, b)`, a semantic predicate that returns true if class `a`
has higher priority than class `b`. Internally it uses the existing linker ordering (or a generated
priority field), but critically, all call sites now express their *intent* — "is this task's class
above fair?" — rather than encoding linker layout knowledge. After this patch, inserting a new class
only requires updating `sched_class_above()`, not auditing every comparison in the tree.

### PATCH 02 — Fallible Fork

`sched_cgroup_fork()` is called from `copy_process()` during `fork(2)`. Before this patch it was
declared `void` — if it failed internally, it could only `BUG()` or silently drop the error.

The patch changes the signature to return `int` and threads that return value back up through
`copy_process()`. A companion function, `sched_cancel_fork()`, is added to undo partial
initialization when a later step of `copy_process()` fails after `sched_cgroup_fork()` has
succeeded.

For sched_ext, this matters because `ops.enable()` — the BPF callback that initializes per-task
state — needs to run during fork. BPF programs may allocate a `BPF_MAP` entry per task; that
allocation can fail. Without a fallible fork path, the only option would have been to defer the
allocation to the first time the task runs, introducing a window where the task exists without
BPF state.

### PATCH 03 — reweight_task()

When a task's priority changes via `setpriority(2)` or `nice(2)`, the kernel calls
`set_user_nice()` → `reweight_task()` (for CFS, this updates the task's load weight in the RB
tree). The existing `sched_class` interface had no hook for this event.

Patch 03 adds `sched_class->reweight_task(rq, p, prio)`. The CFS implementation is refactored
to use this new hook rather than doing the reweighting inline. For sched_ext, the hook generates a
call to `ops.reweight_task()`, allowing a BPF scheduler to update its internal priority queues
when a task's nice value changes while that task is enqueued.

Without this hook, a BPF scheduler that maintains, say, a priority queue keyed on task weight
would see stale weights after a `nice()` call, leading to incorrect scheduling decisions.

### PATCH 04 — switching_to() and check_class_changing/changed()

When a task moves from one scheduler class to another (e.g., from CFS to sched_ext via
`SCHED_EXT` policy, or between any classes), the scheduler calls:

1. `check_class_changing(rq, p, prev_class)` — called with the task still in the old class,
   before dequeuing from the old class.
2. `check_class_changed(rq, p, prev_class, oldprio)` — called after the task has been moved to
   the new class and potentially enqueued.

The problem: `check_class_changed()` calls `switched_to()` on the *new* class, but by that point
the task is already enqueued. There was no hook called on the new class *before* the task arrived.

Patch 04 adds `sched_class->switching_to(rq, p)`, called on the incoming class while the task is
still in the old class. For sched_ext, this is where the kernel can invoke `ops.enable()` on the
BPF program, giving it a chance to allocate and initialize per-task state before the task's first
`enqueue_task_scx()` call. Without this ordering guarantee, the enqueue callback would be called
with uninitialized BPF task state, requiring ugly NULL checks in every enqueue path.

### PATCHES 05–06 — Factored Utilities

`fair.c` contains two categories of code that sched_ext needs to use:

- **Cgroup weight conversion**: `sched_prio_to_weight[]` and related helpers translate cgroup
  CPU weight settings (which follow a specific scale) to scheduler load weights. sched_ext exposes
  these weights to BPF programs so they can implement weighted fair scheduling.

- **Load average tracking**: The PELT (Per-Entity Load Tracking) infrastructure in CFS tracks
  load, utilization, and runnable averages with exponential decay. sched_ext can leverage these
  same signals so BPF programs can make power-aware or utilization-aware decisions without
  reimplementing load tracking from scratch.

These patches extract the relevant functions from `fair.c` into `kernel/sched/sched.h` or
`kernel/sched/pelt.h` so that `ext.c` can call them without introducing a dependency on
`fair.c` internals.

### PATCH 07 — normal_policy()

A small but important helper: `normal_policy(policy)` returns true if the scheduling policy is
one of `SCHED_NORMAL`, `SCHED_BATCH`, or `SCHED_IDLE` — the three "normal" (non-realtime, non-ext)
policies that map to CFS. Before this patch, these checks were open-coded as multi-condition
expressions scattered across `core.c` and `fair.c`.

sched_ext needs to make this determination in several places: for example, when a task that was
previously using `SCHED_EXT` calls `sched_setscheduler()` to switch back to `SCHED_NORMAL`. A
named predicate is clearer than a repeated chain of `policy == SCHED_NORMAL || policy == SCHED_BATCH
|| policy == SCHED_IDLE`.

## Connections Between Patches

These seven patches form a dependency chain that flows into the core sched_ext implementation:

```
PATCH 01 (sched_class_above)
    └─→ Required by ext.c wherever it needs to check "is this task above/below ext class?"

PATCH 02 (fallible fork)
    └─→ Required by PATCH 04: switching_to() / ops.enable() may allocate; fork must propagate errors

PATCH 03 (reweight_task)
    └─→ Required by ext.c: ops.reweight_task() BPF callback

PATCH 04 (switching_to)
    └─→ Required by ext.c: ops.enable() must run before enqueue_task_scx()

PATCHES 05-06 (factored utilities)
    └─→ Required by ext.c: scx_bpf_task_cgroup_weight(), PELT load metrics exposed to BPF

PATCH 07 (normal_policy)
    └─→ Used throughout ext.c: determining when a task is returning to CFS
```

Notice that none of these patches reference sched_ext at all. They are pure scheduler
infrastructure improvements. This was a deliberate design choice: each patch is independently
justifiable and could be accepted on its own merits. The sched_ext patchset was structured this
way to make review easier — reviewers of the scheduler core did not have to understand BPF to
evaluate patches 01–07.

## What to Focus On

**For a maintainer**, the most important lessons from this group are:

1. **Implicit contracts in sched_class.** Before this series, the scheduler had several places
   where the contract was "there are exactly these N scheduler classes in this order." Patches 01
   and 04 make those contracts explicit and extensible. When reviewing future scheduler patches,
   watch for new places where such implicit contracts re-emerge.

2. **Error propagation in lifecycle hooks.** Patch 02's fallible fork is a template for any future
   scheduler hook that runs during `copy_process()`. The pattern — make the hook return `int`,
   add a cancel/cleanup companion, thread the error through `copy_process()` — should be followed
   whenever a new lifecycle hook might fail.

3. **Ordering of class-transition callbacks.** Patch 04 reveals that class transitions had a
   subtle ordering gap: the new class was not notified before the task arrived. `switching_to()`
   fills this gap. When reviewing any future change that touches class transitions, verify that
   `switching_to()`, `switched_to()`, and `check_class_changing/changed()` are called in the
   correct order and that no class-specific state is accessed before the appropriate notification.

4. **Code factoring for cross-class reuse.** Patches 05–06 establish the precedent that helpers
   which multiple scheduler classes need should live in shared headers, not buried in `fair.c`.
   When sched_ext (or any future class) needs a capability that CFS already has, the right fix
   is to promote the CFS implementation to shared code rather than duplicating it.

5. **Semantic naming over structural checks.** Patch 07's `normal_policy()` and patch 01's
   `sched_class_above()` both replace structural knowledge (linker addresses, repeated
   conditionals) with named predicates. This is a general principle: when the same structural
   check appears more than twice, it belongs in a named function that captures the semantic intent.
