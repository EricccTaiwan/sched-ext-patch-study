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

### Overview

This patch factors the arithmetic for converting between the kernel scheduler's internal load weight ("shares") and the cgroup weight scale into two shared inline helpers — `sched_weight_from_cgroup()` and `sched_weight_to_cgroup()` — and moves the `CGROUP_WEIGHT_MIN/DFL/MAX` constants outside `CONFIG_CGROUPS` so the helpers are available unconditionally. The CFS cgroup code is updated to use them. sched_ext will use these same helpers to present task weights to BPF programs in a human-readable scale (1–10000) rather than the raw internal shares value.

### The Problem Being Solved

Before this patch, the conversion between cgroup weight and scheduler shares was inlined at each use site in `cpu_weight_read_u64()` and `cpu_weight_write_u64()`:

```c
// read path:
return DIV_ROUND_CLOSEST_ULL(weight * CGROUP_WEIGHT_DFL, 1024);

// write path:
weight = DIV_ROUND_CLOSEST_ULL(weight * 1024, CGROUP_WEIGHT_DFL);
```

This is fine for one consumer, but sched_ext needs to perform the same conversions when surfacing task weights through BPF maps. Duplicating the arithmetic formula in two separate places invites divergence if the conversion formula ever changes. Additionally, the constants `CGROUP_WEIGHT_MIN/DFL/MAX` were gated by `#ifdef CONFIG_CGROUPS`, making them unavailable in configurations that build sched_ext without cgroup support — even though sched_ext wants to use the cgroup weight range as a user-visible scale regardless of whether cgroups are enabled.

### Code Walkthrough

**`include/linux/cgroup.h`** — constants are moved out of the `CONFIG_CGROUPS` guard:

```c
-#ifdef CONFIG_CGROUPS
-
 /*
  * All weight knobs on the default hierarchy should use the following min,
  * default and max values. ...
  */
 #define CGROUP_WEIGHT_MIN		1
 #define CGROUP_WEIGHT_DFL		100
 #define CGROUP_WEIGHT_MAX		10000

+#ifdef CONFIG_CGROUPS
```

The three `#define`s are now unconditionally available. The `#ifdef CONFIG_CGROUPS` guard is moved down to cover only the cgroup-specific enum and struct definitions that follow. This allows `sched.h` to use `CGROUP_WEIGHT_DFL` in inline helpers without requiring `CONFIG_CGROUPS`.

**`kernel/sched/sched.h`** — two new inline helpers are added:

```c
static inline unsigned long sched_weight_from_cgroup(unsigned long cgrp_weight)
{
	return DIV_ROUND_CLOSEST_ULL(cgrp_weight * 1024, CGROUP_WEIGHT_DFL);
}

static inline unsigned long sched_weight_to_cgroup(unsigned long weight)
{
	return clamp_t(unsigned long,
		       DIV_ROUND_CLOSEST_ULL(weight * CGROUP_WEIGHT_DFL, 1024),
		       CGROUP_WEIGHT_MIN, CGROUP_WEIGHT_MAX);
}
```

The conversion formula is straightforward: the kernel's internal weight scale for CFS uses 1024 as the unit for a "normal" (nice-0) task, while the cgroup weight scale uses 100 as the default. The conversion is a proportional rescaling. The `to_cgroup` direction also clamps the result to `[CGROUP_WEIGHT_MIN, CGROUP_WEIGHT_MAX]` using `clamp_t` — a small correctness improvement over the original inline code which did not clamp.

**`kernel/sched/core.c`** — the CFS cgroup read/write paths are updated to use the new helpers:

```c
 static u64 cpu_weight_read_u64(struct cgroup_subsys_state *css,
 			       struct cftype *cft)
 {
-	struct task_group *tg = css_tg(css);
-	u64 weight = scale_load_down(tg->shares);
-	return DIV_ROUND_CLOSEST_ULL(weight * CGROUP_WEIGHT_DFL, 1024);
+	return sched_weight_to_cgroup(tg_weight(css_tg(css)));
 }
```

```c
 static int cpu_weight_write_u64(struct cgroup_subsys_state *css,
-				struct cftype *cft, u64 weight)
+				struct cftype *cft, u64 cgrp_weight)
 {
-	if (weight < CGROUP_WEIGHT_MIN || weight > CGROUP_WEIGHT_MAX)
+	if (cgrp_weight < CGROUP_WEIGHT_MIN || cgrp_weight > CGROUP_WEIGHT_MAX)
 		return -ERANGE;
-	weight = DIV_ROUND_CLOSEST_ULL(weight * 1024, CGROUP_WEIGHT_DFL);
+	weight = sched_weight_from_cgroup(cgrp_weight);
 	return sched_group_set_shares(css_tg(css), scale_load(weight));
 }
```

The parameter rename from `weight` to `cgrp_weight` in the write path disambiguates the two weight representations within the same function, which was previously a source of confusion. A small `tg_weight()` helper is also extracted to avoid repeating `scale_load_down(tg->shares)`:

```c
+static unsigned long tg_weight(struct task_group *tg)
+{
+	return scale_load_down(tg->shares);
+}
```

### Why sched_ext Needs This

sched_ext exposes task weights to BPF programs through BPF map entries or task struct fields. The internal `load_weight` representation (based on 1024 as the unit for a nice-0 task) is opaque and not documented in any user-facing ABI. The cgroup weight scale (1–10000, default 100) is already user-visible and documented in cgroup v2 documentation, so using it as the BPF-facing representation keeps the interface consistent with cgroup tooling.

Without these shared helpers, the ext scheduler would have to either duplicate the arithmetic or expose the raw internal weight. By factoring the helpers into `sched.h` and making the constants unconditional, sched_ext can call `sched_weight_to_cgroup()` and `sched_weight_from_cgroup()` in its implementation regardless of whether `CONFIG_CGROUPS` is set.

### Connection to Other Patches

This patch does not depend on any earlier patch in the series. It is a self-contained refactoring. The sched_ext implementation later in the series calls `sched_weight_to_cgroup()` when populating the per-task weight field that is visible to BPF programs.

### Key Data Structures / Functions Modified

- **`CGROUP_WEIGHT_MIN / DFL / MAX`** (`include/linux/cgroup.h`): Constants defining the cgroup weight scale (1, 100, 10000). Moved outside `CONFIG_CGROUPS` to be universally available.
- **`sched_weight_from_cgroup()`** (`kernel/sched/sched.h`): New inline helper. Converts a cgroup-scale weight (1–10000) to the scheduler's internal shares representation.
- **`sched_weight_to_cgroup()`** (`kernel/sched/sched.h`): New inline helper. Converts the scheduler's internal shares representation to a cgroup-scale weight. Clamps the result to the valid range.
- **`tg_weight()`** (`kernel/sched/core.c`): New local helper that returns the scaled-down shares value from a `task_group`.
- **`cpu_weight_read_u64()` / `cpu_weight_write_u64()`** (`kernel/sched/core.c`): CFS cgroup `cpu.weight` read/write handlers. Updated to call the new shared helpers instead of open-coding the arithmetic.

