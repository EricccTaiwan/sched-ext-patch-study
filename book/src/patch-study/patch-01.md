# [PATCH 01/30] sched: Restructure sched_class order sanity checks in sched_init()

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-2-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-2-tj@kernel.org)

## Commit Message

```text
Currently, sched_init() checks that the sched_class'es are in the expected
order by testing each adjacency which is a bit brittle and makes it
cumbersome to add optional sched_class'es. Instead, let's verify whether
they're in the expected order using sched_class_above() which is what
matters.

Signed-off-by: Tejun Heo <tj@kernel.org>
Suggested-by: Peter Zijlstra <peterz@infradead.org>
Reviewed-by: David Vernet <dvernet@meta.com>
---
 kernel/sched/core.c | 8 ++++----
 1 file changed, 4 insertions(+), 4 deletions(-)

diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 0935f9d4bb7b..b4d4551bc7f2 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -8164,12 +8164,12 @@ void __init sched_init(void)
 	int i;
 
 	/* Make sure the linker didn't screw up */
-	BUG_ON(&idle_sched_class != &fair_sched_class + 1 ||
-	       &fair_sched_class != &rt_sched_class + 1 ||
-	       &rt_sched_class   != &dl_sched_class + 1);
 #ifdef CONFIG_SMP
-	BUG_ON(&dl_sched_class != &stop_sched_class + 1);
+	BUG_ON(!sched_class_above(&stop_sched_class, &dl_sched_class));
 #endif
+	BUG_ON(!sched_class_above(&dl_sched_class, &rt_sched_class));
+	BUG_ON(!sched_class_above(&rt_sched_class, &fair_sched_class));
+	BUG_ON(!sched_class_above(&fair_sched_class, &idle_sched_class));
 
 	wait_bit_init();
 
-- 
2.45.2
```

## Diff

```diff
---
 kernel/sched/core.c | 8 ++++----
 1 file changed, 4 insertions(+), 4 deletions(-)

diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 0935f9d4bb7b..b4d4551bc7f2 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -8164,12 +8164,12 @@ void __init sched_init(void)
 	int i;

 	/* Make sure the linker didn't screw up */
-	BUG_ON(&idle_sched_class != &fair_sched_class + 1 ||
-	       &fair_sched_class != &rt_sched_class + 1 ||
-	       &rt_sched_class   != &dl_sched_class + 1);
 #ifdef CONFIG_SMP
-	BUG_ON(&dl_sched_class != &stop_sched_class + 1);
+	BUG_ON(!sched_class_above(&stop_sched_class, &dl_sched_class));
 #endif
+	BUG_ON(!sched_class_above(&dl_sched_class, &rt_sched_class));
+	BUG_ON(!sched_class_above(&rt_sched_class, &fair_sched_class));
+	BUG_ON(!sched_class_above(&fair_sched_class, &idle_sched_class));

 	wait_bit_init();

--
2.45.2


```

## Implementation Analysis

### Overview

This patch replaces fragile pointer-arithmetic sanity checks in `sched_init()` with semantic checks using `sched_class_above()`. While it appears small, it is the foundational prerequisite that makes inserting `ext_sched_class` between `fair_sched_class` and `idle_sched_class` possible: the old checks hardcoded strict memory adjacency between every existing class pair, so adding any new class in the middle would have caused a boot-time `BUG()`.

### Background: The Linux Scheduler Class Hierarchy

The Linux kernel uses a chain of `struct sched_class` objects to implement scheduler policy dispatch. Each class handles a specific scheduling policy (e.g., real-time, CFS, deadline). The chain is ordered by priority — highest-priority classes are checked first when the kernel selects the next task to run.

The ordering at the time of this patch (highest to lowest):

```
stop_sched_class  (SMP only — stop-machine tasks)
      |
dl_sched_class    (SCHED_DEADLINE)
      |
rt_sched_class    (SCHED_FIFO, SCHED_RR)
      |
fair_sched_class  (SCHED_NORMAL, SCHED_BATCH — CFS)
      |
idle_sched_class  (SCHED_IDLE — per-CPU idle thread)
```

The sched_ext series inserts `ext_sched_class` between `fair_sched_class` and `idle_sched_class`, making the final chain:

```
stop → dl → rt → fair → ext → idle
```

