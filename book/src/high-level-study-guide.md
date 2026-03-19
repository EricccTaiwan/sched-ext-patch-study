# sched_ext Patch Series: High-Level Study Guide

This guide is written to stand alone. Reading only this document should give you a solid
understanding of what sched_ext is, how it works, and why it was built the way it was.

---

## What sched_ext Is

`sched_ext` is a Linux scheduler class where scheduling **policy lives in a BPF program**
instead of the kernel. It was merged into Linux 6.11.

Traditional Linux schedulers (CFS, RT, Deadline) are static policies compiled into the kernel.
Changing scheduling behavior means modifying kernel source, recompiling, and rebooting. For
datacenter operators and researchers who need to tune scheduling for specific workloads
(ML training jobs, game servers, low-latency services), this iteration cycle is too slow.

`sched_ext` solves this by separating:
- **Mechanism (kernel)**: runqueue management, preemption, CPU affinity enforcement, safety checks
- **Policy (BPF)**: which task runs next, on which CPU, for how long

A BPF program can be loaded and unloaded at runtime. If it misbehaves, the kernel detects
it and falls back to CFS automatically — no panic, no reboot.

---

## Where sched_ext Fits in the Scheduler Hierarchy

Linux uses a chain of `struct sched_class` objects. The kernel walks this chain in priority
order: higher-priority classes are checked first. `sched_ext` inserts `ext_sched_class`
between CFS and the idle class:

```
stop_sched_class     highest priority — stop-machine tasks (SMP only)
      │
dl_sched_class       SCHED_DEADLINE — earliest deadline first
      │
rt_sched_class       SCHED_FIFO / SCHED_RR — real-time tasks
      │
fair_sched_class     SCHED_NORMAL / SCHED_BATCH — CFS (the common case)
      │
ext_sched_class      SCHED_EXT — BPF-controlled          ← sched_ext
      │
idle_sched_class     lowest priority — per-CPU idle thread
```

A task uses `ext_sched_class` only if:
1. Its scheduling policy is `SCHED_EXT` (set via `sched_setscheduler(2)`), **and**
2. A BPF scheduler is currently loaded.

If no BPF scheduler is loaded, `SCHED_EXT` tasks automatically fall back to CFS. RT and
Deadline tasks are never handled by sched_ext — they always outrank it.

---

## The BPF Interface: struct sched_ext_ops

The BPF program fills in a `struct sched_ext_ops` — a vtable of callbacks. The kernel calls
these callbacks at the right points in the scheduling lifecycle. Only `.name` is mandatory;
everything else has a sensible default.

```c
struct sched_ext_ops {
    char name[SCX_OPS_NAME_LEN];    /* required: identifies this scheduler */

    /* --- CPU selection --- */

    /* Pick which CPU should run task p. Return -1 to let kernel decide.
     * Called when p wakes up. Can dispatch directly here (fast path). */
    s32  (*select_cpu)(struct task_struct *p, s32 prev_cpu, u64 wake_flags);

    /* --- Task placement --- */

    /* p became runnable. BPF must call scx_bpf_dispatch() to place it in a DSQ. */
    void (*enqueue)(struct task_struct *p, u64 enq_flags);

    /* p is being removed (class change, migration). Remove from BPF data structures. */
    void (*dequeue)(struct task_struct *p, u64 deq_flags);

    /* CPU needs a task. BPF calls scx_bpf_consume() to move tasks from custom
     * DSQs into this CPU's local DSQ. */
    void (*dispatch)(s32 cpu, struct task_struct *prev);

    /* --- Task state change notifications --- */

    void (*runnable) (struct task_struct *p, u64 enq_flags);  /* p became runnable */
    void (*quiescent)(struct task_struct *p, u64 deq_flags);  /* p blocked/exited */
    void (*running)  (struct task_struct *p);                  /* p started on CPU */
    void (*stopping) (struct task_struct *p, bool runnable);   /* p leaving CPU */

    /* --- Task lifecycle --- */

    /* Called when p first joins SCHED_EXT. Allocate per-task BPF state here.
     * Return error to reject the task (it stays on CFS). */
    s32  (*init_task)(struct task_struct *p, struct scx_init_task_args *args);
    void (*exit_task)(struct task_struct *p, struct scx_exit_task_args *args);
    void (*enable)   (struct task_struct *p);   /* p is now managed by this scheduler */
    void (*disable)  (struct task_struct *p);   /* p is leaving this scheduler */

    /* --- CPU lifecycle --- */

    void (*cpu_online) (s32 cpu);                                  /* CPU hotplugged in */
    void (*cpu_offline)(s32 cpu);                                  /* CPU hotplugged out */
    void (*cpu_acquire)(s32 cpu, struct scx_cpu_acquire_args *a);  /* CPU now exclusively ours */
    void (*cpu_release)(s32 cpu, struct scx_cpu_release_args *a);  /* CPU taken by CFS/RT */

    /* --- Scheduler lifecycle --- */

    s32  (*init)(void);                       /* BPF scheduler loaded */
    void (*exit)(struct scx_exit_info *ei);   /* BPF scheduler unloading */

    /* --- Control knobs --- */

    u64  flags;           /* SCX_OPS_* flags */
    u32  timeout_ms;      /* watchdog timeout; 0 = default (30s) */
    u32  exit_dump_len;   /* bytes of BPF debug ring to print on exit */
};
```

