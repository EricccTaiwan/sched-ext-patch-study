# How sched_ext Works

> A comprehensive, self-contained explanation for systems programmers who know Linux and C
> but are new to sched_ext. This document covers the architecture end-to-end, from the
> motivation through BPF scheduler authorship to kernel internals.

---

## The Problem: Why Scheduling Policy Lives in the Kernel

### The Traditional Scheduler Model

The Linux kernel ships with several scheduling classes, each implementing a distinct policy:

- **CFS** (`fair_sched_class`, `SCHED_NORMAL`/`SCHED_BATCH`): Completely Fair Scheduler. Tracks per-task virtual runtime and always picks the task with the smallest `vruntime`. CPU time is distributed proportionally to task weights (derived from `nice` values).
- **RT** (`rt_sched_class`, `SCHED_FIFO`/`SCHED_RR`): Real-time policies. Fixed-priority preemptive scheduling. A SCHED_FIFO task at priority 50 will starve every SCHED_NORMAL task indefinitely.
- **Deadline** (`dl_sched_class`, `SCHED_DEADLINE`): EDF-based. Tasks declare runtime budgets and deadlines; the kernel guarantees they meet them (or rejects the task at admission time).

Each of these classes is compiled into the kernel. Their code lives in:
- `kernel/sched/fair.c` (CFS, ~7000 lines)
- `kernel/sched/rt.c` (RT, ~2500 lines)
- `kernel/sched/deadline.c` (Deadline, ~1600 lines)

### The Pain Points

**1. Long iteration cycles for policy experiments**

If you want to test a new scheduling heuristic — say, a variant of CFS that biases toward tasks sharing cache lines, or a scheduler that tries to keep gaming threads on P-cores — you must:

1. Write a kernel patch
2. Build the kernel (5–30 minutes depending on your machine)
3. Install it in a test environment
4. Reboot the machine
5. Run experiments
6. If the policy was wrong, go back to step 1

A single experiment can take hours. Iterating toward a good policy for a specific workload requires dozens of experiments. This makes kernel scheduling research expensive and slow.

**2. Impossibility of workload-specific tuning at runtime**

Different workloads have radically different scheduling needs:

- A **batch ML training job** wants maximum CPU utilization, does not care about latency, and benefits from large time slices and NUMA-aware placement.
- A **game render thread** needs consistent sub-millisecond scheduling latency and wants to run on specific cores (e.g., the same physical core as its audio thread).
- A **database server** may want to prioritize query threads over background compaction threads dynamically based on current query load.

CFS handles all of these with the same algorithm, tuned via a handful of sysctl knobs. It cannot express the kind of workload-specific policy these applications need.

**3. No safe way to load custom policies in production**

Even if you write the perfect scheduler for your workload, you cannot deploy it to a production Linux system without running a custom kernel. This means:

- Every production machine needs a custom kernel build — no distro support, no security patches via standard channels.
- Any bug in your scheduler is a kernel bug: it can cause hangs, panics, or security vulnerabilities.
- There is no isolation between the custom scheduler and the rest of the kernel.

The net result: companies that care deeply about scheduling (Meta, Google, Microsoft, game studios) maintain large, divergent kernel trees with proprietary scheduling patches. These trees are expensive to maintain and rarely share improvements.

### What We Need

The ideal solution would let a developer write scheduling policy in a safe, high-level language, load it at runtime without rebooting, have it take effect immediately for chosen workloads, and fail safely if it has bugs. That is exactly what sched_ext provides.

---

## sched_ext in One Paragraph

sched_ext is a Linux scheduling class (`ext_sched_class`) where scheduling policy lives in a BPF program loaded at runtime. Tasks opt in by being assigned the `SCHED_EXT` scheduling policy. The BPF program implements a set of callbacks called `sched_ext_ops` — a vtable of function pointers that the BPF program fills in. The kernel handles **mechanism**: runqueue management, CPU affinity enforcement, preemption delivery, time slice accounting, task lifecycle management, and safety guarantees. The BPF program handles **policy**: which task runs next, on which CPU, for how long. If the BPF scheduler misbehaves — deadlocks, fails to schedule tasks, or crashes — a watchdog timer detects the problem and reverts all `SCHED_EXT` tasks to CFS automatically, without rebooting the machine. The BPF verifier catches memory safety bugs at load time before the scheduler runs at all.

---

## Where sched_ext Fits in the Scheduler Hierarchy

Linux uses a `sched_class` chain. When the kernel needs to pick the next task to run, it walks this chain from highest to lowest priority and asks each class "do you have a runnable task for this CPU?"

```
stop_sched_class     (highest priority: migration/stop tasks)
    ↓
dl_sched_class       (SCHED_DEADLINE: earliest deadline first)
    ↓
rt_sched_class       (SCHED_FIFO / SCHED_RR: real-time tasks)
    ↓
fair_sched_class     (SCHED_NORMAL / SCHED_BATCH: CFS)
    ↓
ext_sched_class      (SCHED_EXT: BPF-controlled)  ← sched_ext
    ↓
idle_sched_class     (lowest priority: idle tasks)
```

Each `sched_class` is defined as a struct of function pointers in the kernel:

```c
/* kernel/sched/sched.h (illustrative, not exact) */
struct sched_class {
    void (*enqueue_task)    (struct rq *rq, struct task_struct *p, int flags);
    void (*dequeue_task)    (struct rq *rq, struct task_struct *p, int flags);
    void (*yield_task)      (struct rq *rq);
    struct task_struct *(*pick_next_task)(struct rq *rq);
    void (*put_prev_task)   (struct rq *rq, struct task_struct *p);
    /* ... many more ... */
};
```

The key rules of the hierarchy:

- **RT and DL tasks are NEVER handled by sched_ext.** A task on SCHED_FIFO is always managed by `rt_sched_class`, regardless of whether a BPF scheduler is loaded.
- **A task uses sched_ext if and only if** it has the `SCHED_EXT` policy AND a BPF scheduler is currently loaded.
- **If no BPF scheduler is loaded**, tasks with `SCHED_EXT` policy fall back to `fair_sched_class` (CFS). They look like normal `SCHED_NORMAL` tasks to the kernel.
- **The BPF scheduler only controls SCHED_EXT tasks.** System threads, RT tasks, and regular CFS tasks are not affected.

This hierarchy means that sched_ext cannot prevent a SCHED_FIFO task from preempting your BPF-scheduled task. The BPF scheduler operates in the space below RT, just like CFS does.

### The sched_class Linked List

In the kernel, the classes are linked in a doubly-linked list via `next` pointers. The `pick_next_task()` kernel function walks this list. For `ext_sched_class`:

```c
/* kernel/sched/ext.c */
DEFINE_SCHED_CLASS(ext) = {
    .enqueue_task       = scx_enqueue,
    .dequeue_task       = scx_dequeue,
    .pick_next_task     = scx_pick_next_task,
    .put_prev_task      = scx_put_prev_task,
    /* ... */
};
```

When `pick_next_task()` reaches `ext_sched_class`, it calls `scx_pick_next_task()`, which drains the CPU's local DSQ (more on DSQs shortly).

---

## The BPF Interface: sched_ext_ops

The BPF program fills in a `sched_ext_ops` structure — a vtable of callbacks. The BPF skeleton infrastructure handles attaching this struct to the kernel.

Only `.name` is required; everything else has a sensible default that makes the scheduler behave like a simple global FIFO.

