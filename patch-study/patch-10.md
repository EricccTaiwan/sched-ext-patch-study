# [PATCH 11/30] sched_ext: Add sysrq-S which disables the BPF scheduler

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-12-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-12-tj@kernel.org)

## Commit Message

```text
This enables the admin to abort the BPF scheduler and revert to CFS anytime.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 drivers/tty/sysrq.c         |  1 +
 kernel/sched/build_policy.c |  1 +
 kernel/sched/ext.c          | 20 ++++++++++++++++++++
 3 files changed, 22 insertions(+)

diff --git a/drivers/tty/sysrq.c b/drivers/tty/sysrq.c
index e5974b8239c9..167e877b8bef 100644
--- a/drivers/tty/sysrq.c
+++ b/drivers/tty/sysrq.c
@@ -531,6 +531,7 @@ static const struct sysrq_key_op *sysrq_key_table[62] = {
 	NULL,				/* P */
 	NULL,				/* Q */
 	&sysrq_replay_logs_op,		/* R */
+	/* S: May be registered by sched_ext for resetting */
 	NULL,				/* S */
 	NULL,				/* T */
 	NULL,				/* U */
diff --git a/kernel/sched/build_policy.c b/kernel/sched/build_policy.c
index f0c148fcd2df..9223c49ddcf3 100644
--- a/kernel/sched/build_policy.c
+++ b/kernel/sched/build_policy.c
@@ -32,6 +32,7 @@
 #include <linux/suspend.h>
 #include <linux/tsacct_kern.h>
 #include <linux/vtime.h>
+#include <linux/sysrq.h>
 #include <linux/percpu-rwsem.h>
 
 #include <uapi/linux/sched/types.h>
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 49b115f5b052..1f5d80df263a 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -20,6 +20,7 @@ enum scx_exit_kind {
 	SCX_EXIT_UNREG = 64,	/* user-space initiated unregistration */
 	SCX_EXIT_UNREG_BPF,	/* BPF-initiated unregistration */
 	SCX_EXIT_UNREG_KERN,	/* kernel-initiated unregistration */
+	SCX_EXIT_SYSRQ,		/* requested by 'S' sysrq */
 
 	SCX_EXIT_ERROR = 1024,	/* runtime error, error msg contains details */
 	SCX_EXIT_ERROR_BPF,	/* ERROR but triggered through scx_bpf_error() */
@@ -2776,6 +2777,8 @@ static const char *scx_exit_reason(enum scx_exit_kind kind)
 		return "Scheduler unregistered from BPF";
 	case SCX_EXIT_UNREG_KERN:
 		return "Scheduler unregistered from the main kernel";
+	case SCX_EXIT_SYSRQ:
+		return "disabled by sysrq-S";
 	case SCX_EXIT_ERROR:
 		return "runtime error";
 	case SCX_EXIT_ERROR_BPF:
@@ -3526,6 +3529,21 @@ static struct bpf_struct_ops bpf_sched_ext_ops = {
  * System integration and init.
  */
 
+static void sysrq_handle_sched_ext_reset(u8 key)
+{
+	if (scx_ops_helper)
+		scx_ops_disable(SCX_EXIT_SYSRQ);
+	else
+		pr_info("sched_ext: BPF scheduler not yet used\n");
+}
+
+static const struct sysrq_key_op sysrq_sched_ext_reset_op = {
+	.handler	= sysrq_handle_sched_ext_reset,
+	.help_msg	= "reset-sched-ext(S)",
+	.action_msg	= "Disable sched_ext and revert all tasks to CFS",
+	.enable_mask	= SYSRQ_ENABLE_RTNICE,
+};
+
 void __init init_sched_ext_class(void)
 {
 	s32 cpu, v;
@@ -3549,6 +3567,8 @@ void __init init_sched_ext_class(void)
 		init_dsq(&rq->scx.local_dsq, SCX_DSQ_LOCAL);
 		INIT_LIST_HEAD(&rq->scx.runnable_list);
 	}
+
+	register_sysrq_key('S', &sysrq_sched_ext_reset_op);
 }
 
 
-- 
2.45.2
```

## Diff

