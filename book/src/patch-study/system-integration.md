# System Integration (Patches 24–28)

## Overview

A production scheduler must coexist with the full complexity of a real Linux system: CPUs
can be hot-plugged in and out, power management events suspend the machine, SMT siblings share
execution resources with security implications, and some workloads demand weighted fair
scheduling rather than simple FIFO. This group of five patches integrates sched_ext with these
system-level concerns.

Patches 24–25 handle CPU topology changes. Patch 26 handles power management. Patch 27
integrates with Linux's core scheduling (CONFIG_SCHED_CORE) for SMT security. Patch 28 adds
virtual time ordering to DSQs, enabling weighted fair scheduling in BPF.

These patches are the most "outward-facing" in the sched_ext series: each one connects sched_ext
to a pre-existing kernel subsystem with its own conventions, locks, and lifecycle rules. For a
maintainer, understanding how sched_ext integrates with each subsystem is as important as
understanding sched_ext itself.

## Why These Patches Are Needed

### CPU Topology Changes

Linux supports CPU hotplug: CPUs can be brought online and offline at runtime (for power saving,
hardware maintenance, or virtualization). A BPF scheduler that maintains a bitmask of online
CPUs, or builds per-CPU data structures at init time, will malfunction if CPUs are added or
removed without notification.

Additionally, even among always-present CPUs, the question of "which CPUs are owned by sched_ext
vs CFS" changes dynamically. When CFS and RT have no runnable tasks on a CPU, that CPU's
capacity is available exclusively to sched_ext. When CFS or RT gains runnable tasks, they
reclaim the CPU.

Patches 24 and 25 provide BPF programs with notifications for both of these changes.

### Power Management

Linux's power management (PM) subsystem can suspend the entire system. During suspend, PM
callbacks are called from process context with interrupts disabled or in unusual lock states.
If a BPF scheduler is active during these callbacks, it may attempt to schedule tasks in
contexts where scheduling is unsafe, causing deadlocks or kernel panics.

The correct response is to bypass the BPF scheduler during PM transitions and fall back to
direct CFS dispatch. Patch 26 implements this bypass.

### Core Scheduling (SMT Security)

Simultaneous Multi-Threading (SMT) allows multiple hardware threads to share a physical core's
execution resources. This is a security concern: a malicious thread on one hardware thread can
potentially observe microarchitectural state (caches, branch predictor) from a thread running
on the sibling hardware thread. Linux's "core scheduling" (CONFIG_SCHED_CORE) feature
addresses this by ensuring that hardware thread siblings run tasks that trust each other
(same "core tag").

Without sched_ext integration, a BPF scheduler could dispatch tasks to SMT sibling threads
without respecting core scheduling constraints, undermining the security model.

### Virtual Time Ordering

The base DSQ implementation (patch 09) is strictly FIFO: tasks are dispatched in the order
they were enqueued. FIFO is simple and fair in the sense that every task waits its turn, but
it does not respect task weights. A high-weight task (high CPU priority) should get more CPU
time than a low-weight task, not just equal turns in the queue.

CFS implements weighted fair scheduling using a virtual time algorithm: each task's virtual
clock advances at a rate inversely proportional to its weight. Tasks are ordered by virtual
time, so lower-weight tasks advance their virtual time faster and are placed later in the
queue. Patch 28 brings this same mechanism to sched_ext DSQs.

## Key Concepts

### PATCH 24 — ops.cpu_acquire() and ops.cpu_release()

These callbacks notify the BPF scheduler when a CPU transitions between "shared" (CFS/RT also
have runnable tasks) and "exclusive to SCX" states.

**`ops.cpu_acquire(cpu, reason)`**: Called when a CPU becomes exclusively available to the SCX
scheduler. This happens when:
- CFS and RT both have no runnable tasks on this CPU.
- The CPU was previously running a CFS/RT task that has now gone idle.

The `reason` argument encodes why the CPU became available (e.g., `SCX_CPU_ACQUIRE_HOTPLUG`
for a newly onlined CPU vs. `SCX_CPU_ACQUIRE_IDLE` for a CPU whose non-SCX tasks have drained).

**`ops.cpu_release(cpu, reason)`**: Called when a CPU is being taken away from exclusive SCX
use. This happens when:
- A CFS or RT task becomes runnable on this CPU (it outranks SCX in priority).
- The CPU is being offlined (hotplug).

The BPF scheduler uses these callbacks to maintain a bitmask of "CPUs available to SCX" and to
make CPU selection decisions in `ops.select_cpu()`. A BPF scheduler that does not implement
these callbacks will have a static view of CPU availability and may dispatch tasks to CPUs that
CFS has reclaimed, causing tasks to run later than expected.

**Implementation**: The callbacks are called from `sched_class->balance()` and from the idle
loop when a CPU transitions between idle states. The lock ordering requires that these callbacks
be called with the runqueue lock held, so BPF programs implementing these callbacks must not
acquire any lock that nests inside the runqueue lock.

### PATCH 25 — ops.cpu_online() and ops.cpu_offline()

While `ops.cpu_acquire/release` track whether a CPU is available to SCX at a given moment,
`ops.cpu_online/offline` track the fundamental presence of the CPU in the system.

