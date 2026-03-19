# [PATCH 23/30] sched_ext: Implement SCX_KICK_WAIT

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-24-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-24-tj@kernel.org)

## Commit Message

```text
From: David Vernet <dvernet@meta.com>

If set when calling scx_bpf_kick_cpu(), the invoking CPU will busy wait for
the kicked cpu to enter the scheduler. See the following for example usage:

  https://github.com/sched-ext/scx/blob/main/scheds/c/scx_pair.bpf.c

v2: - Updated to fit the updated kick_cpus_irq_workfn() implementation.

    - Include SCX_KICK_WAIT related information in debug dump.

Signed-off-by: David Vernet <dvernet@meta.com>
Reviewed-by: Tejun Heo <tj@kernel.org>
Signed-off-by: Tejun Heo <tj@kernel.org>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 kernel/sched/core.c  |  4 ++-
 kernel/sched/ext.c   | 82 ++++++++++++++++++++++++++++++++++++++++----
 kernel/sched/ext.h   |  4 +++
 kernel/sched/sched.h |  2 ++
 4 files changed, 85 insertions(+), 7 deletions(-)

diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index d5eff4036be7..0e6ff33f34e4 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -5898,8 +5898,10 @@ __pick_next_task(struct rq *rq, struct task_struct *prev, struct rq_flags *rf)
 
 	for_each_active_class(class) {
 		p = class->pick_next_task(rq);
-		if (p)
+		if (p) {
+			scx_next_task_picked(rq, p, class);
 			return p;
+		}
 	}
 
 	BUG(); /* The idle class should always have a runnable task. */
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 838a96cb10ea..1ca3067b4e0a 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -532,6 +532,12 @@ enum scx_kick_flags {
 	 * task expires and the dispatch path is invoked.
 	 */
 	SCX_KICK_PREEMPT	= 1LLU << 1,
+
+	/*
+	 * Wait for the CPU to be rescheduled. The scx_bpf_kick_cpu() call will
+	 * return after the target CPU finishes picking the next task.
+	 */
+	SCX_KICK_WAIT		= 1LLU << 2,
 };
 
 enum scx_ops_enable_state {
@@ -661,6 +667,9 @@ static struct {
 
 #endif	/* CONFIG_SMP */
 
+/* for %SCX_KICK_WAIT */
+static unsigned long __percpu *scx_kick_cpus_pnt_seqs;
+
 /*
  * Direct dispatch marker.
  *
@@ -2288,6 +2297,23 @@ static struct task_struct *pick_next_task_scx(struct rq *rq)
 	return p;
 }
 
+void scx_next_task_picked(struct rq *rq, struct task_struct *p,
+			  const struct sched_class *active)
+{
+	lockdep_assert_rq_held(rq);
+
+	if (!scx_enabled())
+		return;
+#ifdef CONFIG_SMP
+	/*
+	 * Pairs with the smp_load_acquire() issued by a CPU in
+	 * kick_cpus_irq_workfn() who is waiting for this CPU to perform a
+	 * resched.
+	 */
+	smp_store_release(&rq->scx.pnt_seq, rq->scx.pnt_seq + 1);
+#endif
+}
+
 #ifdef CONFIG_SMP
 
 static bool test_and_clear_cpu_idle(int cpu)
@@ -3673,9 +3699,9 @@ static void scx_dump_state(struct scx_exit_info *ei, size_t dump_len)
 		seq_buf_init(&ns, buf, avail);
 
 		dump_newline(&ns);
-		dump_line(&ns, "CPU %-4d: nr_run=%u flags=0x%x ops_qseq=%lu",
+		dump_line(&ns, "CPU %-4d: nr_run=%u flags=0x%x ops_qseq=%lu pnt_seq=%lu",
 			  cpu, rq->scx.nr_running, rq->scx.flags,
-			  rq->scx.ops_qseq);
+			  rq->scx.ops_qseq, rq->scx.pnt_seq);
 		dump_line(&ns, "          curr=%s[%d] class=%ps",
 			  rq->curr->comm, rq->curr->pid,
 			  rq->curr->sched_class);
@@ -3688,6 +3714,9 @@ static void scx_dump_state(struct scx_exit_info *ei, size_t dump_len)
 		if (!cpumask_empty(rq->scx.cpus_to_preempt))
 			dump_line(&ns, "  cpus_to_preempt: %*pb",
 				  cpumask_pr_args(rq->scx.cpus_to_preempt));
+		if (!cpumask_empty(rq->scx.cpus_to_wait))
+			dump_line(&ns, "  cpus_to_wait   : %*pb",
+				  cpumask_pr_args(rq->scx.cpus_to_wait));
 
 		used = seq_buf_used(&ns);
 		if (SCX_HAS_OP(dump_cpu)) {
@@ -4383,10 +4412,11 @@ static bool can_skip_idle_kick(struct rq *rq)
 	return !is_idle_task(rq->curr) && !(rq->scx.flags & SCX_RQ_BALANCING);
 }
 
-static void kick_one_cpu(s32 cpu, struct rq *this_rq)
+static bool kick_one_cpu(s32 cpu, struct rq *this_rq, unsigned long *pseqs)
 {
 	struct rq *rq = cpu_rq(cpu);
 	struct scx_rq *this_scx = &this_rq->scx;
+	bool should_wait = false;
 	unsigned long flags;
 
 	raw_spin_rq_lock_irqsave(rq, flags);
@@ -4402,12 +4432,20 @@ static void kick_one_cpu(s32 cpu, struct rq *this_rq)
 			cpumask_clear_cpu(cpu, this_scx->cpus_to_preempt);
 		}
 
+		if (cpumask_test_cpu(cpu, this_scx->cpus_to_wait)) {
+			pseqs[cpu] = rq->scx.pnt_seq;
+			should_wait = true;
+		}
+
 		resched_curr(rq);
 	} else {
 		cpumask_clear_cpu(cpu, this_scx->cpus_to_preempt);
+		cpumask_clear_cpu(cpu, this_scx->cpus_to_wait);
 	}
 
 	raw_spin_rq_unlock_irqrestore(rq, flags);
+
+	return should_wait;
 }
 
 static void kick_one_cpu_if_idle(s32 cpu, struct rq *this_rq)
@@ -4428,10 +4466,12 @@ static void kick_cpus_irq_workfn(struct irq_work *irq_work)
 {
 	struct rq *this_rq = this_rq();
 	struct scx_rq *this_scx = &this_rq->scx;
+	unsigned long *pseqs = this_cpu_ptr(scx_kick_cpus_pnt_seqs);
+	bool should_wait = false;
 	s32 cpu;
 
 	for_each_cpu(cpu, this_scx->cpus_to_kick) {
-		kick_one_cpu(cpu, this_rq);
+		should_wait |= kick_one_cpu(cpu, this_rq, pseqs);
 		cpumask_clear_cpu(cpu, this_scx->cpus_to_kick);
 		cpumask_clear_cpu(cpu, this_scx->cpus_to_kick_if_idle);
 	}
@@ -4440,6 +4480,28 @@ static void kick_cpus_irq_workfn(struct irq_work *irq_work)
 		kick_one_cpu_if_idle(cpu, this_rq);
 		cpumask_clear_cpu(cpu, this_scx->cpus_to_kick_if_idle);
 	}
+
+	if (!should_wait)
+		return;
+
+	for_each_cpu(cpu, this_scx->cpus_to_wait) {
+		unsigned long *wait_pnt_seq = &cpu_rq(cpu)->scx.pnt_seq;
+
+		if (cpu != cpu_of(this_rq)) {
+			/*
+			 * Pairs with smp_store_release() issued by this CPU in
+			 * scx_next_task_picked() on the resched path.
+			 *
+			 * We busy-wait here to guarantee that no other task can
+			 * be scheduled on our core before the target CPU has
+			 * entered the resched path.
+			 */
+			while (smp_load_acquire(wait_pnt_seq) == pseqs[cpu])
+				cpu_relax();
+		}
+
+		cpumask_clear_cpu(cpu, this_scx->cpus_to_wait);
+	}
 }
 
 /**
@@ -4504,6 +4566,11 @@ void __init init_sched_ext_class(void)
 	BUG_ON(!alloc_cpumask_var(&idle_masks.cpu, GFP_KERNEL));
 	BUG_ON(!alloc_cpumask_var(&idle_masks.smt, GFP_KERNEL));
 #endif
+	scx_kick_cpus_pnt_seqs =
+		__alloc_percpu(sizeof(scx_kick_cpus_pnt_seqs[0]) * nr_cpu_ids,
+			       __alignof__(scx_kick_cpus_pnt_seqs[0]));
+	BUG_ON(!scx_kick_cpus_pnt_seqs);
+
 	for_each_possible_cpu(cpu) {
 		struct rq *rq = cpu_rq(cpu);
 
@@ -4513,6 +4580,7 @@ void __init init_sched_ext_class(void)
 		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_kick, GFP_KERNEL));
 		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_kick_if_idle, GFP_KERNEL));
 		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_preempt, GFP_KERNEL));
+		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_wait, GFP_KERNEL));
 		init_irq_work(&rq->scx.kick_cpus_irq_work, kick_cpus_irq_workfn);
 	}
 
@@ -4840,8 +4908,8 @@ __bpf_kfunc void scx_bpf_kick_cpu(s32 cpu, u64 flags)
 	if (flags & SCX_KICK_IDLE) {
 		struct rq *target_rq = cpu_rq(cpu);
 
-		if (unlikely(flags & SCX_KICK_PREEMPT))
-			scx_ops_error("PREEMPT cannot be used with SCX_KICK_IDLE");
+		if (unlikely(flags & (SCX_KICK_PREEMPT | SCX_KICK_WAIT)))
+			scx_ops_error("PREEMPT/WAIT cannot be used with SCX_KICK_IDLE");
 
 		if (raw_spin_rq_trylock(target_rq)) {
 			if (can_skip_idle_kick(target_rq)) {
@@ -4856,6 +4924,8 @@ __bpf_kfunc void scx_bpf_kick_cpu(s32 cpu, u64 flags)
 
 		if (flags & SCX_KICK_PREEMPT)
 			cpumask_set_cpu(cpu, this_rq->scx.cpus_to_preempt);
+		if (flags & SCX_KICK_WAIT)
+			cpumask_set_cpu(cpu, this_rq->scx.cpus_to_wait);
 	}
 
 	irq_work_queue(&this_rq->scx.kick_cpus_irq_work);
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 6ed946f72489..0aeb1fda1794 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -29,6 +29,8 @@ static inline bool task_on_scx(const struct task_struct *p)
 	return scx_enabled() && p->sched_class == &ext_sched_class;
 }
 
+void scx_next_task_picked(struct rq *rq, struct task_struct *p,
+			  const struct sched_class *active);
 void scx_tick(struct rq *rq);
 void init_scx_entity(struct sched_ext_entity *scx);
 void scx_pre_fork(struct task_struct *p);
@@ -69,6 +71,8 @@ static inline const struct sched_class *next_active_class(const struct sched_cla
 #define scx_enabled()		false
 #define scx_switched_all()	false
 
+static inline void scx_next_task_picked(struct rq *rq, struct task_struct *p,
+					const struct sched_class *active) {}
 static inline void scx_tick(struct rq *rq) {}
 static inline void scx_pre_fork(struct task_struct *p) {}
 static inline int scx_fork(struct task_struct *p) { return 0; }
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index b3c578cb43cd..734206e13897 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -740,6 +740,8 @@ struct scx_rq {
 	cpumask_var_t		cpus_to_kick;
 	cpumask_var_t		cpus_to_kick_if_idle;
 	cpumask_var_t		cpus_to_preempt;
+	cpumask_var_t		cpus_to_wait;
+	unsigned long		pnt_seq;
 	struct irq_work		kick_cpus_irq_work;
 };
 #endif /* CONFIG_SCHED_CLASS_EXT */
-- 
2.45.2
```

