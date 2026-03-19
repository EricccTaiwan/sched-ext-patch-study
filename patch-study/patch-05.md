# [PATCH 05/30] sched: Factor out cgroup weight conversion functions

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-6-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-6-tj@kernel.org)

## Commit Message

```text
Factor out sched_weight_from/to_cgroup() which convert between scheduler
shares and cgroup weight. No functional change. The factored out functions
will be used by a new BPF extensible sched_class so that the weights can be
exposed to the BPF programs in a way which is consistent cgroup weights and
easier to interpret.

The weight conversions will be used regardless of cgroup usage. It's just
borrowing the cgroup weight range as it's more intuitive.
CGROUP_WEIGHT_MIN/DFL/MAX constants are moved outside CONFIG_CGROUPS so that
the conversion helpers can always be defined.

v2: The helpers are now defined regardless of COFNIG_CGROUPS.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 include/linux/cgroup.h |  4 ++--
 kernel/sched/core.c    | 28 +++++++++++++---------------
 kernel/sched/sched.h   | 18 ++++++++++++++++++
 3 files changed, 33 insertions(+), 17 deletions(-)

diff --git a/include/linux/cgroup.h b/include/linux/cgroup.h
index 2150ca60394b..3cdaec701600 100644
--- a/include/linux/cgroup.h
+++ b/include/linux/cgroup.h
@@ -29,8 +29,6 @@
 
 struct kernel_clone_args;
 
-#ifdef CONFIG_CGROUPS
-
 /*
  * All weight knobs on the default hierarchy should use the following min,
  * default and max values.  The default value is the logarithmic center of
@@ -40,6 +38,8 @@ struct kernel_clone_args;
 #define CGROUP_WEIGHT_DFL		100
 #define CGROUP_WEIGHT_MAX		10000
 
+#ifdef CONFIG_CGROUPS
+
 enum {
 	CSS_TASK_ITER_PROCS    = (1U << 0),  /* walk only threadgroup leaders */
 	CSS_TASK_ITER_THREADED = (1U << 1),  /* walk all threaded css_sets in the domain */
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index b088fbeaf26d..0bfbceebc4e9 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -9552,29 +9552,27 @@ static int cpu_local_stat_show(struct seq_file *sf,
 }
 
 #ifdef CONFIG_FAIR_GROUP_SCHED
+
+static unsigned long tg_weight(struct task_group *tg)
+{
+	return scale_load_down(tg->shares);
+}
+
 static u64 cpu_weight_read_u64(struct cgroup_subsys_state *css,
 			       struct cftype *cft)
 {
-	struct task_group *tg = css_tg(css);
-	u64 weight = scale_load_down(tg->shares);
-
-	return DIV_ROUND_CLOSEST_ULL(weight * CGROUP_WEIGHT_DFL, 1024);
+	return sched_weight_to_cgroup(tg_weight(css_tg(css)));
 }
 
 static int cpu_weight_write_u64(struct cgroup_subsys_state *css,
-				struct cftype *cft, u64 weight)
+				struct cftype *cft, u64 cgrp_weight)
 {
-	/*
-	 * cgroup weight knobs should use the common MIN, DFL and MAX
-	 * values which are 1, 100 and 10000 respectively.  While it loses
-	 * a bit of range on both ends, it maps pretty well onto the shares
-	 * value used by scheduler and the round-trip conversions preserve
-	 * the original value over the entire range.
-	 */
-	if (weight < CGROUP_WEIGHT_MIN || weight > CGROUP_WEIGHT_MAX)
+	unsigned long weight;
+
+	if (cgrp_weight < CGROUP_WEIGHT_MIN || cgrp_weight > CGROUP_WEIGHT_MAX)
 		return -ERANGE;
 
-	weight = DIV_ROUND_CLOSEST_ULL(weight * 1024, CGROUP_WEIGHT_DFL);
+	weight = sched_weight_from_cgroup(cgrp_weight);
 
 	return sched_group_set_shares(css_tg(css), scale_load(weight));
 }
@@ -9582,7 +9580,7 @@ static int cpu_weight_write_u64(struct cgroup_subsys_state *css,
 static s64 cpu_weight_nice_read_s64(struct cgroup_subsys_state *css,
 				    struct cftype *cft)
 {
-	unsigned long weight = scale_load_down(css_tg(css)->shares);
+	unsigned long weight = tg_weight(css_tg(css));
 	int last_delta = INT_MAX;
 	int prio, delta;
 
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 0ed4271cedf5..656a63c0d393 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -244,6 +244,24 @@ static inline void update_avg(u64 *avg, u64 sample)
 #define shr_bound(val, shift)							\
 	(val >> min_t(typeof(shift), shift, BITS_PER_TYPE(typeof(val)) - 1))
 
+/*
+ * cgroup weight knobs should use the common MIN, DFL and MAX values which are
+ * 1, 100 and 10000 respectively. While it loses a bit of range on both ends, it
+ * maps pretty well onto the shares value used by scheduler and the round-trip
+ * conversions preserve the original value over the entire range.
+ */
+static inline unsigned long sched_weight_from_cgroup(unsigned long cgrp_weight)
+{
+	return DIV_ROUND_CLOSEST_ULL(cgrp_weight * 1024, CGROUP_WEIGHT_DFL);
+}
+
+static inline unsigned long sched_weight_to_cgroup(unsigned long weight)
+{
+	return clamp_t(unsigned long,
+		       DIV_ROUND_CLOSEST_ULL(weight * CGROUP_WEIGHT_DFL, 1024),
+		       CGROUP_WEIGHT_MIN, CGROUP_WEIGHT_MAX);
+}
+
 /*
  * !! For sched_setattr_nocheck() (kernel) only !!
  *
-- 
2.45.2
```