**`ops.cpu_online(cpu)`**: Called when a CPU is brought online via hotplug. The BPF scheduler
should update any CPU topology data structures (bitmasks, per-CPU arrays) to include this CPU.

**`ops.cpu_offline(cpu)`**: Called when a CPU is being taken offline. The BPF scheduler must:
1. Stop dispatching tasks to this CPU.
2. Drain any tasks in this CPU's local DSQ — `scx_bpf_consume()` must not be called for an
   offline CPU after this callback returns.
3. Free any per-CPU BPF state associated with this CPU.

**Ordering with cpu_release**: `ops.cpu_offline()` is always preceded by `ops.cpu_release()`
(the CPU is taken from SCX before it is removed from the system). A well-written BPF scheduler
uses `cpu_release()` to stop new dispatches and `cpu_offline()` to perform final cleanup.

**Implementation challenges**: CPU hotplug callbacks in the kernel follow a strict ordering
protocol (CPUHP states). sched_ext registers its own hotplug state (`CPUHP_AP_SCX_ONLINE`) at
a specific point in the hotplug sequence, ensuring that `ops.cpu_online/offline` are called at
the right time relative to other subsystem hotplug handlers. Reviewing future changes to the
hotplug registration point requires understanding the CPUHP state ordering.

### PATCH 26 — PM Event Bypass

When the system enters suspend, `pm_notifier` callbacks fire. At this point:
- Interrupts may be disabled or in an unusual state.
- The PM code holds PM-specific locks.
- Normal task scheduling is supposed to be quiescent.

If a BPF scheduler receives an `ops.enqueue()` or `ops.dispatch()` call during PM transitions,
it may access BPF maps that are locked (because another CPU is in the BPF runtime), call
`scx_bpf_kick_cpu()` that sends IPIs to CPUs that are in the process of being halted, or
allocate memory in a context where allocation is forbidden.

Patch 26 implements a bypass mode triggered by PM notifiers:

- On `PM_SUSPEND_PREPARE` (system is about to suspend), `scx_pm_handler()` sets
  `scx_ops_bypassing()` to true.
- While bypassing, `enqueue_task_scx()` and `ops.dispatch()` skip the BPF callbacks entirely
  and fall back to CFS-like behavior: tasks are dispatched directly to the global DSQ in FIFO
  order, and the global DSQ is served by the idle CPU selection logic.
- On `PM_POST_SUSPEND` (system has resumed), bypass mode is cleared.

The bypass mechanism is the same one used during `scx_ops_disable_workfn()` (the error exit
path). This reuse is intentional: both situations require "safe scheduling without BPF", and
consolidating them in one bypass path reduces the number of special cases in the enqueue/dispatch
hot paths.

**Why not just call scx_ops_disable() on suspend?** Disabling the BPF scheduler on every
suspend/resume cycle would force the user to reload the BPF scheduler after every resume, which
is expensive and inconvenient. Bypass mode preserves the scheduler's registration and BPF
state, allowing it to resume operation immediately after the system wakes up.

### PATCH 27 — Core Scheduling Integration

Linux's core scheduling (CONFIG_SCHED_CORE) ensures that when SMT siblings run tasks, those
tasks have the same "core tag" (indicating they trust each other). Without SCX integration:

1. A BPF scheduler could dispatch an untrusted task to a CPU whose SMT sibling is running a
   sensitive task.
2. The microarchitectural side-channel isolation provided by core scheduling would be violated.

Patch 27 integrates sched_ext with the core scheduling framework:

**`sched_core_pick()`**: When the kernel selects the next task for a CPU that has SMT siblings,
it calls `sched_core_pick()` to verify that the chosen task has a compatible core tag with the
task running on sibling threads. For sched_ext, this means verifying that the task the BPF
scheduler wants to run is core-tag compatible.

**`scx_pick_task_cookie()`**: A sched_ext-specific function that the core scheduling framework
calls to get the core tag ("cookie" in core scheduling terminology) of the task at the head of
a CPU's local DSQ. This allows the core scheduler to evaluate compatibility before committing
to running the task.

**BPF program implications**: A BPF scheduler that does not set core tags on tasks will behave
as if all tasks have the same core tag (the default tag 0), which means they are all considered
compatible. This is correct for environments where core scheduling is not needed. For
environments that require core scheduling for security, the BPF scheduler must use
`sched_core_put_cookie()`/`sched_core_get_cookie()` BPF helpers (added alongside this patch)
to manage task core tags.

**Lock ordering**: Core scheduling uses its own locks (`sched_core_lock`) that nest under the
runqueue lock. The sched_ext integration must respect this nesting. Any future change to how
sched_ext interacts with `sched_core_pick()` must verify the lock ordering.

### PATCH 28 — DSQ Virtual Time Ordering

Patch 28 adds `scx_bpf_dispatch_vtime(p, dsq_id, vtime, slice, enq_flags)`, a variant of
`scx_bpf_dispatch()` that associates a virtual time key with the dispatch. Within a DSQ, tasks
are ordered by virtual time: tasks with lower vtime values are dispatched first.