The kernel walks this chain using `sched_class_above(a, b)`, which returns true if class `a` has higher scheduling priority than class `b`. Internally, the chain is implemented by placing the `sched_class` structs in a specific linker section so that pointer arithmetic (adding 1 to a class pointer) walks to the next lower-priority class. `sched_class_above()` exploits this layout — but that is an implementation detail that `sched_init()` must not rely on directly when validating the chain.

### The Problem Being Solved

Before this patch, `sched_init()` validated the class ordering by checking **pointer adjacency**:

```c
BUG_ON(&idle_sched_class != &fair_sched_class + 1 ||
       &fair_sched_class != &rt_sched_class + 1 ||
       &rt_sched_class   != &dl_sched_class + 1);
#ifdef CONFIG_SMP
BUG_ON(&dl_sched_class != &stop_sched_class + 1);
#endif
```

This checks that each pair of adjacent classes is separated by exactly one struct-sized step in memory. It is an implicit assertion that no other class exists between them. Inserting `ext_sched_class` between `fair_sched_class` and `idle_sched_class` would cause `&idle_sched_class != &fair_sched_class + 1` to be true, triggering `BUG()` at boot. The check must be removed or changed before sched_ext can be added.

Additionally, the check is semantically wrong: what actually matters for correctness is not whether two structs are adjacent in memory, but whether one class has higher priority than the other. The old code tests a storage layout, not the scheduling semantics.

### Code Walkthrough

The old block is removed entirely:

```c
-	BUG_ON(&idle_sched_class != &fair_sched_class + 1 ||
-	       &fair_sched_class != &rt_sched_class + 1 ||
-	       &rt_sched_class   != &dl_sched_class + 1);
-#ifdef CONFIG_SMP
-	BUG_ON(&dl_sched_class != &stop_sched_class + 1);
-#endif
```

It is replaced with individual pairwise checks using `sched_class_above()`:

```c
#ifdef CONFIG_SMP
	BUG_ON(!sched_class_above(&stop_sched_class, &dl_sched_class));
#endif
	BUG_ON(!sched_class_above(&dl_sched_class,  &rt_sched_class));
	BUG_ON(!sched_class_above(&rt_sched_class,  &fair_sched_class));
	BUG_ON(!sched_class_above(&fair_sched_class, &idle_sched_class));
```

Two structural differences are worth noting:

1. The `#ifdef CONFIG_SMP` now guards only the `stop`/`dl` check (stop is an SMP-only class), whereas the old code had the `#ifdef` wrapping a separate `BUG_ON` for the same reason — this is functionally equivalent.

2. The new checks assert non-adjacency-dependent priority ordering. They will remain true even after `ext_sched_class` is inserted between `fair_sched_class` and `idle_sched_class`, because `sched_class_above(&fair_sched_class, &idle_sched_class)` is still true with ext in between — `fair` is still above `idle` in the ordering.

No check is added for the `fair`/`ext` or `ext`/`idle` boundary here; that is left to a later patch when `ext_sched_class` is actually defined.

### Why sched_ext Needs This

Without this patch, the very first thing `sched_init()` does after `wait_bit_init()` would be to `BUG()` as soon as `ext_sched_class` is inserted. This patch is the minimal, non-functional blocker that must land before any patch that touches the linker-section placement of scheduler classes can be merged.

The change also establishes a clean contract: the scheduler class ordering is validated by its logical meaning (`sched_class_above`), not by a storage artifact. New optional classes can be inserted anywhere in the chain without touching this validation code.

### Connection to Other Patches

This is patch 01 in the series and has no dependencies on subsequent patches. All later patches in this series that add or rearrange scheduler classes depend on this change being in place. Without it, any patch that changes the physical layout of the `sched_class` linker section would produce a boot-time kernel panic.

### Key Data Structures / Functions Modified

- **`sched_init()`** (`kernel/sched/core.c`): The kernel's scheduler initialization function called once at boot. The sanity-check block near its top is the only thing changed.
- **`sched_class_above(a, b)`**: An existing inline helper defined in `kernel/sched/sched.h` that returns true if scheduler class `a` has higher priority than class `b`. It works by comparing the addresses of the two structs in the linker-ordered section — higher address means lower priority in the layout used by this kernel. This patch starts using it for validation rather than raw pointer arithmetic.

