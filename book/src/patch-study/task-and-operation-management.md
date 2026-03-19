# Task and Operation Management (Patches 20–23)

## Overview

This group of four patches refines how sched_ext manages the lifecycle of individual tasks and
tracks in-flight operations. The core implementation (patch 09) established the basic enqueue
and dispatch mechanism, but several important task state transitions were underspecified:
What exactly is the BPF program notified of when a task's CPU run begins or ends? Can the
kernel suppress scheduling ticks when the BPF scheduler doesn't need them? What prevents races
when the BPF program and kernel code concurrently touch the same task? And how does a CPU
coordinate with another to ensure a kicked CPU has actually rescheduled?

Patches 20–23 answer each of these questions, completing the task lifecycle interface and
adding the concurrency controls needed for robust BPF scheduler implementation.

## Why These Patches Are Needed

### Fine-Grained Task State Visibility

The base sched_ext implementation notifies BPF programs of two task events: `ops.enqueue()`
(task becomes runnable) and dispatch (task is placed on a CPU's local DSQ). But between
"task is runnable" and "task is actually running on a CPU" there is a gap that matters for
scheduling algorithms:

- **Work-conserving schedulers** need to know when a CPU actually begins executing a task
  (not just when the task was dispatched) to update utilization estimates.
- **Gang schedulers** need to know when a group of related tasks all become runnable
  simultaneously (they are waiting for all members to be ready before dispatching any).
- **Preemption-aware schedulers** need to know when a task stops executing, distinguishing
  between "stopped voluntarily" (syscall, I/O wait) and "stopped involuntarily" (preempted).

The base implementation does not expose these transitions to BPF programs.

### Tick Suppression

Linux's scheduler tick fires periodically (typically every 1–4ms) on each CPU to implement
time-slicing. The tick calls `scheduler_tick()`, which checks whether the current task has
exhausted its time slice and sets `TIF_NEED_RESCHED` if so.

Many latency-sensitive workloads benefit from `nohz_full` (tickless operation): when a CPU
runs a single task with no pending work, the tick can be suppressed, eliminating jitter from
interrupt-driven preemption. CFS supports this natively. sched_ext needs the same capability.

### In-Flight Operation Tracking

When a BPF program calls `scx_bpf_dispatch()`, the kernel places the task in a DSQ. But
between the BPF program deciding to dispatch a task and the kernel actually executing the
dispatch, the task's state might change: the task could be migrated, preempted, or even exit.
The kernel needs a mechanism to track tasks that are subjects of an in-flight SCX operation
and ensure the operation completes safely or is cancelled.

### Synchronous Kick Confirmation

`scx_bpf_kick_cpu()` (patch 17) sends an IPI and returns immediately — it does not wait for
the target CPU to actually reschedule. For most use cases this is fine (fire and forget), but
for some coordination patterns, the calling CPU needs a guarantee that the target CPU has
processed the kick. Without this, race conditions are possible.

## Key Concepts

### PATCH 20 — Task Lifecycle Callbacks

Patch 20 adds four new `sched_ext_ops` callbacks that give BPF programs fine-grained visibility
into task state:

**`ops.runnable(p, enq_flags)`**: Called when a task transitions from sleeping/waiting to
runnable. This happens just before `ops.enqueue()` is called. The distinction from
`ops.enqueue()` is subtle but important: `runnable()` is called once per sleep-to-wake
transition, while `enqueue()` may be called multiple times (e.g., after preemption and
re-queueing). BPF schedulers use `runnable()` to track the number of runnable tasks (for
load estimation) without double-counting re-queued tasks.

**`ops.running(p)`**: Called immediately before a task begins executing on a CPU
(just before `context_switch()`). This is the notification that the task is now consuming CPU
cycles. BPF schedulers use this to start per-task CPU time accounting, update utilization
estimates, and record `task.start_time` for scheduling analytics.

**`ops.stopping(p, runnable)`**: Called when a task is about to stop running on a CPU, before
it is removed from `rq->curr`. The `runnable` argument indicates whether the task will remain
runnable (true: preempted or yielded) or become blocked (false: waiting for I/O or sleeping).
This is the symmetric counterpart to `ops.running()`.

**`ops.quiescent(p, deq_flags)`**: Called when a task transitions from runnable to not runnable
(the task has gone to sleep, waiting for I/O, or exited). This is the symmetric counterpart to
`ops.runnable()`. BPF schedulers use this to decrement their runnable task count.

The relationship between these four callbacks traces a complete task lifecycle:

```
ops.runnable()     ← task wakes up
ops.enqueue()      ← task placed in a DSQ
ops.running()      ← task begins executing on CPU
ops.stopping()     ← task stops executing (may still be runnable)
ops.enqueue()      ← (if still runnable: re-queued after preemption)
ops.quiescent()    ← task goes to sleep
```

Beyond these four, patch 20 also adds:

**`ops.enable(p)`**: Called when a task first adopts `SCHED_EXT` scheduling policy (or on
system init for existing tasks). This is where BPF programs initialize per-task state
(e.g., allocating a `BPF_MAP_TYPE_TASK_STORAGE` entry). Called from `switching_to()` (patch 04),
before the task is enqueued.

**`ops.disable(p)`**: Called when a task leaves `SCHED_EXT` policy (either by calling
`sched_setscheduler()` to switch to another policy, or when the BPF scheduler is being disabled
and all tasks are returned to CFS). This is where BPF programs free per-task state.

The `enable()`/`disable()` pair guarantees balanced allocation/deallocation. The kernel ensures
`disable()` is called exactly once for each `enable()` call, even during error exits.

### PATCH 21 — Tickless Support (nohz_full Integration)

When a BPF scheduler runs a task on a CPU and that CPU has no other runnable tasks, the
scheduler tick can be suppressed. Patch 21 integrates sched_ext with `nohz_full`:

The relevant function is `task_tick_scx(rq, curr, queued)`, the sched_ext implementation of
`sched_class->task_tick()`. In CFS, this function checks whether the current task's time slice
has expired. In sched_ext, the tick is suppressed if all of the following are true:

1. The CPU's local DSQ is empty (no other SCX tasks waiting).
2. The global DSQ is empty.
3. The BPF scheduler has not set any "tick needed" flag.
4. The BPF scheduler's `ops.dispatch()` would return immediately (no pending work).

When these conditions hold, `task_tick_scx()` calls `sched_can_stop_tick(rq)` to signal that
the tick can be stopped. The `nohz_full` infrastructure then suppresses the timer interrupt
on this CPU until a new task becomes runnable or the CPU is kicked.

**Interaction with time slices**: sched_ext tasks have a `scx_entity.slice` field that holds
the remaining time slice. When the tick fires and `slice` reaches zero, the task is preempted.
With tickless operation, preemption is driven by timer expiry rather than periodic ticks,
which may result in longer time slices than configured — this is intentional for nohz_full
workloads where jitter reduction is more important than strict time-slice enforcement.

**BPF program responsibility**: A BPF scheduler that dispatches tasks with `scx_bpf_dispatch()`
using `SCX_SLICE_INF` (infinite slice) is declaring that it will handle preemption itself (via
`scx_bpf_kick_cpu()` with `SCX_KICK_PREEMPT`). For such schedulers, tick suppression is
always appropriate. A scheduler that uses finite slices should not enable tick suppression
unless it can tolerate some slice overshoot.

### PATCH 22 — scx_entity::in_op_task

This patch adds `in_op_task`, a flag in `scx_entity` that marks tasks that are currently the
subject of an in-flight SCX operation. The primary use case is `scx_bpf_dispatch()`: when the
BPF program calls `scx_bpf_dispatch(p, dsq_id, slice, enq_flags)`, the kernel must:

1. Validate that `p` is still in a valid state for dispatch.
2. Acquire the appropriate locks (the task's DSQ lock, possibly the runqueue lock).
3. Move the task to the target DSQ.

Between steps 1 and 2, the task could be migrated, preempted, or exit. Without `in_op_task`,
the kernel would have to check every condition again after acquiring the locks, and if the
state changed, it would have to abort and potentially corrupt the DSQ.

`in_op_task` works as a serialization token:

- It is set when a BPF callback begins processing a task (e.g., at the start of `ops.enqueue()`).
- It is cleared when the callback returns.
- Any kernel code path that needs to modify a task's scheduling state checks `in_op_task` first.
  If set, it waits (via `scx_task_iter_wait()`) for the in-flight operation to complete.

This avoids TOCTOU (Time Of Check, Time Of Use) races where the BPF program checks a task's
state, decides to dispatch it, and the kernel changes the state before the dispatch completes.

**Relationship to BPF verifier**: The BPF verifier cannot prevent all races — it can prevent
BPF programs from accessing invalid memory, but it cannot reason about kernel-side state
changes. `in_op_task` is the kernel-side mechanism that complements the verifier's static
analysis by providing runtime serialization.

### PATCH 23 — SCX_KICK_WAIT

Patch 23 adds the `SCX_KICK_WAIT` flag to `scx_bpf_kick_cpu()`. When specified:

1. The kick is sent as usual (IPI to target CPU).
2. The calling CPU then waits (via `wait_event()` on a per-CPU completion) until the target
   CPU has completed one full scheduling round (i.e., `schedule()` has returned and a new task
   has been selected).

**Use case**: A BPF scheduler that dispatches a task to CPU A's local DSQ and then needs to
know that CPU A has actually picked up the task (not just received the kick) before proceeding.
For example, a gang scheduler waiting for all CPUs in a gang to have their tasks running.

**Implementation**: The target CPU sets a completion event at the end of `__schedule()` when
it detects a pending `SCX_KICK_WAIT`. The calling CPU's `scx_bpf_kick_cpu()` waits on this
completion with a timeout. If the timeout expires (e.g., the target CPU is stuck), the wait
returns an error but does not trigger a watchdog event — it is the calling CPU's BPF program's
responsibility to handle the timeout.

**Cost**: `SCX_KICK_WAIT` adds synchronization overhead: the calling CPU blocks until the
target CPU reschedules. For high-frequency scheduling decisions, this is too expensive. It is
intended for coarse-grained coordination (gang startup, barrier-style synchronization) rather
than per-task dispatch.

## Connections Between Patches

```
PATCH 20 (lifecycle callbacks)
    └─→ ops.enable/disable: required foundation for per-task BPF state
    └─→ ops.running/stopping: consumed by PATCH 21 (tick suppression) to determine
        whether tick can be stopped based on actual execution state
    └─→ ops.runnable/quiescent: enable accurate task count tracking

PATCH 21 (tickless)
    └─→ Depends on ops.stopping (PATCH 20): tick is only suppressed after stopping
    └─→ Interacts with scx_entity.slice: inf-slice tasks are primary beneficiaries

PATCH 22 (in_op_task)
    └─→ Serializes against PATCH 20 callbacks: in_op_task prevents ops.disable() from
        racing with ops.enqueue() for the same task
    └─→ Interacts with PATCH 23: in-flight dispatch (in_op_task) and synchronous kick
        (KICK_WAIT) together allow BPF programs to implement deterministic scheduling rounds

PATCH 23 (SCX_KICK_WAIT)
    └─→ Extends PATCH 17 (scx_bpf_kick_cpu) with a synchronous variant
    └─→ Used alongside PATCH 22 to confirm task was dispatched and CPU has rescheduled
```

## What to Focus On

**For a maintainer**, the critical lessons from this group:

1. **The enable/disable pairing guarantee.** `ops.enable()` and `ops.disable()` must be called
   in perfectly matched pairs. The kernel's guarantee: `disable()` is called exactly once for
   every `enable()`, even during error exit (`SCX_EXIT_ERROR`). When reviewing any change to
   the class transition or disable path, verify this invariant is preserved. A missed
   `disable()` call leaks BPF per-task resources; a spurious `disable()` call on a task that
   never had `enable()` called is undefined behavior.

2. **runnable/quiescent vs enqueue/dequeue.** The new lifecycle callbacks form two parallel
   pairs: `runnable`/`quiescent` track the task's runnable state (independent of CPU), while
   `running`/`stopping` track CPU execution. These are distinct events and must not be confused.
   A task that is preempted fires `stopping(runnable=true)` (it is still runnable) and will
   fire `enqueue()` again when re-queued, but does not fire `quiescent()`. When reviewing BPF
   schedulers that implement these callbacks, verify they correctly distinguish preemption from
   blocking.

3. **Tick suppression and time-slice accuracy.** `nohz_full` integration means tick-based
   preemption may fire late. A BPF scheduler that relies on precise time slices (e.g., for
   real-time guarantees) should not use tickless mode. When reviewing changes to the tick path
   in `task_tick_scx()`, verify that finite-slice tasks still receive timely preemption.

4. **in_op_task as a liveness concern.** `in_op_task` serializes kernel code against in-flight
   BPF operations. If a BPF program holds `in_op_task` indefinitely (e.g., infinite loop in
   `ops.enqueue()`), kernel code waiting for the serialization will also wait indefinitely.
   The dispatch watchdog (patch 19) catches the infinite loop case, but `in_op_task` itself
   has no timeout. When reviewing future uses of `in_op_task`, ensure the in-flight operation
   is always bounded in time.

5. **SCX_KICK_WAIT and priority inversion.** If CPU A calls `scx_bpf_kick_cpu(B, SCX_KICK_WAIT)`
   and CPU B is running a high-priority RT task (which cannot be preempted by sched_ext), CPU A
   will wait until that RT task voluntarily yields. This is a form of priority inversion: the
   BPF scheduler on CPU A (which may be handling a high-priority SCX task) is blocked waiting
   for an RT task on CPU B to yield. Future changes to `SCX_KICK_WAIT` should consider adding
   a timeout that the BPF program can configure to avoid unbounded waits.