```c
/* Illustrative — based on include/linux/sched/ext.h */
struct sched_ext_ops {
    /* Required */
    char name[SCX_OPS_NAME_LEN];    /* name of this scheduler, e.g. "my_sched" */

    /* --- CPU selection: where should this task run? --- */
    /* Called when a task wakes up. Return a CPU number or -1 to let the
     * kernel decide. BPF can also call scx_bpf_dispatch() here directly
     * (called "direct dispatch") to skip ops.enqueue(). */
    s32 (*select_cpu)(struct task_struct *p, s32 prev_cpu, u64 wake_flags);

    /* --- Task runqueue operations --- */

    /* Task became runnable — place it into a DSQ.
     * BPF MUST call scx_bpf_dispatch() (or scx_bpf_dispatch_vtime()) here,
     * or the task will be lost. If BPF does nothing, the task is dispatched
     * to SCX_DSQ_GLOBAL by default. */
    void (*enqueue)(struct task_struct *p, u64 enq_flags);

    /* Task is being removed from the scheduler (class change, migration, etc.)
     * If BPF maintains external state (maps, lists), clean it up here. */
    void (*dequeue)(struct task_struct *p, u64 deq_flags);

    /* CPU needs a task to run — feed tasks from custom DSQs into the local queue.
     * BPF calls scx_bpf_consume(dsq_id) to move tasks from a custom DSQ to this
     * CPU's local queue. Called when the local queue is empty. */
    void (*dispatch)(s32 cpu, struct task_struct *prev);

    /* --- Task state change notifications --- */

    /* Task transitioned to runnable state (was blocked, now runnable). */
    void (*runnable)(struct task_struct *p, u64 enq_flags);

    /* Task transitioned to a quiescent (blocking) state. */
    void (*quiescent)(struct task_struct *p, u64 deq_flags);

    /* Task is now actually executing on a CPU (context switch complete). */
    void (*running)(struct task_struct *p);

    /* Task is about to be descheduled (before context switch away). */
    void (*stopping)(struct task_struct *p, bool runnable);

    /* Task yielded the CPU voluntarily. */
    void (*yield)(struct task_struct *from, struct task_struct *to);

    /* --- Task lifecycle --- */

    /* Called when task is forked or when SCHED_EXT is set on a task.
     * BPF should allocate per-task state here. Return 0 on success,
     * negative errno on failure (task stays on CFS). */
    s32  (*init_task)(struct task_struct *p, struct scx_init_task_args *args);

    /* Called when task exits or SCHED_EXT is removed. Free per-task state. */
    void (*exit_task)(struct task_struct *p, struct scx_exit_task_args *args);

    /* Task is being enabled for sched_ext scheduling (after init_task). */
    void (*enable)(struct task_struct *p);

    /* Task is being disabled (before exit_task). */
    void (*disable)(struct task_struct *p);

    /* Priority inheritance: task p is boosting task of due to a lock.
     * BPF can requeue 'of' at higher priority. */
    void (*set_weight)(struct task_struct *p, u32 weight);

    /* --- CPU lifecycle --- */

    /* A CPU came online (hotplug). */
    void (*cpu_online)(s32 cpu);

    /* A CPU went offline (hotplug). */
    void (*cpu_offline)(s32 cpu);

    /* BPF scheduler "acquired" this CPU: no higher-priority class has
     * tasks for it, so sched_ext is now responsible for it. */
    void (*cpu_acquire)(s32 cpu, struct scx_cpu_acquire_args *args);

    /* A higher-priority class (RT, DL) needs this CPU back.
     * BPF must stop scheduling on it. */
    void (*cpu_release)(s32 cpu, struct scx_cpu_release_args *args);

    /* --- Scheduler lifecycle --- */

    /* Called once when the BPF scheduler is loaded. Initialize global state,
     * create custom DSQs, etc. Return 0 on success. */
    s32  (*init)(void);

    /* Called when the scheduler is unloaded (normally or due to error).
     * ei contains the reason for exit. Log final state here. */
    void (*exit)(struct scx_exit_info *ei);

    /* --- Control flags --- */

    /* Bitmask of SCX_OPS_* flags:
     *   SCX_OPS_KEEP_BUILTIN_IDLE  - use kernel's idle tracking alongside BPF
     *   SCX_OPS_ENQ_LAST           - call enqueue() when there's only one task
     *   SCX_OPS_ENQ_EXITING        - call enqueue() for exiting tasks
     *   SCX_OPS_SWITCH_PARTIAL     - only switch tasks that opt in (not all SCHED_EXT)
     *   SCX_OPS_HAS_CGROUP_WEIGHT  - scheduler handles cgroup weights
     */
    u64  flags;

    /* Watchdog timeout in milliseconds. If a SCHED_EXT task goes this long
     * without being scheduled, the watchdog disables the BPF scheduler.
     * Default: 30000 (30 seconds). Set to 0 to disable watchdog. */
    u32  timeout_ms;

    /* How many bytes of exit info to dump when the scheduler exits.
     * Default is enough for typical error messages. */
    u32  exit_dump_len;
};
```

### How the BPF Program Attaches the Ops Struct

The `sched_ext_ops` struct is declared in the BPF program with a special ELF section annotation:

```c
/* In the BPF C file */
SEC(".struct_ops.link")
struct sched_ext_ops my_scheduler_ops = {
    .enqueue = (void *)my_enqueue,
    .dispatch = (void *)my_dispatch,
    .name = "my_scheduler",
};
```

The `.struct_ops.link` section tells libbpf that this struct should be "auto-attached" when `skel__attach()` is called. libbpf handles creating the necessary BPF maps and attaching the struct to the kernel's `sched_ext_ops` registration point. Once attached, `ext_sched_class` becomes active in the scheduler hierarchy.

---

## Dispatch Queues (DSQs): The Core Abstraction

Dispatch Queues are the most important concept in sched_ext. Understanding DSQs is the key to understanding how the whole system works.

A **Dispatch Queue (DSQ)** is a queue of tasks waiting to be scheduled. It is an ordered container — tasks go in, tasks come out. The kernel provides three kinds of DSQs:

### 1. The Global DSQ (SCX_DSQ_GLOBAL = 0)

The global DSQ is a single FIFO queue shared across all CPUs. It is created automatically by the kernel when sched_ext is initialized — BPF does not need to do anything to use it.

Properties:
- **Shared**: Any idle CPU can pull tasks from it.
- **FIFO ordering**: Tasks are served in the order they arrive.
- **Automatic draining**: The kernel automatically drains the global DSQ into CPU local queues. BPF does not need to implement `ops.dispatch()` to use it.

The global DSQ is the simplest possible option. A scheduler that puts everything in `SCX_DSQ_GLOBAL` implements pure FIFO scheduling across all CPUs — the simplest valid sched_ext scheduler.

### 2. Per-CPU Local DSQs (SCX_DSQ_LOCAL = 1)

Each CPU has its own local DSQ. This is the queue that the CPU actually runs tasks from — `ext_sched_class.pick_next_task()` dequeues from the local DSQ.

Properties:
- **CPU-private**: Only the owning CPU runs tasks from its local DSQ.
- **Highest priority within sched_ext**: A task in the local DSQ will run before anything is pulled from other DSQs.
- **Direct dispatch**: BPF can dispatch directly to a specific CPU's local DSQ using `SCX_DSQ_LOCAL_ON(cpu)`.

When BPF dispatches to `SCX_DSQ_LOCAL` from within `ops.enqueue()`, the task goes to the local DSQ of the CPU that will run it (the CPU returned by `ops.select_cpu()`). From `ops.dispatch()`, it goes to the local DSQ of the CPU calling dispatch.

### 3. Custom DSQs (BPF-defined)

BPF programs can create their own DSQs with arbitrary IDs. These are the building blocks for sophisticated scheduling policies.

Properties:
- **Created by BPF**: `scx_bpf_create_dsq(dsq_id, node)` — the `node` parameter controls NUMA node allocation for the DSQ's memory.
- **Two orderings**: FIFO (default) or virtual-time ordered (for weighted fair scheduling).
- **Explicit consumption**: BPF must explicitly call `scx_bpf_consume(dsq_id)` from `ops.dispatch()` to move tasks from a custom DSQ to the local DSQ.
- **Destroyed by BPF**: `scx_bpf_destroy_dsq(dsq_id)` in `ops.exit()`.

Custom DSQ IDs are user-defined. The only constraint is that they must not collide with the built-in IDs (`SCX_DSQ_GLOBAL = 0`, `SCX_DSQ_LOCAL = 1`). Typically BPF programs use IDs starting from a high number or use a per-CPU scheme.

### The Task Flow Through DSQs

This is the complete lifecycle of a task in sched_ext:

```
Task wakes up (e.g., from I/O completion, mutex unlock, timer)
    │
    ▼
ops.select_cpu(p, prev_cpu, wake_flags)
    │   BPF picks which CPU this task should run on.
    │   Returns a CPU number (0..nr_cpus-1), or -1 to let the kernel decide.
    │   BPF can also call scx_bpf_dispatch() HERE directly (direct dispatch),
    │   which skips ops.enqueue() entirely.
    │
    ▼
ops.enqueue(p, enq_flags)
    │   BPF places the task into a DSQ by calling:
    │     scx_bpf_dispatch(p, DSQ_ID, slice_ns, enq_flags)   -- FIFO DSQ
    │     scx_bpf_dispatch_vtime(p, DSQ_ID, slice_ns, vtime, enq_flags) -- vtime DSQ
    │   If BPF doesn't dispatch, the task defaults to SCX_DSQ_GLOBAL.
    │
    ▼
[Task sits in a DSQ: custom DSQ, global DSQ, or local DSQ]
    │
    │   (If task went to global DSQ, kernel auto-drains it to local DSQs)
    │   (If task went to a custom DSQ, it waits until ops.dispatch() consumes it)
    │
    ▼
ops.dispatch(cpu, prev_task)
    │   Called when the CPU's local DSQ is empty and the CPU needs a task.
    │   prev_task is the task that just ran (or NULL).
    │   BPF calls:
    │     scx_bpf_consume(dsq_id)   -- moves one task from custom DSQ → local DSQ
    │   BPF can call scx_bpf_consume() multiple times for multiple tasks.
    │   BPF can also call scx_bpf_dispatch() to put more tasks into DSQs.
    │
    ▼
[Task is now in the CPU's local DSQ]
    │
    ▼
ext_sched_class.pick_next_task()
    │   Kernel dequeues the next task from the local DSQ and selects it to run.
    │
    ▼
ops.running(p)
    │   Task is now executing on the CPU.
    │   Notification only — BPF can update accounting here.
    │
    ▼
[Task runs for its time slice, or is preempted by RT/DL task, or blocks]
    │
    ├── Time slice expired ─────────────────────────────────────┐
    │                                                            │
    ├── Preempted by higher-priority class ─────────────────────┤
    │                                                            │
    └── Task blocked (I/O, lock, sleep) ─────────────────────── │
                                                                 │
                                                                 ▼
                                                    ops.stopping(p, runnable)
                                                         │   Task is about to be
                                                         │   descheduled. BPF can
                                                         │   update final accounting.
                                                         │   'runnable' = true if task
                                                         │   will be re-enqueued (time
                                                         │   slice expired), false if
                                                         │   task is blocking.
                                                         │
                                                         ▼
                                            If runnable: ops.enqueue() again
                                            If blocking: ops.quiescent()
                                                         [task waits for wakeup event]
                                                         When event arrives: ops.runnable()
                                                         Then: ops.enqueue()
```