**Virtual time semantics**: `vtime` is a `u64` value. The BPF scheduler is responsible for
computing meaningful vtime values. A common pattern (implementing weighted fair scheduling):

```
new_vtime = current_vtime + (time_slice / task_weight)
```

Where `task_weight` is proportional to the task's nice value or cgroup weight. High-weight tasks
advance their vtime slowly (they are always near the front of the queue); low-weight tasks
advance it quickly (they are pushed toward the back).

**`scx_bpf_now()`**: Also added in this patch, this helper returns the current monotonic time
as a `u64`, giving BPF programs a time source for vtime calculations without requiring a
full `ktime_get()` call.

**DSQ ordering invariant**: Within a single DSQ, a BPF program must use either all-FIFO
dispatches or all-vtime dispatches — mixing them is undefined behavior. The kernel enforces
this by checking whether the DSQ has existing FIFO entries when a vtime dispatch arrives and
vice versa. Violating this invariant triggers `scx_ops_error()`.

**Relationship to CFS vruntime**: CFS's `vruntime` and sched_ext's DSQ vtime are conceptually
similar but technically independent. CFS's vruntime is managed by the kernel; DSQ vtime is
managed entirely by the BPF program. The BPF program can use `scx_bpf_task_cgroup_weight()` to
get a task's CFS-compatible weight for computing vtime values that match CFS's fairness model.

**Per-DSQ vtime tracking**: Each DSQ has a `min_vtime` field that tracks the minimum vtime
of any task in the DSQ. This allows BPF programs to initialize new tasks' vtimes to `min_vtime`
(preventing new tasks from immediately jumping to the front of the queue with vtime = 0).
`scx_bpf_dsq_vtime_anchor(dsq_id)` returns the current `min_vtime` for a DSQ.

## Connections Between Patches

```
PATCH 24 (cpu_acquire/release)
    └─→ Interacts with PATCH 25: acquire/release happen around online/offline transitions
    └─→ Calls must respect PATCH 17's IPI mechanism (notifying CPUs of state change)

PATCH 25 (cpu_online/offline)
    └─→ Pairs with PATCH 24: offline always preceded by release
    └─→ Interacts with PATCH 21 (tickless): offline CPUs don't participate in tick logic

PATCH 26 (PM bypass)
    └─→ Reuses the bypass mechanism from PATCH 09's scx_ops_disable path
    └─→ Interacts with PATCH 22 (in_op_task): in-flight operations must complete before
        bypass mode activates

PATCH 27 (core scheduling)
    └─→ Affects PATCH 09's pick_next_task_scx(): adds core tag compatibility check
    └─→ Interacts with PATCH 24: core scheduling constraints apply on acquired CPUs too

PATCH 28 (vtime DSQ)
    └─→ Extends PATCH 09's DSQ implementation with a new ordering mode
    └─→ Interacts with PATCH 20 (ops.running): vtime accounting typically happens in
        ops.running/stopping to update the task's vtime key
```

## What to Focus On

**For a maintainer**, the critical lessons from this group:

1. **CPU hotplug ordering and CPUHP states.** The `ops.cpu_online/offline` callbacks are
   registered at a specific CPUHP state. The exact state matters: if registered too early, the
   CPU's per-CPU data structures may not be initialized; too late, and the CPU may start
   running tasks before the BPF scheduler knows about it. When reviewing changes to the hotplug
   registration point, verify against the full CPUHP state list and the ordering requirements
   of other subsystems that sched_ext depends on.

2. **Bypass mode as a safety invariant.** Bypass mode (patch 26) is the mechanism by which
   sched_ext guarantees safe operation during system transitions. It is used in three places:
   PM suspend, `scx_ops_disable_workfn()`, and brief transition periods during
   `scx_ops_enable()`. When reviewing changes to any of these three paths, verify that bypass
   mode is entered before BPF callbacks become unsafe and exited only after they become safe
   again.

3. **Core scheduling and the cookie model.** Core scheduling in sched_ext uses the same cookie
   model as CFS (same `struct sched_core_cookie`). A BPF scheduler does not need to understand
   the details of core scheduling to be correct — it just needs to not prevent the kernel from
   performing the compatibility check. The risk is in changes to `scx_pick_task_cookie()` or
   the DSQ iteration code that might inadvertently skip the compatibility check for some tasks.

4. **vtime overflow.** DSQ vtime is a `u64`. BPF programs that compute vtime as
   `accumulated_runtime / weight` will eventually overflow if the BPF scheduler runs long
   enough. The conventional approach is to use relative vtime (difference from `min_vtime`
   rather than absolute elapsed time) and to periodically reset the anchor. When reviewing BPF
   schedulers that use vtime DSQs, check for overflow handling.

5. **The acquire/release and online/offline orthogonality.** `cpu_acquire/release` and
   `cpu_online/offline` are conceptually distinct and should not be confused. A CPU can be
   online but released (CFS has taken it back). A CPU can be offline (not available at all).
   BPF programs must track both states independently. When reviewing the sched_ext hotplug and
   CPU state code, verify that the four combinations (online+acquired, online+released,
   offline+acquired-during-transition, offline) are all handled correctly.