```diff
---
 drivers/tty/sysrq.c         |  1 +
 kernel/sched/build_policy.c |  1 +
 kernel/sched/ext.c          | 20 ++++++++++++++++++++
 3 files changed, 22 insertions(+)

diff --git a/drivers/tty/sysrq.c b/drivers/tty/sysrq.c
index e5974b8239c9..167e877b8bef 100644
--- a/drivers/tty/sysrq.c
+++ b/drivers/tty/sysrq.c
@@ -531,6 +531,7 @@ static const struct sysrq_key_op *sysrq_key_table[62] = {
 	NULL,				/* P */
 	NULL,				/* Q */
 	&sysrq_replay_logs_op,		/* R */
+	/* S: May be registered by sched_ext for resetting */
 	NULL,				/* S */
 	NULL,				/* T */
 	NULL,				/* U */
diff --git a/kernel/sched/build_policy.c b/kernel/sched/build_policy.c
index f0c148fcd2df..9223c49ddcf3 100644
--- a/kernel/sched/build_policy.c
+++ b/kernel/sched/build_policy.c
@@ -32,6 +32,7 @@
 #include <linux/suspend.h>
 #include <linux/tsacct_kern.h>
 #include <linux/vtime.h>
+#include <linux/sysrq.h>
 #include <linux/percpu-rwsem.h>

 #include <uapi/linux/sched/types.h>
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 49b115f5b052..1f5d80df263a 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -20,6 +20,7 @@ enum scx_exit_kind {
 	SCX_EXIT_UNREG = 64,	/* user-space initiated unregistration */
 	SCX_EXIT_UNREG_BPF,	/* BPF-initiated unregistration */
 	SCX_EXIT_UNREG_KERN,	/* kernel-initiated unregistration */
+	SCX_EXIT_SYSRQ,		/* requested by 'S' sysrq */

 	SCX_EXIT_ERROR = 1024,	/* runtime error, error msg contains details */
 	SCX_EXIT_ERROR_BPF,	/* ERROR but triggered through scx_bpf_error() */
@@ -2776,6 +2777,8 @@ static const char *scx_exit_reason(enum scx_exit_kind kind)
 		return "Scheduler unregistered from BPF";
 	case SCX_EXIT_UNREG_KERN:
 		return "Scheduler unregistered from the main kernel";
+	case SCX_EXIT_SYSRQ:
+		return "disabled by sysrq-S";
 	case SCX_EXIT_ERROR:
 		return "runtime error";
 	case SCX_EXIT_ERROR_BPF:
@@ -3526,6 +3529,21 @@ static struct bpf_struct_ops bpf_sched_ext_ops = {
  * System integration and init.
  */

+static void sysrq_handle_sched_ext_reset(u8 key)
+{
+	if (scx_ops_helper)
+		scx_ops_disable(SCX_EXIT_SYSRQ);
+	else
+		pr_info("sched_ext: BPF scheduler not yet used\n");
+}
+
+static const struct sysrq_key_op sysrq_sched_ext_reset_op = {
+	.handler	= sysrq_handle_sched_ext_reset,
+	.help_msg	= "reset-sched-ext(S)",
+	.action_msg	= "Disable sched_ext and revert all tasks to CFS",
+	.enable_mask	= SYSRQ_ENABLE_RTNICE,
+};
+
 void __init init_sched_ext_class(void)
 {
 	s32 cpu, v;
@@ -3549,6 +3567,8 @@ void __init init_sched_ext_class(void)
 		init_dsq(&rq->scx.local_dsq, SCX_DSQ_LOCAL);
 		INIT_LIST_HEAD(&rq->scx.runnable_list);
 	}
+
+	register_sysrq_key('S', &sysrq_sched_ext_reset_op);
 }


--
2.45.2


```

## Implementation Analysis

### High-Level Analysis
This enables the admin to abort the BPF scheduler and revert to CFS anytime.

### Detailed Walkthrough
1. File: `drivers/tty/sysrq.c`
   Hunk: `@@ -531,6 +531,7 @@ static const struct sysrq_key_op *sysrq_key_table[62] = {`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   /* S: May be registered by sched_ext for resetting */
   ```
2. File: `kernel/sched/build_policy.c`
   Hunk: `@@ -32,6 +32,7 @@`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   #include <linux/sysrq.h>
   ```
3. File: `kernel/sched/ext.c`
   Hunk: `@@ -20,6 +20,7 @@ enum scx_exit_kind {`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   SCX_EXIT_SYSRQ,		/* requested by 'S' sysrq */
   ```
   Note
   ```text
   Additional hunks continue in this file (3 more section(s)).
   ```

### sched_ext Context
This patch directly expands sched_ext integration points and makes the scheduler core more extensible for BPF-defined policies.