### Key BPF Helper Functions

These are the primary BPF helpers used to interact with DSQs and CPUs:

```c
/* ========== Dispatching tasks into DSQs ========== */

/* Place task p into DSQ dsq_id with FIFO ordering.
 *   p:         the task being dispatched
 *   dsq_id:    destination DSQ (SCX_DSQ_GLOBAL, SCX_DSQ_LOCAL, or custom ID)
 *   slice:     time slice in nanoseconds; SCX_SLICE_DFL for default (~20ms)
 *   enq_flags: pass-through from ops.enqueue(), or 0
 */
void scx_bpf_dispatch(struct task_struct *p, u64 dsq_id,
                      u64 slice, u64 enq_flags);

/* Place task p into a vtime-ordered DSQ.
 *   vtime:  virtual time value; lower vtime = higher priority (runs sooner)
 *   All other parameters same as scx_bpf_dispatch()
 */
void scx_bpf_dispatch_vtime(struct task_struct *p, u64 dsq_id,
                             u64 slice, u64 vtime, u64 enq_flags);

/* ========== Consuming from DSQs (use in ops.dispatch()) ========== */

/* Move the head task from custom DSQ dsq_id to the current CPU's local DSQ.
 * Returns true if a task was moved, false if the DSQ was empty. */
bool scx_bpf_consume(u64 dsq_id);

/* ========== CPU management ========== */

/* Send a scheduling event to a CPU.
 *   flags:
 *     SCX_KICK_IDLE     - wake the CPU if it's idle (to run newly dispatched tasks)
 *     SCX_KICK_PREEMPT  - preempt the currently running task
 *     SCX_KICK_WAIT     - wait for the CPU to reschedule before returning
 */
void scx_bpf_kick_cpu(s32 cpu, u64 flags);

/* ========== DSQ management ========== */

/* Create a new custom DSQ.
 *   dsq_id: user-chosen ID (must not be 0 or 1)
 *   node:   NUMA node for memory allocation, or -1 for NUMA_NO_NODE
 * Returns 0 on success, negative errno on failure.
 */
s32  scx_bpf_create_dsq(u64 dsq_id, s32 node);

/* Destroy a previously created custom DSQ.
 * Any tasks still in the DSQ are moved to the global DSQ. */
void scx_bpf_destroy_dsq(u64 dsq_id);

/* ========== Per-task queries ========== */

/* Returns the CPU the task is currently running on, or -1 if not running. */
s32  scx_bpf_task_running_on(struct task_struct *p);

/* Returns the CPU selected for a task by select_cpu(), or -1 if not set. */
s32  scx_bpf_task_cpu(struct task_struct *p);

/* ========== Scheduler lifecycle ========== */

/* Voluntarily exit the BPF scheduler with a reason.
 *   exit_code:  user-defined exit code logged to exit_info
 *   fmt, args:  printf-style message for the exit log
 * This triggers the disable path cleanly (safer than a crash). */
void scx_bpf_exit(s64 exit_code, const char *fmt, ...);

/* Emit an error and trigger the disable path. */
void scx_bpf_error(const char *fmt, ...);
```

### The select_cpu / enqueue / dispatch Triangle

The relationship between these three callbacks is the most common source of confusion for new sched_ext developers. Here is the precise interaction:

**`ops.select_cpu(p, prev_cpu, wake_flags)`**
- Called when a task becomes runnable (wakeup path)
- BPF's chance to pick a CPU *before* the task is enqueued
- If BPF calls `scx_bpf_dispatch()` here, the task is dispatched directly — `ops.enqueue()` is NOT called
- If BPF returns a CPU without dispatching, the task proceeds to `ops.enqueue()` with `p->wake_cpu` set to the returned CPU
- Wake flags include bits like `SCX_WAKE_FORK` (task was forked), `SCX_WAKE_SYNC` (synchronous wakeup hint)

**`ops.enqueue(p, enq_flags)`**
- Called for every task that needs to be placed into a DSQ
- BPF MUST call `scx_bpf_dispatch()` or `scx_bpf_dispatch_vtime()` here
- If BPF returns without dispatching, the task is automatically dispatched to `SCX_DSQ_GLOBAL`
- Enqueue flags include `SCX_ENQ_WAKEUP` (task woke from sleep), `SCX_ENQ_LAST` (only task on CPU), `SCX_ENQ_PREEMPT` (BPF preempted the current task for this one)

**`ops.dispatch(cpu, prev)`**
- Called when a CPU's local DSQ is empty and the CPU needs something to run
- `prev` is the task that just ran (may be NULL)
- BPF calls `scx_bpf_consume(dsq_id)` to pull tasks from custom DSQs
- Can be called multiple times if the first consume was empty
- If dispatch returns without producing a task, the CPU goes idle

---

## The Simplest Possible BPF Scheduler

The following is a complete, working minimal scheduler. It implements pure FIFO scheduling using only the global DSQ. This is essentially `scx_simple` from the sched_ext tools repository.

```c
/* minimal_sched.bpf.c
 * The simplest possible sched_ext scheduler.
 *
 * Policy: global FIFO. Every task goes into a single shared queue.
 * CPUs pick tasks in arrival order. No per-task state needed.
 *
 * Build: clang -O2 -g -target bpf -c minimal_sched.bpf.c -o minimal_sched.bpf.o
 * (In practice, use the sched_ext Makefile which handles vmlinux.h and libbpf)
 */

#include <scx/common.bpf.h>

/* char _license[] SEC("license") = "GPL"; is included via common.bpf.h */

/* ops.enqueue() is the only callback we need to implement.
 *
 * The default ops.dispatch() implementation knows how to drain SCX_DSQ_GLOBAL
 * into per-CPU local queues, so we don't need to write dispatch().
 */
void BPF_STRUCT_OPS(minimal_enqueue, struct task_struct *p, u64 enq_flags)
{
    /*
     * SCX_DSQ_GLOBAL (= 0): the built-in global FIFO queue shared by all CPUs.
     * SCX_SLICE_DFL: use the default time slice (tunable via /sys/kernel/sched_ext/).
     * enq_flags: pass through the flags we received (contains wakeup hints etc.)
     */
    scx_bpf_dispatch(p, SCX_DSQ_GLOBAL, SCX_SLICE_DFL, enq_flags);
}

/*
 * The ops struct. Only .enqueue and .name are set.
 * All other callbacks use their built-in defaults:
 *   - select_cpu:  kernel picks CPU based on affinity and cache topology
 *   - dispatch:    automatically drains SCX_DSQ_GLOBAL
 *   - init_task:   no-op (no per-task state)
 *   - exit_task:   no-op
 *   - init:        no-op
 *   - exit:        no-op
 */
SEC(".struct_ops.link")
struct sched_ext_ops minimal_ops = {
    .enqueue    = (void *)minimal_enqueue,
    .name       = "minimal",
};
```

**What each part does:**

- `BPF_STRUCT_OPS(minimal_enqueue, ...)`: A macro from `common.bpf.h` that annotates the function as a struct_ops callback and places it in the correct BPF ELF section.
- `scx_bpf_dispatch(p, SCX_DSQ_GLOBAL, SCX_SLICE_DFL, enq_flags)`: Places the task in the global FIFO queue. When a CPU has nothing to run, the kernel calls the default `ops.dispatch()` implementation, which calls `scx_bpf_consume(SCX_DSQ_GLOBAL)` automatically.
- `SEC(".struct_ops.link")`: Tells libbpf that this struct should be registered and auto-attached to the kernel's sched_ext_ops structure.

**The userspace loader:**

```c
/* minimal_sched.c - userspace loader
 *
 * The .skel.h file is generated by bpftool (or the build system) from the
 * compiled BPF object file. It provides type-safe C wrappers for all BPF
 * operations on this specific program.
 */
#include <stdio.h>
#include <unistd.h>
#include <signal.h>
#include "minimal_sched.skel.h"

int main(void)
{
    struct minimal_sched *skel;
    int err;

    /*
     * open_and_load():
     *   1. Opens the BPF object embedded in the skeleton
     *   2. Runs the BPF verifier (validates memory safety, bounds, etc.)
     *   3. Loads all BPF programs into the kernel
     *   4. Creates any BPF maps
     * Returns NULL on failure.
     */
    skel = minimal_sched__open_and_load();
    if (!skel) {
        fprintf(stderr, "Failed to open and load BPF skeleton\n");
        return 1;
    }

    /*
     * attach():
     *   Registers the sched_ext_ops struct with the kernel.
     *   After this call, all tasks with SCHED_EXT policy are handled
     *   by our minimal_enqueue() callback.
     */
    err = minimal_sched__attach(skel);
    if (err) {
        fprintf(stderr, "Failed to attach scheduler: %d\n", err);
        minimal_sched__destroy(skel);
        return 1;
    }

    printf("Minimal sched_ext scheduler loaded. Press Ctrl+C to unload.\n");

    /*
     * Keep the process alive. The scheduler stays active as long as
     * the skel object is attached. When the process exits (or you call
     * minimal_sched__destroy()), the kernel unloads the BPF scheduler
     * and all SCHED_EXT tasks revert to CFS.
     */
    pause();

    minimal_sched__destroy(skel);
    return 0;
}
```

