# sched_ext Core Implementation (Patches 08–12)

## Overview

This group contains the actual sched_ext implementation — the new scheduler class, its BPF
interface, its safety infrastructure, and the first example schedulers. If the foundational
refactoring patches (01–07) cleared the terrain, this group builds the structure. The cover letter
(patch-08.md) contextualizes the submission as the v7 patchset, the version that was ultimately
merged into Linux 6.11.

The five patches in this group are not equal in size or complexity. The boilerplate patch (patch-08)
establishes the file skeleton and class registration. The core implementation patch (patch-09,
~4000 lines) is where almost all of the scheduling logic lives — it is the patch a maintainer
must understand most deeply. Patches 10–12 add the safety envelope: example schedulers for
verification, a sysrq escape hatch, and a watchdog timer.

## Why These Patches Are Needed

A BPF-based scheduler class requires:

1. A kernel-side implementation of `struct sched_class` that delegates decisions to BPF programs
   through a well-defined callback interface (`struct sched_ext_ops`).
2. Per-task state to track where each task sits in the scheduler's queues.
3. Dispatch queues — the mechanism by which BPF programs move tasks to CPUs.
4. BPF helper functions — the kernel-side API that BPF programs call to perform actions.
5. Graceful failure — when the BPF program misbehaves, the kernel must recover without a panic.
6. Example code that demonstrates the interface is usable and correctly designed.

This group delivers all six. Understanding why each piece exists requires understanding the
problem sched_ext is solving: allow arbitrary scheduling policy in BPF while keeping the kernel
safe from misbehaving BPF programs.

## Key Concepts

### The Cover Letter (patch-08.md) — v7 and the Merge Path

The v7 patchset was submitted after six earlier rounds of review. The cover letter is important
reading for a maintainer because it documents the design decisions that were *debated and resolved*
during review — the reasons certain choices were made over alternatives. It also announces that
sched_ext would be merged into Linux 6.11 via the tip/sched/core tree.

Key design decisions the cover letter defends:
- Why `SCHED_EXT` is a new scheduling policy (not a flag on `SCHED_NORMAL`).
- Why BPF programs communicate through `sched_ext_ops` callbacks rather than a ring buffer.
- Why the dispatch queue abstraction (DSQ) exists as an intermediary rather than having BPF
  programs directly set `curr` on CPUs.

### The Boilerplate Patch — File Structure and Class Registration

The boilerplate patch creates the scaffolding that the core patch fills in:

- `include/linux/sched/ext.h` — userspace-visible header: `SCHED_EXT` policy number,
  `struct sched_ext_ops` declaration (the BPF program fills this struct), and the
  `SCX_DSQ_*` constants.
- `kernel/sched/ext.h` — kernel-internal header: `scx_entity` (per-task state embedded in
  `task_struct`), internal DSQ structures, and declarations for functions `core.c` calls.
- `kernel/sched/ext.c` — the implementation file, initially stub functions.

The critical registration step: `ext_sched_class` is defined with `.next = &idle_sched_class`
and `fair_sched_class.next` is changed to `&ext_sched_class`. This inserts the new class at
the correct priority level. Hooks are added to `kernel/fork.c` (`sched_ext_free()` is called
from `free_task()`), `kernel/sched/core.c` (for class transitions), and `kernel/sched/idle.c`
(so idle CPUs check the SCX global DSQ).

### PATCH 09 — The Core Implementation

This is the heart of sched_ext. The key data structures and mechanisms are:

**`struct scx_dispatch_q` (DSQ)**

A DSQ is an ordered list of tasks waiting to run. There are three kinds:

- `SCX_DSQ_GLOBAL` (ID 0): A single global FIFO queue. Any CPU can dispatch from it.
  This is the simplest possible dispatch model — a BPF scheduler that only uses the global DSQ
  is functionally similar to a simple FIFO scheduler.
- `SCX_DSQ_LOCAL` (ID `SCX_DSQ_LOCAL_ON | cpu`): Per-CPU local queues. Tasks in a CPU's local
  DSQ will run on that specific CPU. The kernel dispatches from the local DSQ before looking
  elsewhere.
- User-defined DSQs: BPF programs can create arbitrary DSQs with `scx_bpf_create_dsq(id, node)`.
  These allow BPF programs to implement complex queuing policies (priority queues, round-robin
  groups, deadline queues) entirely in BPF.

**`struct scx_entity`**