## Diff

```diff
---
 kernel/sched/core.c  |  4 ++-
 kernel/sched/ext.c   | 82 ++++++++++++++++++++++++++++++++++++++++----
 kernel/sched/ext.h   |  4 +++
 kernel/sched/sched.h |  2 ++
 4 files changed, 85 insertions(+), 7 deletions(-)

diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index d5eff4036be7..0e6ff33f34e4 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -5898,8 +5898,10 @@ __pick_next_task(struct rq *rq, struct task_struct *prev, struct rq_flags *rf)

 	for_each_active_class(class) {
 		p = class->pick_next_task(rq);
-		if (p)
+		if (p) {
+			scx_next_task_picked(rq, p, class);
 			return p;
+		}
 	}

 	BUG(); /* The idle class should always have a runnable task. */
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 838a96cb10ea..1ca3067b4e0a 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -532,6 +532,12 @@ enum scx_kick_flags {
 	 * task expires and the dispatch path is invoked.
 	 */
 	SCX_KICK_PREEMPT	= 1LLU << 1,
+
+	/*
+	 * Wait for the CPU to be rescheduled. The scx_bpf_kick_cpu() call will
+	 * return after the target CPU finishes picking the next task.
+	 */
+	SCX_KICK_WAIT		= 1LLU << 2,
 };

 enum scx_ops_enable_state {
@@ -661,6 +667,9 @@ static struct {

 #endif	/* CONFIG_SMP */

+/* for %SCX_KICK_WAIT */
+static unsigned long __percpu *scx_kick_cpus_pnt_seqs;
+
 /*
  * Direct dispatch marker.
  *
@@ -2288,6 +2297,23 @@ static struct task_struct *pick_next_task_scx(struct rq *rq)
 	return p;
 }

+void scx_next_task_picked(struct rq *rq, struct task_struct *p,
+			  const struct sched_class *active)
+{
+	lockdep_assert_rq_held(rq);
+
+	if (!scx_enabled())
+		return;
+#ifdef CONFIG_SMP
+	/*
+	 * Pairs with the smp_load_acquire() issued by a CPU in
+	 * kick_cpus_irq_workfn() who is waiting for this CPU to perform a
+	 * resched.
+	 */
+	smp_store_release(&rq->scx.pnt_seq, rq->scx.pnt_seq + 1);
+#endif
+}
+
 #ifdef CONFIG_SMP

 static bool test_and_clear_cpu_idle(int cpu)
@@ -3673,9 +3699,9 @@ static void scx_dump_state(struct scx_exit_info *ei, size_t dump_len)
 		seq_buf_init(&ns, buf, avail);

 		dump_newline(&ns);
-		dump_line(&ns, "CPU %-4d: nr_run=%u flags=0x%x ops_qseq=%lu",
+		dump_line(&ns, "CPU %-4d: nr_run=%u flags=0x%x ops_qseq=%lu pnt_seq=%lu",
 			  cpu, rq->scx.nr_running, rq->scx.flags,
-			  rq->scx.ops_qseq);
+			  rq->scx.ops_qseq, rq->scx.pnt_seq);
 		dump_line(&ns, "          curr=%s[%d] class=%ps",
 			  rq->curr->comm, rq->curr->pid,
 			  rq->curr->sched_class);
@@ -3688,6 +3714,9 @@ static void scx_dump_state(struct scx_exit_info *ei, size_t dump_len)
 		if (!cpumask_empty(rq->scx.cpus_to_preempt))
 			dump_line(&ns, "  cpus_to_preempt: %*pb",
 				  cpumask_pr_args(rq->scx.cpus_to_preempt));
+		if (!cpumask_empty(rq->scx.cpus_to_wait))
+			dump_line(&ns, "  cpus_to_wait   : %*pb",
+				  cpumask_pr_args(rq->scx.cpus_to_wait));

 		used = seq_buf_used(&ns);
 		if (SCX_HAS_OP(dump_cpu)) {
@@ -4383,10 +4412,11 @@ static bool can_skip_idle_kick(struct rq *rq)
 	return !is_idle_task(rq->curr) && !(rq->scx.flags & SCX_RQ_BALANCING);
 }

-static void kick_one_cpu(s32 cpu, struct rq *this_rq)
+static bool kick_one_cpu(s32 cpu, struct rq *this_rq, unsigned long *pseqs)
 {
 	struct rq *rq = cpu_rq(cpu);
 	struct scx_rq *this_scx = &this_rq->scx;
+	bool should_wait = false;
 	unsigned long flags;

 	raw_spin_rq_lock_irqsave(rq, flags);
@@ -4402,12 +4432,20 @@ static void kick_one_cpu(s32 cpu, struct rq *this_rq)
 			cpumask_clear_cpu(cpu, this_scx->cpus_to_preempt);
 		}

+		if (cpumask_test_cpu(cpu, this_scx->cpus_to_wait)) {
+			pseqs[cpu] = rq->scx.pnt_seq;
+			should_wait = true;
+		}
+
 		resched_curr(rq);
 	} else {
 		cpumask_clear_cpu(cpu, this_scx->cpus_to_preempt);
+		cpumask_clear_cpu(cpu, this_scx->cpus_to_wait);
 	}

 	raw_spin_rq_unlock_irqrestore(rq, flags);
+
+	return should_wait;
 }

 static void kick_one_cpu_if_idle(s32 cpu, struct rq *this_rq)
@@ -4428,10 +4466,12 @@ static void kick_cpus_irq_workfn(struct irq_work *irq_work)
 {
 	struct rq *this_rq = this_rq();
 	struct scx_rq *this_scx = &this_rq->scx;
+	unsigned long *pseqs = this_cpu_ptr(scx_kick_cpus_pnt_seqs);
+	bool should_wait = false;
 	s32 cpu;

 	for_each_cpu(cpu, this_scx->cpus_to_kick) {
-		kick_one_cpu(cpu, this_rq);
+		should_wait |= kick_one_cpu(cpu, this_rq, pseqs);
 		cpumask_clear_cpu(cpu, this_scx->cpus_to_kick);
 		cpumask_clear_cpu(cpu, this_scx->cpus_to_kick_if_idle);
 	}
@@ -4440,6 +4480,28 @@ static void kick_cpus_irq_workfn(struct irq_work *irq_work)
 		kick_one_cpu_if_idle(cpu, this_rq);
 		cpumask_clear_cpu(cpu, this_scx->cpus_to_kick_if_idle);
 	}
+
+	if (!should_wait)
+		return;
+
+	for_each_cpu(cpu, this_scx->cpus_to_wait) {
+		unsigned long *wait_pnt_seq = &cpu_rq(cpu)->scx.pnt_seq;
+
+		if (cpu != cpu_of(this_rq)) {
+			/*
+			 * Pairs with smp_store_release() issued by this CPU in
+			 * scx_next_task_picked() on the resched path.
+			 *
+			 * We busy-wait here to guarantee that no other task can
+			 * be scheduled on our core before the target CPU has
+			 * entered the resched path.
+			 */
+			while (smp_load_acquire(wait_pnt_seq) == pseqs[cpu])
+				cpu_relax();
+		}
+
+		cpumask_clear_cpu(cpu, this_scx->cpus_to_wait);
+	}
 }

 /**
@@ -4504,6 +4566,11 @@ void __init init_sched_ext_class(void)
 	BUG_ON(!alloc_cpumask_var(&idle_masks.cpu, GFP_KERNEL));
 	BUG_ON(!alloc_cpumask_var(&idle_masks.smt, GFP_KERNEL));
 #endif
+	scx_kick_cpus_pnt_seqs =
+		__alloc_percpu(sizeof(scx_kick_cpus_pnt_seqs[0]) * nr_cpu_ids,
+			       __alignof__(scx_kick_cpus_pnt_seqs[0]));
+	BUG_ON(!scx_kick_cpus_pnt_seqs);
+
 	for_each_possible_cpu(cpu) {
 		struct rq *rq = cpu_rq(cpu);

@@ -4513,6 +4580,7 @@ void __init init_sched_ext_class(void)
 		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_kick, GFP_KERNEL));
 		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_kick_if_idle, GFP_KERNEL));
 		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_preempt, GFP_KERNEL));
+		BUG_ON(!zalloc_cpumask_var(&rq->scx.cpus_to_wait, GFP_KERNEL));
 		init_irq_work(&rq->scx.kick_cpus_irq_work, kick_cpus_irq_workfn);
 	}

@@ -4840,8 +4908,8 @@ __bpf_kfunc void scx_bpf_kick_cpu(s32 cpu, u64 flags)
 	if (flags & SCX_KICK_IDLE) {
 		struct rq *target_rq = cpu_rq(cpu);

-		if (unlikely(flags & SCX_KICK_PREEMPT))
-			scx_ops_error("PREEMPT cannot be used with SCX_KICK_IDLE");
+		if (unlikely(flags & (SCX_KICK_PREEMPT | SCX_KICK_WAIT)))
+			scx_ops_error("PREEMPT/WAIT cannot be used with SCX_KICK_IDLE");

 		if (raw_spin_rq_trylock(target_rq)) {
 			if (can_skip_idle_kick(target_rq)) {
@@ -4856,6 +4924,8 @@ __bpf_kfunc void scx_bpf_kick_cpu(s32 cpu, u64 flags)

 		if (flags & SCX_KICK_PREEMPT)
 			cpumask_set_cpu(cpu, this_rq->scx.cpus_to_preempt);
+		if (flags & SCX_KICK_WAIT)
+			cpumask_set_cpu(cpu, this_rq->scx.cpus_to_wait);
 	}

 	irq_work_queue(&this_rq->scx.kick_cpus_irq_work);
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 6ed946f72489..0aeb1fda1794 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -29,6 +29,8 @@ static inline bool task_on_scx(const struct task_struct *p)
 	return scx_enabled() && p->sched_class == &ext_sched_class;
 }

+void scx_next_task_picked(struct rq *rq, struct task_struct *p,
+			  const struct sched_class *active);
 void scx_tick(struct rq *rq);
 void init_scx_entity(struct sched_ext_entity *scx);
 void scx_pre_fork(struct task_struct *p);
@@ -69,6 +71,8 @@ static inline const struct sched_class *next_active_class(const struct sched_cla
 #define scx_enabled()		false
 #define scx_switched_all()	false

+static inline void scx_next_task_picked(struct rq *rq, struct task_struct *p,
+					const struct sched_class *active) {}
 static inline void scx_tick(struct rq *rq) {}
 static inline void scx_pre_fork(struct task_struct *p) {}
 static inline int scx_fork(struct task_struct *p) { return 0; }
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index b3c578cb43cd..734206e13897 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -740,6 +740,8 @@ struct scx_rq {
 	cpumask_var_t		cpus_to_kick;
 	cpumask_var_t		cpus_to_kick_if_idle;
 	cpumask_var_t		cpus_to_preempt;
+	cpumask_var_t		cpus_to_wait;
+	unsigned long		pnt_seq;
 	struct irq_work		kick_cpus_irq_work;
 };
 #endif /* CONFIG_SCHED_CLASS_EXT */
--
2.45.2


```

