# Documentation and Testing (Patches 29–30)

## Overview

A feature that cannot be verified is a feature that cannot be maintained. Patches 29 and 30
close the loop on the sched_ext series by providing the official reference documentation and a
kernel self-test suite. These are not peripheral additions — in the Linux kernel review process,
documentation and selftests are expected for any significant feature that targets mainline, and
their quality signals the maturity and maintainability of the feature itself.

Patch 29 adds `Documentation/scheduler/sched-ext.rst`, the canonical prose documentation for
the sched_ext framework. Patch 30 adds `tools/testing/selftests/sched_ext/`, a test suite that
exercises the correctness of the core dispatch mechanism, error handling, and DSQ lifecycle.

For a maintainer, these two patches are as important as the implementation patches. The
documentation defines the contract that future patches must preserve. The selftests define the
behavioral invariants that regressions must not break.

## Why These Patches Are Needed

### The Documentation Gap

By the time the implementation patches are in place (patches 08–12 and 20–28), a developer
wanting to write a BPF scheduler must understand:

- What `sched_ext_ops` callbacks are available and when each is called.
- The dispatch queue concept and the relationship between global DSQ, local DSQs, and user DSQs.
- How tasks move through the scheduler lifecycle.
- What BPF helpers are available and what each one does.
- What happens when the BPF scheduler makes an error.
- How to load and unload a BPF scheduler safely.

This information is scattered across `include/linux/sched/ext.h`, `kernel/sched/ext.c`, and the
example schedulers. Without a unified reference document, every new sched_ext developer would
have to reverse-engineer these contracts from source code. Patch 29 provides the unified
reference.

### The Testing Gap

The core sched_ext patches are large and complex. Manual testing with `scx_simple` and
`scx_example_qmap` verifies that the happy path works, but does not verify:

- What happens when `scx_bpf_dispatch()` is called with an invalid DSQ ID?
- What happens when `ops.enqueue()` dispatches to a local DSQ of a different CPU?
- What happens when the BPF scheduler tries to use vtime ordering on a FIFO DSQ?
- What happens when the scheduler exits cleanly vs. exits with an error?

Without automated tests covering these cases, a future change to the dispatch or DSQ code
could break error handling silently — the system might panic, return incorrect results, or
silently succeed when it should have triggered an error exit.

Patch 30 covers these cases systematically, providing regression protection for the behavioral
invariants established by the core implementation.

## Key Concepts

### PATCH 29 — Documentation/scheduler/sched-ext.rst

The documentation is structured as a developer reference, not a tutorial. It covers:

**Framework overview**: What sched_ext is, what problem it solves, and how it relates to the
existing scheduler class hierarchy. This section explains the positioning of `ext_sched_class`
between `fair_sched_class` and `idle_sched_class` and what it means for task priorities.

**Writing a BPF scheduler**: A walkthrough of the minimal BPF scheduler (equivalent to
`scx_simple`) with annotations explaining each callback and helper. This section establishes
the conceptual model: the BPF program implements `struct sched_ext_ops`, and each operation
callback corresponds to a specific scheduling event.

**The ops callback reference**: For each `sched_ext_ops` member function:
- When it is called (the kernel event that triggers it).
- What the BPF program is expected to do (the contract).
- What happens if the BPF program does not implement it (the default behavior).
- What happens if the BPF program returns an error (the error exit conditions).

This reference is the normative specification for sched_ext behavior. Any future change to when
a callback is called, or to the contract of what the BPF program must do, is a change to this
specification and must update the documentation.

**Dispatch queue concept**: Explains the three DSQ types (global, local, user-defined), how
tasks flow between them, and the lifecycle of a user-defined DSQ (create in `ops.init()`,
destroy in `ops.exit()`). The documentation makes explicit that tasks must always end up in a
DSQ — there is no mechanism for a BPF program to "hold" a task without placing it in a queue.