**To test it:**

```bash
# Build (requires kernel headers and libbpf)
make minimal_sched

# Load the scheduler
sudo ./minimal_sched &

# Move a process to SCHED_EXT
sudo chrt --ext 0 -p <pid>

# Or start a new process with SCHED_EXT
sudo chrt --ext 0 <command>

# Check that the scheduler is active
cat /sys/kernel/sched_ext/root/ops
# Outputs: minimal

# Unload (kills the background process)
sudo kill %1
```

---

## Per-Task State: scx_entity

Every `task_struct` has an `scx_entity` embedded in it at `task_struct.scx`. This is the sched_ext-specific state per task — it lives in the task itself, not in a separate allocation.

```c
/* Illustrative — based on include/linux/sched/ext.h */
struct scx_entity {
    /* DSQ membership */
    struct scx_dispatch_q   *dsq;           /* which DSQ this task is currently in */
    struct list_head         dsq_node;      /* linkage within the DSQ's task list */
    u64                      dsq_seq;       /* sequence number for this DSQ slot */

    /* Scheduling parameters */
    u64                      dsq_vtime;     /* virtual time for vtime-ordered DSQs */
    u64                      slice;         /* remaining time slice in nanoseconds */

    /* Task state flags (SCX_TASK_*) */
    u32                      flags;

    /* CPU assignment */
    s32                      sticky_cpu;    /* CPU pinned by select_cpu(), or -1 */
    s32                      holding_cpu;   /* CPU currently "holding" the task */

    /* Weight for WFQ (derived from nice value) */
    u32                      weight;        /* 1..10000, default 100 */

    /* Ops state machine */
    u32                      ops_state;     /* SCX_OPSS_* enum value */

    /* ... more internal fields ... */
};
```

**Key fields explained:**

- **`dsq`**: Pointer to the DSQ this task is currently sitting in. NULL if the task is running or transitioning.
- **`dsq_vtime`**: The task's virtual time within its DSQ. For vtime DSQs, this determines ordering — tasks with lower `dsq_vtime` run first. BPF reads and writes this field to implement WFQ.
- **`slice`**: How much time the task has left in its current time slice, in nanoseconds. The kernel decrements this each tick. When it reaches zero, the task is preempted.
- **`weight`**: Task weight derived from the nice value. Higher weight = more CPU time in WFQ. Maps roughly: nice -20 → weight 10000, nice 0 → weight 100, nice 19 → weight 1.
- **`sticky_cpu`**: If `ops.select_cpu()` returned a valid CPU, this field stores it so `ops.enqueue()` knows where the task should go.

**Key flags (`SCX_TASK_*`):**

- `SCX_TASK_QUEUED`: Task is currently in a DSQ (between enqueue and dispatch).
- `SCX_TASK_RUNNABLE`: Task is runnable but may not be in a DSQ yet (transitioning).
- `SCX_TASK_DISALLOW`: BPF scheduler rejected this task (e.g., `init_task()` returned an error). The task runs on CFS instead.
- `SCX_TASK_INIT_DONE`: `ops.init_task()` completed successfully.
- `SCX_TASK_ENABLED`: `ops.enable()` has been called; task is fully under sched_ext control.

**Accessing scx_entity from BPF:**

BPF programs access `task->scx` directly through CO-RE (Compile Once, Run Everywhere) field access. The BPF verifier checks these accesses at load time:

```c
void BPF_STRUCT_OPS(my_enqueue, struct task_struct *p, u64 enq_flags)
{
    u64 vtime = p->scx.dsq_vtime;
    u32 weight = p->scx.weight;
    /* ... */
}
```

---

## Safety: What Happens When the BPF Scheduler Fails

sched_ext is designed with defense in depth. Multiple independent mechanisms ensure the system never hangs due to a buggy BPF scheduler.

### Layer 1: The BPF Verifier (Load-Time Safety)

Before any BPF scheduler runs a single instruction, the kernel's BPF verifier performs static analysis:

- **Memory safety**: All pointer accesses are bounds-checked. Buffer overflows are impossible.
- **Termination**: All loops must have provably bounded iterations. Infinite loops are rejected at load time.
- **Type safety**: BPF uses BTF (BPF Type Format) to verify that struct field accesses are correct for the running kernel version.
- **Helper call validation**: Only approved BPF helpers can be called from sched_ext callbacks (different callbacks have different allowed helper sets).

A BPF scheduler that passes the verifier cannot corrupt kernel memory. This is the first and strongest safety layer.

### Layer 2: sysrq-S (Manual Override)

Any system administrator can press **Alt+SysRq+S** on the keyboard (or `echo s > /proc/sysrq-trigger`) to:

1. Immediately disable the BPF scheduler
2. Move all SCHED_EXT tasks back to CFS
3. Unload the BPF program

This is the emergency escape hatch for cases where the BPF scheduler is causing the system to become unresponsive. The system recovers without a reboot.

### Layer 3: The Watchdog (Automatic Detection)

A kernel timer fires every `timeout_ms / 2` milliseconds (default: every 15 seconds). It scans all SCHED_EXT tasks and checks if any runnable task has not been scheduled for longer than `timeout_ms` (default: 30 seconds).

If the watchdog finds a starved task, it calls `scx_ops_error()` with a message like:

```
sched_ext: "my_scheduler" failed: watchdog detected task stuck for 30001ms
```

This triggers the same disable path as sysrq-S.

The watchdog catches the most common BPF scheduler bug: a `ops.dispatch()` implementation that fails to consume tasks from a custom DSQ, leaving tasks stuck in limbo indefinitely.

BPF schedulers can configure or disable the watchdog:
```c
SEC(".struct_ops.link")
struct sched_ext_ops my_ops = {
    .timeout_ms = 60000,  /* Give my scheduler 60 seconds before watchdog fires */
    /* Set to 0 to disable watchdog entirely (dangerous!) */
    .name = "my_scheduler",
};
```

### Layer 4: BPF Scheduler Self-Reporting

The BPF scheduler itself can trigger the disable path gracefully:

```c
/* Voluntary exit — scheduler knows it cannot continue */
void BPF_STRUCT_OPS(my_dispatch, s32 cpu, struct task_struct *prev)
{
    if (some_fatal_condition) {
        scx_bpf_exit(-EINVAL, "dispatch: fatal error in queue %d", cpu);
        return;
    }
    /* ... */
}
```

`scx_bpf_exit()` and `scx_bpf_error()` both trigger the disable path. The difference: `exit` is for intentional/graceful exit, `error` is for unexpected errors. Both cause `ops.exit(exit_info)` to be called with the message you provided.

### The Disable Path (Step by Step)

When any of the above triggers, the kernel executes the disable path:

1. **SCX_BYPASS mode activated**: A global flag is set that bypasses the BPF scheduler. New scheduling decisions are handled by CFS immediately, without calling any BPF callbacks.

2. **Runqueues drained**: The kernel iterates over all CPUs and moves tasks from SCX DSQs to CFS runqueues. Tasks that were waiting in custom DSQs get placed on the CFS runqueue of their affinity-preferred CPU.

3. **`ops.exit(exit_info)` called**: The BPF scheduler's exit callback is invoked. `exit_info` contains:
   - `exit_info->reason`: Why we're exiting (watchdog, sysrq, error, etc.)
   - `exit_info->msg`: Error message (if any)
   - `exit_info->dump`: Ring buffer of recent BPF prints/logs
   The BPF scheduler should log this to a BPF map or ring buffer for the userspace process to read.

4. **BPF program unloaded**: The struct_ops link is detached and the BPF programs are freed.

5. **System continues on CFS**: All tasks that were SCHED_EXT continue running, now managed by CFS. The kernel notes that no BPF scheduler is active; SCHED_EXT tasks behave like SCHED_NORMAL tasks until a new BPF scheduler is loaded.

**The key guarantee: The kernel never panics due to a BPF scheduler bug.** The combination of the BPF verifier (preventing memory corruption), the bypass mechanism (preventing scheduling deadlocks), and the watchdog (detecting starvation) means the worst-case outcome of a buggy BPF scheduler is "all tasks fall back to CFS" — not a kernel panic.

---

## A More Complex Example: Priority Queues

This example shows how `ops.enqueue()` and `ops.dispatch()` interact for a scheduler with multiple priority levels. This is illustrative pseudocode showing the patterns; real implementations add more error handling.

