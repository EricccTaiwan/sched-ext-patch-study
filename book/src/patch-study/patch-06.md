# [PATCH 06/30] sched: Factor out update_other_load_avgs() from __update_blocked_others()

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-7-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-7-tj@kernel.org)

## Commit Message

```text
RT, DL, thermal and irq load and utilization metrics need to be decayed and
updated periodically and before consumption to keep the numbers reasonable.
This is currently done from __update_blocked_others() as a part of the fair
class load balance path. Let's factor it out to update_other_load_avgs().
Pure refactor. No functional changes.

This will be used by the new BPF extensible scheduling class to ensure that
the above metrics are properly maintained.

v2: Refreshed on top of tip:sched/core.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
---
 kernel/sched/fair.c     | 16 +++-------------
 kernel/sched/sched.h    |  4 ++++
 kernel/sched/syscalls.c | 19 +++++++++++++++++++
 3 files changed, 26 insertions(+), 13 deletions(-)

diff --git a/kernel/sched/fair.c b/kernel/sched/fair.c
index 18ecd4f908e4..715d7c1f55df 100644
--- a/kernel/sched/fair.c
+++ b/kernel/sched/fair.c
@@ -9352,28 +9352,18 @@ static inline void update_blocked_load_status(struct rq *rq, bool has_blocked) {
 
 static bool __update_blocked_others(struct rq *rq, bool *done)
 {
-	const struct sched_class *curr_class;
-	u64 now = rq_clock_pelt(rq);
-	unsigned long hw_pressure;
-	bool decayed;
+	bool updated;
 
 	/*
 	 * update_load_avg() can call cpufreq_update_util(). Make sure that RT,
 	 * DL and IRQ signals have been updated before updating CFS.
 	 */
-	curr_class = rq->curr->sched_class;
-
-	hw_pressure = arch_scale_hw_pressure(cpu_of(rq));
-
-	decayed = update_rt_rq_load_avg(now, rq, curr_class == &rt_sched_class) |
-		  update_dl_rq_load_avg(now, rq, curr_class == &dl_sched_class) |
-		  update_hw_load_avg(now, rq, hw_pressure) |
-		  update_irq_load_avg(rq, 0);
+	updated = update_other_load_avgs(rq);
 
 	if (others_have_blocked(rq))
 		*done = false;
 
-	return decayed;
+	return updated;
 }
 
 #ifdef CONFIG_FAIR_GROUP_SCHED
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 656a63c0d393..a5a4f59151db 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -3074,6 +3074,8 @@ static inline void cpufreq_update_util(struct rq *rq, unsigned int flags) { }
 
 #ifdef CONFIG_SMP
 
+bool update_other_load_avgs(struct rq *rq);
+
 unsigned long effective_cpu_util(int cpu, unsigned long util_cfs,
 				 unsigned long *min,
 				 unsigned long *max);
@@ -3117,6 +3119,8 @@ static inline unsigned long cpu_util_rt(struct rq *rq)
 	return READ_ONCE(rq->avg_rt.util_avg);
 }
 
+#else /* !CONFIG_SMP */
+static inline bool update_other_load_avgs(struct rq *rq) { return false; }
 #endif /* CONFIG_SMP */
 
 #ifdef CONFIG_UCLAMP_TASK
diff --git a/kernel/sched/syscalls.c b/kernel/sched/syscalls.c
index cf189bc3dd18..050215ef8fa4 100644
--- a/kernel/sched/syscalls.c
+++ b/kernel/sched/syscalls.c
@@ -259,6 +259,25 @@ int sched_core_idle_cpu(int cpu)
 #endif
 
 #ifdef CONFIG_SMP
+/*
+ * Load avg and utiliztion metrics need to be updated periodically and before
+ * consumption. This function updates the metrics for all subsystems except for
+ * the fair class. @rq must be locked and have its clock updated.
+ */
+bool update_other_load_avgs(struct rq *rq)
+{
+	u64 now = rq_clock_pelt(rq);
+	const struct sched_class *curr_class = rq->curr->sched_class;
+	unsigned long hw_pressure = arch_scale_hw_pressure(cpu_of(rq));
+
+	lockdep_assert_rq_held(rq);
+
+	return update_rt_rq_load_avg(now, rq, curr_class == &rt_sched_class) |
+		update_dl_rq_load_avg(now, rq, curr_class == &dl_sched_class) |
+		update_hw_load_avg(now, rq, hw_pressure) |
+		update_irq_load_avg(rq, 0);
+}
+
 /*
  * This function computes an effective utilization for the given CPU, to be
  * used for frequency selection given the linear relation: f = u * f_max.
-- 
2.45.2
```

## Diff

