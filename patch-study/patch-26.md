# [PATCH 25/30] sched_ext: Implement sched_ext_ops.cpu_online/offline()

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-26-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-26-tj@kernel.org)

## Commit Message

```text
Add ops.cpu_online/offline() which are invoked when CPUs come online and
offline respectively. As the enqueue path already automatically bypasses
tasks to the local dsq on a deactivated CPU, BPF schedulers are guaranteed
to see tasks only on CPUs which are between online() and offline().

If the BPF scheduler doesn't implement ops.cpu_online/offline(), the
scheduler is automatically exited with SCX_ECODE_RESTART |
SCX_ECODE_RSN_HOTPLUG. Userspace can implement CPU hotpplug support
trivially by simply reinitializing and reloading the scheduler.

scx_qmap is updated to print out online CPUs on hotplug events. Other
schedulers are updated to restart based on ecode.

v3: - The previous implementation added @reason to
      sched_class.rq_on/offline() to distinguish between CPU hotplug events
      and topology updates. This was buggy and fragile as the methods are
      skipped if the current state equals the target state. Instead, add
      scx_rq_[de]activate() which are directly called from
      sched_cpu_de/activate(). This also allows ops.cpu_on/offline() to
      sleep which can be useful.

    - ops.dispatch() could be called on a CPU that the BPF scheduler was
      told to be offline. The dispatch patch is updated to bypass in such
      cases.

v2: - To accommodate lock ordering change between scx_cgroup_rwsem and
      cpus_read_lock(), CPU hotplug operations are put into its own SCX_OPI
      block and enabled eariler during scx_ope_enable() so that
      cpus_read_lock() can be dropped before acquiring scx_cgroup_rwsem.

    - Auto exit with ECODE added.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 kernel/sched/core.c                          |   4 +
 kernel/sched/ext.c                           | 156 ++++++++++++++++++-
 kernel/sched/ext.h                           |   4 +
 kernel/sched/sched.h                         |   6 +
 tools/sched_ext/include/scx/compat.h         |  26 ++++
 tools/sched_ext/include/scx/user_exit_info.h |  28 ++++
 tools/sched_ext/scx_central.c                |   9 +-
 tools/sched_ext/scx_qmap.bpf.c               |  57 +++++++
 tools/sched_ext/scx_qmap.c                   |   4 +
 tools/sched_ext/scx_simple.c                 |   8 +-
 10 files changed, 290 insertions(+), 12 deletions(-)

diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 0e6ff33f34e4..c798c847d57e 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -7984,6 +7984,8 @@ int sched_cpu_activate(unsigned int cpu)
 		cpuset_cpu_active();
 	}
 
+	scx_rq_activate(rq);
+
 	/*
 	 * Put the rq online, if not already. This happens:
 	 *
@@ -8044,6 +8046,8 @@ int sched_cpu_deactivate(unsigned int cpu)
 	}
 	rq_unlock_irqrestore(rq, &rf);
 
+	scx_rq_deactivate(rq);
+
 #ifdef CONFIG_SCHED_SMT
 	/*
 	 * When going down, decrement the number of cores with SMT present.
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 686dab6ab592..7c2f2a542b32 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -30,6 +30,29 @@ enum scx_exit_kind {
 	SCX_EXIT_ERROR_STALL,	/* watchdog detected stalled runnable tasks */
 };
 
+/*
+ * An exit code can be specified when exiting with scx_bpf_exit() or
+ * scx_ops_exit(), corresponding to exit_kind UNREG_BPF and UNREG_KERN
+ * respectively. The codes are 64bit of the format:
+ *
+ *   Bits: [63  ..  48 47   ..  32 31 .. 0]
+ *         [ SYS ACT ] [ SYS RSN ] [ USR  ]
+ *
+ *   SYS ACT: System-defined exit actions
+ *   SYS RSN: System-defined exit reasons
+ *   USR    : User-defined exit codes and reasons
+ *
+ * Using the above, users may communicate intention and context by ORing system
+ * actions and/or system reasons with a user-defined exit code.
+ */
+enum scx_exit_code {
+	/* Reasons */
+	SCX_ECODE_RSN_HOTPLUG	= 1LLU << 32,
+
+	/* Actions */
+	SCX_ECODE_ACT_RESTART	= 1LLU << 48,
+};
+
 /*
  * scx_exit_info is passed to ops.exit() to describe why the BPF scheduler is
  * being disabled.
@@ -457,7 +480,29 @@ struct sched_ext_ops {
 	void (*dump_task)(struct scx_dump_ctx *ctx, struct task_struct *p);
 
 	/*
-	 * All online ops must come before ops.init().
+	 * All online ops must come before ops.cpu_online().
+	 */
+
+	/**
+	 * cpu_online - A CPU became online
+	 * @cpu: CPU which just came up
+	 *
+	 * @cpu just came online. @cpu will not call ops.enqueue() or
+	 * ops.dispatch(), nor run tasks associated with other CPUs beforehand.
+	 */
+	void (*cpu_online)(s32 cpu);
+
+	/**
+	 * cpu_offline - A CPU is going offline
+	 * @cpu: CPU which is going offline
+	 *
+	 * @cpu is going offline. @cpu will not call ops.enqueue() or
+	 * ops.dispatch(), nor run tasks associated with other CPUs afterwards.
+	 */
+	void (*cpu_offline)(s32 cpu);
+
+	/*
+	 * All CPU hotplug ops must come before ops.init().
 	 */
 
 	/**
@@ -496,6 +541,15 @@ struct sched_ext_ops {
 	 */
 	u32 exit_dump_len;
 
+	/**
+	 * hotplug_seq - A sequence number that may be set by the scheduler to
+	 * detect when a hotplug event has occurred during the loading process.
+	 * If 0, no detection occurs. Otherwise, the scheduler will fail to
+	 * load if the sequence number does not match @scx_hotplug_seq on the
+	 * enable path.
+	 */
+	u64 hotplug_seq;
+
 	/**
 	 * name - BPF scheduler's name
 	 *
@@ -509,7 +563,9 @@ struct sched_ext_ops {
 enum scx_opi {
 	SCX_OPI_BEGIN			= 0,
 	SCX_OPI_NORMAL_BEGIN		= 0,
-	SCX_OPI_NORMAL_END		= SCX_OP_IDX(init),
+	SCX_OPI_NORMAL_END		= SCX_OP_IDX(cpu_online),
+	SCX_OPI_CPU_HOTPLUG_BEGIN	= SCX_OP_IDX(cpu_online),
+	SCX_OPI_CPU_HOTPLUG_END		= SCX_OP_IDX(init),
 	SCX_OPI_END			= SCX_OP_IDX(init),
 };
 
@@ -694,6 +750,7 @@ static atomic_t scx_exit_kind = ATOMIC_INIT(SCX_EXIT_DONE);
 static struct scx_exit_info *scx_exit_info;
 
 static atomic_long_t scx_nr_rejected = ATOMIC_LONG_INIT(0);
+static atomic_long_t scx_hotplug_seq = ATOMIC_LONG_INIT(0);
 
 /*
  * The maximum amount of time in jiffies that a task may be runnable without
@@ -1419,11 +1476,7 @@ static void direct_dispatch(struct task_struct *p, u64 enq_flags)
 
 static bool scx_rq_online(struct rq *rq)
 {
-#ifdef CONFIG_SMP
-	return likely(rq->online);
-#else
-	return true;
-#endif
+	return likely(rq->scx.flags & SCX_RQ_ONLINE);
 }
 
 static void do_enqueue_task(struct rq *rq, struct task_struct *p, u64 enq_flags,
@@ -1438,6 +1491,11 @@ static void do_enqueue_task(struct rq *rq, struct task_struct *p, u64 enq_flags,
 	if (sticky_cpu == cpu_of(rq))
 		goto local_norefill;
 
+	/*
+	 * If !scx_rq_online(), we already told the BPF scheduler that the CPU
+	 * is offline and are just running the hotplug path. Don't bother the
+	 * BPF scheduler.
+	 */
 	if (!scx_rq_online(rq))
 		goto local;
 
@@ -2673,6 +2731,42 @@ void __scx_update_idle(struct rq *rq, bool idle)
 #endif
 }
 
+static void handle_hotplug(struct rq *rq, bool online)
+{
+	int cpu = cpu_of(rq);
+
+	atomic_long_inc(&scx_hotplug_seq);
+
+	if (online && SCX_HAS_OP(cpu_online))
+		SCX_CALL_OP(SCX_KF_SLEEPABLE, cpu_online, cpu);
+	else if (!online && SCX_HAS_OP(cpu_offline))
+		SCX_CALL_OP(SCX_KF_SLEEPABLE, cpu_offline, cpu);
+	else
+		scx_ops_exit(SCX_ECODE_ACT_RESTART | SCX_ECODE_RSN_HOTPLUG,
+			     "cpu %d going %s, exiting scheduler", cpu,
+			     online ? "online" : "offline");
+}
+
+void scx_rq_activate(struct rq *rq)
+{
+	handle_hotplug(rq, true);
+}
+
+void scx_rq_deactivate(struct rq *rq)
+{
+	handle_hotplug(rq, false);
+}
+
+static void rq_online_scx(struct rq *rq)
+{
+	rq->scx.flags |= SCX_RQ_ONLINE;
+}
+
+static void rq_offline_scx(struct rq *rq)
+{
+	rq->scx.flags &= ~SCX_RQ_ONLINE;
+}
+
 #else	/* CONFIG_SMP */
 
 static bool test_and_clear_cpu_idle(int cpu) { return false; }
@@ -3104,6 +3198,9 @@ DEFINE_SCHED_CLASS(ext) = {
 	.balance		= balance_scx,
 	.select_task_rq		= select_task_rq_scx,
 	.set_cpus_allowed	= set_cpus_allowed_scx,
+
+	.rq_online		= rq_online_scx,
+	.rq_offline		= rq_offline_scx,
 #endif
 
 	.task_tick		= task_tick_scx,
@@ -3235,10 +3332,18 @@ static ssize_t scx_attr_nr_rejected_show(struct kobject *kobj,
 }
 SCX_ATTR(nr_rejected);
 
+static ssize_t scx_attr_hotplug_seq_show(struct kobject *kobj,
+					 struct kobj_attribute *ka, char *buf)
+{
+	return sysfs_emit(buf, "%ld\n", atomic_long_read(&scx_hotplug_seq));
+}
+SCX_ATTR(hotplug_seq);
+
 static struct attribute *scx_global_attrs[] = {
 	&scx_attr_state.attr,
 	&scx_attr_switch_all.attr,
 	&scx_attr_nr_rejected.attr,
+	&scx_attr_hotplug_seq.attr,
 	NULL,
 };
 
@@ -3941,6 +4046,25 @@ static struct kthread_worker *scx_create_rt_helper(const char *name)
 	return helper;
 }
 
+static void check_hotplug_seq(const struct sched_ext_ops *ops)
+{
+	unsigned long long global_hotplug_seq;
+
+	/*
+	 * If a hotplug event has occurred between when a scheduler was
+	 * initialized, and when we were able to attach, exit and notify user
+	 * space about it.
+	 */
+	if (ops->hotplug_seq) {
+		global_hotplug_seq = atomic_long_read(&scx_hotplug_seq);
+		if (ops->hotplug_seq != global_hotplug_seq) {
+			scx_ops_exit(SCX_ECODE_ACT_RESTART | SCX_ECODE_RSN_HOTPLUG,
+				     "expected hotplug seq %llu did not match actual %llu",
+				     ops->hotplug_seq, global_hotplug_seq);
+		}
+	}
+}
+
 static int validate_ops(const struct sched_ext_ops *ops)
 {
 	/*
@@ -4023,6 +4147,10 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)
 		}
 	}
 
+	for (i = SCX_OPI_CPU_HOTPLUG_BEGIN; i < SCX_OPI_CPU_HOTPLUG_END; i++)
+		if (((void (**)(void))ops)[i])
+			static_branch_enable_cpuslocked(&scx_has_op[i]);
+
 	cpus_read_unlock();
 
 	ret = validate_ops(ops);
@@ -4064,6 +4192,8 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)
 	percpu_down_write(&scx_fork_rwsem);
 	cpus_read_lock();
 
+	check_hotplug_seq(ops);
+
 	for (i = SCX_OPI_NORMAL_BEGIN; i < SCX_OPI_NORMAL_END; i++)
 		if (((void (**)(void))ops)[i])
 			static_branch_enable_cpuslocked(&scx_has_op[i]);
@@ -4374,6 +4504,9 @@ static int bpf_scx_init_member(const struct btf_type *t,
 		ops->exit_dump_len =
 			*(u32 *)(udata + moff) ?: SCX_EXIT_DUMP_DFL_LEN;
 		return 1;
+	case offsetof(struct sched_ext_ops, hotplug_seq):
+		ops->hotplug_seq = *(u64 *)(udata + moff);
+		return 1;
 	}
 
 	return 0;
@@ -4387,6 +4520,8 @@ static int bpf_scx_check_member(const struct btf_type *t,
 
 	switch (moff) {
 	case offsetof(struct sched_ext_ops, init_task):
+	case offsetof(struct sched_ext_ops, cpu_online):
+	case offsetof(struct sched_ext_ops, cpu_offline):
 	case offsetof(struct sched_ext_ops, init):
 	case offsetof(struct sched_ext_ops, exit):
 		break;
@@ -4457,6 +4592,8 @@ static s32 init_task_stub(struct task_struct *p, struct scx_init_task_args *args
 static void exit_task_stub(struct task_struct *p, struct scx_exit_task_args *args) {}
 static void enable_stub(struct task_struct *p) {}
 static void disable_stub(struct task_struct *p) {}
+static void cpu_online_stub(s32 cpu) {}
+static void cpu_offline_stub(s32 cpu) {}
 static s32 init_stub(void) { return -EINVAL; }
 static void exit_stub(struct scx_exit_info *info) {}
 
@@ -4479,6 +4616,8 @@ static struct sched_ext_ops __bpf_ops_sched_ext_ops = {
 	.exit_task = exit_task_stub,
 	.enable = enable_stub,
 	.disable = disable_stub,
+	.cpu_online = cpu_online_stub,
+	.cpu_offline = cpu_offline_stub,
 	.init = init_stub,
 	.exit = exit_stub,
 };
@@ -4719,6 +4858,9 @@ void __init init_sched_ext_class(void)
 		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_preempt, GFP_KERNEL));
 		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_wait, GFP_KERNEL));
 		init_irq_work(&rq->scx.kick_cpus_irq_work, kick_cpus_irq_workfn);
+
+		if (cpu_online(cpu))
+			cpu_rq(cpu)->scx.flags |= SCX_RQ_ONLINE;
 	}
 
 	register_sysrq_key('S', &sysrq_sched_ext_reset_op);
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 4ebd1c2478f1..037f9acdf443 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -40,6 +40,8 @@ int scx_fork(struct task_struct *p);
 void scx_post_fork(struct task_struct *p);
 void scx_cancel_fork(struct task_struct *p);
 bool scx_can_stop_tick(struct rq *rq);
+void scx_rq_activate(struct rq *rq);
+void scx_rq_deactivate(struct rq *rq);
 int scx_check_setscheduler(struct task_struct *p, int policy);
 bool task_should_scx(struct task_struct *p);
 void init_sched_ext_class(void);
@@ -81,6 +83,8 @@ static inline int scx_fork(struct task_struct *p) { return 0; }
 static inline void scx_post_fork(struct task_struct *p) {}
 static inline void scx_cancel_fork(struct task_struct *p) {}
 static inline bool scx_can_stop_tick(struct rq *rq) { return true; }
+static inline void scx_rq_activate(struct rq *rq) {}
+static inline void scx_rq_deactivate(struct rq *rq) {}
 static inline int scx_check_setscheduler(struct task_struct *p, int policy) { return 0; }
 static inline bool task_on_scx(const struct task_struct *p) { return false; }
 static inline void init_sched_ext_class(void) {}
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 147d18cf01ce..c0d6e42c99cc 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -726,6 +726,12 @@ struct cfs_rq {
 #ifdef CONFIG_SCHED_CLASS_EXT
 /* scx_rq->flags, protected by the rq lock */
 enum scx_rq_flags {
+	/*
+	 * A hotplugged CPU starts scheduling before rq_online_scx(). Track
+	 * ops.cpu_on/offline() state so that ops.enqueue/dispatch() are called
+	 * only while the BPF scheduler considers the CPU to be online.
+	 */
+	SCX_RQ_ONLINE		= 1 << 0,
 	SCX_RQ_BALANCING	= 1 << 1,
 	SCX_RQ_CAN_STOP_TICK	= 1 << 2,
 };
diff --git a/tools/sched_ext/include/scx/compat.h b/tools/sched_ext/include/scx/compat.h
index c58024c980c8..cc56ff9aa252 100644
--- a/tools/sched_ext/include/scx/compat.h
+++ b/tools/sched_ext/include/scx/compat.h
@@ -8,6 +8,9 @@
 #define __SCX_COMPAT_H
 
 #include <bpf/btf.h>
+#include <fcntl.h>
+#include <stdlib.h>
+#include <unistd.h>
 
 struct btf *__COMPAT_vmlinux_btf __attribute__((weak));
 
@@ -106,6 +109,28 @@ static inline bool __COMPAT_struct_has_field(const char *type, const char *field
 #define SCX_OPS_SWITCH_PARTIAL							\
 	__COMPAT_ENUM_OR_ZERO("scx_ops_flags", "SCX_OPS_SWITCH_PARTIAL")
 
+static inline long scx_hotplug_seq(void)
+{
+	int fd;
+	char buf[32];
+	ssize_t len;
+	long val;
+
+	fd = open("/sys/kernel/sched_ext/hotplug_seq", O_RDONLY);
+	if (fd < 0)
+		return -ENOENT;
+
+	len = read(fd, buf, sizeof(buf) - 1);
+	SCX_BUG_ON(len <= 0, "read failed (%ld)", len);
+	buf[len] = 0;
+	close(fd);
+
+	val = strtoul(buf, NULL, 10);
+	SCX_BUG_ON(val < 0, "invalid num hotplug events: %lu", val);
+
+	return val;
+}
+
 /*
  * struct sched_ext_ops can change over time. If compat.bpf.h::SCX_OPS_DEFINE()
  * is used to define ops and compat.h::SCX_OPS_LOAD/ATTACH() are used to load
@@ -123,6 +148,7 @@ static inline bool __COMPAT_struct_has_field(const char *type, const char *field
 										\
 	__skel = __scx_name##__open();						\
 	SCX_BUG_ON(!__skel, "Could not open " #__scx_name);			\
+	__skel->struct_ops.__ops_name->hotplug_seq = scx_hotplug_seq();		\
 	__skel; 								\
 })
 
diff --git a/tools/sched_ext/include/scx/user_exit_info.h b/tools/sched_ext/include/scx/user_exit_info.h
index c2ef85c645e1..891693ee604e 100644
--- a/tools/sched_ext/include/scx/user_exit_info.h
+++ b/tools/sched_ext/include/scx/user_exit_info.h
@@ -77,7 +77,35 @@ struct user_exit_info {
 	if (__uei->msg[0] != '\0')						\
 		fprintf(stderr, " (%s)", __uei->msg);				\
 	fputs("\n", stderr);							\
+	__uei->exit_code;							\
 })
 
+/*
+ * We can't import vmlinux.h while compiling user C code. Let's duplicate
+ * scx_exit_code definition.
+ */
+enum scx_exit_code {
+	/* Reasons */
+	SCX_ECODE_RSN_HOTPLUG		= 1LLU << 32,
+
+	/* Actions */
+	SCX_ECODE_ACT_RESTART		= 1LLU << 48,
+};
+
+enum uei_ecode_mask {
+	UEI_ECODE_USER_MASK		= ((1LLU << 32) - 1),
+	UEI_ECODE_SYS_RSN_MASK		= ((1LLU << 16) - 1) << 32,
+	UEI_ECODE_SYS_ACT_MASK		= ((1LLU << 16) - 1) << 48,
+};
+
+/*
+ * These macro interpret the ecode returned from UEI_REPORT().
+ */
+#define UEI_ECODE_USER(__ecode)		((__ecode) & UEI_ECODE_USER_MASK)
+#define UEI_ECODE_SYS_RSN(__ecode)	((__ecode) & UEI_ECODE_SYS_RSN_MASK)
+#define UEI_ECODE_SYS_ACT(__ecode)	((__ecode) & UEI_ECODE_SYS_ACT_MASK)
+
+#define UEI_ECODE_RESTART(__ecode)	(UEI_ECODE_SYS_ACT((__ecode)) == SCX_ECODE_ACT_RESTART)
+
 #endif	/* __bpf__ */
 #endif	/* __USER_EXIT_INFO_H */
diff --git a/tools/sched_ext/scx_central.c b/tools/sched_ext/scx_central.c
index fb3f50886552..21deea320bd7 100644
--- a/tools/sched_ext/scx_central.c
+++ b/tools/sched_ext/scx_central.c
@@ -46,14 +46,14 @@ int main(int argc, char **argv)
 {
 	struct scx_central *skel;
 	struct bpf_link *link;
-	__u64 seq = 0;
+	__u64 seq = 0, ecode;
 	__s32 opt;
 	cpu_set_t *cpuset;
 
 	libbpf_set_print(libbpf_print_fn);
 	signal(SIGINT, sigint_handler);
 	signal(SIGTERM, sigint_handler);
-
+restart:
 	skel = SCX_OPS_OPEN(central_ops, scx_central);
 
 	skel->rodata->central_cpu = 0;
@@ -126,7 +126,10 @@ int main(int argc, char **argv)
 	}
 
 	bpf_link__destroy(link);
-	UEI_REPORT(skel, uei);
+	ecode = UEI_REPORT(skel, uei);
 	scx_central__destroy(skel);
+
+	if (UEI_ECODE_RESTART(ecode))
+		goto restart;
 	return 0;
 }
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 4a87377558c8..619078355bf5 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -358,8 +358,63 @@ void BPF_STRUCT_OPS(qmap_dump_task, struct scx_dump_ctx *dctx, struct task_struc
 		     taskc->force_local);
 }
 
+/*
+ * Print out the online and possible CPU map using bpf_printk() as a
+ * demonstration of using the cpumask kfuncs and ops.cpu_on/offline().
+ */
+static void print_cpus(void)
+{
+	const struct cpumask *possible, *online;
+	s32 cpu;
+	char buf[128] = "", *p;
+	int idx;
+
+	possible = scx_bpf_get_possible_cpumask();
+	online = scx_bpf_get_online_cpumask();
+
+	idx = 0;
+	bpf_for(cpu, 0, scx_bpf_nr_cpu_ids()) {
+		if (!(p = MEMBER_VPTR(buf, [idx++])))
+			break;
+		if (bpf_cpumask_test_cpu(cpu, online))
+			*p++ = 'O';
+		else if (bpf_cpumask_test_cpu(cpu, possible))
+			*p++ = 'X';
+		else
+			*p++ = ' ';
+
+		if ((cpu & 7) == 7) {
+			if (!(p = MEMBER_VPTR(buf, [idx++])))
+				break;
+			*p++ = '|';
+		}
+	}
+	buf[sizeof(buf) - 1] = '\0';
+
+	scx_bpf_put_cpumask(online);
+	scx_bpf_put_cpumask(possible);
+
+	bpf_printk("CPUS: |%s", buf);
+}
+
+void BPF_STRUCT_OPS(qmap_cpu_online, s32 cpu)
+{
+	bpf_printk("CPU %d coming online", cpu);
+	/* @cpu is already online at this point */
+	print_cpus();
+}
+
+void BPF_STRUCT_OPS(qmap_cpu_offline, s32 cpu)
+{
+	bpf_printk("CPU %d going offline", cpu);
+	/* @cpu is still online at this point */
+	print_cpus();
+}
+
 s32 BPF_STRUCT_OPS_SLEEPABLE(qmap_init)
 {
+	print_cpus();
+
 	return scx_bpf_create_dsq(SHARED_DSQ, -1);
 }
 
@@ -378,6 +433,8 @@ SCX_OPS_DEFINE(qmap_ops,
 	       .dump			= (void *)qmap_dump,
 	       .dump_cpu		= (void *)qmap_dump_cpu,
 	       .dump_task		= (void *)qmap_dump_task,
+	       .cpu_online		= (void *)qmap_cpu_online,
+	       .cpu_offline		= (void *)qmap_cpu_offline,
 	       .init			= (void *)qmap_init,
 	       .exit			= (void *)qmap_exit,
 	       .timeout_ms		= 5000U,
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index 2a97421afe9a..920fb54f9c77 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -122,5 +122,9 @@ int main(int argc, char **argv)
 	bpf_link__destroy(link);
 	UEI_REPORT(skel, uei);
 	scx_qmap__destroy(skel);
+	/*
+	 * scx_qmap implements ops.cpu_on/offline() and doesn't need to restart
+	 * on CPU hotplug events.
+	 */
 	return 0;
 }
diff --git a/tools/sched_ext/scx_simple.c b/tools/sched_ext/scx_simple.c
index 7f500d1d56ac..bead482e1383 100644
--- a/tools/sched_ext/scx_simple.c
+++ b/tools/sched_ext/scx_simple.c
@@ -62,11 +62,12 @@ int main(int argc, char **argv)
 	struct scx_simple *skel;
 	struct bpf_link *link;
 	__u32 opt;
+	__u64 ecode;
 
 	libbpf_set_print(libbpf_print_fn);
 	signal(SIGINT, sigint_handler);
 	signal(SIGTERM, sigint_handler);
-
+restart:
 	skel = SCX_OPS_OPEN(simple_ops, scx_simple);
 
 	while ((opt = getopt(argc, argv, "vh")) != -1) {
@@ -93,7 +94,10 @@ int main(int argc, char **argv)
 	}
 
 	bpf_link__destroy(link);
-	UEI_REPORT(skel, uei);
+	ecode = UEI_REPORT(skel, uei);
 	scx_simple__destroy(skel);
+
+	if (UEI_ECODE_RESTART(ecode))
+		goto restart;
 	return 0;
 }
-- 
2.45.2
```

