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
This patch improves the robustness of scheduler class hierarchy validation by replacing fragile linker-dependent address comparisons with semantic checks using `sched_class_above()`.

### The Problem with the Old Approach

The previous implementation relied on **linker-enforced memory layout**:

```c
BUG_ON(&idle_sched_class != &fair_sched_class + 1 ||
       &fair_sched_class != &rt_sched_class + 1 ||
       &rt_sched_class   != &dl_sched_class + 1);
```

**Issues with this approach**:
1. **Brittle**: Depends on linker script placement - any change breaks validation
2. **Non-semantic**: Checks memory adjacency, not the actual hierarchy relationship
3. **Unscalable**: Difficult to add optional scheduling classes (e.g., sched_ext) without modifying checks
4. **Implementation detail**: Exposes kernel internals rather than verifying logical properties

### The Solution: Semantic Checks

The new approach uses logical hierarchy validation:

```c
#ifdef CONFIG_SMP
	BUG_ON(!sched_class_above(&stop_sched_class, &dl_sched_class));
#endif
BUG_ON(!sched_class_above(&dl_sched_class, &rt_sched_class));
BUG_ON(!sched_class_above(&rt_sched_class, &fair_sched_class));
BUG_ON(!sched_class_above(&fair_sched_class, &idle_sched_class));
```

**Advantages**:
1. **Semantically correct**: Verifies the actual priority hierarchy that matters
2. **Flexible**: Works with optional or dynamically-added scheduler classes
3. **Future-proof**: Allows sched_ext and other new classes without code changes
4. **Clear intent**: Code explicitly shows the expected hierarchy

### Scheduling Class Hierarchy

The expected priority ordering (highest to lowest):
1. `stop_sched_class` - Stop/wake machine tasks (SMP only)
2. `dl_sched_class` - Deadline tasks (SCHED_DEADLINE)
3. `rt_sched_class` - Real-time tasks (SCHED_FIFO, SCHED_RR)
4. `fair_sched_class` - Normal tasks (SCHED_NORMAL) - CFS
5. `idle_sched_class` - Idle tasks (SCHED_IDLE)

Future additions (e.g., sched_ext) would fit between fair and idle:
- `stop_sched_class` → `dl_sched_class` → `rt_sched_class` → `fair_sched_class` → **`ext_sched_class`** → `idle_sched_class`

### How `sched_class_above()` Works

The function checks if one scheduling class has higher priority than another by traversing the class hierarchy. This is the proper way to validate scheduling policies, as it:
- Validates what matters: scheduling priority relationships
- Ignores implementation details: memory layout
- Supports extensibility: new classes can be inserted without validation changes

### Impact

**Lines changed**: 4 insertions, 4 deletions in `kernel/sched/core.c`

**Binary impact**: None - just changes compile-time validation

**Prerequisites for sched_ext**: This change is essential infrastructure that:
- Enables sched_ext to register itself in the scheduler hierarchy without modifying validation code
- Demonstrates the kernel's readiness for extensible scheduling classes
- Establishes the pattern for future scheduler class additions