## Diff

```diff
---
 include/linux/cgroup.h |  4 ++--
 kernel/sched/core.c    | 28 +++++++++++++---------------
 kernel/sched/sched.h   | 18 ++++++++++++++++++
 3 files changed, 33 insertions(+), 17 deletions(-)

diff --git a/include/linux/cgroup.h b/include/linux/cgroup.h
index 2150ca60394b..3cdaec701600 100644
--- a/include/linux/cgroup.h
+++ b/include/linux/cgroup.h
@@ -29,8 +29,6 @@

 struct kernel_clone_args;

-#ifdef CONFIG_CGROUPS
-
 /*
  * All weight knobs on the default hierarchy should use the following min,
  * default and max values.  The default value is the logarithmic center of
@@ -40,6 +38,8 @@ struct kernel_clone_args;
 #define CGROUP_WEIGHT_DFL		100
 #define CGROUP_WEIGHT_MAX		10000

+#ifdef CONFIG_CGROUPS
+
 enum {
 	CSS_TASK_ITER_PROCS    = (1U << 0),  /* walk only threadgroup leaders */
 	CSS_TASK_ITER_THREADED = (1U << 1),  /* walk all threaded css_sets in the domain */
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index b088fbeaf26d..0bfbceebc4e9 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -9552,29 +9552,27 @@ static int cpu_local_stat_show(struct seq_file *sf,
 }

 #ifdef CONFIG_FAIR_GROUP_SCHED
+
+static unsigned long tg_weight(struct task_group *tg)
+{
+	return scale_load_down(tg->shares);
+}
+
 static u64 cpu_weight_read_u64(struct cgroup_subsys_state *css,
 			       struct cftype *cft)
 {
-	struct task_group *tg = css_tg(css);
-	u64 weight = scale_load_down(tg->shares);
-
-	return DIV_ROUND_CLOSEST_ULL(weight * CGROUP_WEIGHT_DFL, 1024);
+	return sched_weight_to_cgroup(tg_weight(css_tg(css)));
 }

 static int cpu_weight_write_u64(struct cgroup_subsys_state *css,
-				struct cftype *cft, u64 weight)
+				struct cftype *cft, u64 cgrp_weight)
 {
-	/*
-	 * cgroup weight knobs should use the common MIN, DFL and MAX
-	 * values which are 1, 100 and 10000 respectively.  While it loses
-	 * a bit of range on both ends, it maps pretty well onto the shares
-	 * value used by scheduler and the round-trip conversions preserve
-	 * the original value over the entire range.
-	 */
-	if (weight < CGROUP_WEIGHT_MIN || weight > CGROUP_WEIGHT_MAX)
+	unsigned long weight;
+
+	if (cgrp_weight < CGROUP_WEIGHT_MIN || cgrp_weight > CGROUP_WEIGHT_MAX)
 		return -ERANGE;

-	weight = DIV_ROUND_CLOSEST_ULL(weight * 1024, CGROUP_WEIGHT_DFL);
+	weight = sched_weight_from_cgroup(cgrp_weight);

 	return sched_group_set_shares(css_tg(css), scale_load(weight));
 }
@@ -9582,7 +9580,7 @@ static int cpu_weight_write_u64(struct cgroup_subsys_state *css,
 static s64 cpu_weight_nice_read_s64(struct cgroup_subsys_state *css,
 				    struct cftype *cft)
 {
-	unsigned long weight = scale_load_down(css_tg(css)->shares);
+	unsigned long weight = tg_weight(css_tg(css));
 	int last_delta = INT_MAX;
 	int prio, delta;

diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 0ed4271cedf5..656a63c0d393 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -244,6 +244,24 @@ static inline void update_avg(u64 *avg, u64 sample)
 #define shr_bound(val, shift)							\
 	(val >> min_t(typeof(shift), shift, BITS_PER_TYPE(typeof(val)) - 1))

+/*
+ * cgroup weight knobs should use the common MIN, DFL and MAX values which are
+ * 1, 100 and 10000 respectively. While it loses a bit of range on both ends, it
+ * maps pretty well onto the shares value used by scheduler and the round-trip
+ * conversions preserve the original value over the entire range.
+ */
+static inline unsigned long sched_weight_from_cgroup(unsigned long cgrp_weight)
+{
+	return DIV_ROUND_CLOSEST_ULL(cgrp_weight * 1024, CGROUP_WEIGHT_DFL);
+}
+
+static inline unsigned long sched_weight_to_cgroup(unsigned long weight)
+{
+	return clamp_t(unsigned long,
+		       DIV_ROUND_CLOSEST_ULL(weight * CGROUP_WEIGHT_DFL, 1024),
+		       CGROUP_WEIGHT_MIN, CGROUP_WEIGHT_MAX);
+}
+
 /*
  * !! For sched_setattr_nocheck() (kernel) only !!
  *
--
2.45.2


```

