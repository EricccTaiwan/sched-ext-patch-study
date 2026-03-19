# Introduction

`sched_ext` is a Linux kernel feature that allows BPF programs to implement custom CPU scheduling policies, replacing or extending the default scheduler at runtime without modifying kernel source.

This book covers:
- A repository overview and high-level architecture guide
- A complete conceptual explainer of how sched_ext works
- Patch-by-patch analysis across all 42 patches in the upstream submission

## Recommended Reading Path

- **New to sched_ext?** Start with **How sched_ext Works** for a complete conceptual overview of the architecture, data flow, and BPF ops interface.
- **Want the big picture first?** Read the **High-Level Study Guide** for a structured summary of the patch series goals and design decisions.
- **Ready to dive into patches?** Use the **Patch Study** section to trace the implementation patch by patch.

Commit messages and diffs are preserved verbatim from the original mailing list submissions.