## Implementation Analysis

### Overview

This patch extends `scx_bpf_kick_cpu()` with `SCX_KICK_WAIT`, a flag that causes the calling CPU to busy-wait until the target CPU completes one full scheduling cycle (i.e., picks its next task). Without this flag, `scx_bpf_kick_cpu()` merely schedules a reschedule interrupt on the target CPU and returns immediately — there is no guarantee the target CPU has actually acted on it before the caller continues.

The motivating use case is the `scx_pair` scheduler: it dispatches a task to CPU A's local DSQ from CPU B's context, then needs a hard guarantee that CPU A has consumed that task before CPU B proceeds. Without `SCX_KICK_WAIT`, CPU B would race forward and potentially dispatch again before CPU A had a chance to pick up the first task.

The implementation uses a sequence counter (`pnt_seq`) incremented by the target CPU in `__pick_next_task()`, combined with an `smp_store_release`/`smp_load_acquire` barrier pair for correct cross-CPU memory ordering. The waiting CPU spins in `kick_cpus_irq_workfn()` — an irq_work context — which is a carefully chosen location because irq_work runs with all prior irq_work on this CPU complete, avoiding re-entrancy issues.

### Code Walkthrough

**New `pnt_seq` counter in `scx_rq` (`sched.h`)**

```c
struct scx_rq {
    cpumask_var_t   cpus_to_kick;
    cpumask_var_t   cpus_to_kick_if_idle;
    cpumask_var_t   cpus_to_preempt;
+   cpumask_var_t   cpus_to_wait;
+   unsigned long   pnt_seq;
    struct irq_work kick_cpus_irq_work;
};
```