## Implementation Analysis

This patch is a pure refactoring effort. It extracts the logic for converting between the scheduler's internal "shares" representation and the user-facing "cgroup weight" into a pair of helper functions.

The main changes are:

1.  **New Conversion Functions:**
    -   Two new `static inline` functions, `sched_weight_from_cgroup()` and `sched_weight_to_cgroup()`, are introduced in `kernel/sched/sched.h`.
    -   `sched_weight_from_cgroup()` converts a cgroup weight (in the range 1-10000) to the scheduler's internal weight representation.
    -   `sched_weight_to_cgroup()` performs the reverse conversion.

2.  **Refactoring of Cgroup Code:**
    -   The `cpu_weight_read_u64()` and `cpu_weight_write_u64()` functions in `kernel/sched/core.c` are updated to use these new helper functions. This simplifies the code and makes the conversion explicit.
    -   A new helper `tg_weight` is also introduced to get the weight from a task group.

3.  **Constant Definitions Moved:**
    -   The `CGROUP_WEIGHT_MIN`, `CGROUP_WEIGHT_DFL`, and `CGROUP_WEIGHT_MAX` macros are moved out of the `CONFIG_CGROUPS` block in `include/linux/cgroup.h`. This makes them available even when cgroups are disabled, which is necessary because the new conversion functions are defined unconditionally.

This change has no functional impact on its own. The primary motivation is to make the weight conversion logic reusable. As the commit message states, the BPF extensible scheduler will use these functions to expose task weights to BPF programs in a user-friendly format (the cgroup weight scale) rather than the scheduler's internal format. This makes it easier for developers to write and reason about BPF scheduling policies.

