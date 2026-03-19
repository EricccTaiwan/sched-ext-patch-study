# Debugging and Monitoring (Patches 13–16, 18)

## Overview

A scheduler that can be loaded as a BPF program is only as useful as the operator's ability to
observe it. When a BPF scheduler misbehaves — starving tasks, consuming too much CPU, entering
an error state — the operator needs tools to diagnose the problem and recover. This group of
five patches builds the observability and diagnostic infrastructure around the sched_ext core.

Patches 13–16 are directly about visibility: who can use the ext class, what state is printed
when the scheduler is examined, how debug output is captured at error time, and how to inspect
the live system from userspace. Patch 18 is the `scx_central` example scheduler, which belongs
here rather than with the core examples (patch 10) because its primary contribution is
demonstrating a multi-CPU coordination pattern that has important implications for how operators
think about centralized scheduling and its failure modes.

## Why These Patches Are Needed

The core sched_ext implementation (patch 09) is designed for correctness and performance. It
correctly handles the BPF scheduler lifecycle, dispatches tasks, and exits gracefully on error.
But it is essentially a black box from an operator's perspective:

- How do you know which tasks are using the ext class and which are not?
- When the system appears to slow down, how do you know whether the BPF scheduler is responsible?
- When the BPF scheduler exits with an error, what was it doing at the time?
- How do you verify the scheduler is actually registered and processing tasks?

Without answers to these questions, sched_ext would be difficult to operate safely in production.
These patches provide those answers at four different levels of granularity:
per-task policy control, system-level state dumps, error-time debug capture, and live monitoring.

## Key Concepts

### PATCH 13 — Per-Task Disallow Flag (SCX_TASK_DISALLOW)

Not all tasks should use a BPF scheduler. Real-time tasks (`SCHED_FIFO`, `SCHED_RR`) and
deadline tasks (`SCHED_DEADLINE`) never use sched_ext — they use their own higher-priority
classes. But among `SCHED_EXT` tasks, there may be specific tasks that the operator or BPF
program wants to keep on CFS even when the ext class is loaded.

Patch 13 introduces `SCX_TASK_DISALLOW`, a flag in `scx_entity.flags`. When set:
- `enqueue_task_scx()` does not call `ops.enqueue()`.
- The task is forwarded to `fair_sched_class.enqueue_task()` instead.
- The task runs on CFS as if sched_ext were not loaded.

The flag can be set by the BPF program from within `ops.enable()` — this is how a BPF
scheduler can "opt out" specific tasks (e.g., watchdog threads, init, specific system daemons)
from BPF management.

This is architecturally significant: it means a BPF scheduler does not need to handle
every `SCHED_EXT` task. A BPF scheduler can focus on a specific workload class (e.g., only
latency-sensitive application threads) while leaving infrastructure threads on CFS.

From a maintainer perspective, `SCX_TASK_DISALLOW` establishes the principle that the ext class
is not an all-or-nothing switch. This has implications for every subsequent patch that adds
per-task state or transitions — each must correctly handle the disallowed case. In particular,
when the BPF scheduler is disabled and all tasks must return to CFS, disallowed tasks are already
on CFS and must not be double-migrated.

### PATCH 14 — scx_dump_state() in sysrq-T / show_state()

Linux's `show_state()` function (triggered by `Alt+SysRq+T` or writing to `/proc/sysrq-trigger`)
dumps the state of all runnable tasks to the kernel log. This is the traditional first tool
for diagnosing scheduler problems or deadlocks.

Patch 14 adds `scx_dump_state()`, called from `show_state()` when `CONFIG_SCHED_CLASS_EXT` is
enabled. The output includes:

- The name of the currently loaded BPF scheduler (`ops.name`).
- The global DSQ depth (number of tasks waiting in `SCX_DSQ_GLOBAL`).
- Per-CPU local DSQ depths.
- Total number of runnable SCX tasks.
- Error state and reason if the scheduler has exited.

This information is prepended to the existing per-task state dump, giving operators an immediate
summary of the ext class state before they read through individual task entries.

The implementation hooks into `kernel/sched/core.c`'s `show_state_filter()`. The key challenge
is lock ordering: `scx_dump_state()` must not acquire any lock that `show_state()` might
already hold while iterating over tasks. The patch uses RCU and lock-free reads where possible,
falling back to trylock semantics for fields that require the runqueue lock. This lock-order
discipline is a recurring concern in scheduler observability code and is worth studying carefully.