**BPF helper reference**: For each `scx_bpf_*` function:
- Its signature and arguments.
- Pre/post conditions (what must be true before calling, what is guaranteed after).
- Which `sched_ext_ops` callbacks it may be called from.
- Thread safety guarantees.

**Error handling and exit states**: Explains the difference between:
- `SCX_EXIT_NONE` (scheduler not loaded or shut down cleanly).
- `SCX_EXIT_DONE` (BPF program called `scx_bpf_exit()` explicitly — clean shutdown).
- `SCX_EXIT_UNREG` (BPF program unregistered via bpftool/BPF link drop).
- `SCX_EXIT_ERROR` (kernel detected misbehavior — watchdog, invalid dispatch, etc.).
- `SCX_EXIT_SYSRQ` (user pressed Alt+SysRq+S).

Understanding exit states is critical for operators diagnosing why a BPF scheduler terminated.

**Example usage**: Shows how to load a BPF scheduler using `bpf_skel__open()`, set ops
callbacks, and load it into the kernel. This section is aimed at BPF scheduler developers who
need a quick start guide.

### PATCH 30 — tools/testing/selftests/sched_ext/

The test suite in `tools/testing/selftests/sched_ext/` consists of several test programs, each
testing a specific behavioral aspect of the sched_ext implementation. The tests are designed to
run without root (where possible) or with minimal privilege.

**DSQ creation and destruction (`test_create_dsq`)**: Creates a user-defined DSQ, dispatches
tasks to it, and then destroys it. Verifies:
- `scx_bpf_create_dsq()` succeeds with a valid ID.
- `scx_bpf_create_dsq()` fails with `EEXIST` if the ID is already taken.
- `scx_bpf_destroy_dsq()` correctly frees the DSQ.
- Using a destroyed DSQ in `scx_bpf_dispatch()` triggers an error exit.

**Dispatch to local DSQ (`test_local_dsq`)**: Dispatches tasks to the calling CPU's local DSQ
and verifies that they run. Verifies:
- Tasks dispatched to `SCX_DSQ_LOCAL` run on the dispatching CPU.
- Tasks dispatched to `SCX_DSQ_LOCAL_ON(cpu)` run on the specified CPU (cross-CPU dispatch).

**Error conditions (`test_bogus_dsq`, `test_vtime_misuse`)**: Intentionally misbehaves to
verify that the kernel's error detection works:
- `test_bogus_dsq`: Calls `scx_bpf_dispatch(p, INVALID_DSQ_ID, ...)`. Verifies that the
  scheduler exits with `SCX_EXIT_ERROR`, not with a kernel panic.
- `test_vtime_misuse`: Mixes FIFO and vtime dispatches to the same DSQ. Verifies that this
  triggers an error exit with a meaningful reason string.

**Local-on dispatch (`test_local_on`)**: Tests the `SCX_DSQ_LOCAL_ON` mechanism where a task
is dispatched to a specific CPU's local DSQ from a different CPU. Verifies that the task
actually runs on the target CPU (CPU affinity is respected in dispatch).

**Enqueue flags (`test_enqueue_flags`)**: Tests the `SCX_ENQ_*` flags that control enqueue
behavior:
- `SCX_ENQ_WAKEUP`: Task is waking up from sleep.
- `SCX_ENQ_LAST`: This is the last task being enqueued in a batch.
- `SCX_ENQ_HEAD`: Task should go to the head of its DSQ (priority boost).

**Exit behavior (`test_exit`)**: Verifies the clean shutdown path:
- BPF scheduler calls `scx_bpf_exit(reason)` explicitly.
- The scheduler exits with `SCX_EXIT_DONE`, not `SCX_EXIT_ERROR`.
- The `reason` string is available in the exit state debugfs files.
- All tasks return to CFS after the scheduler exits.

**prog_run test (`test_prog_run`)**: Uses `BPF_PROG_RUN` to invoke individual BPF callbacks
(without loading the full scheduler) and verifies their return values and side effects. This
allows unit testing of individual callbacks in isolation — without paying the overhead of
loading a full BPF scheduler for each test case.

