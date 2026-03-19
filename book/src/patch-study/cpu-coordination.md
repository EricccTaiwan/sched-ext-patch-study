# CPU Coordination (Patches 17 and 19)

## Overview

Scheduling a task requires not just deciding which task to run, but also coordinating the CPUs
that will run it. A BPF scheduler that can only enqueue tasks passively — waiting for each CPU
to call `ops.dispatch()` on its own schedule — cannot implement latency-sensitive policies or
ensure timely preemption of lower-priority work. Patches 17 and 19 add the active control
primitives that allow a BPF scheduler to reach out and influence CPU behavior directly.

Patch 17 introduces `scx_bpf_kick_cpu()`, the primary inter-CPU signaling mechanism in
sched_ext. Patch 19 extends the watchdog to detect a specific failure mode introduced by the
dispatch mechanism: an infinite loop inside `ops.dispatch()` that never yields control back
to the kernel.

Together these two patches complete the control loop between the BPF scheduler and the CPUs it
manages: kick gives the BPF program the ability to push CPUs, and the extended watchdog ensures
that push mechanism cannot be abused to lock up the system.

## Why These Patches Are Needed

### The Problem with Purely Reactive Dispatch

In the base sched_ext design (patch 09), the flow is:

1. A CPU needs a task to run.
2. The CPU calls `pick_next_task_scx()`.
3. If the local DSQ is empty, the kernel calls `ops.dispatch(cpu, prev)`.
4. The BPF program fills the local DSQ.
5. The CPU runs the task.

This is purely reactive: the CPU asks, the BPF program answers. For many scheduling policies
this is sufficient, but consider these scenarios:

**Latency-sensitive wakeup**: A high-priority task wakes up on a system where all CPUs are
running lower-priority tasks. In the reactive model, the high-priority task must wait until
one of those CPUs naturally calls `ops.dispatch()` — which happens only after its current
task yields or is preempted by a timer. Until then, the high-priority task sits idle in a DSQ.

**Idle CPU with work available**: A task is dispatched to the global DSQ. Several CPUs are
idle and could pick it up, but they are in the deep idle state (halted). In the reactive model,
they will not wake up until the next interrupt. The task experiences unnecessary latency.

**Cross-CPU work stealing**: A CPU has an empty local DSQ and needs to steal work from another
CPU's queue. The stealing CPU can query other CPUs' DSQs and dispatch tasks to itself, but it
cannot tell an overloaded CPU to immediately re-evaluate its queues.

`scx_bpf_kick_cpu()` solves all three by letting any BPF context signal any CPU to take a
scheduling action immediately.

### The Dispatch Loop Problem

`ops.dispatch()` is called with the runqueue lock held. If a BPF program enters an infinite
loop inside `ops.dispatch()` — for example, calling `scx_bpf_consume()` in a tight loop that
never runs out of tasks — the CPU will never release the runqueue lock, other CPUs that need
to migrate tasks to or from this CPU will spin waiting for the lock, and the system will
gradually deadlock.

The base watchdog (patch 12) detects task stalls: a runnable task that hasn't been scheduled.
But a spinning `ops.dispatch()` doesn't produce a stalled task — it produces a CPU that is
nominally "busy scheduling" but actually spinning. The base watchdog cannot catch this.

Patch 19 extends the watchdog specifically for this dispatch loop failure mode.

## Key Concepts

### PATCH 17 — scx_bpf_kick_cpu()

`scx_bpf_kick_cpu(cpu, flags)` is a BPF helper that sends an inter-processor interrupt (IPI)
to the target CPU, causing it to re-evaluate its scheduling state. The `flags` argument controls
what kind of action the target CPU will take:

**`SCX_KICK_IDLE`**: If the target CPU is idle (in the idle loop or halted), wake it up. If it
is not idle, this is a no-op — the CPU is already running a task and will naturally call
`ops.dispatch()` when that task finishes or yields.

Use case: A task was just dispatched to a DSQ, and the BPF program wants to ensure an idle CPU
picks it up promptly rather than waiting for the next timer interrupt to fire.