### The three most important callbacks

**`ops.enqueue(p, flags)`** — the scheduling decision.
This is called every time a task becomes runnable (wakeup, fork, preemption). The BPF program
decides where to put the task by calling `scx_bpf_dispatch(p, dsq_id, slice, flags)`. If your
scheduler only implements this one callback, it already has a complete (FIFO) policy.

**`ops.dispatch(cpu, prev)`** — feeding CPUs.
Called when a CPU is idle and needs a task. The BPF program calls `scx_bpf_consume(dsq_id)`
to pull the next task from a custom DSQ into this CPU's local queue. If you only use the
global DSQ (`SCX_DSQ_GLOBAL`), you don't need to implement this — the kernel drains it
automatically.

**`ops.select_cpu(p, prev_cpu, flags)`** — CPU affinity.
Called when a task wakes up. Returning a valid CPU triggers a "direct dispatch" optimization:
if that CPU's local queue is empty, the task is dispatched there immediately, skipping
`ops.enqueue` entirely. This is a critical performance path for latency-sensitive workloads.

---

## Dispatch Queues (DSQs): The Core Abstraction

A **Dispatch Queue (DSQ)** is a queue of tasks waiting to be scheduled. This is the central
abstraction in sched_ext. There are three kinds:

### 1. Global DSQ — SCX_DSQ_GLOBAL (id = 0)

A single FIFO queue shared across all CPUs. Any idle CPU can pull from it. This is the
simplest possible dispatch model:

```
BPF: scx_bpf_dispatch(p, SCX_DSQ_GLOBAL, SCX_SLICE_DFL, 0)
     → task sits in global FIFO
     → any idle CPU dequeues it and runs it
```

A scheduler that only calls `scx_bpf_dispatch(p, SCX_DSQ_GLOBAL, ...)` in `ops.enqueue` is
functionally a global FIFO scheduler with zero BPF complexity.

### 2. Per-CPU Local DSQs — SCX_DSQ_LOCAL (id = 1)

Each CPU has its own local queue. A CPU only runs tasks from its own local DSQ. This is how
per-CPU affinity works: dispatch to a specific CPU's local DSQ and that CPU will run it.

```
BPF: scx_bpf_dispatch(p, SCX_DSQ_LOCAL, SCX_SLICE_DFL, 0)
     → task goes to this CPU's local DSQ
     → only this CPU will run it
```

To dispatch to a *specific* CPU's local DSQ from `ops.dispatch`:
```c
scx_bpf_dispatch(p, SCX_DSQ_LOCAL_ON | target_cpu, slice, flags);
```

### 3. Custom DSQs — BPF-defined

BPF programs can create any number of DSQs:
```c
scx_bpf_create_dsq(my_dsq_id, NUMA_node);   /* in ops.init() */
scx_bpf_destroy_dsq(my_dsq_id);             /* in ops.exit() */
```

Custom DSQs hold tasks until `ops.dispatch()` consumes them:
```c
/* in ops.dispatch(): move tasks from my_dsq into this CPU's local queue */
scx_bpf_consume(my_dsq_id);
```

Custom DSQs can be FIFO (insertion order) or **vtime-ordered** (sorted by virtual time for
weighted fair scheduling).

### Task flow through DSQs

```
Task wakes up
    │
    ▼
ops.select_cpu(p)          ← BPF picks CPU; can direct-dispatch here
    │
    ▼ (if no direct dispatch)
ops.enqueue(p)             ← BPF calls scx_bpf_dispatch(p, dsq_id, slice, flags)
    │
    ▼
[Task sits in DSQ]
    │
    ▼ (when CPU needs work)
ops.dispatch(cpu)          ← BPF calls scx_bpf_consume(dsq_id) to move task
    │                         from custom DSQ → CPU's local DSQ
    ▼
[Task in local DSQ]
    │
    ▼
CPU picks task             ← kernel: pick_next_task_scx()
    │
    ▼
ops.running(p)             ← task is executing
    │
    ▼
Time slice expires / preempted
    │
    ▼
ops.stopping(p)            ← task leaving CPU
    │
    ├─ still runnable? → ops.enqueue(p) again
    └─ blocked?        → ops.quiescent(p)
```