### PATCH 15 — ops.exit_dump_len and the Debug Ring Buffer

When a BPF scheduler exits with an error, the most valuable diagnostic information is often
available only inside the BPF program — the state of BPF maps, the task that was being processed,
the DSQ the program was trying to dispatch to. The kernel's own error message (e.g., "invalid
DSQ ID") tells you what went wrong but not why the BPF program thought it was valid.

Patch 15 adds a debug dump mechanism:

- `sched_ext_ops.exit_dump_len` — BPF programs set this to the number of bytes they want to
  allocate for debug output. Set to 0 to disable.
- A ring buffer of that size is allocated when the BPF scheduler is enabled.
- The BPF program can write to this ring buffer at any time via `bpf_printk()`-style helpers
  that target the SCX debug buffer.
- When `scx_ops_error()` is called, the kernel prints the last `exit_dump_len` bytes of the
  ring buffer to the kernel log before completing the disable sequence.

The ring buffer is a fixed-size circular buffer: if the BPF program writes more than
`exit_dump_len` bytes, older entries are overwritten. This means the output always contains
the most recent diagnostic information — exactly what is needed for debugging the final
moments before an error.

From a design perspective, this patch demonstrates a general principle for BPF observability:
the kernel provides a fixed-size storage mechanism and a commit point (the error exit), and the
BPF program is responsible for writing meaningful content. The kernel never interprets the
content — it just captures and prints it verbatim.

The ring buffer is allocated during `scx_ops_enable()` and freed during
`scx_ops_disable_workfn()`. Allocation is at enable time, not error time, because at error time
the system may be under memory pressure — possibly the very cause of the error. This is a
recurring pattern in kernel error reporting infrastructure.

### PATCH 16 — scx_show_state.py

While patches 14 and 15 provide kernel-level output (triggered by specific events), patch 16
provides a userspace tool for live, on-demand monitoring: `tools/sched_ext/scx_show_state.py`.

The script reads from `/sys/kernel/debug/sched/ext` (the SCX debugfs directory created by the
core patch) and formats the output for human consumption:

- Whether an SCX scheduler is currently loaded.
- The scheduler's name and when it was loaded.
- Per-CPU statistics: dispatches per second, local DSQ depth, idle time.
- Global DSQ statistics.
- Error state and reason if the scheduler has exited.

The script is intentionally simple — it is a reference implementation, not a production
monitoring tool. Its value is documenting which debugfs files expose which information,
making it straightforward for operators to integrate SCX monitoring into their own tooling
(Prometheus exporters, grafana dashboards, systemd watchdog scripts).

For a maintainer, this script is important because it documents the debugfs interface contract.
When reviewing changes to the debugfs output format, check whether `scx_show_state.py` would
need to be updated and whether the change preserves backward compatibility for existing scripts.
The kernel's official stance is that debugfs interfaces are not stable, but sched_ext's debugfs
interface is explicitly documented by the Python script, creating a de facto stability expectation.

### PATCH 18 — scx_central: Centralized Dispatch Pattern

`scx_central` is the third example BPF scheduler. Its architecture is fundamentally different
from `scx_simple` (global FIFO) and `scx_example_qmap` (per-CPU priority queues):

- One designated "central" CPU is responsible for all scheduling decisions.
- When `ops.dispatch(cpu, prev)` is called on any non-central CPU, it does nothing and returns.
- The central CPU's `ops.dispatch()` iterates over all other CPUs, examines their local DSQ
  depths, and dispatches tasks to fill them using `scx_bpf_dispatch()` with
  `SCX_DSQ_LOCAL_ON(target_cpu)`.

This pattern is motivated by scheduling algorithms that require global visibility to make
decisions — work-stealing, NUMA-aware placement, gang scheduling. On such algorithms, having
each CPU make independent decisions leads to suboptimal outcomes because no single CPU has the
full picture.

`scx_central` demonstrates several important mechanisms:

**Cross-CPU dispatch**: A BPF program on the central CPU dispatches tasks to other CPUs' local
DSQs. This requires `SCX_DSQ_LOCAL_ON(cpu)` rather than `SCX_DSQ_LOCAL`, and the BPF program
must handle the case where a target CPU's local DSQ is already full (the dispatch call fails
and the task stays in the user DSQ for the next dispatch cycle).