**`SCX_KICK_PREEMPT`**: If the target CPU is running a SCX task, preempt it immediately.
This causes the CPU to finish the current scheduling quantum early and call `pick_next_task_scx()`
sooner than it would have naturally.

Use case: A high-priority task wakes up and needs a CPU. The BPF program identifies which CPU
is running the lowest-priority current task, kicks it with `SCX_KICK_PREEMPT`, and dispatches
the high-priority task to that CPU's local DSQ. The preempted CPU immediately picks up the
high-priority task.

**`SCX_KICK_WAIT`** (added in patch 23, cpu-coordination group): Block the calling CPU until
the target CPU has completed one full scheduling round. This is used when the kicking CPU needs
a guarantee that the target CPU has actually processed the kick before proceeding.

**Implementation details**

`scx_bpf_kick_cpu()` sends an IPI using `smp_send_reschedule(cpu)`, the same mechanism the
kernel uses for normal task migrations. The target CPU handles the IPI by setting
`TIF_NEED_RESCHED` and, if idle, exiting the idle loop.

For `SCX_KICK_PREEMPT`, the target CPU's `scx_rq.flags` has `SCX_RQ_PREEMPT` set before the
IPI is sent. When the target CPU processes the reschedule, it checks this flag and calls
`resched_curr()` on itself, which causes the current task to be preempted at the next
scheduler tick or preemption point.

The BPF helper is accessible only from BPF programs attached to sched_ext — it is not a
general-purpose IPI mechanism. It is registered in the BPF verifier's allowed helper set for
the `BPF_PROG_TYPE_STRUCT_OPS` program type that implements `sched_ext_ops`.

**Interaction with scx_central**

Patch 18 (`scx_central`) is the primary consumer of `scx_bpf_kick_cpu()`. The central
scheduler, after dispatching tasks to a CPU's local DSQ, uses `SCX_KICK_IDLE` to wake that
CPU. Without the kick, the idle CPU might remain halted for up to several milliseconds (until
the next timer interrupt), adding avoidable latency to task wakeups.

### PATCH 19 — Watchdog Extension for Dispatch Loops

The dispatch loop watchdog works as follows:

**Detection mechanism**: Each CPU tracks how long it has been in `ops.dispatch()`. A timestamp
`scx_rq.dispatch_start` is set when `ops.dispatch()` is entered and cleared when it returns.
The watchdog timer (which fires every `scx_watchdog_timeout / 2`) checks whether any CPU has
been in `ops.dispatch()` for longer than `scx_watchdog_timeout`.

**Stall condition**: If `ops.dispatch()` has been executing for more than `scx_watchdog_timeout`,
the watchdog calls `scx_ops_error()` with reason "dispatch stall detected on CPU N". This
triggers the full disable sequence: the BPF scheduler is killed and all tasks return to CFS.

**Why this is safe**: The dispatch loop stall check is done by the watchdog timer, which runs
on a different CPU via the hrtimer infrastructure. The stalling CPU cannot prevent the watchdog
from firing because the watchdog runs in interrupt context on other CPUs. The watchdog CPU can
call `scx_ops_error()` even while the stalling CPU holds the runqueue lock, because
`scx_ops_error()` is designed to be called from any context and only sets a flag atomically
before deferring actual work to a workqueue.

**Relationship to the base watchdog**

The base watchdog (patch 12) tracks per-task `runnable_at` timestamps. This dispatch watchdog
tracks per-CPU `dispatch_start` timestamps. They are complementary: the task watchdog catches
"task never scheduled" bugs, the dispatch watchdog catches "CPU never returns from dispatch"
bugs. Both call the same `scx_ops_error()` function, producing the same disable sequence.

**BPF program implications**

Any BPF program that implements `ops.dispatch()` must ensure the callback returns within
`scx_watchdog_timeout`. Long-running dispatch logic (e.g., iterating over thousands of tasks)
must be broken into multiple dispatch calls. The `scx_bpf_consume()` helper returns true while
tasks are available and false when the DSQ is empty — a well-written dispatch loop checks this
return value and exits when it returns false, rather than consuming indefinitely.