## Diff

```diff
---
 kernel/sched/core.c                          |   4 +
 kernel/sched/ext.c                           | 156 ++++++++++++++++++-
 kernel/sched/ext.h                           |   4 +
 kernel/sched/sched.h                         |   6 +
 tools/sched_ext/include/scx/compat.h         |  26 ++++
 tools/sched_ext/include/scx/user_exit_info.h |  28 ++++
 tools/sched_ext/scx_central.c                |   9 +-
 tools/sched_ext/scx_qmap.bpf.c               |  57 +++++++
 tools/sched_ext/scx_qmap.c                   |   4 +
 tools/sched_ext/scx_simple.c                 |   8 +-
 10 files changed, 290 insertions(+), 12 deletions(-)

diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 0e6ff33f34e4..c798c847d57e 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -7984,6 +7984,8 @@ int sched_cpu_activate(unsigned int cpu)
 		cpuset_cpu_active();
 	}

+	scx_rq_activate(rq);
+
 	/*
 	 * Put the rq online, if not already. This happens:
 	 *
@@ -8044,6 +8046,8 @@ int sched_cpu_deactivate(unsigned int cpu)
 	}
 	rq_unlock_irqrestore(rq, &rf);

+	scx_rq_deactivate(rq);
+
 #ifdef CONFIG_SCHED_SMT
 	/*
 	 * When going down, decrement the number of cores with SMT present.
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 686dab6ab592..7c2f2a542b32 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -30,6 +30,29 @@ enum scx_exit_kind {
 	SCX_EXIT_ERROR_STALL,	/* watchdog detected stalled runnable tasks */
 };

+/*
+ * An exit code can be specified when exiting with scx_bpf_exit() or
+ * scx_ops_exit(), corresponding to exit_kind UNREG_BPF and UNREG_KERN
+ * respectively. The codes are 64bit of the format:
+ *
+ *   Bits: [63  ..  48 47   ..  32 31 .. 0]
+ *         [ SYS ACT ] [ SYS RSN ] [ USR  ]
+ *
+ *   SYS ACT: System-defined exit actions
+ *   SYS RSN: System-defined exit reasons
+ *   USR    : User-defined exit codes and reasons
+ *
+ * Using the above, users may communicate intention and context by ORing system
+ * actions and/or system reasons with a user-defined exit code.
+ */
+enum scx_exit_code {
+	/* Reasons */
+	SCX_ECODE_RSN_HOTPLUG	= 1LLU << 32,
+
+	/* Actions */
+	SCX_ECODE_ACT_RESTART	= 1LLU << 48,
+};
+
 /*
  * scx_exit_info is passed to ops.exit() to describe why the BPF scheduler is
  * being disabled.
@@ -457,7 +480,29 @@ struct sched_ext_ops {
 	void (*dump_task)(struct scx_dump_ctx *ctx, struct task_struct *p);

 	/*
-	 * All online ops must come before ops.init().
+	 * All online ops must come before ops.cpu_online().
+	 */
+
+	/**
+	 * cpu_online - A CPU became online
+	 * @cpu: CPU which just came up
+	 *
+	 * @cpu just came online. @cpu will not call ops.enqueue() or
+	 * ops.dispatch(), nor run tasks associated with other CPUs beforehand.
+	 */
+	void (*cpu_online)(s32 cpu);
+
+	/**
+	 * cpu_offline - A CPU is going offline
+	 * @cpu: CPU which is going offline
+	 *
+	 * @cpu is going offline. @cpu will not call ops.enqueue() or
+	 * ops.dispatch(), nor run tasks associated with other CPUs afterwards.
+	 */
+	void (*cpu_offline)(s32 cpu);
+
+	/*
+	 * All CPU hotplug ops must come before ops.init().
 	 */

 	/**
@@ -496,6 +541,15 @@ struct sched_ext_ops {
 	 */
 	u32 exit_dump_len;

+	/**
+	 * hotplug_seq - A sequence number that may be set by the scheduler to
+	 * detect when a hotplug event has occurred during the loading process.
+	 * If 0, no detection occurs. Otherwise, the scheduler will fail to
+	 * load if the sequence number does not match @scx_hotplug_seq on the
+	 * enable path.
+	 */
+	u64 hotplug_seq;
+
 	/**
 	 * name - BPF scheduler's name
 	 *
@@ -509,7 +563,9 @@ struct sched_ext_ops {
 enum scx_opi {
 	SCX_OPI_BEGIN			= 0,
 	SCX_OPI_NORMAL_BEGIN		= 0,
-	SCX_OPI_NORMAL_END		= SCX_OP_IDX(init),
+	SCX_OPI_NORMAL_END		= SCX_OP_IDX(cpu_online),
+	SCX_OPI_CPU_HOTPLUG_BEGIN	= SCX_OP_IDX(cpu_online),
+	SCX_OPI_CPU_HOTPLUG_END		= SCX_OP_IDX(init),
 	SCX_OPI_END			= SCX_OP_IDX(init),
 };

@@ -694,6 +750,7 @@ static atomic_t scx_exit_kind = ATOMIC_INIT(SCX_EXIT_DONE);
 static struct scx_exit_info *scx_exit_info;

 static atomic_long_t scx_nr_rejected = ATOMIC_LONG_INIT(0);
+static atomic_long_t scx_hotplug_seq = ATOMIC_LONG_INIT(0);

 /*
  * The maximum amount of time in jiffies that a task may be runnable without
@@ -1419,11 +1476,7 @@ static void direct_dispatch(struct task_struct *p, u64 enq_flags)

 static bool scx_rq_online(struct rq *rq)
 {
-#ifdef CONFIG_SMP
-	return likely(rq->online);
-#else
-	return true;
-#endif
+	return likely(rq->scx.flags & SCX_RQ_ONLINE);
 }

 static void do_enqueue_task(struct rq *rq, struct task_struct *p, u64 enq_flags,
@@ -1438,6 +1491,11 @@ static void do_enqueue_task(struct rq *rq, struct task_struct *p, u64 enq_flags,
 	if (sticky_cpu == cpu_of(rq))
 		goto local_norefill;

+	/*
+	 * If !scx_rq_online(), we already told the BPF scheduler that the CPU
+	 * is offline and are just running the hotplug path. Don't bother the
+	 * BPF scheduler.
+	 */
 	if (!scx_rq_online(rq))
 		goto local;

@@ -2673,6 +2731,42 @@ void __scx_update_idle(struct rq *rq, bool idle)
 #endif
 }

+static void handle_hotplug(struct rq *rq, bool online)
+{
+	int cpu = cpu_of(rq);
+
+	atomic_long_inc(&scx_hotplug_seq);
+
+	if (online && SCX_HAS_OP(cpu_online))
+		SCX_CALL_OP(SCX_KF_SLEEPABLE, cpu_online, cpu);
+	else if (!online && SCX_HAS_OP(cpu_offline))
+		SCX_CALL_OP(SCX_KF_SLEEPABLE, cpu_offline, cpu);
+	else
+		scx_ops_exit(SCX_ECODE_ACT_RESTART | SCX_ECODE_RSN_HOTPLUG,
+			     "cpu %d going %s, exiting scheduler", cpu,
+			     online ? "online" : "offline");
+}
+
+void scx_rq_activate(struct rq *rq)
+{
+	handle_hotplug(rq, true);
+}
+
+void scx_rq_deactivate(struct rq *rq)
+{
+	handle_hotplug(rq, false);
+}
+
+static void rq_online_scx(struct rq *rq)
+{
+	rq->scx.flags |= SCX_RQ_ONLINE;
+}
+
+static void rq_offline_scx(struct rq *rq)
+{
+	rq->scx.flags &= ~SCX_RQ_ONLINE;
+}
+
 #else	/* CONFIG_SMP */

 static bool test_and_clear_cpu_idle(int cpu) { return false; }
@@ -3104,6 +3198,9 @@ DEFINE_SCHED_CLASS(ext) = {
 	.balance		= balance_scx,
 	.select_task_rq		= select_task_rq_scx,
 	.set_cpus_allowed	= set_cpus_allowed_scx,
+
+	.rq_online		= rq_online_scx,
+	.rq_offline		= rq_offline_scx,
 #endif

 	.task_tick		= task_tick_scx,
@@ -3235,10 +3332,18 @@ static ssize_t scx_attr_nr_rejected_show(struct kobject *kobj,
 }
 SCX_ATTR(nr_rejected);

+static ssize_t scx_attr_hotplug_seq_show(struct kobject *kobj,
+					 struct kobj_attribute *ka, char *buf)
+{
+	return sysfs_emit(buf, "%ld\n", atomic_long_read(&scx_hotplug_seq));
+}
+SCX_ATTR(hotplug_seq);
+
 static struct attribute *scx_global_attrs[] = {
 	&scx_attr_state.attr,
 	&scx_attr_switch_all.attr,
 	&scx_attr_nr_rejected.attr,
+	&scx_attr_hotplug_seq.attr,
 	NULL,
 };

@@ -3941,6 +4046,25 @@ static struct kthread_worker *scx_create_rt_helper(const char *name)
 	return helper;
 }

+static void check_hotplug_seq(const struct sched_ext_ops *ops)
+{
+	unsigned long long global_hotplug_seq;
+
+	/*
+	 * If a hotplug event has occurred between when a scheduler was
+	 * initialized, and when we were able to attach, exit and notify user
+	 * space about it.
+	 */
+	if (ops->hotplug_seq) {
+		global_hotplug_seq = atomic_long_read(&scx_hotplug_seq);
+		if (ops->hotplug_seq != global_hotplug_seq) {
+			scx_ops_exit(SCX_ECODE_ACT_RESTART | SCX_ECODE_RSN_HOTPLUG,
+				     "expected hotplug seq %llu did not match actual %llu",
+				     ops->hotplug_seq, global_hotplug_seq);
+		}
+	}
+}
+
 static int validate_ops(const struct sched_ext_ops *ops)
 {
 	/*
@@ -4023,6 +4147,10 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)
 		}
 	}

+	for (i = SCX_OPI_CPU_HOTPLUG_BEGIN; i < SCX_OPI_CPU_HOTPLUG_END; i++)
+		if (((void (**)(void))ops)[i])
+			static_branch_enable_cpuslocked(&scx_has_op[i]);
+
 	cpus_read_unlock();

 	ret = validate_ops(ops);
@@ -4064,6 +4192,8 @@ static int scx_ops_enable(struct sched_ext_ops *ops, struct bpf_link *link)
 	percpu_down_write(&scx_fork_rwsem);
 	cpus_read_lock();

+	check_hotplug_seq(ops);
+
 	for (i = SCX_OPI_NORMAL_BEGIN; i < SCX_OPI_NORMAL_END; i++)
 		if (((void (**)(void))ops)[i])
 			static_branch_enable_cpuslocked(&scx_has_op[i]);
@@ -4374,6 +4504,9 @@ static int bpf_scx_init_member(const struct btf_type *t,
 		ops->exit_dump_len =
 			*(u32 *)(udata + moff) ?: SCX_EXIT_DUMP_DFL_LEN;
 		return 1;
+	case offsetof(struct sched_ext_ops, hotplug_seq):
+		ops->hotplug_seq = *(u64 *)(udata + moff);
+		return 1;
 	}

 	return 0;
@@ -4387,6 +4520,8 @@ static int bpf_scx_check_member(const struct btf_type *t,

 	switch (moff) {
 	case offsetof(struct sched_ext_ops, init_task):
+	case offsetof(struct sched_ext_ops, cpu_online):
+	case offsetof(struct sched_ext_ops, cpu_offline):
 	case offsetof(struct sched_ext_ops, init):
 	case offsetof(struct sched_ext_ops, exit):
 		break;
@@ -4457,6 +4592,8 @@ static s32 init_task_stub(struct task_struct *p, struct scx_init_task_args *args
 static void exit_task_stub(struct task_struct *p, struct scx_exit_task_args *args) {}
 static void enable_stub(struct task_struct *p) {}
 static void disable_stub(struct task_struct *p) {}
+static void cpu_online_stub(s32 cpu) {}
+static void cpu_offline_stub(s32 cpu) {}
 static s32 init_stub(void) { return -EINVAL; }
 static void exit_stub(struct scx_exit_info *info) {}

@@ -4479,6 +4616,8 @@ static struct sched_ext_ops __bpf_ops_sched_ext_ops = {
 	.exit_task = exit_task_stub,
 	.enable = enable_stub,
 	.disable = disable_stub,
+	.cpu_online = cpu_online_stub,
+	.cpu_offline = cpu_offline_stub,
 	.init = init_stub,
 	.exit = exit_stub,
 };
@@ -4719,6 +4858,9 @@ void __init init_sched_ext_class(void)
 		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_preempt, GFP_KERNEL));
 		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_wait, GFP_KERNEL));
 		init_irq_work(&rq->scx.kick_cpus_irq_work, kick_cpus_irq_workfn);
+
+		if (cpu_online(cpu))
+			cpu_rq(cpu)->scx.flags |= SCX_RQ_ONLINE;
 	}

 	register_sysrq_key('S', &sysrq_sched_ext_reset_op);
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 4ebd1c2478f1..037f9acdf443 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -40,6 +40,8 @@ int scx_fork(struct task_struct *p);
 void scx_post_fork(struct task_struct *p);
 void scx_cancel_fork(struct task_struct *p);
 bool scx_can_stop_tick(struct rq *rq);
+void scx_rq_activate(struct rq *rq);
+void scx_rq_deactivate(struct rq *rq);
 int scx_check_setscheduler(struct task_struct *p, int policy);
 bool task_should_scx(struct task_struct *p);
 void init_sched_ext_class(void);
@@ -81,6 +83,8 @@ static inline int scx_fork(struct task_struct *p) { return 0; }
 static inline void scx_post_fork(struct task_struct *p) {}
 static inline void scx_cancel_fork(struct task_struct *p) {}
 static inline bool scx_can_stop_tick(struct rq *rq) { return true; }
+static inline void scx_rq_activate(struct rq *rq) {}
+static inline void scx_rq_deactivate(struct rq *rq) {}
 static inline int scx_check_setscheduler(struct task_struct *p, int policy) { return 0; }
 static inline bool task_on_scx(const struct task_struct *p) { return false; }
 static inline void init_sched_ext_class(void) {}
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index 147d18cf01ce..c0d6e42c99cc 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -726,6 +726,12 @@ struct cfs_rq {
 #ifdef CONFIG_SCHED_CLASS_EXT
 /* scx_rq->flags, protected by the rq lock */
 enum scx_rq_flags {
+	/*
+	 * A hotplugged CPU starts scheduling before rq_online_scx(). Track
+	 * ops.cpu_on/offline() state so that ops.enqueue/dispatch() are called
+	 * only while the BPF scheduler considers the CPU to be online.
+	 */
+	SCX_RQ_ONLINE		= 1 << 0,
 	SCX_RQ_BALANCING	= 1 << 1,
 	SCX_RQ_CAN_STOP_TICK	= 1 << 2,
 };
diff --git a/tools/sched_ext/include/scx/compat.h b/tools/sched_ext/include/scx/compat.h
index c58024c980c8..cc56ff9aa252 100644
--- a/tools/sched_ext/include/scx/compat.h
+++ b/tools/sched_ext/include/scx/compat.h
@@ -8,6 +8,9 @@
 #define __SCX_COMPAT_H

 #include <bpf/btf.h>
+#include <fcntl.h>
+#include <stdlib.h>
+#include <unistd.h>

 struct btf *__COMPAT_vmlinux_btf __attribute__((weak));

@@ -106,6 +109,28 @@ static inline bool __COMPAT_struct_has_field(const char *type, const char *field
 #define SCX_OPS_SWITCH_PARTIAL							\
 	__COMPAT_ENUM_OR_ZERO("scx_ops_flags", "SCX_OPS_SWITCH_PARTIAL")

+static inline long scx_hotplug_seq(void)
+{
+	int fd;
+	char buf[32];
+	ssize_t len;
+	long val;
+
+	fd = open("/sys/kernel/sched_ext/hotplug_seq", O_RDONLY);
+	if (fd < 0)
+		return -ENOENT;
+
+	len = read(fd, buf, sizeof(buf) - 1);
+	SCX_BUG_ON(len <= 0, "read failed (%ld)", len);
+	buf[len] = 0;
+	close(fd);
+
+	val = strtoul(buf, NULL, 10);
+	SCX_BUG_ON(val < 0, "invalid num hotplug events: %lu", val);
+
+	return val;
+}
+
 /*
  * struct sched_ext_ops can change over time. If compat.bpf.h::SCX_OPS_DEFINE()
  * is used to define ops and compat.h::SCX_OPS_LOAD/ATTACH() are used to load
@@ -123,6 +148,7 @@ static inline bool __COMPAT_struct_has_field(const char *type, const char *field
 										\
 	__skel = __scx_name##__open();						\
 	SCX_BUG_ON(!__skel, "Could not open " #__scx_name);			\
+	__skel->struct_ops.__ops_name->hotplug_seq = scx_hotplug_seq();		\
 	__skel; 								\
 })

diff --git a/tools/sched_ext/include/scx/user_exit_info.h b/tools/sched_ext/include/scx/user_exit_info.h
index c2ef85c645e1..891693ee604e 100644
--- a/tools/sched_ext/include/scx/user_exit_info.h
+++ b/tools/sched_ext/include/scx/user_exit_info.h
@@ -77,7 +77,35 @@ struct user_exit_info {
 	if (__uei->msg[0] != '\0')						\
 		fprintf(stderr, " (%s)", __uei->msg);				\
 	fputs("\n", stderr);							\
+	__uei->exit_code;							\
 })

+/*
+ * We can't import vmlinux.h while compiling user C code. Let's duplicate
+ * scx_exit_code definition.
+ */
+enum scx_exit_code {
+	/* Reasons */
+	SCX_ECODE_RSN_HOTPLUG		= 1LLU << 32,
+
+	/* Actions */
+	SCX_ECODE_ACT_RESTART		= 1LLU << 48,
+};
+
+enum uei_ecode_mask {
+	UEI_ECODE_USER_MASK		= ((1LLU << 32) - 1),
+	UEI_ECODE_SYS_RSN_MASK		= ((1LLU << 16) - 1) << 32,
+	UEI_ECODE_SYS_ACT_MASK		= ((1LLU << 16) - 1) << 48,
+};
+
+/*
+ * These macro interpret the ecode returned from UEI_REPORT().
+ */
+#define UEI_ECODE_USER(__ecode)		((__ecode) & UEI_ECODE_USER_MASK)
+#define UEI_ECODE_SYS_RSN(__ecode)	((__ecode) & UEI_ECODE_SYS_RSN_MASK)
+#define UEI_ECODE_SYS_ACT(__ecode)	((__ecode) & UEI_ECODE_SYS_ACT_MASK)
+
+#define UEI_ECODE_RESTART(__ecode)	(UEI_ECODE_SYS_ACT((__ecode)) == SCX_ECODE_ACT_RESTART)
+
 #endif	/* __bpf__ */
 #endif	/* __USER_EXIT_INFO_H */
diff --git a/tools/sched_ext/scx_central.c b/tools/sched_ext/scx_central.c
index fb3f50886552..21deea320bd7 100644
--- a/tools/sched_ext/scx_central.c
+++ b/tools/sched_ext/scx_central.c
@@ -46,14 +46,14 @@ int main(int argc, char **argv)
 {
 	struct scx_central *skel;
 	struct bpf_link *link;
-	__u64 seq = 0;
+	__u64 seq = 0, ecode;
 	__s32 opt;
 	cpu_set_t *cpuset;

 	libbpf_set_print(libbpf_print_fn);
 	signal(SIGINT, sigint_handler);
 	signal(SIGTERM, sigint_handler);
-
+restart:
 	skel = SCX_OPS_OPEN(central_ops, scx_central);

 	skel->rodata->central_cpu = 0;
@@ -126,7 +126,10 @@ int main(int argc, char **argv)
 	}

 	bpf_link__destroy(link);
-	UEI_REPORT(skel, uei);
+	ecode = UEI_REPORT(skel, uei);
 	scx_central__destroy(skel);
+
+	if (UEI_ECODE_RESTART(ecode))
+		goto restart;
 	return 0;
 }
diff --git a/tools/sched_ext/scx_qmap.bpf.c b/tools/sched_ext/scx_qmap.bpf.c
index 4a87377558c8..619078355bf5 100644
--- a/tools/sched_ext/scx_qmap.bpf.c
+++ b/tools/sched_ext/scx_qmap.bpf.c
@@ -358,8 +358,63 @@ void BPF_STRUCT_OPS(qmap_dump_task, struct scx_dump_ctx *dctx, struct task_struc
 		     taskc->force_local);
 }

+/*
+ * Print out the online and possible CPU map using bpf_printk() as a
+ * demonstration of using the cpumask kfuncs and ops.cpu_on/offline().
+ */
+static void print_cpus(void)
+{
+	const struct cpumask *possible, *online;
+	s32 cpu;
+	char buf[128] = "", *p;
+	int idx;
+
+	possible = scx_bpf_get_possible_cpumask();
+	online = scx_bpf_get_online_cpumask();
+
+	idx = 0;
+	bpf_for(cpu, 0, scx_bpf_nr_cpu_ids()) {
+		if (!(p = MEMBER_VPTR(buf, [idx++])))
+			break;
+		if (bpf_cpumask_test_cpu(cpu, online))
+			*p++ = 'O';
+		else if (bpf_cpumask_test_cpu(cpu, possible))
+			*p++ = 'X';
+		else
+			*p++ = ' ';
+
+		if ((cpu & 7) == 7) {
+			if (!(p = MEMBER_VPTR(buf, [idx++])))
+				break;
+			*p++ = '|';
+		}
+	}
+	buf[sizeof(buf) - 1] = '\0';
+
+	scx_bpf_put_cpumask(online);
+	scx_bpf_put_cpumask(possible);
+
+	bpf_printk("CPUS: |%s", buf);
+}
+
+void BPF_STRUCT_OPS(qmap_cpu_online, s32 cpu)
+{
+	bpf_printk("CPU %d coming online", cpu);
+	/* @cpu is already online at this point */
+	print_cpus();
+}
+
+void BPF_STRUCT_OPS(qmap_cpu_offline, s32 cpu)
+{
+	bpf_printk("CPU %d going offline", cpu);
+	/* @cpu is still online at this point */
+	print_cpus();
+}
+
 s32 BPF_STRUCT_OPS_SLEEPABLE(qmap_init)
 {
+	print_cpus();
+
 	return scx_bpf_create_dsq(SHARED_DSQ, -1);
 }

@@ -378,6 +433,8 @@ SCX_OPS_DEFINE(qmap_ops,
 	       .dump			= (void *)qmap_dump,
 	       .dump_cpu		= (void *)qmap_dump_cpu,
 	       .dump_task		= (void *)qmap_dump_task,
+	       .cpu_online		= (void *)qmap_cpu_online,
+	       .cpu_offline		= (void *)qmap_cpu_offline,
 	       .init			= (void *)qmap_init,
 	       .exit			= (void *)qmap_exit,
 	       .timeout_ms		= 5000U,
diff --git a/tools/sched_ext/scx_qmap.c b/tools/sched_ext/scx_qmap.c
index 2a97421afe9a..920fb54f9c77 100644
--- a/tools/sched_ext/scx_qmap.c
+++ b/tools/sched_ext/scx_qmap.c
@@ -122,5 +122,9 @@ int main(int argc, char **argv)
 	bpf_link__destroy(link);
 	UEI_REPORT(skel, uei);
 	scx_qmap__destroy(skel);
+	/*
+	 * scx_qmap implements ops.cpu_on/offline() and doesn't need to restart
+	 * on CPU hotplug events.
+	 */
 	return 0;
 }
diff --git a/tools/sched_ext/scx_simple.c b/tools/sched_ext/scx_simple.c
index 7f500d1d56ac..bead482e1383 100644
--- a/tools/sched_ext/scx_simple.c
+++ b/tools/sched_ext/scx_simple.c
@@ -62,11 +62,12 @@ int main(int argc, char **argv)
 	struct scx_simple *skel;
 	struct bpf_link *link;
 	__u32 opt;
+	__u64 ecode;

 	libbpf_set_print(libbpf_print_fn);
 	signal(SIGINT, sigint_handler);
 	signal(SIGTERM, sigint_handler);
-
+restart:
 	skel = SCX_OPS_OPEN(simple_ops, scx_simple);

 	while ((opt = getopt(argc, argv, "vh")) != -1) {
@@ -93,7 +94,10 @@ int main(int argc, char **argv)
 	}

 	bpf_link__destroy(link);
-	UEI_REPORT(skel, uei);
+	ecode = UEI_REPORT(skel, uei);
 	scx_simple__destroy(skel);
+
+	if (UEI_ECODE_RESTART(ecode))
+		goto restart;
 	return 0;
 }
--
2.45.2


```

