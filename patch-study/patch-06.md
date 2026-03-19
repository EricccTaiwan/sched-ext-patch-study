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

### High-Level Analysis
RT, DL, thermal and irq load and utilization metrics need to be decayed and

### Detailed Walkthrough
1. File: `kernel/sched/fair.c`
   Hunk: `@@ -9352,28 +9352,18 @@ static inline void update_blocked_load_status(struct rq *rq, bool has_blocked) {`
   Before
   ```text
   const struct sched_class *curr_class;
   u64 now = rq_clock_pelt(rq);
   unsigned long hw_pressure;
   ```
   After
   ```text
   bool updated;
   updated = update_other_load_avgs(rq);
   return updated;
   ```
2. File: `kernel/sched/sched.h`
   Hunk: `@@ -3074,6 +3074,8 @@ static inline void cpufreq_update_util(struct rq *rq, unsigned int flags) { }`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   bool update_other_load_avgs(struct rq *rq);
   
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```
3. File: `kernel/sched/syscalls.c`
   Hunk: `@@ -259,6 +259,25 @@ int sched_core_idle_cpu(int cpu)`
   Before
   ```text
   -
   ```
   After
   ```text
   /*
   * Load avg and utiliztion metrics need to be updated periodically and before
   * consumption. This function updates the metrics for all subsystems except for
   ```

### sched_ext Context
This patch is mostly structural, but the cleanup reduces coupling and gives later sched_ext patches a safer place to hook in.