`pnt_seq` (pick-next-task sequence counter) is a monotonically increasing counter embedded in `scx_rq`. It starts at zero and is incremented by one each time this CPU picks a next task while sched_ext is enabled. The `cpus_to_wait` cpumask parallels `cpus_to_preempt` — it accumulates the set of CPUs the current CPU needs to wait for before the irq_work handler returns.

**`scx_next_task_picked()` hook in `core.c`**

```c
+if (p) {
+    scx_next_task_picked(rq, p, class);
     return p;
+}
```

The hook is inserted inside `__pick_next_task()` at the exact point where a task has been selected. `scx_next_task_picked()` is called unconditionally for any scheduler class (not just SCX), so the sequence counter advances whether or not the picked task was scheduled by the BPF program. This is intentional: a `SCX_KICK_WAIT` caller only cares that the target CPU went through a full scheduling decision, regardless of which task won.

**`scx_next_task_picked()` implementation (`ext.c`)**

```c
void scx_next_task_picked(struct rq *rq, struct task_struct *p,
                          const struct sched_class *active)
{
    lockdep_assert_rq_held(rq);
    if (!scx_enabled())
        return;
#ifdef CONFIG_SMP
    smp_store_release(&rq->scx.pnt_seq, rq->scx.pnt_seq + 1);
#endif
}
```