```diff
---
 kernel/sched/fair.c     | 16 +++-------------
 kernel/sched/sched.h    |  4 ++++
 kernel/sched/syscalls.c | 19 +++++++++++++++++++
 3 files changed, 26 insertions(+), 13 deletions(-)

diff --git a/kernel/sched/fair.c b/kernel/sched/fair.c
index 18ecd4f908e4..715d7c1f55df 100644
--- a/kernel/sched/fair.c
+++ b/kernel/sched/fair.c
@@ -9352,28 +9352,18 @@ static inline void update_blocked_load_status(struct rq *rq, bool has_blocked) {

 static bool __update_blocked_others(struct rq *rq, bool *done)
 {
-	const struct sched_class *curr_class;
-	u64 now = rq_clock_pelt(rq);
-	unsigned long hw_pressure;
-	bool decayed;
+	bool updated;

 	/*
 	 * update_load_avg() can call cpufreq_update_util(). Make sure that RT,
 	 * DL and IRQ signals have been updated before updating CFS.
 	 */
-	curr_class = rq->curr->sched_class;
-
-	hw_pressure = arch_scale_hw_pressure(cpu_of(rq));
-
-	decayed = update_rt_rq_load_avg(now, rq, curr_class == &rt_sched_class) |
-		  update_dl_rq_load_avg(now, rq, curr_class == &dl_sched_class) |
-		  update_hw_load_avg(now, rq, hw_pressure) |
-		  update_irq_load_avg(rq, 0);
+	updated = update_other_load_avgs(rq);

 	if (others_have_blocked(rq))
 		*done = false;

-	return decayed;
+	return updated;
 }

 #ifdef CONFIG_FAIR_GROUP_SCHED
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 656a63c0d393..a5a4f59151db 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -3074,6 +3074,8 @@ static inline void cpufreq_update_util(struct rq *rq, unsigned int flags) { }

 #ifdef CONFIG_SMP

+bool update_other_load_avgs(struct rq *rq);
+
 unsigned long effective_cpu_util(int cpu, unsigned long util_cfs,
 				 unsigned long *min,
 				 unsigned long *max);
@@ -3117,6 +3119,8 @@ static inline unsigned long cpu_util_rt(struct rq *rq)
 	return READ_ONCE(rq->avg_rt.util_avg);
 }

+#else /* !CONFIG_SMP */
+static inline bool update_other_load_avgs(struct rq *rq) { return false; }
 #endif /* CONFIG_SMP */

 #ifdef CONFIG_UCLAMP_TASK
diff --git a/kernel/sched/syscalls.c b/kernel/sched/syscalls.c
index cf189bc3dd18..050215ef8fa4 100644
--- a/kernel/sched/syscalls.c
+++ b/kernel/sched/syscalls.c
@@ -259,6 +259,25 @@ int sched_core_idle_cpu(int cpu)
 #endif

 #ifdef CONFIG_SMP
+/*
+ * Load avg and utiliztion metrics need to be updated periodically and before
+ * consumption. This function updates the metrics for all subsystems except for
+ * the fair class. @rq must be locked and have its clock updated.
+ */
+bool update_other_load_avgs(struct rq *rq)
+{
+	u64 now = rq_clock_pelt(rq);
+	const struct sched_class *curr_class = rq->curr->sched_class;
+	unsigned long hw_pressure = arch_scale_hw_pressure(cpu_of(rq));
+
+	lockdep_assert_rq_held(rq);
+
+	return update_rt_rq_load_avg(now, rq, curr_class == &rt_sched_class) |
+		update_dl_rq_load_avg(now, rq, curr_class == &dl_sched_class) |
+		update_hw_load_avg(now, rq, hw_pressure) |
+		update_irq_load_avg(rq, 0);
+}
+
 /*
  * This function computes an effective utilization for the given CPU, to be
  * used for frequency selection given the linear relation: f = u * f_max.
--
2.45.2


```

## Implementation Analysis

### Overview

This patch extracts the per-CPU load average update logic for RT, DL, hardware pressure, and IRQ subsystems from `__update_blocked_others()` in `fair.c` into a standalone function `update_other_load_avgs()` in `syscalls.c`, declared in `sched.h`. The function is pure refactoring — no behavior changes. sched_ext needs it because the ext class has its own load balancing path that does not go through CFS's `__update_blocked_others()`, yet it still must keep these metrics current.

### The Problem Being Solved

Before this patch, the code that updates RT, DL, hardware pressure, and IRQ load averages lived exclusively inside `__update_blocked_others()`, a `static` function in `kernel/sched/fair.c`:

```c
curr_class = rq->curr->sched_class;
hw_pressure = arch_scale_hw_pressure(cpu_of(rq));

decayed = update_rt_rq_load_avg(now, rq, curr_class == &rt_sched_class) |
          update_dl_rq_load_avg(now, rq, curr_class == &dl_sched_class) |
          update_hw_load_avg(now, rq, hw_pressure) |
          update_irq_load_avg(rq, 0);
```