## Implementation Analysis

### High-Level Analysis
Add ops.cpu_online/offline() which are invoked when CPUs come online and

### Detailed Walkthrough
1. File: `kernel/sched/core.c`
   Hunk: `@@ -7984,6 +7984,8 @@ int sched_cpu_activate(unsigned int cpu)`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   scx_rq_activate(rq);
   
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```
2. File: `kernel/sched/ext.c`
   Hunk: `@@ -30,6 +30,29 @@ enum scx_exit_kind {`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   /*
   * An exit code can be specified when exiting with scx_bpf_exit() or
   * scx_ops_exit(), corresponding to exit_kind UNREG_BPF and UNREG_KERN
   ```
   Note
   ```text
   Additional hunks continue in this file (17 more section(s)).
   ```
3. File: `kernel/sched/ext.h`
   Hunk: `@@ -40,6 +40,8 @@ int scx_fork(struct task_struct *p);`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   void scx_rq_activate(struct rq *rq);
   void scx_rq_deactivate(struct rq *rq);
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```
4. File: `kernel/sched/sched.h`
   Hunk: `@@ -726,6 +726,12 @@ struct cfs_rq {`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   /*
   * A hotplugged CPU starts scheduling before rq_online_scx(). Track
   * ops.cpu_on/offline() state so that ops.enqueue/dispatch() are called
   ```
5. File: `tools/sched_ext/include/scx/compat.h`
   Hunk: `@@ -8,6 +8,9 @@`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   #include <fcntl.h>
   #include <stdlib.h>
   #include <unistd.h>
   ```
   Note
   ```text
   Additional hunks continue in this file (2 more section(s)).
   ```
6. File: `tools/sched_ext/include/scx/user_exit_info.h`
   Hunk: `@@ -77,7 +77,35 @@ struct user_exit_info {`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   __uei->exit_code;							\
   /*
   * We can't import vmlinux.h while compiling user C code. Let's duplicate
   ```
7. File: `tools/sched_ext/scx_central.c`
   Hunk: `@@ -46,14 +46,14 @@ int main(int argc, char **argv)`
   Before
   ```text
   __u64 seq = 0;
   
   ```
   After
   ```text
   __u64 seq = 0, ecode;
   restart:
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```
8. File: `tools/sched_ext/scx_qmap.bpf.c`
   Hunk: `@@ -358,8 +358,63 @@ void BPF_STRUCT_OPS(qmap_dump_task, struct scx_dump_ctx *dctx, struct task_struc`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   /*
   * Print out the online and possible CPU map using bpf_printk() as a
   * demonstration of using the cpumask kfuncs and ops.cpu_on/offline().
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```

### sched_ext Context
This patch directly expands sched_ext integration points and makes the scheduler core more extensible for BPF-defined policies.