`smp_store_release()` ensures that all prior memory writes on this CPU (including any modifications the BPF program or sched class made when dequeuing/running the picked task) are visible to any other CPU that observes the new `pnt_seq` value via `smp_load_acquire()`. This is the release side of the acquire/release pair.

**`scx_kick_cpus_pnt_seqs` per-CPU snapshot array**

```c
static unsigned long __percpu *scx_kick_cpus_pnt_seqs;
```

This is a per-CPU array of size `nr_cpu_ids`. When CPU A's irq_work handler is about to wait for CPU B, it first snapshots CPU B's current `pnt_seq` into `scx_kick_cpus_pnt_seqs[B]`. After all kicks are issued, it waits until CPU B's `pnt_seq` has advanced beyond that snapshot value.

The per-CPU allocation in `init_sched_ext_class()`:

```c
scx_kick_cpus_pnt_seqs =
    __alloc_percpu(sizeof(scx_kick_cpus_pnt_seqs[0]) * nr_cpu_ids,
                   __alignof__(scx_kick_cpus_pnt_seqs[0]));
BUG_ON(!scx_kick_cpus_pnt_seqs);
```

Per-CPU allocation avoids false sharing: if two different CPUs are simultaneously running `kick_cpus_irq_workfn()` and waiting for different targets, they each have their own snapshot array with no cache line contention.