**CPU affinity in dispatch**: When filling another CPU's local DSQ, `scx_central` must respect
the task's CPU affinity mask. `scx_bpf_cpumask_test_cpu()` checks whether the target CPU is
allowed for the task before dispatching.

**Kick idle CPUs**: After filling a CPU's local DSQ, the central scheduler uses
`scx_bpf_kick_cpu(cpu, SCX_KICK_IDLE)` (from patch 17, the cpu-coordination group) to wake the
idle CPU so it actually picks up the dispatched task. Without this, the idle CPU might remain
in the idle loop even though its local DSQ is now non-empty.

**Central CPU overhead and failure mode**: The central CPU is busier than others. If the central
CPU's `ops.dispatch()` does not complete in time, other CPUs' local DSQs drain empty, those
CPUs have no work to run, and the watchdog (patch 12) detects the stall. This is the primary
operational failure mode for the centralized scheduling pattern, and `scx_central` teaches
operators to monitor the central CPU's scheduling latency as a leading indicator.

## Connections Between Patches

```
PATCH 13 (SCX_TASK_DISALLOW)
    └─→ Affects what scx_dump_state() (PATCH 14) counts as an "SCX task"
    └─→ Disallowed tasks don't call ops.enqueue() so they don't write to the debug buffer

PATCH 14 (scx_dump_state)
    └─→ Reads DSQ depth state that PATCH 09 core maintains
    └─→ Reads error state that scx_ops_error() sets
    └─→ Is the kernel-side counterpart to PATCH 16's userspace script

PATCH 15 (exit_dump_len / debug ring buffer)
    └─→ Extends the error exit path from PATCH 09 (scx_ops_error)
    └─→ The ring buffer content is printed before the state PATCH 14 shows

PATCH 16 (scx_show_state.py)
    └─→ Reads debugfs files created by PATCH 09
    └─→ Formats information that PATCH 14 dumps to kernel log
    └─→ References the debug buffer output from PATCH 15

PATCH 18 (scx_central)
    └─→ Requires scx_bpf_kick_cpu() from PATCH 17 (cpu-coordination)
    └─→ Demonstrates the watchdog failure mode (PATCH 12) for centralized scheduling
    └─→ Uses SCX_TASK_DISALLOW (PATCH 13) to keep the central CPU thread on CFS
```

## What to Focus On

**For a maintainer**, the critical lessons from this group:

1. **The disallow flag interaction with class transitions.** `SCX_TASK_DISALLOW` creates a case
   where a task has `SCHED_EXT` policy but runs on `fair_sched_class`. This two-level dispatch
   is a source of subtle bugs in transitions. When reviewing future changes to the class
   transition logic or the disable path, verify explicitly that disallowed tasks are handled
   correctly — they must not be double-migrated back to CFS when the scheduler is disabled,
   and `ops.disable()` must not be called for tasks that never had `ops.enable()` called.

2. **Lock ordering in dump functions.** `scx_dump_state()` operates in a constrained locking
   environment. The pattern — RCU for reading live state, avoid runqueue locks, use trylocks
   with graceful fallback — must be followed in any future dump function added to `ext.c`.
   Violating this will cause deadlocks on `Alt+SysRq+T`, which is exactly the tool operators
   use when the system appears hung.

3. **Fixed-size debug capture vs. dynamic allocation.** The ring buffer in patch 15 is
   fixed-size and allocated at enable time, not at error time. This is correct: at error time,
   the system may be under memory pressure (possibly the cause of the error). Any future
   addition to the error reporting path in `ext.c` should follow this pre-allocation pattern.

4. **debugfs interface as a stability contract.** The `scx_show_state.py` script documents
   the debugfs interface. Once a debugfs file is consumed by external tooling, changing its
   format is a user-visible regression. Future changes to debugfs output must update the Python
   script atomically and should note the format change in the commit message.

5. **Centralized scheduling and the watchdog interaction.** `scx_central` teaches that the
   watchdog timeout must be calibrated against the dispatch latency of the centralized scheduler.
   If the central CPU takes longer than `scx_watchdog_timeout / 2` to process one dispatch
   round, tasks on other CPUs will appear stalled to the watchdog. Future changes to watchdog
   thresholds or dispatch batching must consider this interaction.
