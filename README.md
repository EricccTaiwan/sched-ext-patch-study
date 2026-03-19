# sched_ext (Extensible Scheduler Class) Patch Series Documentation

This repository documents and analyzes the sched_ext BPF extensible scheduler patch series (v7, June 2024).

## Overview

The project includes:
- A main study guide: [sched-ext-patch-study.md](sched-ext-patch-study.md)
- Per-patch analysis files: `patch-study/patch-01.md` through `patch-study/patch-30.md`
- Original source material: `source/scx-v7-patch.mbox`, `source/scx-v7-patch.mbox.gz`, and `source/original-patches/`
- Utility scripts for parsing and analysis generation in `scripts/`

## Patch Categories

- Foundational refactoring: patches 01-07
- sched_ext core: patches 08-11
- Debugging and monitoring: patches 12-16
- CPU coordination: patches 17-19
- Task management: patches 20-23
- System integration: patches 24-28
- Documentation and testing: patches 29-30

## What Each Patch File Contains

Each `patch-study/patch-XX.md` includes:
1. Commit message and rationale
2. Implementation analysis
3. Diff-focused breakdown
4. Link to the lore.kernel.org discussion thread

## Key Concepts

- BPF-based scheduler extensibility through `sched_ext`
- Safety via BPF verification and watchdog mechanisms
- Automatic fallback behavior when scheduler failures occur
- Dispatch queue (`dsq`) and task lifecycle control

## References

- Kernel repository: https://git.kernel.org/pub/scm/linux/kernel/git/tj/sched_ext.git
- sched_ext examples: https://github.com/sched-ext/scx
- Community Slack: https://bit.ly/scx_slack

## Notes

- Patch series version: v7 (June 2024)
- Target kernel line: Linux 6.11+