**`kick_one_cpu()` changes**

```c
-static void kick_one_cpu(s32 cpu, struct rq *this_rq)
+static bool kick_one_cpu(s32 cpu, struct rq *this_rq, unsigned long *pseqs)
```

The function now returns `bool` indicating whether a wait is needed. The `pseqs` parameter is the caller's snapshot array. Inside, after acquiring the target rq lock:

```c
if (cpumask_test_cpu(cpu, this_scx->cpus_to_wait)) {
    pseqs[cpu] = rq->scx.pnt_seq;   /* snapshot before resched */
    should_wait = true;
}
resched_curr(rq);
```

The snapshot must be taken under the target rq lock, before calling `resched_curr()`. This ordering is critical: if the snapshot were taken after `resched_curr()`, the target CPU could have already advanced `pnt_seq` before the snapshot, causing the waiter to see an already-advanced counter and immediately stop waiting — it would not have actually waited for the resched triggered by this kick.

When the target CPU is not running (i.e., `can_skip_idle_kick()` path falls through to the else branch), `cpus_to_wait` is cleared immediately since there is nothing to wait for.

**Busy-wait loop in `kick_cpus_irq_workfn()`**

```c
for_each_cpu(cpu, this_scx->cpus_to_wait) {
    unsigned long *wait_pnt_seq = &cpu_rq(cpu)->scx.pnt_seq;

    if (cpu != cpu_of(this_rq)) {
        while (smp_load_acquire(wait_pnt_seq) == pseqs[cpu])
            cpu_relax();
    }

    cpumask_clear_cpu(cpu, this_scx->cpus_to_wait);
}
```