This function is called as part of CFS's blocked-load update path, which runs during CFS load balancing. The comment in `__update_blocked_others()` already acknowledged the coupling: RT, DL, and IRQ signals need to be updated before CFS updates its own load averages (because `update_load_avg()` can trigger `cpufreq_update_util()`).

sched_ext has its own load balancing code path that does not involve CFS's blocked-load update. If `update_other_load_avgs()` is only reachable through CFS, then when an ext-class CPU is idle or lightly loaded and CFS's path is not being run, the RT/DL/IRQ load metrics stagnate. Stale metrics affect CPU frequency selection and other consumers of these signals. The fix is to make the function independently callable.

### Code Walkthrough

**`kernel/sched/syscalls.c`** — the new function is defined here (under `#ifdef CONFIG_SMP`):

```c
bool update_other_load_avgs(struct rq *rq)
{
	u64 now = rq_clock_pelt(rq);
	const struct sched_class *curr_class = rq->curr->sched_class;
	unsigned long hw_pressure = arch_scale_hw_pressure(cpu_of(rq));

	lockdep_assert_rq_held(rq);

	return update_rt_rq_load_avg(now, rq, curr_class == &rt_sched_class) |
		update_dl_rq_load_avg(now, rq, curr_class == &dl_sched_class) |
		update_hw_load_avg(now, rq, hw_pressure) |
		update_irq_load_avg(rq, 0);
}
```

The logic is identical to what was in `__update_blocked_others()`. Notable additions compared to the original inline code:

- `lockdep_assert_rq_held(rq)`: An assertion that the caller holds the runqueue lock. This is a documentation-in-code improvement that catches misuse at compile/debug time.
- The function is placed in `syscalls.c` rather than `fair.c`, making it neutral with respect to scheduler class — it is not CFS-specific infrastructure.

**`kernel/sched/fair.c`** — `__update_blocked_others()` is simplified:

```c
 static bool __update_blocked_others(struct rq *rq, bool *done)
 {
-	const struct sched_class *curr_class;
-	u64 now = rq_clock_pelt(rq);
-	unsigned long hw_pressure;
-	bool decayed;
+	bool updated;

 	/*
 	 * update_load_avg() can call cpufreq_update_util(). Make sure that RT,
 	 * DL and IRQ signals have been updated before updating CFS.
 	 */
-	curr_class = rq->curr->sched_class;
-	hw_pressure = arch_scale_hw_pressure(cpu_of(rq));
-	decayed = update_rt_rq_load_avg(...) | update_dl_rq_load_avg(...) | ...;
+	updated = update_other_load_avgs(rq);

 	if (others_have_blocked(rq))
 		*done = false;

-	return decayed;
+	return updated;
 }
```

The body is replaced by a single call site. The variable rename from `decayed` to `updated` is cosmetic but more accurate — the return value indicates whether any metric was updated, not specifically whether any load average decayed.

**`kernel/sched/sched.h`** — declaration and no-op stub:

```c
#ifdef CONFIG_SMP
bool update_other_load_avgs(struct rq *rq);
...
#else /* !CONFIG_SMP */
static inline bool update_other_load_avgs(struct rq *rq) { return false; }
#endif /* CONFIG_SMP */
```

The `!CONFIG_SMP` stub returns false (no updates occurred), which is correct because on a single-CPU system these per-runqueue averages are not meaningful for load balancing.

### Why sched_ext Needs This

sched_ext performs its own per-CPU scheduling decisions and implements a load balancing path independent of CFS. If the CFS blocked-load update path (`update_blocked_averages()`) is not running for a given CPU — which can happen when the CPU is under ext-class control — then RT, DL, hardware pressure, and IRQ load averages will not be updated. These metrics are consumed by `effective_cpu_util()` and the cpufreq governor, so stale values can cause incorrect frequency scaling.

By factoring out `update_other_load_avgs()`, the sched_ext load balancing code can call it directly to ensure the metrics stay current regardless of whether the CFS path runs.

### Connection to Other Patches

This patch does not depend on earlier patches in the series. It is a prerequisite for the sched_ext load balancing implementation later in the series, which will call `update_other_load_avgs()` from the ext class's equivalent of `update_blocked_averages()`.

### Key Data Structures / Functions Modified

- **`update_other_load_avgs()`** (`kernel/sched/syscalls.c`, declared in `kernel/sched/sched.h`): New function. Updates RT, DL, hardware pressure, and IRQ load averages for a given runqueue. Requires the runqueue lock to be held.
- **`__update_blocked_others()`** (`kernel/sched/fair.c`): CFS internal function called during blocked-load accounting. Simplified to delegate to `update_other_load_avgs()`.
- **`update_rt_rq_load_avg()` / `update_dl_rq_load_avg()` / `update_hw_load_avg()` / `update_irq_load_avg()`**: Existing per-subsystem load average update functions now called through `update_other_load_avgs()`. Their signatures are unchanged.