---

## A Complete Minimal BPF Scheduler

This is a fully working sched_ext scheduler. It puts every task in the global FIFO queue.

```c
/* minimal.bpf.c */
#include <scx/common.bpf.h>

/* Every task → global FIFO queue → any idle CPU runs it. */
void BPF_STRUCT_OPS(minimal_enqueue, struct task_struct *p, u64 enq_flags)
{
    scx_bpf_dispatch(p, SCX_DSQ_GLOBAL, SCX_SLICE_DFL, enq_flags);
}

/* No ops.dispatch() needed: kernel drains SCX_DSQ_GLOBAL automatically. */

SEC(".struct_ops.link")
struct sched_ext_ops minimal_ops = {
    .enqueue = (void *)minimal_enqueue,
    .name    = "minimal",
};
```

```c
/* minimal.c — userspace loader */
#include "minimal.skel.h"   /* auto-generated by bpftool */

int main(void)
{
    struct minimal *skel = minimal__open_and_load();
    minimal__attach(skel);   /* BPF scheduler is now active */
    pause();                  /* run until killed */
    minimal__destroy(skel);
    return 0;
}
```

Once `minimal__attach()` returns, all tasks with `SCHED_EXT` policy are scheduled by this
BPF program. When the process exits, the BPF scheduler is unloaded and all tasks return to CFS.

---

## Per-Task State: struct scx_entity

Every `task_struct` has a `struct scx_entity` embedded at `task_struct.scx`. This is
sched_ext's per-task tracking state:

```
struct scx_entity {
    struct scx_dispatch_q *dsq;        which DSQ this task is currently in
    u64                    dsq_vtime;  virtual time (for vtime-ordered DSQs)
    u64                    slice;      remaining time slice in nanoseconds
    u32                    flags;      SCX_TASK_* status flags
    ...
}
```