The self-CPU check (`cpu != cpu_of(this_rq)`) prevents deadlock: you cannot wait for yourself to pick a task because you are currently in irq_work on that CPU and cannot schedule. `smp_load_acquire()` is the acquire side of the barrier pair — it ensures that once the waiter observes `pnt_seq` advance, all writes made by the target CPU before its `smp_store_release()` are also visible to the waiter.

`cpu_relax()` inserts a pause/hint instruction (x86: `PAUSE`, ARM: `YIELD`) that reduces power consumption and avoids memory ordering hazards in tight spin loops.

**Flag registration in `scx_bpf_kick_cpu()`**

```c
if (flags & SCX_KICK_PREEMPT)
    cpumask_set_cpu(cpu, this_rq->scx.cpus_to_preempt);
+if (flags & SCX_KICK_WAIT)
+   cpumask_set_cpu(cpu, this_rq->scx.cpus_to_wait);
```

`SCX_KICK_WAIT` is incompatible with `SCX_KICK_IDLE` (enforced by the existing error check):

```c
-if (unlikely(flags & SCX_KICK_PREEMPT))
-    scx_ops_error("PREEMPT cannot be used with SCX_KICK_IDLE");
+if (unlikely(flags & (SCX_KICK_PREEMPT | SCX_KICK_WAIT)))
+   scx_ops_error("PREEMPT/WAIT cannot be used with SCX_KICK_IDLE");
```

`SCX_KICK_IDLE` uses a trylock path that returns early without guaranteed delivery if the CPU is not idle — waiting would be undefined. `SCX_KICK_WAIT` can be combined with `SCX_KICK_PREEMPT` to mean "force a reschedule now and wait for it to complete".

**Debug dump additions**

`pnt_seq` is added to the per-CPU line in `scx_dump_state()`:

```c
dump_line(&ns, "CPU %-4d: nr_run=%u flags=0x%x ops_qseq=%lu pnt_seq=%lu", ...);
```

`cpus_to_wait` is conditionally printed when non-empty, paralleling the existing `cpus_to_preempt` dump. A non-empty `cpus_to_wait` in a crash dump indicates the crash occurred while a CPU was in the middle of waiting for another CPU to reschedule — useful for diagnosing wait-related deadlocks or scheduler stalls.

### Key Concepts

**`pnt_seq` — pick-next-task sequence counter**

A per-rq monotonically increasing counter that serves as a generation number for scheduling decisions. It is incremented exactly once per task selection, unconditionally (for all sched classes, not just SCX). The counter lives in `rq->scx.pnt_seq` rather than `rq` itself because it is an SCX-specific concern — adding it to the core `rq` would pollute the struct for non-SCX kernels.

**acquire/release memory ordering**

The `smp_store_release` in `scx_next_task_picked()` and `smp_load_acquire` in `kick_cpus_irq_workfn()` form a synchronization pair. Release ensures all prior stores are visible before the counter update; acquire ensures all subsequent loads see memory written before the release. Without this pair, the waiter could observe the advanced counter but still see stale task state.

**Why irq_work context for busy-waiting**

`kick_cpus_irq_workfn()` runs in irq_work context (softirq-level, with local IRQs disabled). Busy-waiting here is safe for short durations (one scheduling cycle), but it holds IRQs off on the waiting CPU for that period. This is intentional and acceptable for the `scx_pair` use case where the wait is bounded by the target CPU's time to schedule. Schedulers that use `SCX_KICK_WAIT` must be aware they are introducing latency on the waiting CPU.

**`scx_kick_cpus_pnt_seqs` — why per-CPU**

If a single CPU could kick and wait for multiple targets simultaneously (via `for_each_cpu` over `cpus_to_kick`), a shared array would require locking. Per-CPU allocation gives each kicker its own snapshot array, trading memory (N CPUs × N CPU_IDS × 8 bytes) for lock-free access.

### Locking and Concurrency Notes