```c
/* priority_sched.bpf.c
 * Priority queue scheduler: 5 priority levels based on nice value.
 * Queue 0 = highest priority (nice -20..-12)
 * Queue 4 = lowest priority  (nice  12..19)
 *
 * A task in queue 0 will always run before any task in queue 1,
 * regardless of arrival order. This is strict priority scheduling.
 */

#include <scx/common.bpf.h>

#define NUM_QUEUES 5

/* DSQ IDs: we use 100, 101, 102, 103, 104 to avoid colliding with
 * SCX_DSQ_GLOBAL (0) and SCX_DSQ_LOCAL (1). */
#define QUEUE_BASE 100

/* Map nice value range (-20..19) to queue index (0..4).
 * Nice range is 40 units wide; divide into 5 buckets of 8. */
static inline u32 nice_to_queue(struct task_struct *p)
{
    /* static_prio: 100 (RT) to 139 (nice 19). Nice 0 = static_prio 120.
     * MAX_RT_PRIO = 100 */
    int nice_offset = p->static_prio - 120;  /* -20..19 */
    int queue = (nice_offset + 20) / 8;      /* 0..4 */

    /* Clamp to valid range */
    if (queue < 0) queue = 0;
    if (queue >= NUM_QUEUES) queue = NUM_QUEUES - 1;
    return (u32)queue;
}

/* Create all 5 DSQs when the scheduler loads. */
s32 BPF_STRUCT_OPS(prio_init)
{
    int i;
    for (i = 0; i < NUM_QUEUES; i++) {
        s32 ret = scx_bpf_create_dsq(QUEUE_BASE + i, -1);
        if (ret < 0) {
            /* If DSQ creation fails, we cannot operate.
             * Return error to abort loading. */
            scx_bpf_error("Failed to create DSQ %d: %d", i, ret);
            return ret;
        }
    }
    return 0;  /* Success */
}

/* Place task into the appropriate priority queue. */
void BPF_STRUCT_OPS(prio_enqueue, struct task_struct *p, u64 enq_flags)
{
    u32 queue = nice_to_queue(p);
    scx_bpf_dispatch(p, QUEUE_BASE + queue, SCX_SLICE_DFL, enq_flags);
}

/* CPU needs a task: scan queues from highest to lowest priority. */
void BPF_STRUCT_OPS(prio_dispatch, s32 cpu, struct task_struct *prev)
{
    int i;
    for (i = 0; i < NUM_QUEUES; i++) {
        /*
         * scx_bpf_consume() moves one task from the custom DSQ to this
         * CPU's local DSQ and returns true. We return immediately after
         * finding a task — the CPU will pick it up from its local DSQ.
         *
         * If the DSQ is empty, consume() returns false and we try the
         * next priority level.
         */
        if (scx_bpf_consume(QUEUE_BASE + i))
            return;
    }
    /* All queues empty: CPU will go idle. That's fine. */
}

/* Destroy DSQs when the scheduler unloads. */
void BPF_STRUCT_OPS(prio_exit, struct scx_exit_info *ei)
{
    int i;
    for (i = 0; i < NUM_QUEUES; i++)
        scx_bpf_destroy_dsq(QUEUE_BASE + i);
    /* Log exit reason */
    bpf_printk("prio_sched exiting: %s", ei->msg);
}

SEC(".struct_ops.link")
struct sched_ext_ops prio_ops = {
    .init     = (void *)prio_init,
    .enqueue  = (void *)prio_enqueue,
    .dispatch = (void *)prio_dispatch,
    .exit     = (void *)prio_exit,
    .name     = "priority_sched",
};
```

**Step-by-step walkthrough when a task wakes up:**

1. A task with nice value `-8` wakes from sleep (e.g., I/O completion).
2. `ops.select_cpu()` is called — we use the default, which picks the least-loaded CPU.
3. `ops.enqueue(p, SCX_ENQ_WAKEUP)` is called.
4. `nice_to_queue(p)` maps nice `-8` to queue index `1` (the second-highest priority).
5. `scx_bpf_dispatch(p, QUEUE_BASE + 1, SCX_SLICE_DFL, enq_flags)` places the task in DSQ 101.
6. The CPU's local DSQ may already be busy running something else. The task waits in DSQ 101.
7. When the current task's slice expires, `ext_sched_class.pick_next_task()` fires and finds the local DSQ empty.
8. `ops.dispatch(cpu, prev)` is called.
9. We check DSQ 100 (highest priority) — it's empty.
10. We check DSQ 101 — it has our task. `scx_bpf_consume(101)` moves it to the local DSQ and returns true.
11. The CPU picks the task from its local DSQ and runs it.
12. When its slice expires, `ops.stopping()` fires, then `ops.enqueue()` is called again to re-enqueue it.

---

## Virtual Time Scheduling: Weighted Fair Queuing

FIFO and strict-priority scheduling are easy but unfair — a flood of low-latency tasks can starve high-nice-value tasks. Weighted Fair Queuing (WFQ) provides fairness: each task gets CPU time proportional to its weight.

sched_ext supports WFQ through vtime-ordered DSQs. A vtime DSQ orders tasks by their `vtime` field — the task with the smallest vtime runs next.

The key insight: **time advances slower for high-weight tasks**. If task A has weight 200 (double the default) and task B has weight 100, and both do the same amount of work, task A's vtime advances at half the rate of task B's. So task A always appears to have "used less virtual time" and gets scheduled first, effectively getting 2x the CPU time.

```c
/* wfq_sched.bpf.c
 * Weighted Fair Queuing using a single vtime-ordered global DSQ.
 *
 * All tasks share one vtime DSQ. Tasks with higher weight (lower nice)
 * advance their vtime more slowly, so they stay near the front of the queue
 * and get proportionally more CPU time.
 */

#include <scx/common.bpf.h>

/* Global virtual time: the minimum vtime among all runnable tasks.
 * We use this to "lag-limit" new tasks — they start at min_vtime so
 * they don't get a burst of backlogged CPU time upon waking. */
static u64 global_min_vtime = 0;

void BPF_STRUCT_OPS(wfq_enqueue, struct task_struct *p, u64 enq_flags)
{
    u64 vtime = p->scx.dsq_vtime;
    u32 weight = p->scx.weight;  /* 1..10000, default 100 for nice 0 */

    /*
     * Lag limiting: if the task's vtime has fallen far behind the global
     * minimum (e.g., it was sleeping for a long time), snap it forward.
     * Without this, a waking task would see a huge credit and monopolize
     * the CPU for an extended period.
     *
     * We allow tasks to be behind by at most one default slice's worth
     * of virtual time.
     */
    if (vtime_before(vtime, global_min_vtime))
        vtime = global_min_vtime;

    /*
     * Advance the task's virtual time by (slice / weight).
     *
     * Heavier tasks (higher weight) advance their vtime MORE slowly.
     * This is the core WFQ invariant:
     *   - weight 200 task: vtime += 10ms / 200 = 0.05ms per real millisecond
     *   - weight 100 task: vtime += 10ms / 100 = 0.10ms per real millisecond
     *
     * The weight-100 task's vtime grows twice as fast, so the weight-200
     * task always looks "further behind" and gets scheduled preferentially.
     */
    vtime += SCX_SLICE_DFL / weight;

    /* Update the task's stored vtime for the next scheduling decision */
    p->scx.dsq_vtime = vtime;

    /*
     * Dispatch to the global vtime-ordered DSQ.
     * The DSQ will insert this task in vtime order (smallest first).
     */
    scx_bpf_dispatch_vtime(p, SCX_DSQ_GLOBAL, SCX_SLICE_DFL, vtime, enq_flags);
}

void BPF_STRUCT_OPS(wfq_running, struct task_struct *p)
{
    /*
     * When a task starts running, update the global minimum vtime.
     * The task at the head of the vtime queue (the one that just started
     * running) has the minimum vtime among all runnable tasks.
     *
     * NOTE: this is a simplified approximation. Production schedulers
     * (like scx_rustland) use more sophisticated min-vtime tracking.
     */
    if (vtime_before(global_min_vtime, p->scx.dsq_vtime))
        global_min_vtime = p->scx.dsq_vtime;
}

SEC(".struct_ops.link")
struct sched_ext_ops wfq_ops = {
    .enqueue  = (void *)wfq_enqueue,
    .running  = (void *)wfq_running,
    .name     = "wfq_sched",
};

/* Helper: returns true if a < b, handling 64-bit wraparound */
static inline bool vtime_before(u64 a, u64 b)
{
    return (s64)(a - b) < 0;
}
```

**Why vtime DSQs instead of per-task sorting in BPF?**

You might think: "I can maintain a sorted tree in a BPF map." The problem is that BPF map operations are O(log n) and have higher constant factors than kernel data structures. Using the kernel's built-in vtime DSQ (which uses a red-black tree internally) gives you correct, efficient, SMP-safe WFQ ordering without any complex BPF logic.

---

## Tickless Operation

### The Traditional Timer Tick

In a non-tickless kernel, a hardware timer fires every `1/HZ` seconds (typically 4ms at `HZ=250`). Each tick:
1. Decrements the current task's time slice (`p->scx.slice`)
2. If the slice reaches 0, sets a reschedule flag
3. At the next safe point, the kernel context-switches to the next task

This works fine for most workloads, but the interrupt overhead is measurable for compute-intensive tasks running on dedicated cores.

### sched_ext and nohz_full

Linux has a "nohz_full" mode where CPUs that are running a single task suppress the periodic timer entirely — the tick is dynamically re-enabled only when needed. sched_ext integrates with this:

- **Large slices**: If BPF dispatches tasks with large slice values (e.g., `SCX_SLICE_INF` for infinite), the kernel knows the task won't expire its slice soon and can suppress ticks.
- **BPF slice management**: BPF sets `p->scx.slice` when calling `scx_bpf_dispatch()`. The kernel uses this to determine when to re-enable the tick.
- **Slice expiry callback**: When a task's slice does expire mid-tick-suppression, the hardware timer that does fire handles it correctly.