A BPF program that does not implement `ops.dispatch()` is unaffected by this watchdog extension,
since the kernel will use its default (empty) dispatch implementation.

## Connections Between Patches

```
PATCH 17 (scx_bpf_kick_cpu)
    └─→ Required by PATCH 18 (scx_central): central CPU kicks idle CPUs after dispatch
    └─→ Used by PATCH 23 (SCX_KICK_WAIT): adds a blocking variant of the kick
    └─→ Enables preemption-based priority enforcement for BPF schedulers

PATCH 19 (dispatch watchdog)
    └─→ Extends PATCH 12 (base watchdog): same error path, new detection condition
    └─→ Makes scx_bpf_consume() loops in ops.dispatch() safe to write
    └─→ Protects against a failure mode that scx_central (PATCH 18) could trigger
        if its central dispatch loop ran without bound
```

## Connections to Core Infrastructure

Both patches build directly on the core implementation:

- `scx_bpf_kick_cpu()` uses `smp_send_reschedule()` which is part of the kernel's IPI
  infrastructure, not sched_ext-specific. The sched_ext addition is the BPF-accessible wrapper
  and the `SCX_KICK_PREEMPT` logic that hooks into the SCX-specific reschedule path.

- The dispatch watchdog uses `scx_rq`, the per-CPU sched_ext runqueue state introduced in
  patch 09. The `dispatch_start` timestamp is a new field in `scx_rq` added by this patch.

- Both patches interact with `scx_ops_error()`: kick enables controlled preemption that is safe
  to use even during error recovery, and the dispatch watchdog triggers the error exit.

## What to Focus On

**For a maintainer**, the critical lessons from this group:

1. **IPI overhead and batching.** `scx_bpf_kick_cpu()` sends a real IPI. IPIs are cheap but not
   free — each one is an interrupt that interrupts the target CPU's execution. A BPF scheduler
   that sends an IPI for every task wakeup (one task per kick) will generate significant IPI
   overhead on a large system. When reviewing BPF schedulers or changes to kick semantics, watch
   for unbounded kick rates. The `SCX_KICK_IDLE` flag is specifically designed to be no-op when
   the CPU is already running, which reduces overhead in the common case.

2. **Preemption semantics and fairness.** `SCX_KICK_PREEMPT` can be used to implement strict
   priority preemption. However, if a BPF scheduler aggressively preempts whenever a
   higher-priority task appears, it can cause starvation of lower-priority tasks if the system
   is always generating high-priority work. When reviewing schedulers that use `SCX_KICK_PREEMPT`,
   verify they have a mechanism to ensure lower-priority tasks eventually run.

3. **The dispatch watchdog timeout calibration.** The watchdog timeout (`scx_watchdog_timeout`,
   default 30 seconds) is a system-wide parameter. A BPF scheduler that does legitimate
   long-running dispatch work (e.g., sorting thousands of tasks) will be killed by the watchdog
   if its dispatch time exceeds this threshold. When reviewing BPF schedulers or changes to the
   watchdog timeout, verify that the timeout is appropriate for the intended workload. The
   timeout is configurable via a module parameter, but changing it affects all SCX schedulers
   on the system.

4. **Runqueue lock semantics in ops.dispatch().** `ops.dispatch()` is called with the runqueue
   lock held. This means the BPF program cannot call any function that would acquire the
   runqueue lock recursively. The BPF verifier enforces some of this, but maintainers reviewing
   new BPF helpers for use in `ops.dispatch()` must verify that they do not acquire the
   runqueue lock or any lock that nests inside the runqueue lock.

5. **The dispatch watchdog and legitimate blocking.** The dispatch watchdog fires if
   `ops.dispatch()` doesn't return within the timeout. But what if a BPF program legitimately
   needs to wait for an external event during dispatch (e.g., a BPF spinlock protecting a
   complex data structure)? This is forbidden: `ops.dispatch()` must never block. Any
   synchronization in `ops.dispatch()` must use non-blocking mechanisms (BPF spin_lock with
   `bpf_spin_lock()`). When reviewing changes to dispatch semantics, maintain this invariant.