- `pnt_seq` is read and written without any spinlock, relying entirely on `smp_store_release`/`smp_load_acquire` for ordering. This is correct because it is only written by the owning CPU (in `scx_next_task_picked()`, called from `__pick_next_task()` which holds the rq lock) and only read by remote CPUs spinning in irq_work.
- The `pseqs[cpu]` snapshot in `kick_one_cpu()` is taken under `raw_spin_rq_lock_irqsave(rq)` on the target rq. This ensures atomicity: the snapshot and the `resched_curr()` call are both under the same lock, so the target CPU cannot have advanced `pnt_seq` between snapshot and resched.
- `cpus_to_wait` is modified only from the owning CPU's context (BPF program call to `scx_bpf_kick_cpu()` sets it; irq_work handler clears it), so no additional locking is needed for the cpumask itself.
- The self-CPU skip in the wait loop prevents a deadlock where a CPU waits for its own `pnt_seq` to advance while holding irq_work context — which prevents the very scheduling that would advance it.

### Why Maintainers Need to Know This

**Ordering invariant for dispatch + wait**: The entire `SCX_KICK_WAIT` mechanism is built on the invariant that `pnt_seq` is snapshotted under the target rq lock, before `resched_curr()`. Any future refactoring that changes this ordering (e.g., moving the snapshot outside the lock) would silently break the wait guarantee and introduce hard-to-reproduce races where the waiter returns too early.

**Bounded busy-wait assumption**: The wait loop spins with IRQs disabled (irq_work context). It assumes the target CPU will call `__pick_next_task()` in bounded time. If the target CPU is stuck in a long non-preemptible section (e.g., a spinlock), the waiting CPU will spin for the duration, potentially causing RCU stall warnings or watchdog timeouts. BPF schedulers using `SCX_KICK_WAIT` must ensure the kicked CPU is free to schedule promptly.

**`SCX_KICK_WAIT` does not guarantee task pickup**: The wait ensures the target CPU went through `__pick_next_task()`, but does not guarantee it picked the specific task you dispatched. If the target CPU picks a higher-priority non-SCX task, your dispatched task remains in the local DSQ. `SCX_KICK_PREEMPT | SCX_KICK_WAIT` together provide the strongest guarantee: force preemption and wait for it to complete, but even then the task selection is subject to normal priority ordering.

**Debug signal**: A non-empty `cpus_to_wait` in a post-mortem dump means a CPU died mid-wait. Cross-reference the `pnt_seq` values — if the waited-for CPU's `pnt_seq` equals the snapshot value, the target CPU never completed the scheduling cycle, pointing to a hang or panic on the target CPU during or before `__pick_next_task()`.

**Per-CPU snapshot array sizing**: `scx_kick_cpus_pnt_seqs` is allocated as `nr_cpu_ids` entries per CPU. On systems with many CPUs, this is a significant allocation (e.g., 1024 CPUs × 1024 entries × 8 bytes = 8 MB). If `nr_cpu_ids` is ever changed after boot or hotplug changes the CPU layout, the array would be stale. Currently this is safe because `init_sched_ext_class()` uses `nr_cpu_ids` at boot, but maintainers should watch for any dynamic CPU topology changes.

### Connection to Other Patches

- **PATCH 17/30 (scx_bpf_kick_cpu infrastructure)**: This patch builds directly on the kick infrastructure from PATCH 17, which introduced `cpus_to_kick`, `cpus_to_preempt`, `kick_cpus_irq_workfn()`, and `kick_one_cpu()`. `SCX_KICK_WAIT` adds the fourth cpumask (`cpus_to_wait`) to the same pattern and extends `kick_one_cpu()` with snapshot logic.

- **PATCH 19/30 (dispatch loop watchdog)**: Both patches deal with bounded execution in `balance_scx()` / `kick_cpus_irq_workfn()`. The dispatch loop watchdog limits iterations with `SCX_DSP_MAX_LOOPS`; `SCX_KICK_WAIT` introduces bounded spinning in irq_work. Together they represent the two places where BPF scheduler misbehavior can stall the kernel, and both have mitigations.

- **PATCH 18/30 (post-mortem dump)**: The `pnt_seq` and `cpus_to_wait` additions to `scx_dump_state()` make this patch's debugging artifacts visible in the dump infrastructure introduced in PATCH 18. A complete dump now shows whether a CPU was actively waiting when the scheduler exited.

- **`scx_pair` example scheduler**: The reference implementation for `SCX_KICK_WAIT` is `scx_pair.bpf.c` in the scx repository. It pairs two CPUs and uses `SCX_KICK_PREEMPT | SCX_KICK_WAIT` to synchronize task placement across the pair, ensuring both CPUs of a pair always run tasks from the same cgroup simultaneously.