Embedded in `task_struct` (alongside `struct sched_entity se` for CFS). Tracks:
- Which DSQ the task is currently in (`dsq` pointer).
- The task's position in the DSQ (`dsq_node`).
- Slice remaining (`slice` — how many nanoseconds the task can run before it's preempted).
- Virtual time for vtime-ordered DSQs (`dsq_vtime`).
- Various flags: `SCX_TASK_QUEUED`, `SCX_TASK_RUNNING`, `SCX_TASK_DISALLOW`, etc.

**The dispatch path**

When the kernel needs to pick the next task for a CPU, `pick_next_task_scx()` is called:

1. Check the CPU's local DSQ (`rq->scx.local_dsq`). If non-empty, take the first task.
2. Call `ops.dispatch(cpu, prev)` — give the BPF program a chance to fill the local DSQ.
3. After `ops.dispatch()` returns, check the local DSQ again.
4. Check `SCX_DSQ_GLOBAL` as a fallback.
5. If still empty, return NULL (kernel will try `idle_sched_class`).

**The enqueue path**

When a task becomes runnable, `enqueue_task_scx()` is called:

1. Call `ops.select_cpu(p, prev_cpu, wake_flags)` — BPF program can return a preferred CPU.
2. If the preferred CPU's local DSQ is empty and the CPU is idle, dispatch there directly
   (this is the "direct dispatch" optimization that avoids an extra `ops.dispatch()` round).
3. Otherwise, call `ops.enqueue(p, enq_flags)`. The BPF program must call
   `scx_bpf_dispatch(p, dsq_id, slice, enq_flags)` to place the task in a DSQ.

**BPF helper functions (`scx_bpf_*`)**

These are the kernel-side API that BPF programs call:

- `scx_bpf_dispatch(p, dsq_id, slice, enq_flags)` — move task `p` to DSQ `dsq_id` with
  time slice `slice`.
- `scx_bpf_dispatch_vtime(p, dsq_id, vtime, slice, enq_flags)` — dispatch with virtual time
  ordering.
- `scx_bpf_consume(dsq_id)` — in `ops.dispatch()`, pull the next task from a user DSQ into
  the local DSQ.
- `scx_bpf_create_dsq(dsq_id, node)` — create a new DSQ.
- `scx_bpf_destroy_dsq(dsq_id)` — destroy a DSQ (BPF programs clean up in `ops.exit()`).
- `scx_bpf_task_running(p)` — is the task currently executing on a CPU?
- `scx_bpf_cpu_rq(cpu)` — get the `struct rq *` for a CPU (used to enqueue to local DSQs).

**Error exit (`scx_ops_error()`)**

If the BPF program misbehaves (e.g., tries to dispatch to a non-existent DSQ, returns an
invalid CPU from `select_cpu`, or causes a kernel BUG), the kernel calls `scx_ops_error()`.
This:
1. Sets an error state in `scx_ops_exit_kind`.
2. Schedules `scx_ops_disable_workfn()` on a work queue.
3. The work function disables the BPF scheduler: moves all tasks back to CFS, calls
   `ops.exit()`, and clears `ext_sched_class` from the class list.

The error state captures a human-readable reason string and is readable from debugfs, which
feeds the monitoring tooling in later patches.

### PATCH 10 — Example Schedulers

Two example BPF schedulers are provided in `tools/sched_ext/`:

**`scx_simple`**: The simplest possible sched_ext scheduler. It implements only `ops.enqueue()`
and `ops.dispatch()`. Every task is dispatched to `SCX_DSQ_GLOBAL`. This is the "hello world"
of sched_ext and demonstrates the minimum viable implementation.

**`scx_example_qmap`**: A more sophisticated scheduler using 5 per-priority queues implemented
as a BPF array map. `ops.enqueue()` places tasks in the queue corresponding to their nice value.
`ops.dispatch()` drains queues in priority order. This demonstrates:
- How to create and manage BPF-defined DSQs.
- How `scx_bpf_consume()` is used to pull from custom DSQs into the local DSQ.
- How per-task data can be stored in BPF maps keyed by `task_struct *`.

These examples are not just demos — they are the primary validation that the API is usable
and that the kernel-side implementation correctly handles the BPF callbacks.

### PATCH 11 — sysrq-S Emergency Fallback

The keyboard shortcut `Alt+SysRq+S` is registered to call `scx_ops_disable()`. This provides
a human-accessible escape hatch: if a BPF scheduler causes the system to become unresponsive
(tasks not scheduled, UI frozen), a user at the console can press `Alt+SysRq+S` to forcibly
kill the BPF scheduler and return all tasks to CFS.

Mechanically, this calls `scx_ops_error()` with a "sysrq" reason, which triggers the same
disable path as an internal error. The distinction is in the exit reason recorded: `SCX_EXIT_SYSRQ`
vs `SCX_EXIT_ERROR`. This is important for post-mortem analysis — was the scheduler disabled
intentionally or due to a bug?

The sysrq handler is registered in `scx_init()` and deregistered in `scx_exit()`.

### PATCH 12 — Watchdog Timer

The watchdog timer addresses a failure mode that sysrq cannot catch: the system is technically
running but the BPF scheduler is not scheduling tasks in a timely manner. For example, a BPF
program might have a bug where certain tasks are never dequeued from a user-defined DSQ, starving
them indefinitely.

The watchdog implementation:
- A per-CPU `struct scx_watchdog` contains a `hrtimer` and tracks when the CPU's SCX tasks
  were last dispatched.
- The timer fires every `scx_watchdog_timeout / 2` (default: 15 seconds, half the 30-second
  timeout).
- On each fire, it checks whether any runnable SCX task has not been scheduled within
  `scx_watchdog_timeout`.
- If a stall is detected, `scx_ops_error()` is called with "runnable task stall detected".

The watchdog uses a generation counter per task (`scx_entity.runnable_at`) that is updated
each time a task is dispatched. The watchdog checks whether `now - runnable_at > timeout` for
any runnable task.

The watchdog is enabled when `scx_ops_enable()` succeeds and disabled as part of
`scx_ops_disable_workfn()`. It cannot fire during class transitions, avoiding a window
where a task might appear stalled simply because it is being migrated.

## Connections Between Patches

The patches in this group build on each other in a specific order:

```
PATCH 08 (boilerplate)
    └─→ Creates the files and stubs that PATCH 09 fills in
    └─→ Registers ext_sched_class, making the class visible to the scheduler

PATCH 09 (core)
    └─→ Implements the full dispatch/enqueue/select_cpu machinery
    └─→ Provides scx_ops_error() which PATCH 11 and PATCH 12 use
    └─→ Provides scx_ops_enable/disable which PATCH 12's watchdog wraps

PATCH 10 (examples)
    └─→ Validates that PATCH 09's API is correct and complete
    └─→ The simplest test that the dispatch path works end-to-end

PATCH 11 (sysrq)
    └─→ Uses scx_ops_error() from PATCH 09
    └─→ Provides human-accessible escape hatch tested before watchdog

PATCH 12 (watchdog)
    └─→ Uses scx_ops_error() from PATCH 09
    └─→ Closes the failure mode that PATCH 11 cannot catch (no human present)
```

## Connections to Foundational Patches

This group directly consumes every change from patches 01–07:

- `sched_class_above()` (PATCH 01) is called in `ext.c` wherever class priority comparisons occur.
- Fallible fork (PATCH 02) enables `scx_cgroup_can_attach()` and `ops.enable()` during fork to
  propagate `ENOMEM`.
- `reweight_task()` (PATCH 03) is implemented in `ext.c` to call `ops.reweight_task()`.
- `switching_to()` (PATCH 04) is implemented in `ext.c` to call `ops.enable()` before enqueue.
- Cgroup/PELT helpers (PATCHES 05–06) are called from `scx_bpf_task_cgroup_weight()` and
  the PELT integration in `scx_entity`.
- `normal_policy()` (PATCH 07) is used in several places in `ext.c` to check task policy.

## What to Focus On

**For a maintainer**, the critical areas to understand in this group:

1. **The dispatch contract.** The rule is: a task must end up in a DSQ (via `scx_bpf_dispatch()`)
   before the kernel can run it. If `ops.enqueue()` is called and the BPF program does not call
   `scx_bpf_dispatch()`, the task is considered to have been "consumed" without being dispatched,
   which triggers an error exit. Understanding this contract is necessary to evaluate any future
   change to the enqueue/dispatch path.

2. **DSQ lifecycle.** User-defined DSQs are created with `scx_bpf_create_dsq()` and must be
   destroyed in `ops.exit()`. If a BPF program forgets to destroy a DSQ, the kernel detects
   leaked DSQs during `scx_ops_disable_workfn()` and logs an error. Future patches touching DSQ
   lifecycle (e.g., per-NUMA DSQs, per-cgroup DSQs) must respect this cleanup contract.

3. **The error exit machinery.** `scx_ops_error()` can be called from any context — interrupt,
   softirq, process context — so it must be lock-free in its initial steps. The actual disable
   work is deferred to a workqueue. Understanding this deferred-disable pattern is essential for
   reviewing any change that adds new error conditions.

4. **`scx_entity` in `task_struct`.** Adding fields to `task_struct` is always scrutinized
   heavily in kernel review because it increases memory usage for every task on the system,
   not just SCX tasks. Study how `scx_entity` is conditionally compiled (`CONFIG_SCHED_CLASS_EXT`)
   and what techniques are used to minimize its footprint.

5. **The select_cpu / direct dispatch optimization.** The path where `ops.select_cpu()` returns
   a CPU whose local DSQ is empty, and the task is dispatched there without going through
   `ops.enqueue()` at all, is a critical performance optimization. Any change to wakeup paths
   must preserve this fast path or explicitly justify removing it.

6. **Example schedulers as specification.** The example schedulers in PATCH 10 are not just
   documentation — they are the canonical test of whether a proposed API change is usable.
   When reviewing future sched_ext API changes, check whether the examples would need to change
   and whether the changes make the examples simpler or more complex.
