# sched_ext Patch Series: High-Level Study Guide

## Executive Summary

This repository captures the design evolution of `sched_ext`: a Linux scheduler class that allows policy to move from static kernel logic into verified BPF programs. The patch series does more than add features. It establishes a new scheduler development model: programmable, observable, and fail-safe.

At a high level, the series delivers three outcomes:
- A programmable control plane for scheduling policy
- A safety framework that preserves system stability
- Operational tooling for debugging, validation, and iteration

## Why This Series Matters

Traditional scheduler development requires deep kernel changes for each policy experiment. `sched_ext` changes that constraint by separating:
- **Mechanism in kernel space**: lifecycle hooks, dispatch paths, safety boundaries
- **Policy in BPF space**: queueing strategy, prioritization, and adaptation logic

This architecture enables faster policy experimentation while retaining kernel-grade safety expectations.

## Architectural Vision

`sched_ext` is best understood as an interface layer between the kernel scheduler core and policy logic authored in BPF.

```text
Policy intent (BPF schedulers)
  -> verified callbacks and helpers
  -> sched_ext dispatch and lifecycle framework
  -> kernel scheduling execution
```

Design principles that appear throughout the patches:
- **Programmability**: expose stable hooks and helper APIs
- **Containment**: constrain failure domains and recover predictably
- **Observability**: make scheduler behavior inspectable in production
- **Interoperability**: coexist with existing scheduler subsystems

## sched_ext in Practice

Beyond architecture, `sched_ext` defines a concrete runtime contract between the kernel and a BPF scheduler implementation.

### Execution Contract

At runtime, the kernel scheduler core still owns CPU time accounting, task state transitions, and correctness invariants. A BPF scheduler participates by implementing callbacks and using helper APIs to make policy decisions.

In practical terms, this means:
- The kernel decides **when** scheduling decisions are required
- The BPF program decides **which runnable tasks** to prioritize and dispatch
- Shared queues and dispatch structures carry intent from BPF policy into kernel execution

This split preserves deterministic kernel mechanics while making policy iteration significantly faster.

### Policy Surface Exposed by sched_ext

The patch series gradually opens policy control in a structured way:
- Task selection and dispatch ordering
- CPU-local vs system-wide coordination decisions
- Preemption and kick semantics for responsiveness
- Scheduler behavior during transitions such as hotplug and PM events

The key point is that `sched_ext` is not one scheduler policy. It is an extensible policy framework.

### Reliability Model

`sched_ext` assumes policies may be imperfect during development and explicitly optimizes for safe failure.

Reliability patterns repeated across the series:
- Runtime watchdogs to detect policy stalls
- Debug dump paths to shorten mean time to diagnosis
- Controlled disable / fallback behavior when integrity checks fail
- Clear lifecycle boundaries to avoid inconsistent in-flight state

This reliability-first posture is what makes sched_ext viable on real systems rather than only in lab experiments.

### Why This Is Different from Earlier Scheduler Experimentation

Historically, scheduler experimentation often required kernel forks, out-of-tree patches, and difficult rebases. `sched_ext` changes the economics:
- Faster policy iteration without repeatedly modifying scheduler core internals
- Better observability during policy development and production testing
- Cleaner collaboration model between kernel maintainers and policy authors

In effect, `sched_ext` moves scheduler innovation from "patching core logic every time" to "evolving policy on top of a hardened kernel interface."

## Evolution Across the Series

The series progresses in clear layers. This sequencing is intentional and reflects engineering priorities.

### 1) Foundations (Patches 01-07)
Refactors and ordering semantics that prepare the scheduler core for extension points.

### 2) Core Bring-Up (Patches 08-11)
Introduces the core `sched_ext` framework, initial integrations, and recovery pathways.

### 3) Diagnostics and Reliability (Patches 12-16)
Adds watchdogs, diagnostics, and operational visibility needed for safe adoption.

### 4) Coordination Semantics (Patches 17-19)
Builds CPU coordination and control mechanics that support multi-CPU correctness.

### 5) Task and Operation Lifecycle (Patches 20-23)
Strengthens state tracking and synchronization across in-flight scheduler operations.

### 6) System Integration (Patches 24-28)
Integrates with power management, hotplug behavior, and core scheduling contexts.

### 7) Documentation and Validation (Patches 29-30)
Consolidates reference documentation and selftests to support repeatable use.

## Operating Model: Safety by Design

`sched_ext` is designed for controlled extensibility rather than unrestricted scheduler replacement.

Key safeguards include:
- Verification and bounded interfaces for BPF-based logic
- Watchdog and fault-detection paths for runtime anomalies
- Fallback behavior to preserve forward progress under failure
- Explicit lifecycle hooks for cleanup and consistency

The result is a model where experimentation can move faster without compromising system availability.

## Adoption Mindset

For teams evaluating sched_ext, the series suggests a practical rollout pattern:
- Start with reference schedulers and selftests to validate kernel behavior
- Add policy complexity incrementally while monitoring watchdog and debug signals
- Treat fallback behavior as a first-class production control, not an edge case

This approach aligns with the design intent of the series: rapid policy experimentation with explicit operational guardrails.

## What to Read, Depending on Goal

### Strategic understanding
Read this document, then review:
- `patch-study/patch-09.md` (core architecture)
- `patch-study/patch-29.md` (formal documentation)
- `patch-study/patch-30.md` (validation and tests)

### Systems integration focus
Review:
- `patch-study/patch-24.md` through `patch-study/patch-28.md`

### Reliability and debugging focus
Review:
- `patch-study/patch-11.md` through `patch-study/patch-16.md`

## Repository Map

- Main overview: `README.md`
- High-level guide: `sched-ext-patch-study.md`
- Patch analyses: `patch-study/patch-01.md` ... `patch-study/patch-30.md`
- Original sources: `source/scx-v7-patch.mbox`, `source/scx-v7-patch.mbox.gz`, `source/original-patches/`
- Utilities: `scripts/`

## References

- Kernel tree (sched_ext): https://git.kernel.org/pub/scm/linux/kernel/git/tj/sched_ext.git
- Example schedulers and tooling: https://github.com/sched-ext/scx
- Community workspace: https://bit.ly/scx_slack

## Metadata

- Patch series: v7 (June 2024)
- Target kernel line: Linux 6.11+