```c
/* Give latency-sensitive tasks a normal slice, compute tasks a large one */
void BPF_STRUCT_OPS(tickless_enqueue, struct task_struct *p, u64 enq_flags)
{
    u64 slice;

    if (p->flags & PF_KTHREAD) {
        /* Kernel threads: use default slice */
        slice = SCX_SLICE_DFL;
    } else if (task_is_latency_sensitive(p)) {
        /* Interactive tasks: small slice for quick response */
        slice = 1 * NSEC_PER_MSEC;
    } else {
        /* Batch/compute tasks: large slice, suppress ticks */
        slice = 100 * NSEC_PER_MSEC;
    }

    scx_bpf_dispatch(p, SCX_DSQ_GLOBAL, slice, enq_flags);
}
```

The benefit: a CPU running a long-running compute task with a 100ms slice will only receive a timer interrupt every 100ms instead of every 4ms. For compute-bound workloads, this reduces scheduling overhead from ~250 interrupts/second to ~10 interrupts/second.

### The `ops.stopping()` / `ops.running()` Pattern for Precise Accounting

BPF schedulers that do vtime-based scheduling need to know exactly how much time a task actually used. The `running`/`stopping` pair enables this:

```c
void BPF_STRUCT_OPS(my_running, struct task_struct *p)
{
    /* Record when the task started executing */
    p->scx.dsq_vtime = bpf_ktime_get_ns();  /* repurpose for start time */
}

void BPF_STRUCT_OPS(my_stopping, struct task_struct *p, bool runnable)
{
    u64 now = bpf_ktime_get_ns();
    u64 used = now - p->scx.dsq_vtime;  /* actual CPU time consumed */

    /* Update virtual time based on actual usage, not allocated slice */
    p->scx.dsq_vtime = compute_new_vtime(p, used);
}
```

---

## CPU Coordination: Multi-CPU Scheduling

For true global scheduling policies, BPF needs to coordinate decisions across CPUs. sched_ext provides two patterns for this.

### The scx_central Pattern (Centralized Dispatch)

In this pattern, one designated CPU acts as the "scheduler CPU" and makes all scheduling decisions for all other CPUs:

```
                    All tasks enqueue here
                           │
                           ▼
                     Central CPU
                    ┌──────────────┐
                    │ ops.dispatch │
                    │ (for all CPUs│
                    │  via         │
                    │  dispatch_   │
                    │  local_on()) │
                    └──────┬───────┘
                           │
               ┌───────────┼───────────┐
               │           │           │
               ▼           ▼           ▼
           CPU 0's      CPU 1's    CPU 2's
          local DSQ    local DSQ  local DSQ
```

Implementation sketch:

```c
/* central_sched.bpf.c - simplified central scheduler pattern */

#define CENTRAL_CPU 0

/* Per-CPU task queues: tasks for each CPU */
struct {
    __uint(type, BPF_MAP_TYPE_QUEUE);
    __uint(max_entries, 4096);
    __type(value, u32);  /* task pid or task pointer */
} cpu_queues[MAX_CPUS] SEC(".maps");

void BPF_STRUCT_OPS(central_enqueue, struct task_struct *p, u64 enq_flags)
{
    s32 target_cpu = p->scx.sticky_cpu;
    if (target_cpu < 0)
        target_cpu = bpf_get_smp_processor_id();

    /* Put task in a per-CPU queue for the central scheduler to process */
    scx_bpf_dispatch(p, CPU_DSQ(target_cpu), SCX_SLICE_DFL, enq_flags);
}

void BPF_STRUCT_OPS(central_dispatch, s32 cpu, struct task_struct *prev)
{
    if (cpu != CENTRAL_CPU) {
        /*
         * Worker CPUs don't dispatch themselves.
         * They wait for the central CPU to push tasks into their local DSQ.
         * If the central CPU is busy, this CPU may briefly go idle —
         * the central CPU will kick it with scx_bpf_kick_cpu().
         */
        return;
    }

    /* Central CPU: dispatch tasks to all CPUs */
    int target;
    bpf_for(target, 0, nr_cpus) {
        if (!scx_bpf_consume(CPU_DSQ(target)))
            continue;  /* No task for this CPU */

        if (target == CENTRAL_CPU) {
            /* Task for us: it's now in our local DSQ, we'll pick it up */
            continue;
        }

        /*
         * Dispatch directly to target CPU's local DSQ.
         * scx_bpf_kick_cpu() wakes the CPU if it's idle.
         */
        /* Note: in real code, use scx_bpf_dispatch_local_on() here */
        scx_bpf_kick_cpu(target, SCX_KICK_IDLE);
    }
}
```

The central pattern enables global policies that are difficult to implement with distributed per-CPU decisions — for example, ensuring that exactly N tasks of type X are running at any moment across the entire system.

### CPU Acquire/Release: Knowing When You Own CPUs

The kernel calls `ops.cpu_acquire()` and `ops.cpu_release()` to tell the BPF scheduler which CPUs it currently "owns":

```c
void BPF_STRUCT_OPS(my_cpu_acquire, s32 cpu, struct scx_cpu_acquire_args *args)
{
    /*
     * The kernel has given us this CPU: no RT/DL tasks are runnable on it.
     * We can schedule sched_ext tasks here.
     * Update our internal CPU availability bitmap.
     */
    atomic_or(&available_cpus, (1ULL << cpu));
}

void BPF_STRUCT_OPS(my_cpu_release, s32 cpu, struct scx_cpu_release_args *args)
{
    /*
     * An RT or DL task needs this CPU. We must stop scheduling here.
     * The kernel will call pick_next_task() for the higher class next.
     * args->reason tells us why: SCX_CPU_RELEASE_PREEMPT or similar.
     */
    atomic_and(&available_cpus, ~(1ULL << cpu));
}
```

These callbacks are essential for BPF schedulers that implement NUMA-aware placement, power management (C-state optimization), or work-stealing algorithms that need accurate CPU availability information.

### Work-Stealing with scx_bpf_kick_cpu

When a BPF scheduler enqueues a task but the target CPU is busy, it needs to notify an idle CPU to steal the work:

```c
void BPF_STRUCT_OPS(stealing_enqueue, struct task_struct *p, u64 enq_flags)
{
    /* Place task in global queue */
    scx_bpf_dispatch(p, SCX_DSQ_GLOBAL, SCX_SLICE_DFL, enq_flags);

    /* If there are idle CPUs, wake one of them to pick up this task */
    s32 idle_cpu = scx_bpf_pick_idle_cpu(p->cpus_ptr, 0);
    if (idle_cpu >= 0)
        scx_bpf_kick_cpu(idle_cpu, SCX_KICK_IDLE);
}
```

`scx_bpf_pick_idle_cpu()` searches the CPU idle mask (maintained by the kernel or BPF, depending on flags) for an idle CPU within the task's affinity mask.

---

## Core Scheduling Integration

### The SMT Problem

Modern CPUs use Simultaneous Multithreading (SMT, also known as Hyperthreading). A physical core contains 2 or 4 "logical CPUs" (hardware threads) that share the core's execution resources including L1/L2 caches and execution pipelines.

This sharing creates a security problem: a malicious task on one hardware thread can use microarchitectural side channels (Spectre, MDS) to read data being processed by a task on the sibling hardware thread. This is the threat model that "core scheduling" addresses.

### Core Scheduling

Core scheduling (`CONFIG_SCHED_CORE`) requires that SMT siblings always run tasks from the same security domain (tagged with the same `core_sched_cookie`). If two tasks have different cookies (different trust levels), they cannot run on sibling HTs simultaneously — one HT must idle or run an idle thread while the other HT runs.

**Without core scheduling integration**, sched_ext could accidentally schedule:
- Task A (cookie X, user process) on CPU 0
- Task B (cookie Y, potentially hostile) on CPU 1 (sibling of CPU 0)

This would be a security vulnerability.

**sched_ext's integration**:

sched_ext participates in core scheduling through the `ops.core_sched_before()` callback and the cookie-based task pairing mechanism:

```c
/* BPF can implement task affinity for core scheduling.
 * This callback is called to decide if task 'a' should run before
 * task 'b' on the same physical core, considering their cookies.
 *
 * Return true if 'a' should run before 'b'.
 * Return false if 'b' should run before 'a' or they're equivalent.
 *
 * The kernel uses this to ensure compatible tasks are co-scheduled
 * on SMT siblings. */
bool BPF_STRUCT_OPS(my_core_sched_before,
                    struct task_struct *a, struct task_struct *b)
{
    /* For security: prefer tasks with the same cookie as the sibling */
    if (a->core_cookie == b->core_cookie)
        return false;  /* equivalent priority */

    /* Otherwise, use vtime ordering */
    return vtime_before(a->scx.dsq_vtime, b->scx.dsq_vtime);
}
```

If a BPF scheduler does not implement `core_sched_before()`, the kernel uses default cookie comparison rules.

---

## Writing a Production BPF Scheduler: Key Principles

### 1. Handle init_task() Errors Correctly

`ops.init_task()` is called for every task that joins sched_ext. If you allocate per-task memory here (from a BPF map, for example) and the allocation fails, you must return a negative errno:

```c
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 65536);
    __type(key, pid_t);
    __type(value, struct my_task_data);
} task_data SEC(".maps");

s32 BPF_STRUCT_OPS(my_init_task, struct task_struct *p,
                   struct scx_init_task_args *args)
{
    struct my_task_data data = { .vtime = 0, .weight = p->scx.weight };
    pid_t pid = p->pid;

    if (bpf_map_update_elem(&task_data, &pid, &data, BPF_NOEXIST) < 0) {
        /*
         * Map is full. Return -ENOMEM to signal failure.
         * The kernel will set SCX_TASK_DISALLOW on this task,
         * and it will be handled by CFS instead.
         * DO NOT return 0 here — that would lie to the kernel.
         */
        scx_bpf_error("task_data map full");
        return -ENOMEM;
    }
    return 0;
}
```

Tasks that fail `init_task()` get the `SCX_TASK_DISALLOW` flag and are transparently redirected to CFS. This is safe — the system keeps running, the task just doesn't use your scheduler.

### 2. Always Handle ops.dequeue()

When a task leaves sched_ext (policy change, migration, exit), `ops.dequeue()` is called. If your BPF scheduler maintains external state — anything beyond `p->scx.*` fields — you must clean it up here:

```c
void BPF_STRUCT_OPS(my_dequeue, struct task_struct *p, u64 deq_flags)
{
    pid_t pid = p->pid;

    /*
     * Remove per-task data from our map.
     * If we don't do this, the map entry leaks.
     * For BPF_MAP_TYPE_HASH with max_entries, leaks eventually cause
     * bpf_map_update_elem() to fail, breaking the scheduler for new tasks.
     */
    bpf_map_delete_elem(&task_data, &pid);
}
```

Missing `ops.dequeue()` cleanup is the most common production bug in BPF schedulers.

### 3. Keep ops.dispatch() Bounded

`ops.dispatch()` must not loop indefinitely. The BPF verifier will catch truly infinite loops, but you can still write a dispatch that takes too long or starves the CPU:

```c
/* BAD: could spin consuming tasks forever if the DSQ is constantly refilled */
void BPF_STRUCT_OPS(bad_dispatch, s32 cpu, struct task_struct *prev)
{
    while (scx_bpf_consume(my_dsq)) {
        /* This will keep running until the DSQ is empty... */
        /* but if enqueue() keeps adding tasks, we might never return */
    }
}

/* GOOD: consume at most N tasks per dispatch call */
void BPF_STRUCT_OPS(good_dispatch, s32 cpu, struct task_struct *prev)
{
    int i;
    for (i = 0; i < 8; i++) {  /* BPF loop bound */
        if (!scx_bpf_consume(my_dsq))
            break;
    }
    /* Return normally. The CPU will call dispatch() again if needed. */
}
```

### 4. Use scx_bpf_exit() for Graceful Shutdown

When the scheduler detects an unrecoverable error, calling `scx_bpf_exit()` is better than letting the watchdog fire:

```c
s32 BPF_STRUCT_OPS(my_init)
{
    if (scx_bpf_create_dsq(MY_DSQ, -1) < 0) {
        /* Don't return -ENOMEM silently — the kernel won't know why */
        scx_bpf_exit(-ENOMEM, "Failed to create DSQ during init");
        return -ENOMEM;
    }
    return 0;
}
```

`scx_bpf_exit()` is called from within `ops.init()` or any callback. The kernel receives the exit message and triggers the disable path immediately, logging the message for the userspace process to read via `ops.exit()`.

### 5. Test with the sched_ext Selftests

The kernel tree includes selftests in `tools/testing/selftests/sched_ext/`. These tests cover:

- Basic load/unload of example schedulers
- Watchdog trigger tests
- sysrq-S functionality
- Migration and CPU hotplug edge cases
- ops.init_task() failure handling

Run them with:
```bash
cd tools/testing/selftests/sched_ext
sudo make && sudo ./runner.py
```

### 6. Monitor via /sys/kernel/sched_ext

When a scheduler is loaded, the kernel exposes information at:

```
/sys/kernel/sched_ext/
├── root/
│   ├── ops          # current scheduler name
│   ├── state        # enabled/disabled/initializing
│   └── stats/       # per-scheduler statistics
└── ...
```

Read `state` to check if your scheduler is still active:
```bash
cat /sys/kernel/sched_ext/root/ops  # "my_scheduler" or empty
```

### 7. Build with libbpf Skeletons

The recommended build pattern:

```makefile
# Makefile excerpt
%.bpf.o: %.bpf.c vmlinux.h
	clang -O2 -g -target bpf \
		-D__TARGET_ARCH_$(ARCH) \
		-I$(LIBBPF_INCLUDE) \
		-c $< -o $@

%.skel.h: %.bpf.o
	bpftool gen skeleton $< > $@

%: %.c %.skel.h
	$(CC) -O2 -g $< -o $@ -lbpf -lelf -lz
```

The skeleton header (`*.skel.h`) generated by `bpftool gen skeleton` provides:
- `my_sched__open()` — parse the BPF object, prepare maps
- `my_sched__load()` — run the verifier, load into kernel
- `my_sched__attach()` — register the struct_ops and activate the scheduler
- `my_sched__destroy()` — clean up and unload

---

## The ops_state Machine: How Tasks Join and Leave sched_ext

Every task has an `ops_state` field (part of `scx_entity`) that tracks its relationship with the BPF scheduler. The transitions are driven by the kernel, not BPF.

```
[Not an SCX task]
      │
      │  SCHED_EXT policy set (via sched_setscheduler() / prctl())
      │  OR task forked from an SCX task
      │
      ▼
[SCX_OPSS_NONE]
      │  Kernel calls ops.init_task(p, args)
      │
      ├─── init_task() returned 0 (success) ──────────────────────────────────┐
      │                                                                        │
      ├─── init_task() returned -errno ─────────────────────────────────────┐ │
      │    SCX_TASK_DISALLOW set; task falls back to CFS                    │ │
      │    (ops.exit_task() NOT called for init failures)                   │ │
      │                                                                     ▼ ▼
      │                                                          [SCX_OPSS_INIT_DONE]
      │                                                                     │
      │                                                 Kernel calls ops.enable(p)
      │                                                                     │
      │                                                                     ▼
      │                                                           [SCX_OPSS_ENABLED]
      │                                                           ◄────────────────
      │                                                           │  Normal operating
      │                                                           │  state. All
      │                                                           │  scheduling ops
      │                                                           │  active.
      │                                                           ─────────────────►
      │
      │    (Task policy changed away from SCHED_EXT, task exits,
      │     or BPF scheduler is unloaded)
      │
      │                                                 Kernel calls ops.disable(p)
      │                                                                     │
      │                                                                     ▼
      │                                                         [SCX_OPSS_DISABLED]
      │                                                                     │
      │                                                Kernel calls ops.exit_task(p)
      │                                                                     │
      │                                                                     ▼
      │                                                          [Not an SCX task]
```

**Key transition notes:**

- `ops.init_task()` failure does NOT call `ops.exit_task()`. The task never fully joined, so there is nothing to clean up on the exit path.
- `ops.enable()` is called after `ops.init_task()` succeeds. This is when the task first becomes schedulable by your BPF program.
- The `INIT_DONE → ENABLED` transition may be delayed if the task is being migrated. The kernel ensures `enable()` is called on the task's destination CPU.
- When the BPF scheduler is unloaded, the kernel calls `ops.disable()` on every SCHED_EXT task simultaneously (in parallel), then calls `ops.exit_task()` in sequence.

---

## Kernel Entry Points: Where sched_ext Hooks In

Understanding where sched_ext integrates into the kernel helps with debugging and understanding overhead.

### Task Lifecycle Hooks

**`sched_fork()` → `scx_fork()`**
Called when a new task is created via `fork()`/`clone()`. Allocates the `scx_entity` structure (already embedded in `task_struct`, but needs initialization) and calls `ops.init_task()` if the task will use SCHED_EXT.

```c
/* kernel/sched/core.c */
int sched_fork(unsigned long clone_flags, struct task_struct *p)
{
    /* ... other initialization ... */
    scx_fork(p);  /* -> calls ops.init_task() */
    return 0;
}
```

**`do_exit()` → `scx_exit_task()`**
Called when a task exits. Calls `ops.stopping()` (if running), `ops.dequeue()` (if queued), `ops.disable()`, and `ops.exit_task()` in order.

**`sched_setscheduler()` → `__setscheduler()` → class switch**
When userspace calls `sched_setscheduler(pid, SCHED_EXT, &param)`, the kernel:
1. Calls `check_class_changing()` to validate the transition
2. Removes the task from its current class's runqueue
3. Sets `p->sched_class = &ext_sched_class`
4. Calls `scx_ops_enable_task()` → `ops.init_task()` then `ops.enable()`
5. Enqueues the task on the ext runqueue

### Scheduling Hooks

**`schedule()` → `__schedule()` → `pick_next_task()`**
The main scheduling path. When the kernel decides to context-switch:
1. Calls `put_prev_task()` on the outgoing task → `ops.stopping()`
2. Walks the sched_class chain to find the next task
3. If `ext_sched_class` has tasks, calls `scx_pick_next_task()`
4. `scx_pick_next_task()` dequeues from the CPU's local DSQ
5. If local DSQ is empty, calls `ops.dispatch(cpu, prev)` first
6. Returns the selected task → `ops.running()` called

**`try_to_wake_up()` (ttwu)**
The wakeup path. Called when a sleeping task should become runnable:
1. Calls `select_task_rq_ext()` → `ops.select_cpu()`
2. Moves task to the selected CPU's runqueue
3. Calls `enqueue_task_ext()` → `ops.runnable()` then `ops.enqueue()`
4. May kick the target CPU: `scx_bpf_kick_cpu(target, SCX_KICK_IDLE)`

