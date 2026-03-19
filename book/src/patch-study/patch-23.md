# [PATCH 21/30] sched_ext: Implement tickless support

**View on Lore**: [https://lore.kernel.org/all/20240618212056.2833381-22-tj@kernel.org](https://lore.kernel.org/all/20240618212056.2833381-22-tj@kernel.org)

## Commit Message

```text
Allow BPF schedulers to indicate tickless operation by setting p->scx.slice
to SCX_SLICE_INF. A CPU whose current task has infinte slice goes into
tickless operation.

scx_central is updated to use tickless operations for all tasks and
instead use a BPF timer to expire slices. This also uses the SCX_ENQ_PREEMPT
and task state tracking added by the previous patches.

Currently, there is no way to pin the timer on the central CPU, so it may
end up on one of the worker CPUs; however, outside of that, the worker CPUs
can go tickless both while running sched_ext tasks and idling.

With schbench running, scx_central shows:

  root@test ~# grep ^LOC /proc/interrupts; sleep 10; grep ^LOC /proc/interrupts
  LOC:     142024        656        664        449   Local timer interrupts
  LOC:     161663        663        665        449   Local timer interrupts

Without it:

  root@test ~ [SIGINT]# grep ^LOC /proc/interrupts; sleep 10; grep ^LOC /proc/interrupts
  LOC:     188778       3142       3793       3993   Local timer interrupts
  LOC:     198993       5314       6323       6438   Local timer interrupts

While scx_central itself is too barebone to be useful as a
production scheduler, a more featureful central scheduler can be built using
the same approach. Google's experience shows that such an approach can have
significant benefits for certain applications such as VM hosting.

v4: Allow operation even if BPF_F_TIMER_CPU_PIN is not available.

v3: Pin the central scheduler's timer on the central_cpu using
    BPF_F_TIMER_CPU_PIN.

v2: Convert to BPF inline iterators.

Signed-off-by: Tejun Heo <tj@kernel.org>
Reviewed-by: David Vernet <dvernet@meta.com>
Acked-by: Josh Don <joshdon@google.com>
Acked-by: Hao Luo <haoluo@google.com>
Acked-by: Barret Rhoden <brho@google.com>
---
 include/linux/sched/ext.h         |   1 +
 kernel/sched/core.c               |  11 ++-
 kernel/sched/ext.c                |  52 +++++++++-
 kernel/sched/ext.h                |   2 +
 kernel/sched/sched.h              |   1 +
 tools/sched_ext/scx_central.bpf.c | 159 ++++++++++++++++++++++++++++--
 tools/sched_ext/scx_central.c     |  29 +++++-
 7 files changed, 242 insertions(+), 13 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index 3b2809b980ac..6f1a4977e9f8 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -16,6 +16,7 @@ enum scx_public_consts {
 	SCX_OPS_NAME_LEN	= 128,
 
 	SCX_SLICE_DFL		= 20 * 1000000,	/* 20ms */
+	SCX_SLICE_INF		= U64_MAX,	/* infinite, implies nohz */
 };
 
 /*
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 1a3144c80af8..d5eff4036be7 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -1256,11 +1256,14 @@ bool sched_can_stop_tick(struct rq *rq)
 		return true;
 
 	/*
-	 * If there are no DL,RR/FIFO tasks, there must only be CFS tasks left;
-	 * if there's more than one we need the tick for involuntary
-	 * preemption.
+	 * If there are no DL,RR/FIFO tasks, there must only be CFS or SCX tasks
+	 * left. For CFS, if there's more than one we need the tick for
+	 * involuntary preemption. For SCX, ask.
 	 */
-	if (rq->nr_running > 1)
+	if (!scx_switched_all() && rq->nr_running > 1)
+		return false;
+
+	if (scx_enabled() && !scx_can_stop_tick(rq))
 		return false;
 
 	/*
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 2e652f7b8f54..ce32fc6b05cd 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -1086,7 +1086,8 @@ static void update_curr_scx(struct rq *rq)
 	account_group_exec_runtime(curr, delta_exec);
 	cgroup_account_cputime(curr, delta_exec);
 
-	curr->scx.slice -= min(curr->scx.slice, delta_exec);
+	if (curr->scx.slice != SCX_SLICE_INF)
+		curr->scx.slice -= min(curr->scx.slice, delta_exec);
 }
 
 static void dsq_mod_nr(struct scx_dispatch_q *dsq, s32 delta)
@@ -2093,6 +2094,28 @@ static void set_next_task_scx(struct rq *rq, struct task_struct *p, bool first)
 		SCX_CALL_OP(SCX_KF_REST, running, p);
 
 	clr_task_runnable(p, true);
+
+	/*
+	 * @p is getting newly scheduled or got kicked after someone updated its
+	 * slice. Refresh whether tick can be stopped. See scx_can_stop_tick().
+	 */
+	if ((p->scx.slice == SCX_SLICE_INF) !=
+	    (bool)(rq->scx.flags & SCX_RQ_CAN_STOP_TICK)) {
+		if (p->scx.slice == SCX_SLICE_INF)
+			rq->scx.flags |= SCX_RQ_CAN_STOP_TICK;
+		else
+			rq->scx.flags &= ~SCX_RQ_CAN_STOP_TICK;
+
+		sched_update_tick_dependency(rq);
+
+		/*
+		 * For now, let's refresh the load_avgs just when transitioning
+		 * in and out of nohz. In the future, we might want to add a
+		 * mechanism which calls the following periodically on
+		 * tick-stopped CPUs.
+		 */
+		update_other_load_avgs(rq);
+	}
 }
 
 static void put_prev_task_scx(struct rq *rq, struct task_struct *p)
@@ -2818,6 +2841,26 @@ int scx_check_setscheduler(struct task_struct *p, int policy)
 	return 0;
 }
 
+#ifdef CONFIG_NO_HZ_FULL
+bool scx_can_stop_tick(struct rq *rq)
+{
+	struct task_struct *p = rq->curr;
+
+	if (scx_ops_bypassing())
+		return false;
+
+	if (p->sched_class != &ext_sched_class)
+		return true;
+
+	/*
+	 * @rq can dispatch from different DSQs, so we can't tell whether it
+	 * needs the tick or not by looking at nr_running. Allow stopping ticks
+	 * iff the BPF scheduler indicated so. See set_next_task_scx().
+	 */
+	return rq->scx.flags & SCX_RQ_CAN_STOP_TICK;
+}
+#endif
+
 /*
  * Omitted operations:
  *
@@ -3120,6 +3163,9 @@ static void scx_ops_bypass(bool bypass)
 		}
 
 		rq_unlock_irqrestore(rq, &rf);
+
+		/* kick to restore ticks */
+		resched_cpu(cpu);
 	}
 }
 
@@ -4576,7 +4622,9 @@ __bpf_kfunc_start_defs();
  * BPF locks (in the future when BPF introduces more flexible locking).
  *
  * @p is allowed to run for @slice. The scheduling path is triggered on slice
- * exhaustion. If zero, the current residual slice is maintained.
+ * exhaustion. If zero, the current residual slice is maintained. If
+ * %SCX_SLICE_INF, @p never expires and the BPF scheduler must kick the CPU with
+ * scx_bpf_kick_cpu() to trigger scheduling.
  */
 __bpf_kfunc void scx_bpf_dispatch(struct task_struct *p, u64 dsq_id, u64 slice,
 				  u64 enq_flags)
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 33a9f7fe5832..6ed946f72489 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -35,6 +35,7 @@ void scx_pre_fork(struct task_struct *p);
 int scx_fork(struct task_struct *p);
 void scx_post_fork(struct task_struct *p);
 void scx_cancel_fork(struct task_struct *p);
+bool scx_can_stop_tick(struct rq *rq);
 int scx_check_setscheduler(struct task_struct *p, int policy);
 bool task_should_scx(struct task_struct *p);
 void init_sched_ext_class(void);
@@ -73,6 +74,7 @@ static inline void scx_pre_fork(struct task_struct *p) {}
 static inline int scx_fork(struct task_struct *p) { return 0; }
 static inline void scx_post_fork(struct task_struct *p) {}
 static inline void scx_cancel_fork(struct task_struct *p) {}
+static inline bool scx_can_stop_tick(struct rq *rq) { return true; }
 static inline int scx_check_setscheduler(struct task_struct *p, int policy) { return 0; }
 static inline bool task_on_scx(const struct task_struct *p) { return false; }
 static inline void init_sched_ext_class(void) {}
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index d9054eb4ba82..b3c578cb43cd 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -727,6 +727,7 @@ struct cfs_rq {
 /* scx_rq->flags, protected by the rq lock */
 enum scx_rq_flags {
 	SCX_RQ_BALANCING	= 1 << 1,
+	SCX_RQ_CAN_STOP_TICK	= 1 << 2,
 };
 
 struct scx_rq {
diff --git a/tools/sched_ext/scx_central.bpf.c b/tools/sched_ext/scx_central.bpf.c
index 428b2262faa3..1d8fd570eaa7 100644
--- a/tools/sched_ext/scx_central.bpf.c
+++ b/tools/sched_ext/scx_central.bpf.c
@@ -13,7 +13,26 @@
  *    through per-CPU BPF queues. The current design is chosen to maximally
  *    utilize and verify various SCX mechanisms such as LOCAL_ON dispatching.
  *
- * b. Preemption
+ * b. Tickless operation
+ *
+ *    All tasks are dispatched with the infinite slice which allows stopping the
+ *    ticks on CONFIG_NO_HZ_FULL kernels running with the proper nohz_full
+ *    parameter. The tickless operation can be observed through
+ *    /proc/interrupts.
+ *
+ *    Periodic switching is enforced by a periodic timer checking all CPUs and
+ *    preempting them as necessary. Unfortunately, BPF timer currently doesn't
+ *    have a way to pin to a specific CPU, so the periodic timer isn't pinned to
+ *    the central CPU.
+ *
+ * c. Preemption
+ *
+ *    Kthreads are unconditionally queued to the head of a matching local dsq
+ *    and dispatched with SCX_DSQ_PREEMPT. This ensures that a kthread is always
+ *    prioritized over user threads, which is required for ensuring forward
+ *    progress as e.g. the periodic timer may run on a ksoftirqd and if the
+ *    ksoftirqd gets starved by a user thread, there may not be anything else to
+ *    vacate that user thread.
  *
  *    SCX_KICK_PREEMPT is used to trigger scheduling and CPUs to move to the
  *    next tasks.
@@ -32,14 +51,17 @@ char _license[] SEC("license") = "GPL";
 
 enum {
 	FALLBACK_DSQ_ID		= 0,
+	MS_TO_NS		= 1000LLU * 1000,
+	TIMER_INTERVAL_NS	= 1 * MS_TO_NS,
 };
 
 const volatile s32 central_cpu;
 const volatile u32 nr_cpu_ids = 1;	/* !0 for veristat, set during init */
 const volatile u64 slice_ns = SCX_SLICE_DFL;
 
+bool timer_pinned = true;
 u64 nr_total, nr_locals, nr_queued, nr_lost_pids;
-u64 nr_dispatches, nr_mismatches, nr_retries;
+u64 nr_timers, nr_dispatches, nr_mismatches, nr_retries;
 u64 nr_overflows;
 
 UEI_DEFINE(uei);
@@ -52,6 +74,23 @@ struct {
 
 /* can't use percpu map due to bad lookups */
 bool RESIZABLE_ARRAY(data, cpu_gimme_task);
+u64 RESIZABLE_ARRAY(data, cpu_started_at);
+
+struct central_timer {
+	struct bpf_timer timer;
+};
+
+struct {
+	__uint(type, BPF_MAP_TYPE_ARRAY);
+	__uint(max_entries, 1);
+	__type(key, u32);
+	__type(value, struct central_timer);
+} central_timer SEC(".maps");
+
+static bool vtime_before(u64 a, u64 b)
+{
+	return (s64)(a - b) < 0;
+}
 
 s32 BPF_STRUCT_OPS(central_select_cpu, struct task_struct *p,
 		   s32 prev_cpu, u64 wake_flags)
@@ -71,9 +110,22 @@ void BPF_STRUCT_OPS(central_enqueue, struct task_struct *p, u64 enq_flags)
 
 	__sync_fetch_and_add(&nr_total, 1);
 
+	/*
+	 * Push per-cpu kthreads at the head of local dsq's and preempt the
+	 * corresponding CPU. This ensures that e.g. ksoftirqd isn't blocked
+	 * behind other threads which is necessary for forward progress
+	 * guarantee as we depend on the BPF timer which may run from ksoftirqd.
+	 */
+	if ((p->flags & PF_KTHREAD) && p->nr_cpus_allowed == 1) {
+		__sync_fetch_and_add(&nr_locals, 1);
+		scx_bpf_dispatch(p, SCX_DSQ_LOCAL, SCX_SLICE_INF,
+				 enq_flags | SCX_ENQ_PREEMPT);
+		return;
+	}
+
 	if (bpf_map_push_elem(&central_q, &pid, 0)) {
 		__sync_fetch_and_add(&nr_overflows, 1);
-		scx_bpf_dispatch(p, FALLBACK_DSQ_ID, SCX_SLICE_DFL, enq_flags);
+		scx_bpf_dispatch(p, FALLBACK_DSQ_ID, SCX_SLICE_INF, enq_flags);
 		return;
 	}
 
@@ -106,7 +158,7 @@ static bool dispatch_to_cpu(s32 cpu)
 		 */
 		if (!bpf_cpumask_test_cpu(cpu, p->cpus_ptr)) {
 			__sync_fetch_and_add(&nr_mismatches, 1);
-			scx_bpf_dispatch(p, FALLBACK_DSQ_ID, SCX_SLICE_DFL, 0);
+			scx_bpf_dispatch(p, FALLBACK_DSQ_ID, SCX_SLICE_INF, 0);
 			bpf_task_release(p);
 			/*
 			 * We might run out of dispatch buffer slots if we continue dispatching
@@ -120,7 +172,7 @@ static bool dispatch_to_cpu(s32 cpu)
 		}
 
 		/* dispatch to local and mark that @cpu doesn't need more */
-		scx_bpf_dispatch(p, SCX_DSQ_LOCAL_ON | cpu, SCX_SLICE_DFL, 0);
+		scx_bpf_dispatch(p, SCX_DSQ_LOCAL_ON | cpu, SCX_SLICE_INF, 0);
 
 		if (cpu != central_cpu)
 			scx_bpf_kick_cpu(cpu, SCX_KICK_IDLE);
@@ -188,9 +240,102 @@ void BPF_STRUCT_OPS(central_dispatch, s32 cpu, struct task_struct *prev)
 	}
 }
 
+void BPF_STRUCT_OPS(central_running, struct task_struct *p)
+{
+	s32 cpu = scx_bpf_task_cpu(p);
+	u64 *started_at = ARRAY_ELEM_PTR(cpu_started_at, cpu, nr_cpu_ids);
+	if (started_at)
+		*started_at = bpf_ktime_get_ns() ?: 1;	/* 0 indicates idle */
+}
+
+void BPF_STRUCT_OPS(central_stopping, struct task_struct *p, bool runnable)
+{
+	s32 cpu = scx_bpf_task_cpu(p);
+	u64 *started_at = ARRAY_ELEM_PTR(cpu_started_at, cpu, nr_cpu_ids);
+	if (started_at)
+		*started_at = 0;
+}
+
+static int central_timerfn(void *map, int *key, struct bpf_timer *timer)
+{
+	u64 now = bpf_ktime_get_ns();
+	u64 nr_to_kick = nr_queued;
+	s32 i, curr_cpu;
+
+	curr_cpu = bpf_get_smp_processor_id();
+	if (timer_pinned && (curr_cpu != central_cpu)) {
+		scx_bpf_error("Central timer ran on CPU %d, not central CPU %d",
+			      curr_cpu, central_cpu);
+		return 0;
+	}
+
+	bpf_for(i, 0, nr_cpu_ids) {
+		s32 cpu = (nr_timers + i) % nr_cpu_ids;
+		u64 *started_at;
+
+		if (cpu == central_cpu)
+			continue;
+
+		/* kick iff the current one exhausted its slice */
+		started_at = ARRAY_ELEM_PTR(cpu_started_at, cpu, nr_cpu_ids);
+		if (started_at && *started_at &&
+		    vtime_before(now, *started_at + slice_ns))
+			continue;
+
+		/* and there's something pending */
+		if (scx_bpf_dsq_nr_queued(FALLBACK_DSQ_ID) ||
+		    scx_bpf_dsq_nr_queued(SCX_DSQ_LOCAL_ON | cpu))
+			;
+		else if (nr_to_kick)
+			nr_to_kick--;
+		else
+			continue;
+
+		scx_bpf_kick_cpu(cpu, SCX_KICK_PREEMPT);
+	}
+
+	bpf_timer_start(timer, TIMER_INTERVAL_NS, BPF_F_TIMER_CPU_PIN);
+	__sync_fetch_and_add(&nr_timers, 1);
+	return 0;
+}
+
 int BPF_STRUCT_OPS_SLEEPABLE(central_init)
 {
-	return scx_bpf_create_dsq(FALLBACK_DSQ_ID, -1);
+	u32 key = 0;
+	struct bpf_timer *timer;
+	int ret;
+
+	ret = scx_bpf_create_dsq(FALLBACK_DSQ_ID, -1);
+	if (ret)
+		return ret;
+
+	timer = bpf_map_lookup_elem(&central_timer, &key);
+	if (!timer)
+		return -ESRCH;
+
+	if (bpf_get_smp_processor_id() != central_cpu) {
+		scx_bpf_error("init from non-central CPU");
+		return -EINVAL;
+	}
+
+	bpf_timer_init(timer, &central_timer, CLOCK_MONOTONIC);
+	bpf_timer_set_callback(timer, central_timerfn);
+
+	ret = bpf_timer_start(timer, TIMER_INTERVAL_NS, BPF_F_TIMER_CPU_PIN);
+	/*
+	 * BPF_F_TIMER_CPU_PIN is pretty new (>=6.7). If we're running in a
+	 * kernel which doesn't have it, bpf_timer_start() will return -EINVAL.
+	 * Retry without the PIN. This would be the perfect use case for
+	 * bpf_core_enum_value_exists() but the enum type doesn't have a name
+	 * and can't be used with bpf_core_enum_value_exists(). Oh well...
+	 */
+	if (ret == -EINVAL) {
+		timer_pinned = false;
+		ret = bpf_timer_start(timer, TIMER_INTERVAL_NS, 0);
+	}
+	if (ret)
+		scx_bpf_error("bpf_timer_start failed (%d)", ret);
+	return ret;
 }
 
 void BPF_STRUCT_OPS(central_exit, struct scx_exit_info *ei)
@@ -209,6 +354,8 @@ SCX_OPS_DEFINE(central_ops,
 	       .select_cpu		= (void *)central_select_cpu,
 	       .enqueue			= (void *)central_enqueue,
 	       .dispatch		= (void *)central_dispatch,
+	       .running			= (void *)central_running,
+	       .stopping		= (void *)central_stopping,
 	       .init			= (void *)central_init,
 	       .exit			= (void *)central_exit,
 	       .name			= "central");
diff --git a/tools/sched_ext/scx_central.c b/tools/sched_ext/scx_central.c
index 5f09fc666a63..fb3f50886552 100644
--- a/tools/sched_ext/scx_central.c
+++ b/tools/sched_ext/scx_central.c
@@ -48,6 +48,7 @@ int main(int argc, char **argv)
 	struct bpf_link *link;
 	__u64 seq = 0;
 	__s32 opt;
+	cpu_set_t *cpuset;
 
 	libbpf_set_print(libbpf_print_fn);
 	signal(SIGINT, sigint_handler);
@@ -77,10 +78,35 @@ int main(int argc, char **argv)
 
 	/* Resize arrays so their element count is equal to cpu count. */
 	RESIZE_ARRAY(skel, data, cpu_gimme_task, skel->rodata->nr_cpu_ids);
+	RESIZE_ARRAY(skel, data, cpu_started_at, skel->rodata->nr_cpu_ids);
 
 	SCX_OPS_LOAD(skel, central_ops, scx_central, uei);
+
+	/*
+	 * Affinitize the loading thread to the central CPU, as:
+	 * - That's where the BPF timer is first invoked in the BPF program.
+	 * - We probably don't want this user space component to take up a core
+	 *   from a task that would benefit from avoiding preemption on one of
+	 *   the tickless cores.
+	 *
+	 * Until BPF supports pinning the timer, it's not guaranteed that it
+	 * will always be invoked on the central CPU. In practice, this
+	 * suffices the majority of the time.
+	 */
+	cpuset = CPU_ALLOC(skel->rodata->nr_cpu_ids);
+	SCX_BUG_ON(!cpuset, "Failed to allocate cpuset");
+	CPU_ZERO(cpuset);
+	CPU_SET(skel->rodata->central_cpu, cpuset);
+	SCX_BUG_ON(sched_setaffinity(0, sizeof(cpuset), cpuset),
+		   "Failed to affinitize to central CPU %d (max %d)",
+		   skel->rodata->central_cpu, skel->rodata->nr_cpu_ids - 1);
+	CPU_FREE(cpuset);
+
 	link = SCX_OPS_ATTACH(skel, central_ops, scx_central);
 
+	if (!skel->data->timer_pinned)
+		printf("WARNING : BPF_F_TIMER_CPU_PIN not available, timer not pinned to central\n");
+
 	while (!exit_req && !UEI_EXITED(skel, uei)) {
 		printf("[SEQ %llu]\n", seq++);
 		printf("total   :%10" PRIu64 "    local:%10" PRIu64 "   queued:%10" PRIu64 "  lost:%10" PRIu64 "\n",
@@ -88,7 +114,8 @@ int main(int argc, char **argv)
 		       skel->bss->nr_locals,
 		       skel->bss->nr_queued,
 		       skel->bss->nr_lost_pids);
-		printf("                    dispatch:%10" PRIu64 " mismatch:%10" PRIu64 " retry:%10" PRIu64 "\n",
+		printf("timer   :%10" PRIu64 " dispatch:%10" PRIu64 " mismatch:%10" PRIu64 " retry:%10" PRIu64 "\n",
+		       skel->bss->nr_timers,
 		       skel->bss->nr_dispatches,
 		       skel->bss->nr_mismatches,
 		       skel->bss->nr_retries);
-- 
2.45.2
```

## Diff

```diff
---
 include/linux/sched/ext.h         |   1 +
 kernel/sched/core.c               |  11 ++-
 kernel/sched/ext.c                |  52 +++++++++-
 kernel/sched/ext.h                |   2 +
 kernel/sched/sched.h              |   1 +
 tools/sched_ext/scx_central.bpf.c | 159 ++++++++++++++++++++++++++++--
 tools/sched_ext/scx_central.c     |  29 +++++-
 7 files changed, 242 insertions(+), 13 deletions(-)

diff --git a/include/linux/sched/ext.h b/include/linux/sched/ext.h
index 3b2809b980ac..6f1a4977e9f8 100644
--- a/include/linux/sched/ext.h
+++ b/include/linux/sched/ext.h
@@ -16,6 +16,7 @@ enum scx_public_consts {
 	SCX_OPS_NAME_LEN	= 128,

 	SCX_SLICE_DFL		= 20 * 1000000,	/* 20ms */
+	SCX_SLICE_INF		= U64_MAX,	/* infinite, implies nohz */
 };

 /*
diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 1a3144c80af8..d5eff4036be7 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -1256,11 +1256,14 @@ bool sched_can_stop_tick(struct rq *rq)
 		return true;

 	/*
-	 * If there are no DL,RR/FIFO tasks, there must only be CFS tasks left;
-	 * if there's more than one we need the tick for involuntary
-	 * preemption.
+	 * If there are no DL,RR/FIFO tasks, there must only be CFS or sched_ext tasks
+	 * left. For CFS, if there's more than one we need the tick for
+	 * involuntary preemption. For sched_ext, ask.
 	 */
-	if (rq->nr_running > 1)
+	if (!scx_switched_all() && rq->nr_running > 1)
+		return false;
+
+	if (scx_enabled() && !scx_can_stop_tick(rq))
 		return false;

 	/*
diff --git a/kernel/sched/ext.c b/kernel/sched/ext.c
index 2e652f7b8f54..ce32fc6b05cd 100644
--- a/kernel/sched/ext.c
+++ b/kernel/sched/ext.c
@@ -1086,7 +1086,8 @@ static void update_curr_scx(struct rq *rq)
 	account_group_exec_runtime(curr, delta_exec);
 	cgroup_account_cputime(curr, delta_exec);

-	curr->scx.slice -= min(curr->scx.slice, delta_exec);
+	if (curr->scx.slice != SCX_SLICE_INF)
+		curr->scx.slice -= min(curr->scx.slice, delta_exec);
 }

 static void dsq_mod_nr(struct scx_dispatch_q *dsq, s32 delta)
@@ -2093,6 +2094,28 @@ static void set_next_task_scx(struct rq *rq, struct task_struct *p, bool first)
 		SCX_CALL_OP(SCX_KF_REST, running, p);

 	clr_task_runnable(p, true);
+
+	/*
+	 * @p is getting newly scheduled or got kicked after someone updated its
+	 * slice. Refresh whether tick can be stopped. See scx_can_stop_tick().
+	 */
+	if ((p->scx.slice == SCX_SLICE_INF) !=
+	    (bool)(rq->scx.flags & SCX_RQ_CAN_STOP_TICK)) {
+		if (p->scx.slice == SCX_SLICE_INF)
+			rq->scx.flags |= SCX_RQ_CAN_STOP_TICK;
+		else
+			rq->scx.flags &= ~SCX_RQ_CAN_STOP_TICK;
+
+		sched_update_tick_dependency(rq);
+
+		/*
+		 * For now, let's refresh the load_avgs just when transitioning
+		 * in and out of nohz. In the future, we might want to add a
+		 * mechanism which calls the following periodically on
+		 * tick-stopped CPUs.
+		 */
+		update_other_load_avgs(rq);
+	}
 }

 static void put_prev_task_scx(struct rq *rq, struct task_struct *p)
@@ -2818,6 +2841,26 @@ int scx_check_setscheduler(struct task_struct *p, int policy)
 	return 0;
 }

+#ifdef CONFIG_NO_HZ_FULL
+bool scx_can_stop_tick(struct rq *rq)
+{
+	struct task_struct *p = rq->curr;
+
+	if (scx_ops_bypassing())
+		return false;
+
+	if (p->sched_class != &ext_sched_class)
+		return true;
+
+	/*
+	 * @rq can dispatch from different DSQs, so we can't tell whether it
+	 * needs the tick or not by looking at nr_running. Allow stopping ticks
+	 * iff the BPF scheduler indicated so. See set_next_task_scx().
+	 */
+	return rq->scx.flags & SCX_RQ_CAN_STOP_TICK;
+}
+#endif
+
 /*
  * Omitted operations:
  *
@@ -3120,6 +3163,9 @@ static void scx_ops_bypass(bool bypass)
 		}

 		rq_unlock_irqrestore(rq, &rf);
+
+		/* kick to restore ticks */
+		resched_cpu(cpu);
 	}
 }

@@ -4576,7 +4622,9 @@ __bpf_kfunc_start_defs();
  * BPF locks (in the future when BPF introduces more flexible locking).
  *
  * @p is allowed to run for @slice. The scheduling path is triggered on slice
- * exhaustion. If zero, the current residual slice is maintained.
+ * exhaustion. If zero, the current residual slice is maintained. If
+ * %SCX_SLICE_INF, @p never expires and the BPF scheduler must kick the CPU with
+ * scx_bpf_kick_cpu() to trigger scheduling.
  */
 __bpf_kfunc void scx_bpf_dispatch(struct task_struct *p, u64 dsq_id, u64 slice,
 				  u64 enq_flags)
diff --git a/kernel/sched/ext.h b/kernel/sched/ext.h
index 33a9f7fe5832..6ed946f72489 100644
--- a/kernel/sched/ext.h
+++ b/kernel/sched/ext.h
@@ -35,6 +35,7 @@ void scx_pre_fork(struct task_struct *p);
 int scx_fork(struct task_struct *p);
 void scx_post_fork(struct task_struct *p);
 void scx_cancel_fork(struct task_struct *p);
+bool scx_can_stop_tick(struct rq *rq);
 int scx_check_setscheduler(struct task_struct *p, int policy);
 bool task_should_scx(struct task_struct *p);
 void init_sched_ext_class(void);
@@ -73,6 +74,7 @@ static inline void scx_pre_fork(struct task_struct *p) {}
 static inline int scx_fork(struct task_struct *p) { return 0; }
 static inline void scx_post_fork(struct task_struct *p) {}
 static inline void scx_cancel_fork(struct task_struct *p) {}
+static inline bool scx_can_stop_tick(struct rq *rq) { return true; }
 static inline int scx_check_setscheduler(struct task_struct *p, int policy) { return 0; }
 static inline bool task_on_scx(const struct task_struct *p) { return false; }
 static inline void init_sched_ext_class(void) {}
diff --git a/kernel/sched/sched.h b/kernel/sched/sched.h
index d9054eb4ba82..b3c578cb43cd 100644
--- a/kernel/sched/sched.h
+++ b/kernel/sched/sched.h
@@ -727,6 +727,7 @@ struct cfs_rq {
 /* scx_rq->flags, protected by the rq lock */
 enum scx_rq_flags {
 	SCX_RQ_BALANCING	= 1 << 1,
+	SCX_RQ_CAN_STOP_TICK	= 1 << 2,
 };

 struct scx_rq {
diff --git a/tools/sched_ext/scx_central.bpf.c b/tools/sched_ext/scx_central.bpf.c
index 428b2262faa3..1d8fd570eaa7 100644
--- a/tools/sched_ext/scx_central.bpf.c
+++ b/tools/sched_ext/scx_central.bpf.c
@@ -13,7 +13,26 @@
  *    through per-CPU BPF queues. The current design is chosen to maximally
  *    utilize and verify various sched_ext mechanisms such as LOCAL_ON dispatching.
  *
- * b. Preemption
+ * b. Tickless operation
+ *
+ *    All tasks are dispatched with the infinite slice which allows stopping the
+ *    ticks on CONFIG_NO_HZ_FULL kernels running with the proper nohz_full
+ *    parameter. The tickless operation can be observed through
+ *    /proc/interrupts.
+ *
+ *    Periodic switching is enforced by a periodic timer checking all CPUs and
+ *    preempting them as necessary. Unfortunately, BPF timer currently doesn't
+ *    have a way to pin to a specific CPU, so the periodic timer isn't pinned to
+ *    the central CPU.
+ *
+ * c. Preemption
+ *
+ *    Kthreads are unconditionally queued to the head of a matching local dsq
+ *    and dispatched with SCX_DSQ_PREEMPT. This ensures that a kthread is always
+ *    prioritized over user threads, which is required for ensuring forward
+ *    progress as e.g. the periodic timer may run on a ksoftirqd and if the
+ *    ksoftirqd gets starved by a user thread, there may not be anything else to
+ *    vacate that user thread.
  *
  *    SCX_KICK_PREEMPT is used to trigger scheduling and CPUs to move to the
  *    next tasks.
@@ -32,14 +51,17 @@ char _license[] SEC("license") = "GPL";

 enum {
 	FALLBACK_DSQ_ID		= 0,
+	MS_TO_NS		= 1000LLU * 1000,
+	TIMER_INTERVAL_NS	= 1 * MS_TO_NS,
 };

 const volatile s32 central_cpu;
 const volatile u32 nr_cpu_ids = 1;	/* !0 for veristat, set during init */
 const volatile u64 slice_ns = SCX_SLICE_DFL;

+bool timer_pinned = true;
 u64 nr_total, nr_locals, nr_queued, nr_lost_pids;
-u64 nr_dispatches, nr_mismatches, nr_retries;
+u64 nr_timers, nr_dispatches, nr_mismatches, nr_retries;
 u64 nr_overflows;

 UEI_DEFINE(uei);
@@ -52,6 +74,23 @@ struct {

 /* can't use percpu map due to bad lookups */
 bool RESIZABLE_ARRAY(data, cpu_gimme_task);
+u64 RESIZABLE_ARRAY(data, cpu_started_at);
+
+struct central_timer {
+	struct bpf_timer timer;
+};
+
+struct {
+	__uint(type, BPF_MAP_TYPE_ARRAY);
+	__uint(max_entries, 1);
+	__type(key, u32);
+	__type(value, struct central_timer);
+} central_timer SEC(".maps");
+
+static bool vtime_before(u64 a, u64 b)
+{
+	return (s64)(a - b) < 0;
+}

 s32 BPF_STRUCT_OPS(central_select_cpu, struct task_struct *p,
 		   s32 prev_cpu, u64 wake_flags)
@@ -71,9 +110,22 @@ void BPF_STRUCT_OPS(central_enqueue, struct task_struct *p, u64 enq_flags)

 	__sync_fetch_and_add(&nr_total, 1);

+	/*
+	 * Push per-cpu kthreads at the head of local dsq's and preempt the
+	 * corresponding CPU. This ensures that e.g. ksoftirqd isn't blocked
+	 * behind other threads which is necessary for forward progress
+	 * guarantee as we depend on the BPF timer which may run from ksoftirqd.
+	 */
+	if ((p->flags & PF_KTHREAD) && p->nr_cpus_allowed == 1) {
+		__sync_fetch_and_add(&nr_locals, 1);
+		scx_bpf_dispatch(p, SCX_DSQ_LOCAL, SCX_SLICE_INF,
+				 enq_flags | SCX_ENQ_PREEMPT);
+		return;
+	}
+
 	if (bpf_map_push_elem(&central_q, &pid, 0)) {
 		__sync_fetch_and_add(&nr_overflows, 1);
-		scx_bpf_dispatch(p, FALLBACK_DSQ_ID, SCX_SLICE_DFL, enq_flags);
+		scx_bpf_dispatch(p, FALLBACK_DSQ_ID, SCX_SLICE_INF, enq_flags);
 		return;
 	}

@@ -106,7 +158,7 @@ static bool dispatch_to_cpu(s32 cpu)
 		 */
 		if (!bpf_cpumask_test_cpu(cpu, p->cpus_ptr)) {
 			__sync_fetch_and_add(&nr_mismatches, 1);
-			scx_bpf_dispatch(p, FALLBACK_DSQ_ID, SCX_SLICE_DFL, 0);
+			scx_bpf_dispatch(p, FALLBACK_DSQ_ID, SCX_SLICE_INF, 0);
 			bpf_task_release(p);
 			/*
 			 * We might run out of dispatch buffer slots if we continue dispatching
@@ -120,7 +172,7 @@ static bool dispatch_to_cpu(s32 cpu)
 		}

 		/* dispatch to local and mark that @cpu doesn't need more */
-		scx_bpf_dispatch(p, SCX_DSQ_LOCAL_ON | cpu, SCX_SLICE_DFL, 0);
+		scx_bpf_dispatch(p, SCX_DSQ_LOCAL_ON | cpu, SCX_SLICE_INF, 0);

 		if (cpu != central_cpu)
 			scx_bpf_kick_cpu(cpu, SCX_KICK_IDLE);
@@ -188,9 +240,102 @@ void BPF_STRUCT_OPS(central_dispatch, s32 cpu, struct task_struct *prev)
 	}
 }

+void BPF_STRUCT_OPS(central_running, struct task_struct *p)
+{
+	s32 cpu = scx_bpf_task_cpu(p);
+	u64 *started_at = ARRAY_ELEM_PTR(cpu_started_at, cpu, nr_cpu_ids);
+	if (started_at)
+		*started_at = bpf_ktime_get_ns() ?: 1;	/* 0 indicates idle */
+}
+
+void BPF_STRUCT_OPS(central_stopping, struct task_struct *p, bool runnable)
+{
+	s32 cpu = scx_bpf_task_cpu(p);
+	u64 *started_at = ARRAY_ELEM_PTR(cpu_started_at, cpu, nr_cpu_ids);
+	if (started_at)
+		*started_at = 0;
+}
+
+static int central_timerfn(void *map, int *key, struct bpf_timer *timer)
+{
+	u64 now = bpf_ktime_get_ns();
+	u64 nr_to_kick = nr_queued;
+	s32 i, curr_cpu;
+
+	curr_cpu = bpf_get_smp_processor_id();
+	if (timer_pinned && (curr_cpu != central_cpu)) {
+		scx_bpf_error("Central timer ran on CPU %d, not central CPU %d",
+			      curr_cpu, central_cpu);
+		return 0;
+	}
+
+	bpf_for(i, 0, nr_cpu_ids) {
+		s32 cpu = (nr_timers + i) % nr_cpu_ids;
+		u64 *started_at;
+
+		if (cpu == central_cpu)
+			continue;
+
+		/* kick iff the current one exhausted its slice */
+		started_at = ARRAY_ELEM_PTR(cpu_started_at, cpu, nr_cpu_ids);
+		if (started_at && *started_at &&
+		    vtime_before(now, *started_at + slice_ns))
+			continue;
+
+		/* and there's something pending */
+		if (scx_bpf_dsq_nr_queued(FALLBACK_DSQ_ID) ||
+		    scx_bpf_dsq_nr_queued(SCX_DSQ_LOCAL_ON | cpu))
+			;
+		else if (nr_to_kick)
+			nr_to_kick--;
+		else
+			continue;
+
+		scx_bpf_kick_cpu(cpu, SCX_KICK_PREEMPT);
+	}
+
+	bpf_timer_start(timer, TIMER_INTERVAL_NS, BPF_F_TIMER_CPU_PIN);
+	__sync_fetch_and_add(&nr_timers, 1);
+	return 0;
+}
+
 int BPF_STRUCT_OPS_SLEEPABLE(central_init)
 {
-	return scx_bpf_create_dsq(FALLBACK_DSQ_ID, -1);
+	u32 key = 0;
+	struct bpf_timer *timer;
+	int ret;
+
+	ret = scx_bpf_create_dsq(FALLBACK_DSQ_ID, -1);
+	if (ret)
+		return ret;
+
+	timer = bpf_map_lookup_elem(&central_timer, &key);
+	if (!timer)
+		return -ESRCH;
+
+	if (bpf_get_smp_processor_id() != central_cpu) {
+		scx_bpf_error("init from non-central CPU");
+		return -EINVAL;
+	}
+
+	bpf_timer_init(timer, &central_timer, CLOCK_MONOTONIC);
+	bpf_timer_set_callback(timer, central_timerfn);
+
+	ret = bpf_timer_start(timer, TIMER_INTERVAL_NS, BPF_F_TIMER_CPU_PIN);
+	/*
+	 * BPF_F_TIMER_CPU_PIN is pretty new (>=6.7). If we're running in a
+	 * kernel which doesn't have it, bpf_timer_start() will return -EINVAL.
+	 * Retry without the PIN. This would be the perfect use case for
+	 * bpf_core_enum_value_exists() but the enum type doesn't have a name
+	 * and can't be used with bpf_core_enum_value_exists(). Oh well...
+	 */
+	if (ret == -EINVAL) {
+		timer_pinned = false;
+		ret = bpf_timer_start(timer, TIMER_INTERVAL_NS, 0);
+	}
+	if (ret)
+		scx_bpf_error("bpf_timer_start failed (%d)", ret);
+	return ret;
 }

 void BPF_STRUCT_OPS(central_exit, struct scx_exit_info *ei)
@@ -209,6 +354,8 @@ SCX_OPS_DEFINE(central_ops,
 	       .select_cpu		= (void *)central_select_cpu,
 	       .enqueue			= (void *)central_enqueue,
 	       .dispatch		= (void *)central_dispatch,
+	       .running			= (void *)central_running,
+	       .stopping		= (void *)central_stopping,
 	       .init			= (void *)central_init,
 	       .exit			= (void *)central_exit,
 	       .name			= "central");
diff --git a/tools/sched_ext/scx_central.c b/tools/sched_ext/scx_central.c
index 5f09fc666a63..fb3f50886552 100644
--- a/tools/sched_ext/scx_central.c
+++ b/tools/sched_ext/scx_central.c
@@ -48,6 +48,7 @@ int main(int argc, char **argv)
 	struct bpf_link *link;
 	__u64 seq = 0;
 	__s32 opt;
+	cpu_set_t *cpuset;

 	libbpf_set_print(libbpf_print_fn);
 	signal(SIGINT, sigint_handler);
@@ -77,10 +78,35 @@ int main(int argc, char **argv)

 	/* Resize arrays so their element count is equal to cpu count. */
 	RESIZE_ARRAY(skel, data, cpu_gimme_task, skel->rodata->nr_cpu_ids);
+	RESIZE_ARRAY(skel, data, cpu_started_at, skel->rodata->nr_cpu_ids);

 	SCX_OPS_LOAD(skel, central_ops, scx_central, uei);
+
+	/*
+	 * Affinitize the loading thread to the central CPU, as:
+	 * - That's where the BPF timer is first invoked in the BPF program.
+	 * - We probably don't want this user space component to take up a core
+	 *   from a task that would benefit from avoiding preemption on one of
+	 *   the tickless cores.
+	 *
+	 * Until BPF supports pinning the timer, it's not guaranteed that it
+	 * will always be invoked on the central CPU. In practice, this
+	 * suffices the majority of the time.
+	 */
+	cpuset = CPU_ALLOC(skel->rodata->nr_cpu_ids);
+	SCX_BUG_ON(!cpuset, "Failed to allocate cpuset");
+	CPU_ZERO(cpuset);
+	CPU_SET(skel->rodata->central_cpu, cpuset);
+	SCX_BUG_ON(sched_setaffinity(0, sizeof(cpuset), cpuset),
+		   "Failed to affinitize to central CPU %d (max %d)",
+		   skel->rodata->central_cpu, skel->rodata->nr_cpu_ids - 1);
+	CPU_FREE(cpuset);
+
 	link = SCX_OPS_ATTACH(skel, central_ops, scx_central);

+	if (!skel->data->timer_pinned)
+		printf("WARNING : BPF_F_TIMER_CPU_PIN not available, timer not pinned to central\n");
+
 	while (!exit_req && !UEI_EXITED(skel, uei)) {
 		printf("[SEQ %llu]\n", seq++);
 		printf("total   :%10" PRIu64 "    local:%10" PRIu64 "   queued:%10" PRIu64 "  lost:%10" PRIu64 "\n",
@@ -88,7 +114,8 @@ int main(int argc, char **argv)
 		       skel->bss->nr_locals,
 		       skel->bss->nr_queued,
 		       skel->bss->nr_lost_pids);
-		printf("                    dispatch:%10" PRIu64 " mismatch:%10" PRIu64 " retry:%10" PRIu64 "\n",
+		printf("timer   :%10" PRIu64 " dispatch:%10" PRIu64 " mismatch:%10" PRIu64 " retry:%10" PRIu64 "\n",
+		       skel->bss->nr_timers,
 		       skel->bss->nr_dispatches,
 		       skel->bss->nr_mismatches,
 		       skel->bss->nr_retries);
--
2.45.2


```

## Implementation Analysis

### Overview

Linux's `CONFIG_NO_HZ_FULL` (nohz_full) feature allows CPUs to run without periodic timer ticks, reducing latency and overhead for real-time and high-performance workloads. Before this patch, sched_ext tasks always required ticks (for slice accounting and involuntary preemption). This patch integrates sched_ext with nohz: a BPF scheduler can signal that a task should run without ticks by setting `p->scx.slice = SCX_SLICE_INF` (U64_MAX). When a CPU's current task has an infinite slice, the CPU can enter tickless mode. The `scx_central` example is updated to demonstrate full tickless operation using a BPF timer for preemption instead of the tick.

### Code Walkthrough

**`include/linux/sched/ext.h` — `SCX_SLICE_INF`**

```c
SCX_SLICE_INF = U64_MAX,  /* infinite, implies nohz */
```

A new sentinel value for `p->scx.slice`. Setting this value tells sched_ext: "this task should run until the BPF scheduler explicitly kicks it off via `scx_bpf_kick_cpu()`." The kernel will not decrement the slice and will not trigger a scheduling event based on time expiration.

**`kernel/sched/sched.h` — `SCX_RQ_CAN_STOP_TICK`**

```c
enum scx_rq_flags {
    SCX_RQ_BALANCING     = 1 << 1,
    SCX_RQ_CAN_STOP_TICK = 1 << 2,  // NEW
};
```

A per-rq flag set in `set_next_task_scx()` when the newly selected task has `slice == SCX_SLICE_INF`. Cleared when the slice is not infinite. This flag is the single source of truth that `scx_can_stop_tick()` checks.

**`kernel/sched/ext.c` — `update_curr_scx()` guard**

```c
if (curr->scx.slice != SCX_SLICE_INF)
    curr->scx.slice -= min(curr->scx.slice, delta_exec);
```

The slice accounting code is guarded by a `SCX_SLICE_INF` check. An infinite-slice task never has its slice decremented, so it will never naturally trigger a reschedule due to time expiration.

**`kernel/sched/ext.c` — `set_next_task_scx()` tick dependency update**

```c
if ((p->scx.slice == SCX_SLICE_INF) !=
    (bool)(rq->scx.flags & SCX_RQ_CAN_STOP_TICK)) {
    if (p->scx.slice == SCX_SLICE_INF)
        rq->scx.flags |= SCX_RQ_CAN_STOP_TICK;
    else
        rq->scx.flags &= ~SCX_RQ_CAN_STOP_TICK;

    sched_update_tick_dependency(rq);
    update_other_load_avgs(rq);
}
```

When a task starts running, the code checks if the tick-stop state has changed. If it has, `sched_update_tick_dependency()` notifies the nohz subsystem. `update_other_load_avgs()` refreshes load averages at the transition boundary, since tickless CPUs stop receiving the periodic load average updates that normally come from the tick.

**`kernel/sched/ext.c` — `scx_can_stop_tick()` (CONFIG_NO_HZ_FULL)**

```c
#ifdef CONFIG_NO_HZ_FULL
bool scx_can_stop_tick(struct rq *rq)
{
    struct task_struct *p = rq->curr;
    if (scx_ops_bypassing()) return false;
    if (p->sched_class != &ext_sched_class) return true;
    return rq->scx.flags & SCX_RQ_CAN_STOP_TICK;
}
#endif
```

Called from `sched_can_stop_tick()` in `kernel/sched/core.c`. If the current task is not an SCX task, return true (defer to other scheduler classes). If it is an SCX task, return the `SCX_RQ_CAN_STOP_TICK` flag. During bypass, always return false.

**`kernel/sched/core.c` — `sched_can_stop_tick()` modification**

```c
// Before:
if (rq->nr_running > 1) return false;

// After:
if (!scx_switched_all() && rq->nr_running > 1) return false;
if (scx_enabled() && !scx_can_stop_tick(rq)) return false;
```

The "more than one runnable task → need tick for preemption" check is relaxed for `scx_switched_all()` mode: when all tasks use SCHED_EXT, the BPF scheduler handles preemption and does not need the tick for involuntary preemption.

**`scx_ops_bypass()` — kick to restore ticks**

```c
rq_unlock_irqrestore(rq, &rf);
resched_cpu(cpu);  // NEW: kick to restore ticks
```

When bypass mode is exited, each CPU is kicked to force a scheduling cycle that re-evaluates tick dependency, restoring ticks where needed.

**`scx_central.bpf.c` — tickless central scheduler**

The example scheduler is substantially extended:
1. All dispatches use `SCX_SLICE_INF` instead of `SCX_SLICE_DFL`.
2. A BPF timer (`central_timerfn`) fires every 1ms, checks which worker CPUs have exceeded `slice_ns`, and kicks them with `SCX_KICK_PREEMPT`.
3. `ops.running()` records `cpu_started_at[cpu] = bpf_ktime_get_ns()` when a task starts.
4. `ops.stopping()` clears `cpu_started_at[cpu] = 0`.
5. Per-CPU kthreads are dispatched with `SCX_ENQ_PREEMPT` to prevent ksoftirqd starvation (which would break the BPF timer).
6. The userspace loader affinitizes itself to `central_cpu` so the initial timer fires on the correct CPU.

The observed result: worker CPUs accumulate ~7 local timer interrupts over 10 seconds with tickless vs. ~2200 without.

### Key Concepts

- **`SCX_SLICE_INF` = U64_MAX**: The BPF scheduler's signal for "this task runs until I kick it." The kernel will not decrement the slice. The BPF scheduler takes responsibility for preemption via `scx_bpf_kick_cpu()` or BPF timers.
- **`SCX_RQ_CAN_STOP_TICK`**: A per-rq flag caching whether the current task has `SCX_SLICE_INF`. Updated in `set_next_task_scx()` under `rq->lock`. Read without locking in `scx_can_stop_tick()` — treated as advisory.
- **`sched_update_tick_dependency(rq)`**: The kernel function that tells the nohz subsystem whether a CPU can stop its tick. Must be called when `SCX_RQ_CAN_STOP_TICK` changes. Requires `rq->lock` to be held.
- **BPF timer for preemption**: When ticks are stopped, the kernel's tick-based involuntary preemption is gone. The BPF scheduler must substitute its own preemption mechanism. `scx_central` uses a `bpf_timer` at 1ms intervals.
- **`BPF_F_TIMER_CPU_PIN`**: A BPF timer flag (kernel >= 6.7) that pins the timer to a specific CPU. `scx_central` tries to pin to `central_cpu` with a fallback for older kernels.

### Locking and Concurrency Notes

- `scx_can_stop_tick()` is called from `sched_can_stop_tick()` which does NOT hold `rq->lock`. It reads `rq->scx.flags` without locking. This is intentional — the value is advisory.
- `SCX_RQ_CAN_STOP_TICK` is written under `rq->lock` (in `set_next_task_scx()`) and read without locking in `scx_can_stop_tick()`. The nohz subsystem tolerates this inconsistency.
- `scx_ops_bypass()` iterates all CPUs holding each CPU's `rq->lock` individually. The `resched_cpu()` call after unlocking wakes tickless CPUs back to a schedulable state.

### Why Maintainers Need to Know This

- **Tickless mode requires `SCX_SLICE_INF` on every dispatch to that task**: Tick suppression is per-scheduling-event. Switching to a finite-slice task immediately re-enables the tick for that CPU.
- **The BPF timer may not stay on `central_cpu`**: Even with `BPF_F_TIMER_CPU_PIN`, timer migration can occur. `scx_central` errors if this happens with `timer_pinned=true`. Production schedulers need robust handling.
- **ksoftirqd starvation kills the timer**: If a user task with infinite slice starves ksoftirqd, the BPF timer cannot fire. The per-CPU kthread priority boost in `central_enqueue()` is the mitigation — single-CPU-affinity kthreads are dispatched with `SCX_ENQ_PREEMPT`.
- **Load averages go stale on tickless CPUs**: `update_other_load_avgs()` is called only at the tick transition boundary. Production schedulers using tickless mode should account for potentially stale load data.

### Connection to Other Patches

- **PATCH 20/30** added `ops.running()` and `ops.stopping()` — this patch's `scx_central` is their first significant consumer, using them to track `cpu_started_at[]` for the BPF timer-based slice enforcement.
- **PATCH 17/30** introduced `SCX_KICK_PREEMPT` — the BPF timer uses `scx_bpf_kick_cpu(cpu, SCX_KICK_PREEMPT)` to force-expire infinite-slice tasks.
- **PATCH 22/30** replaces `SCX_CALL_OP()` with `SCX_CALL_OP_TASK()` in `set_next_task_scx()`, upgrading the `ops.running()` call added here.

### Detailed Walkthrough
1. File: `include/linux/sched/ext.h`
   Hunk: `@@ -16,6 +16,7 @@ enum scx_public_consts {`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   SCX_SLICE_INF		= U64_MAX,	/* infinite, implies nohz */
   ```
2. File: `kernel/sched/core.c`
   Hunk: `@@ -1256,11 +1256,14 @@ bool sched_can_stop_tick(struct rq *rq)`
   Before
   ```text
   * If there are no DL,RR/FIFO tasks, there must only be CFS tasks left;
   * if there's more than one we need the tick for involuntary
   * preemption.
   ```
   After
   ```text
   * If there are no DL,RR/FIFO tasks, there must only be CFS or sched_ext tasks
   * left. For CFS, if there's more than one we need the tick for
   * involuntary preemption. For sched_ext, ask.
   ```
3. File: `kernel/sched/ext.c`
   Hunk: `@@ -1086,7 +1086,8 @@ static void update_curr_scx(struct rq *rq)`
   Before
   ```text
   curr->scx.slice -= min(curr->scx.slice, delta_exec);
   ```
   After
   ```text
   if (curr->scx.slice != SCX_SLICE_INF)
   curr->scx.slice -= min(curr->scx.slice, delta_exec);
   ```
   Note
   ```text
   Additional hunks continue in this file (4 more section(s)).
   ```
4. File: `kernel/sched/ext.h`
   Hunk: `@@ -35,6 +35,7 @@ void scx_pre_fork(struct task_struct *p);`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   bool scx_can_stop_tick(struct rq *rq);
   ```
   Note
   ```text
   Additional hunks continue in this file (1 more section(s)).
   ```
5. File: `kernel/sched/sched.h`
   Hunk: `@@ -727,6 +727,7 @@ struct cfs_rq {`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   SCX_RQ_CAN_STOP_TICK	= 1 << 2,
   ```
6. File: `tools/sched_ext/scx_central.bpf.c`
   Hunk: `@@ -13,7 +13,26 @@`
   Before
   ```text
   * b. Preemption
   ```
   After
   ```text
   * b. Tickless operation
   *
   *    All tasks are dispatched with the infinite slice which allows stopping the
   ```
   Note
   ```text
   Additional hunks continue in this file (7 more section(s)).
   ```
7. File: `tools/sched_ext/scx_central.c`
   Hunk: `@@ -48,6 +48,7 @@ int main(int argc, char **argv)`
   Before
   ```text
   (no notable removed lines in sampled hunk)
   ```
   After
   ```text
   cpu_set_t *cpuset;
   ```
   Note
   ```text
   Additional hunks continue in this file (2 more section(s)).
   ```

### sched_ext Context
This patch directly expands sched_ext integration points and makes the scheduler core more extensible for BPF-defined policies.

