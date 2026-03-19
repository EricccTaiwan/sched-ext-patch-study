// Populate the sidebar
//
// This is a script, and not included directly in the page, to control the total size of the book.
// The TOC contains an entry for each page, so if each page includes a copy of the TOC,
// the total size of the page becomes O(n**2).
class MDBookSidebarScrollbox extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        this.innerHTML = '<ol class="chapter"><li class="chapter-item expanded "><a href="introduction.html"><strong aria-hidden="true">1.</strong> Introduction</a></li><li class="chapter-item expanded "><a href="index.html"><strong aria-hidden="true">2.</strong> Repository README</a></li><li class="chapter-item expanded "><a href="high-level-study-guide.html"><strong aria-hidden="true">3.</strong> High-Level Study Guide</a></li><li class="chapter-item expanded "><a href="patch-study/index.html"><strong aria-hidden="true">4.</strong> Patch Study</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="patch-study/foundational-refactoring.html"><strong aria-hidden="true">4.1.</strong> Foundational Refactoring (01-07)</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="patch-study/patch-01.html"><strong aria-hidden="true">4.1.1.</strong> Patch 01: sched: Restructure sched_class order sanity checks in sched_init()</a></li><li class="chapter-item expanded "><a href="patch-study/patch-02.html"><strong aria-hidden="true">4.1.2.</strong> Patch 02: sched: Allow sched_cgroup_fork() to fail and introduce sched_cancel_fork()</a></li><li class="chapter-item expanded "><a href="patch-study/patch-03.html"><strong aria-hidden="true">4.1.3.</strong> Patch 03: sched: Add sched_class-&gt;reweight_task()</a></li><li class="chapter-item expanded "><a href="patch-study/patch-04.html"><strong aria-hidden="true">4.1.4.</strong> Patch 04: sched: Add sched_class-&gt;switching_to() and expose check_class_changing/changed()</a></li><li class="chapter-item expanded "><a href="patch-study/patch-05.html"><strong aria-hidden="true">4.1.5.</strong> Patch 05: sched: Factor out cgroup weight conversion functions</a></li><li class="chapter-item expanded "><a href="patch-study/patch-06.html"><strong aria-hidden="true">4.1.6.</strong> Patch 06: sched: Factor out update_other_load_avgs() from __update_blocked_others()</a></li><li class="chapter-item expanded "><a href="patch-study/patch-07.html"><strong aria-hidden="true">4.1.7.</strong> Patch 07: sched: Add normal_policy()</a></li></ol></li><li class="chapter-item expanded "><a href="patch-study/sched-ext-core.html"><strong aria-hidden="true">4.2.</strong> sched_ext Core (08-11)</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="patch-study/patch-08.html"><strong aria-hidden="true">4.2.1.</strong> Patch 08: sched: Implement BPF extensible scheduler class</a></li><li class="chapter-item expanded "><a href="patch-study/patch-09.html"><strong aria-hidden="true">4.2.2.</strong> Patch 09: sched_ext: Add boilerplate for extensible scheduler class</a></li><li class="chapter-item expanded "><a href="patch-study/patch-10.html"><strong aria-hidden="true">4.2.3.</strong> Patch 10: sched_ext: Add sysrq-S which disables the BPF scheduler</a></li><li class="chapter-item expanded "><a href="patch-study/patch-11.html"><strong aria-hidden="true">4.2.4.</strong> Patch 11: sched_ext: Implement runnable task stall watchdog</a></li></ol></li><li class="chapter-item expanded "><a href="patch-study/debugging-and-monitoring.html"><strong aria-hidden="true">4.3.</strong> Debugging and Monitoring (12-16)</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="patch-study/patch-12.html"><strong aria-hidden="true">4.3.1.</strong> Patch 12: sched_ext: Print sched_ext info when dumping stack</a></li><li class="chapter-item expanded "><a href="patch-study/patch-13.html"><strong aria-hidden="true">4.3.2.</strong> Patch 13: sched_ext: Allow BPF schedulers to disallow specific tasks from joining SCHED_EXT</a></li><li class="chapter-item expanded "><a href="patch-study/patch-14.html"><strong aria-hidden="true">4.3.3.</strong> Patch 14: tools/sched_ext: Add scx_show_state.py</a></li><li class="chapter-item expanded "><a href="patch-study/patch-15.html"><strong aria-hidden="true">4.3.4.</strong> Patch 15: sched_ext: Add scx_simple and scx_example_qmap example schedulers</a></li><li class="chapter-item expanded "><a href="patch-study/patch-16.html"><strong aria-hidden="true">4.3.5.</strong> Patch 16: sched_ext: Add a central scheduler which makes all scheduling decisions on one CPU</a></li></ol></li><li class="chapter-item expanded "><a href="patch-study/cpu-coordination.html"><strong aria-hidden="true">4.4.</strong> CPU Coordination (17-19)</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="patch-study/patch-17.html"><strong aria-hidden="true">4.4.1.</strong> Patch 17: sched_ext: Implement scx_bpf_kick_cpu() and task preemption support</a></li><li class="chapter-item expanded "><a href="patch-study/patch-18.html"><strong aria-hidden="true">4.4.2.</strong> Patch 18: sched_ext: Print debug dump after an error exit</a></li><li class="chapter-item expanded "><a href="patch-study/patch-19.html"><strong aria-hidden="true">4.4.3.</strong> Patch 19: sched_ext: Make watchdog handle ops.dispatch() looping stall</a></li></ol></li><li class="chapter-item expanded "><a href="patch-study/task-and-operation-management.html"><strong aria-hidden="true">4.5.</strong> Task and Operation Management (20-23)</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="patch-study/patch-20.html"><strong aria-hidden="true">4.5.1.</strong> Patch 20: sched_ext: Add task state tracking operations</a></li><li class="chapter-item expanded "><a href="patch-study/patch-21.html"><strong aria-hidden="true">4.5.2.</strong> Patch 21: sched_ext: Track tasks that are subjects of the in-flight sched_ext operation</a></li><li class="chapter-item expanded "><a href="patch-study/patch-22.html"><strong aria-hidden="true">4.5.3.</strong> Patch 22: sched_ext: Implement SCX_KICK_WAIT</a></li><li class="chapter-item expanded "><a href="patch-study/patch-23.html"><strong aria-hidden="true">4.5.4.</strong> Patch 23: sched_ext: Implement tickless support</a></li></ol></li><li class="chapter-item expanded "><a href="patch-study/system-integration.html"><strong aria-hidden="true">4.6.</strong> System Integration (24-28)</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="patch-study/patch-24.html"><strong aria-hidden="true">4.6.1.</strong> Patch 24: sched_ext: Bypass BPF scheduler while PM events are in progress</a></li><li class="chapter-item expanded "><a href="patch-study/patch-25.html"><strong aria-hidden="true">4.6.2.</strong> Patch 25: sched_ext: Implement sched_ext_ops.cpu_acquire/release()</a></li><li class="chapter-item expanded "><a href="patch-study/patch-26.html"><strong aria-hidden="true">4.6.3.</strong> Patch 26: sched_ext: Implement sched_ext_ops.cpu_online/offline()</a></li><li class="chapter-item expanded "><a href="patch-study/patch-27.html"><strong aria-hidden="true">4.6.4.</strong> Patch 27: sched_ext: Implement core-sched support</a></li><li class="chapter-item expanded "><a href="patch-study/patch-28.html"><strong aria-hidden="true">4.6.5.</strong> Patch 28: sched_ext: Add vtime-ordered priority queue to dispatch_q&#39;s</a></li></ol></li><li class="chapter-item expanded "><a href="patch-study/documentation-and-testing.html"><strong aria-hidden="true">4.7.</strong> Documentation and Testing (29-30)</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="patch-study/patch-29.html"><strong aria-hidden="true">4.7.1.</strong> Patch 29: sched_ext: Documentation: scheduler: Document extensible scheduler class</a></li><li class="chapter-item expanded "><a href="patch-study/patch-30.html"><strong aria-hidden="true">4.7.2.</strong> Patch 30: sched_ext: Implement BPF extensible scheduler class</a></li></ol></li><li class="chapter-item expanded "><a href="patch-study/community-follow-up.html"><strong aria-hidden="true">4.8.</strong> Community Follow-up (31-42)</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="patch-study/patch-31.html"><strong aria-hidden="true">4.8.1.</strong> Patch 31: sched_ext: Add selftests</a></li><li class="chapter-item expanded "><a href="patch-study/patch-32.html"><strong aria-hidden="true">4.8.2.</strong> Patch 32: Re: sched_ext: Documentation: scheduler: Document</a></li><li class="chapter-item expanded "><a href="patch-study/patch-33.html"><strong aria-hidden="true">4.8.3.</strong> Patch 33: Re: sched: Add sched_class-&gt;switching_to() and expose</a></li><li class="chapter-item expanded "><a href="patch-study/patch-34.html"><strong aria-hidden="true">4.8.4.</strong> Patch 34: Re: sched: Add sched_class-&gt;switching_to() and expose</a></li><li class="chapter-item expanded "><a href="patch-study/patch-35.html"><strong aria-hidden="true">4.8.5.</strong> Patch 35: Re: sched: Add sched_class-&gt;switching_to() and expose</a></li><li class="chapter-item expanded "><a href="patch-study/patch-36.html"><strong aria-hidden="true">4.8.6.</strong> Patch 36: Re: sched_ext: Add scx_simple and scx_example_qmap</a></li><li class="chapter-item expanded "><a href="patch-study/patch-37.html"><strong aria-hidden="true">4.8.7.</strong> Patch 37: [PATCH sched_ext/for-6.11] sched_ext: Drop tools_clean target from</a></li><li class="chapter-item expanded "><a href="patch-study/patch-38.html"><strong aria-hidden="true">4.8.8.</strong> Patch 38: Re: [PATCH sched_ext/for-6.11] sched_ext: Drop tools_clean target</a></li><li class="chapter-item expanded "><a href="patch-study/patch-39.html"><strong aria-hidden="true">4.8.9.</strong> Patch 39: Re: sched_ext: Implement BPF extensible scheduler class</a></li><li class="chapter-item expanded "><a href="patch-study/patch-40.html"><strong aria-hidden="true">4.8.10.</strong> Patch 40: Re: sched_ext: Implement BPF extensible scheduler class</a></li><li class="chapter-item expanded "><a href="patch-study/patch-41.html"><strong aria-hidden="true">4.8.11.</strong> Patch 41: Re: sched_ext: Implement BPF extensible scheduler class</a></li><li class="chapter-item expanded "><a href="patch-study/patch-42.html"><strong aria-hidden="true">4.8.12.</strong> Patch 42: Re: sched_ext: Implement BPF extensible scheduler class</a></li></ol></li></ol></li></ol>';
        // Set the current, active page, and reveal it if it's hidden
        let current_page = document.location.href.toString().split("#")[0].split("?")[0];
        if (current_page.endsWith("/")) {
            current_page += "index.html";
        }
        var links = Array.prototype.slice.call(this.querySelectorAll("a"));
        var l = links.length;
        for (var i = 0; i < l; ++i) {
            var link = links[i];
            var href = link.getAttribute("href");
            if (href && !href.startsWith("#") && !/^(?:[a-z+]+:)?\/\//.test(href)) {
                link.href = path_to_root + href;
            }
            // The "index" page is supposed to alias the first chapter in the book.
            if (link.href === current_page || (i === 0 && path_to_root === "" && current_page.endsWith("/index.html"))) {
                link.classList.add("active");
                var parent = link.parentElement;
                if (parent && parent.classList.contains("chapter-item")) {
                    parent.classList.add("expanded");
                }
                while (parent) {
                    if (parent.tagName === "LI" && parent.previousElementSibling) {
                        if (parent.previousElementSibling.classList.contains("chapter-item")) {
                            parent.previousElementSibling.classList.add("expanded");
                        }
                    }
                    parent = parent.parentElement;
                }
            }
        }
        // Track and set sidebar scroll position
        this.addEventListener('click', function(e) {
            if (e.target.tagName === 'A') {
                sessionStorage.setItem('sidebar-scroll', this.scrollTop);
            }
        }, { passive: true });
        var sidebarScrollTop = sessionStorage.getItem('sidebar-scroll');
        sessionStorage.removeItem('sidebar-scroll');
        if (sidebarScrollTop) {
            // preserve sidebar scroll position when navigating via links within sidebar
            this.scrollTop = sidebarScrollTop;
        } else {
            // scroll sidebar to current active section when navigating via "next/previous chapter" buttons
            var activeSection = document.querySelector('#sidebar .active');
            if (activeSection) {
                activeSection.scrollIntoView({ block: 'center' });
            }
        }
        // Toggle buttons
        var sidebarAnchorToggles = document.querySelectorAll('#sidebar a.toggle');
        function toggleSection(ev) {
            ev.currentTarget.parentElement.classList.toggle('expanded');
        }
        Array.from(sidebarAnchorToggles).forEach(function (el) {
            el.addEventListener('click', toggleSection);
        });
    }
}
window.customElements.define("mdbook-sidebar-scrollbox", MDBookSidebarScrollbox);