The `prog_run` approach is particularly valuable for testing error conditions: you can inject
invalid arguments (e.g., a NULL task pointer, an out-of-range CPU ID) directly into a callback
and verify that the callback returns the expected error code without needing to reproduce the
exact kernel state that would naturally trigger that condition.

**Test infrastructure**: The test suite uses the kernel's `kselftest` framework:
- Tests are run by `make -C tools/testing/selftests/sched_ext run_tests`.
- Each test is a separate binary that forks a worker process, loads the BPF test scheduler,
  runs the test scenario, and checks the result.
- Tests that require `CAP_BPF` (loading BPF programs) are automatically skipped in unprivileged
  environments.
- Tests verify cleanup: after each test, the BPF scheduler is unloaded and all tasks return to
  CFS. A test that leaks a loaded BPF scheduler causes subsequent tests to fail, providing
  built-in leak detection.

## Connections Between Patches

```
PATCH 29 (documentation)
    └─→ Documents the contracts established by PATCHES 08-28
    └─→ The ops callback reference is the normative specification that PATCH 30
        tests verify against

PATCH 30 (selftests)
    └─→ Tests the core dispatch mechanism from PATCH 09
    └─→ Tests the error exit paths that PATCHES 11-12 implement
    └─→ Tests DSQ vtime ordering from PATCH 28
    └─→ Tests the lifecycle callbacks from PATCH 20 via prog_run
```

## What to Focus On

**For a maintainer**, the critical lessons from this group:

1. **Documentation as specification.** The `sched-ext.rst` document is the normative
   specification for sched_ext behavior. When a patch changes when a callback is called, or
   changes the contract of a BPF helper, the documentation must be updated in the same patch.
   Accepting a behavioral change without a documentation update creates a situation where the
   code and spec diverge, making it impossible for BPF scheduler developers to know which to
   trust.

2. **Selftest coverage as a merge gate.** In the Linux kernel, selftests for a feature are
   expected to pass before the feature is merged. When reviewing future sched_ext patches that
   change behavioral aspects (e.g., new exit conditions, new DSQ ordering modes, new enqueue
   flags), verify that the selftest suite covers the new behavior. A patch that adds a new
   feature without a corresponding selftest case creates a gap that will likely be exploited
   by a future regression.

3. **Error path testing.** The `test_bogus_dsq` and `test_vtime_misuse` tests are specifically
   testing error paths — they intentionally trigger misbehavior and verify the kernel's
   response. These tests are more valuable than happy-path tests from a maintenance perspective
   because they verify that the safety mechanisms work. When reviewing the selftests, be
   skeptical of any feature that has no error path tests.

4. **The prog_run approach for unit testing.** `test_prog_run` demonstrates how to test
   individual BPF callbacks in isolation using `BPF_PROG_RUN`. This technique should be used
   for any new BPF callback that has non-trivial logic. Unit testing callbacks in isolation
   is faster, more targeted, and easier to debug than full integration tests that require
   reproducing complex scheduler state.

5. **Test cleanup as a first-class concern.** Each test verifies that cleanup is complete:
   BPF scheduler unloaded, all tasks on CFS, no leaked DSQs. This cleanup verification is
   not just housekeeping — it is a test of the `scx_ops_disable_workfn()` path. A future
   change to the disable path that introduces a cleanup bug will be caught by the first test
   that runs after the broken test. Maintaining this cleanup discipline in new tests is
   essential.

6. **rst documentation format and kernel doc conventions.** `sched-ext.rst` follows the kernel
   documentation conventions: reStructuredText format, cross-references to other kernel docs
   using `:doc:` roles, function documentation using `.. c:function::` directives. When adding
   new sections to this document or adding documentation for new BPF helpers, follow these
   conventions to ensure the document renders correctly in `make htmldocs` and integrates with
   the kernel's documentation build system.