**`scheduler_tick()`**
Called by the timer interrupt every `1/HZ` seconds:
1. Calls `task_tick_ext()` for the current ext task
2. Decrements `p->scx.slice`
3. If slice expired: sets `TIF_NEED_RESCHED` flag → next `schedule()` call preempts the task
4. Checks watchdog: if any SCHED_EXT task has been runnable but unscheduled for `>timeout_ms`, triggers `scx_ops_error()`

### The Per-CPU Runqueue

Each CPU has a `struct rq` (runqueue) that contains all scheduling state for that CPU:

```c
/* Simplified kernel/sched/sched.h */
struct rq {
    /* ... */
    struct cfs_rq       cfs;    /* CFS runqueue */
    struct rt_rq        rt;     /* RT runqueue */
    struct dl_rq        dl;     /* Deadline runqueue */
    struct scx_rq       scx;    /* sched_ext per-CPU state */
    /* ... */
};

struct scx_rq {
    struct scx_dispatch_q   local_dsq;  /* per-CPU local DSQ */
    u64                     flags;
    /* ... */
};
```

The `scx.local_dsq` is the per-CPU local DSQ. `ext_sched_class.pick_next_task()` dequeues from this. The only way to get a task into this DSQ is:
- BPF calls `scx_bpf_dispatch(p, SCX_DSQ_LOCAL, ...)` or `scx_bpf_dispatch(p, SCX_DSQ_LOCAL_ON(cpu), ...)`
- The kernel auto-drains `SCX_DSQ_GLOBAL` into local DSQs
- BPF calls `scx_bpf_consume(custom_dsq)` from `ops.dispatch()`, which moves the task to the local DSQ

---

## Putting It All Together: The scx_simple Scheduler

The `scx_simple` scheduler in the `sched_ext/scx` tools repository is the canonical minimal example. Here is an annotated version that ties together all the concepts:

```
Load time:
  1. Userspace calls minimal_sched__open_and_load()
  2. BPF verifier runs — validates all callbacks
  3. Kernel calls ops.init() — BPF creates any global state
  4. For each existing SCHED_EXT task:
       ops.init_task(p, ...) → ops.enable(p)

Run time (task wakeup):
  1. Task T wakes from sleep (I/O, timer, etc.)
  2. Kernel calls ops.select_cpu(T, prev_cpu, SCX_WAKE_TTWU)
     → BPF returns a CPU (or -1 for kernel to decide)
  3. Kernel calls ops.runnable(T, SCX_ENQ_WAKEUP)
     → BPF notes T is now runnable (accounting only)
  4. Kernel calls ops.enqueue(T, SCX_ENQ_WAKEUP)
     → BPF calls scx_bpf_dispatch(T, SCX_DSQ_GLOBAL, SCX_SLICE_DFL, ...)
  5. T is now in the global DSQ

Run time (CPU needs a task):
  1. CPU N's local DSQ is empty; it's about to go idle
  2. ext_sched_class.pick_next_task() is called
  3. Local DSQ is empty; kernel calls ops.dispatch(N, prev_task)
  4. BPF calls scx_bpf_consume(SCX_DSQ_GLOBAL)
     → Moves T from global DSQ to CPU N's local DSQ
     → Returns true
  5. kernel picks T from local DSQ
  6. ops.running(T) called — T is now executing

Run time (task runs out of time):
  1. T's p->scx.slice reaches 0 (decremented by timer tick)
  2. TIF_NEED_RESCHED set; T preempted at next safe point
  3. ops.stopping(T, true) called — T still runnable
  4. ops.enqueue(T, 0) called — T re-enqueued
  5. [cycle repeats]

Unload time:
  1. Userspace calls minimal_sched__destroy()
  2. Kernel activates SCX_BYPASS mode
  3. All runqueue tasks migrated to CFS
  4. ops.exit(exit_info) called
  5. BPF program freed
  6. SCHED_EXT tasks continue running on CFS
```

---

## Glossary

**BPF verifier**: The kernel's static analyzer that validates BPF programs at load time. Checks memory safety, bounds, types, and termination before any code runs.

**bypass mode** (`SCX_BYPASS`): A kernel state where the BPF scheduler is skipped and all tasks fall back to CFS. Activated during the disable path (watchdog, sysrq-S, or `scx_bpf_exit()`).

**CO-RE** (Compile Once, Run Everywhere): The BPF mechanism that allows BPF programs compiled against one kernel version's BTF type info to run on different kernel versions, with field offsets adjusted at load time.

**core scheduling**: A Linux security feature (`CONFIG_SCHED_CORE`) that prevents tasks with different `core_sched_cookie` values from running simultaneously on SMT siblings. Mitigates MDS/Spectre-class side-channel attacks.

**direct dispatch**: Calling `scx_bpf_dispatch()` from within `ops.select_cpu()` instead of from `ops.enqueue()`. When used, `ops.enqueue()` is skipped for that task, reducing callback overhead.

**DSQ** (Dispatch Queue): A queue of tasks waiting to be scheduled. The fundamental data structure in sched_ext. Three kinds: global (`SCX_DSQ_GLOBAL`), per-CPU local (`SCX_DSQ_LOCAL`), and custom (BPF-created).

**`ext_sched_class`**: The kernel `sched_class` struct that implements the sched_ext scheduling class. Lives in `kernel/sched/ext.c`. Fourth in the scheduler hierarchy, below RT and above idle.

**ops_state**: The state machine tracking a task's relationship with the BPF scheduler. Values: `SCX_OPSS_NONE`, `SCX_OPSS_INIT_DONE`, `SCX_OPSS_ENABLED`, `SCX_OPSS_DISABLED`.

**`scx_entity`**: Per-task sched_ext state embedded in `task_struct` at `task_struct.scx`. Contains DSQ membership, vtime, slice, weight, and state flags.

**`sched_ext_ops`**: The BPF vtable. A struct of function pointers that the BPF program fills in. The kernel calls these functions to implement scheduling policy. The BPF program registers this via the `.struct_ops.link` ELF section.

**`SCX_DSQ_GLOBAL`** (= 0): The built-in global FIFO DSQ shared by all CPUs. The kernel automatically drains it into per-CPU local DSQs. The simplest way to use sched_ext.

**`SCX_DSQ_LOCAL`** (= 1): The symbolic ID meaning "this CPU's local DSQ." Each CPU has a private local DSQ; `ext_sched_class.pick_next_task()` dequeues exclusively from it.

**`SCX_DSQ_LOCAL_ON(cpu)`**: A macro that produces the DSQ ID for a specific CPU's local DSQ. Used to dispatch a task directly to a target CPU, bypassing the usual enqueue flow.

**`SCX_SLICE_DFL`**: A constant representing the default time slice duration. Configurable via sysfs. Approximately 20ms by default.

**`SCX_SLICE_INF`**: A constant representing an infinite time slice. Used when the BPF scheduler manages preemption explicitly rather than relying on periodic timer ticks.

**`SCX_TASK_DISALLOW`**: A flag on `scx_entity` indicating that the BPF scheduler rejected this task (e.g., `ops.init_task()` returned an error). The task runs on CFS instead.

**skeleton** (`*.skel.h`): A generated C header file produced by `bpftool gen skeleton`. Provides type-safe C wrappers for opening, loading, attaching, and destroying a specific BPF program.

**slice**: The duration (in nanoseconds) allocated to a task for one scheduling quantum. Set by BPF via the `slice` parameter of `scx_bpf_dispatch()`. Decremented by timer ticks. When it reaches zero, the task is preempted.

**`struct_ops`**: A BPF program type that implements a kernel "struct of callbacks" interface. sched_ext uses struct_ops to implement the `sched_ext_ops` vtable in BPF. The BPF verifier applies callback-specific rules to each function in the struct.

**vtime** (virtual time): A monotonically increasing per-task counter used for weighted fair scheduling. In a vtime-ordered DSQ, tasks with smaller vtime run first. High-weight tasks advance their vtime more slowly, giving them higher effective priority.

**watchdog**: A kernel timer that fires every `timeout_ms / 2` milliseconds and checks if any SCHED_EXT task has been runnable but unscheduled for longer than `timeout_ms`. If detected, triggers the disable path and logs an error.

---

## Further Reading

For readers who want to go deeper, the following are the canonical sources:

- **Kernel source**: `kernel/sched/ext.c` — the sched_ext implementation (~4000 lines)
- **Kernel headers**: `include/linux/sched/ext.h` — `sched_ext_ops`, `scx_entity`, and all public types
- **BPF helpers**: `include/uapi/linux/bpf.h` — helper function declarations
- **Example schedulers**: `tools/sched_ext/` in the kernel tree (or the `sched-ext/scx` GitHub repo)
  - `scx_simple`: minimal FIFO scheduler (global DSQ only)
  - `scx_central`: centralized dispatch pattern
  - `scx_flatcg`: cgroup-aware scheduler
  - `scx_rustland`: userspace scheduling via io_uring, written in Rust
  - `scx_layered`: production-quality layered scheduler (used at Meta)
- **Selftests**: `tools/testing/selftests/sched_ext/`
- **Design document**: `Documentation/scheduler/sched-ext.rst` in the kernel tree