Key flags:
- `SCX_TASK_QUEUED` — task is sitting in a DSQ
- `SCX_TASK_RUNNABLE` — task is runnable (may not be in a DSQ yet if ops.enqueue hasn't run)
- `SCX_TASK_DISALLOW` — BPF scheduler rejected this task; it runs on CFS instead

BPF programs access `scx_entity` via `p->scx` in BPF code using CO-RE (BPF Compile Once,
Run Everywhere) field access.

---

## Safety: Three Layers of Protection

sched_ext is designed so that a buggy BPF scheduler cannot crash the kernel or starve tasks
permanently. There are three complementary escape hatches:

### Layer 1: BPF Verifier (load-time)

Before a BPF scheduler is allowed to run, the kernel's BPF verifier checks it for:
- Memory safety (no out-of-bounds access)
- No infinite loops
- Correct use of BPF helpers (only `scx_bpf_*` helpers allowed from scheduler context)

A scheduler that fails verification never runs.

### Layer 2: Watchdog Timer (runtime)

A kernel timer fires every `timeout_ms / 2` (default: every 15 seconds). On each fire, it
checks: **is any SCHED_EXT task runnable but hasn't run in `timeout_ms`?**

If yes → the BPF scheduler is killed and all tasks return to CFS.

This catches the common failure mode: BPF scheduler has a bug and stops dispatching some
tasks, causing them to starve indefinitely.

### Layer 3: sysrq-S (manual override)

Pressing **Alt+SysRq+S** at the console calls `scx_ops_disable()` immediately. This is the
human-accessible escape hatch: if the BPF scheduler causes the system to become unresponsive
(UI frozen, shell not responding), a user at the physical console can recover without a reboot.

### The disable path (triggered by any of the above)

When any escape hatch fires:
1. **Bypass mode activated** — all new scheduling bypasses BPF, falls back to CFS-like dispatch
2. **DSQs drained** — all tasks in sched_ext DSQs are moved to CFS runqueues
3. **`ops.exit(exit_info)` called** — BPF program gets a chance to log its final state
4. **BPF program unloaded** — `ext_sched_class` continues to exist but has no BPF ops
5. **System continues normally on CFS** — zero data loss, no panic

The exit reason (`SCX_EXIT_SYSRQ`, `SCX_EXIT_ERROR_STALL`, `SCX_EXIT_ERROR`, etc.) is
recorded and readable from debugfs.

---

## A More Complex Example: Priority Queue Scheduler

This shows how `ops.enqueue` and `ops.dispatch` work together for multi-queue scheduling:

```c
#define NUM_QUEUES 5

s32 BPF_STRUCT_OPS(prio_init)
{
    for (int i = 0; i < NUM_QUEUES; i++)
        scx_bpf_create_dsq(i, -1);   /* create 5 DSQs, NUMA-local */
    return 0;
}

void BPF_STRUCT_OPS(prio_enqueue, struct task_struct *p, u64 enq_flags)
{
    /* map nice value (-20..19) to queue 0 (highest) .. 4 (lowest) */
    u32 q = (p->static_prio - MAX_RT_PRIO) / 8;
    q = q > 4 ? 4 : q;
    scx_bpf_dispatch(p, q, SCX_SLICE_DFL, enq_flags);
}

void BPF_STRUCT_OPS(prio_dispatch, s32 cpu, struct task_struct *prev)
{
    /* always serve highest-priority non-empty queue */
    for (int i = 0; i < NUM_QUEUES; i++)
        if (scx_bpf_consume(i))
            return;
}

void BPF_STRUCT_OPS(prio_exit, struct scx_exit_info *ei)
{
    for (int i = 0; i < NUM_QUEUES; i++)
        scx_bpf_destroy_dsq(i);
}
```

**Step-by-step when a task wakes up:**
1. `ops.enqueue(p)` is called on the CPU where p woke up
2. BPF checks `p->static_prio`, maps to queue 0-4, calls `scx_bpf_dispatch(p, q, ...)`
3. Task sits in DSQ `q`
4. When a CPU goes idle, kernel calls `ops.dispatch(cpu, NULL)`
5. BPF iterates queues 0→4, calls `scx_bpf_consume(0)` — if queue 0 has a task, it moves
   to this CPU's local DSQ and `ops.dispatch` returns
6. Kernel picks task from local DSQ and runs it

---

## Weighted Fair Scheduling with Virtual Time

For weighted fairness (high-priority tasks get proportionally more CPU), use vtime DSQs:

```c
void BPF_STRUCT_OPS(wfq_enqueue, struct task_struct *p, u64 enq_flags)
{
    u64 vtime = p->scx.dsq_vtime;
    u32 weight = p->scx.weight;      /* 1..10000; default 100; higher = more CPU */

    /* Advance vtime inversely proportional to weight.
     * Heavy tasks (high weight) advance slowly → stay near queue front → run more.
     * Light tasks (low weight) advance quickly → pushed toward back → run less. */
    vtime += SCX_SLICE_DFL / weight;

    scx_bpf_dispatch_vtime(p, SCX_DSQ_GLOBAL, SCX_SLICE_DFL, vtime, enq_flags);
}
```

The DSQ sorts tasks by vtime. The CPU always picks the task with the smallest vtime.
For new tasks, initialize `p->scx.dsq_vtime` to the DSQ's current minimum vtime
(`scx_bpf_dsq_vtime_anchor()`) so they don't jump to the front with vtime = 0.

---

## CPU Coordination: The Central Scheduler Pattern

For policies requiring global visibility across all CPUs, sched_ext supports a "central
scheduler" pattern where one CPU makes all dispatch decisions:

```
ops.select_cpu()    → always route enqueue through CPU 0 (the central CPU)
ops.enqueue()       → place task in per-CPU target queues (runs on central CPU)
ops.dispatch()      → central CPU dispatches to remote CPU local queues;
                      worker CPUs return without dispatching (they wait for work)
scx_bpf_kick_cpu()  → central CPU kicks worker CPUs to wake them up
```

This enables: topology-aware scheduling, NUMA-optimal placement, global fairness policies.

`scx_bpf_kick_cpu(cpu, SCX_KICK_IDLE)` wakes an idle CPU.
`scx_bpf_kick_cpu(cpu, SCX_KICK_PREEMPT)` preempts a running task on that CPU.
`scx_bpf_kick_cpu(cpu, SCX_KICK_WAIT)` waits until that CPU completes one schedule round.

---

## The Patch Series in One View

The 30 patches build sched_ext in layers. Each layer depends on the previous:

```
LAYER 1: Foundations (Patches 01-07)
  Remove hardcoded assumptions about the scheduler class set.
  Add hooks the ext class will need (reweight_task, switching_to).
  Factor out shared utilities (cgroup weights, PELT).
  ↓
LAYER 2: Core (Patches 08-12)
  08: Create file skeleton and register ext_sched_class
  09: Implement the full BPF scheduler (~4000 lines):
      - sched_ext_ops dispatch/enqueue machinery
      - DSQ implementation (global, local, custom)
      - scx_bpf_* helpers
      - Error exit path
  10: Example schedulers (scx_simple, scx_qmap)
  11: sysrq-S emergency escape
  12: Watchdog timer
  ↓
LAYER 3: Observability (Patches 13-16, 18)
  Per-task disallow flag, stack dump integration, debug ring,
  scx_show_state.py, central scheduler example.
  ↓
LAYER 4: CPU Control (Patches 17, 19)
  scx_bpf_kick_cpu(), preemption support.
  Watchdog extended to dispatch() loops.
  ↓
LAYER 5: Task Lifecycle (Patches 20-23)
  Fine-grained state callbacks (runnable/running/stopping/quiescent).
  Tickless support. In-flight operation tracking. SCX_KICK_WAIT.
  ↓
LAYER 6: System Integration (Patches 24-28)
  CPU hotplug (cpu_online/offline, cpu_acquire/release).
  PM event bypass. Core scheduling (SMT security).
  Vtime-ordered DSQs.
  ↓
LAYER 7: Documentation and Tests (Patches 29-30)
  Documentation/scheduler/sched-ext.rst.
  tools/testing/selftests/sched_ext/.
```

---

## Key Data Structures at a Glance

| Structure | Where | Purpose |
|-----------|-------|---------|
| `struct sched_ext_ops` | BPF program | The vtable BPF fills in; kernel calls these |
| `struct scx_entity` | `task_struct.scx` | Per-task sched_ext state (DSQ, slice, flags) |
| `struct scx_dispatch_q` | `kernel/sched/ext.c` | A DSQ — holds tasks waiting to be run |
| `ext_sched_class` | `kernel/sched/ext.c` | The `sched_class` implementation that calls ops |
| `struct rq.scx` | per-CPU runqueue | Per-CPU sched_ext state (local DSQ, stats) |

## Key BPF Helpers at a Glance

| Helper | When to call | What it does |
|--------|-------------|--------------|
| `scx_bpf_dispatch(p, dsq, slice, flags)` | `ops.enqueue()` | Move task to a DSQ |
| `scx_bpf_dispatch_vtime(p, dsq, slice, vtime, flags)` | `ops.enqueue()` | Move task to vtime DSQ |
| `scx_bpf_consume(dsq_id)` | `ops.dispatch()` | Move task from DSQ → local queue |
| `scx_bpf_kick_cpu(cpu, flags)` | Anywhere | Force CPU to reschedule |
| `scx_bpf_create_dsq(id, node)` | `ops.init()` | Create a custom DSQ |
| `scx_bpf_destroy_dsq(id)` | `ops.exit()` | Destroy a custom DSQ |
| `scx_bpf_task_running(p)` | Anywhere | Is task currently executing? |
| `scx_bpf_exit(code, fmt, ...)` | Anywhere | Voluntarily unload scheduler |

---

## Operating Model: Safety by Design

`sched_ext` is designed for controlled extensibility rather than unrestricted scheduler
replacement. The key design principle: **the kernel is always in control of safety; the BPF
program is only in control of policy.**

- The BPF verifier enforces memory safety at load time
- The watchdog enforces forward progress at runtime
- Bypass mode ensures the system can always recover
- The disable path is atomic: all tasks atomically return to CFS

This means a BPF scheduler bug produces a warning and a CFS fallback, never a kernel panic.

---

## What to Read Next

| Goal | Start here |
|------|-----------|
| Understand the full API in depth | [`sched-ext-explainer.md`](../sched-ext-explainer.md) |
| Write a BPF scheduler | [`sched-ext-explainer.md`](../sched-ext-explainer.md) + patch 29 (docs) |
| Understand the core implementation | `patch-study/patch-30.md` (PATCH 09/30) |
| Understand the file structure | `patch-study/patch-09.md` (PATCH 08/30 boilerplate) |
| Debug a running sched_ext scheduler | `patch-study/patch-12.md` through `patch-study/patch-18.md` |
| Understand system integration | `patch-study/patch-24.md` through `patch-study/patch-28.md` |

---

## References

- Kernel tree: https://git.kernel.org/pub/scm/linux/kernel/git/tj/sched_ext.git
- Example schedulers and tooling: https://github.com/sched-ext/scx
- Community workspace: https://bit.ly/scx_slack

## Metadata

- Patch series: v7 (June 2024)
- Merged into: Linux 6.11
