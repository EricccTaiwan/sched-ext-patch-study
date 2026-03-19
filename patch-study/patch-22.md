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

### High-Level Analysis
From: David Vernet <dvernet@meta.com>

### Detailed Walkthrough
1. File: `kernel/sched/core.c`
   Hunk: `@@ -5898,8 +5898,10 @@ __pick_next_task(struct rq *rq, struct task_struct *prev, struct rq_flags *rf)`
   Before
   ```text
   if (p)
   ```
   After
   ```text
   if (p) {
   scx_next_task_picked(rq, p, class);
   }
   ```
2. File: `kernel/sched/ext.c`
   Hunk: `@@ -532,6 +532,12 @@ enum scx_kick_flags {`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   
   /*
   * Wait for the CPU to be rescheduled. The scx_bpf_kick_cpu() call will
   ```
   Note
   ```text
   Additional hunks continue in this file (12 more section(s)).
   ```
3. File: `kernel/sched/ext.h`
   Hunk: `@@ -29,6 +29,8 @@ static inline bool task_on_scx(const struct task_struct *p)`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   void scx_next_task_picked(struct rq *rq, struct task_struct *p,
   const struct sched_class *active);
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```
4. File: `kernel/sched/sched.h`
   Hunk: `@@ -740,6 +740,8 @@ struct scx_rq {`
   Before
   ```text
   -
   ```
   After
   ```text
   cpumask_var_t		cpus_to_wait;
   unsigned long		pnt_seq;
   ```

### sched_ext Context
This patch directly expands sched_ext integration points and makes the scheduler core more extensible for BPF-defined policies.

