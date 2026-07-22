// ============================================================
//  CPRI — shared front-end (Premium 2026 redesign)
//  Injects navbar + footer + global UX chrome, handles nav,
//  dark mode, search, AI assistant, particles, counters,
//  charts, reveals, toasts, a11y, mobile nav, and content.
// ============================================================
// Guaranteed page-loader dismissal (runs no matter what else happens)
setTimeout(() => { const l = document.getElementById('pageLoader'); if (l) l.classList.add('hide'); }, 2200);

const CPRI = (() => {
  const SITE = {
    shortName: 'CPRI',
    name: 'Center for Policy and Research Innovations',
    baseNav: [
      { label: 'Home', href: 'index.html', icon: 'bi-house' },
      { label: 'About', icon: 'bi-info-circle', group: [
        { label: 'About CPRI', href: 'about.html', icon: 'bi-info-circle', desc: 'Mission, vision & team' },
        { label: 'Research Agenda', href: 'research-agenda.html', icon: 'bi-graph-up-arrow', desc: 'Priority themes' },
        { label: 'Contact', href: 'contact.html', icon: 'bi-envelope', desc: 'Get in touch' }
      ]},
      { label: 'News & Events', icon: 'bi-megaphone', group: [
        { label: 'Announcements', href: 'announcements.html', icon: 'bi-megaphone', desc: 'Latest updates' },
        { label: 'Events', href: 'events.html', icon: 'bi-calendar-event', desc: 'Workshops & talks' },
        { label: 'Events & Conferences', href: 'events-module.html', icon: 'bi-people', desc: 'Symposia' }
      ]},
      { label: 'Research', icon: 'bi-journal-richtext', group: [        { label: 'Student Researcher Portal', href: 'student-researchers.html', icon: 'bi-mortarboard', desc: 'Submit capstone and research outputs' },        { label: 'Submissions', href: 'submissions.html', icon: 'bi-send', desc: 'Submit research' },
        { label: 'Repository', href: 'repository.html', icon: 'bi-archive', desc: 'Open repository' },
        { label: 'Publications', href: 'publications.html', icon: 'bi-journal-richtext', desc: 'Papers & briefs' },
        { label: 'Ethics Review', href: 'ethics.html', icon: 'bi-shield-check', desc: 'Ethics clearance' },
        { label: 'Researchers', href: 'researchers.html', icon: 'bi-people', desc: 'Our people' },
        { label: 'Innovation & Extension', href: 'innovation-extension.html', icon: 'bi-lightbulb', desc: 'Applied work' },
        { label: 'Reports', href: 'reports.html', icon: 'bi-file-earmark-bar-graph', desc: 'Annual reports' }
      ]},
      { label: 'Admin', href: 'admin-dashboard.html', icon: 'bi-speedometer2' }
    ]
  };

  const PAGE_LABELS = {
    'index.html':'Home','about.html':'About CPRI','research-agenda.html':'Research Agenda',
    'contact.html':'Contact','announcements.html':'Announcements','events.html':'Events',
    'events-module.html':'Events & Conferences','student-researchers.html':'Student Researchers',
    'submissions.html':'Submissions','repository.html':'Repository','publications.html':'Publications','ethics.html':'Ethics Review',
    'researchers.html':'Researchers','innovation-extension.html':'Innovation & Extension',
    'reports.html':'Reports','admin-dashboard.html':'Admin Console','account.html':'My Account',
    'login.html':'Login','register.html':'Register','forgot.html':'Forgot Password',
    'reset.html':'Reset Password','profile.html':'Profile','submission.html':'Submission',
    'submit.html':'Submit','repository-detail.html':'Repository Item','publication-detail.html':'Publication',
    'publication-form.html':'Edit Publication','researcher-detail.html':'Researcher',
    'researcher-form.html':'Edit Researcher','event-detail.html':'Event','event-registration.html':'Event Registration',
    'event-abstract.html':'Event Abstract','ethics-detail.html':'Ethics Detail','ethics-form.html':'Ethics Form',
    'innovation-extension-detail.html':'Innovation Detail','innovation-extension-form.html':'Innovation Form'
  };

  const currentPage = () => location.pathname.split('/').pop() || 'index.html';

  async function getNavItems() {
    const auth = [];
    try {
      const me = await fetch('/api/auth/me').then(r => r.ok ? r.json() : null).catch(() => null);
      if (me && me.user) {
        auth.push({ label: 'Dashboard', href: 'admin-dashboard.html', primary: true });
        auth.push({ label: 'My Account', href: 'account.html' });
        auth.push({ label: 'Logout', href: '#', action: 'logout' });
      } else {
        auth.push({ label: 'Login', href: 'login.html' });
        auth.push({ label: 'Register', href: 'register.html', primary: true });
      }
    } catch {
      auth.push({ label: 'Login', href: 'login.html' });
      auth.push({ label: 'Register', href: 'register.html', primary: true });
    }
    return { nav: SITE.baseNav, auth };
  }

  function breadcrumbHtml(active) {
    if (active === 'index.html') return '';
    const label = PAGE_LABELS[active] || active.replace('.html','');
    return `<nav class="breadcrumb-bar" aria-label="Breadcrumb">
      <div class="container-xl">
        <a href="index.html"><i class="bi bi-house"></i> Home</a>
        <i class="bi bi-chevron-right"></i><span aria-current="page">${label}</span>
      </div></nav>`;
  }

  function headerHtml(active, navItems) {
    const links = navItems.nav.map(item => {
      const icon = item.icon ? `<i class="bi ${item.icon}"></i>` : '';
      if (item.group) {
        const sub = item.group.map(s => {
          const isActive = s.href === active ? ' class="active"' : '';
          const si = s.icon ? `<i class="bi ${s.icon}"></i>` : '';
          const sd = s.desc ? `<small>${s.desc}</small>` : '';
          return `<li><a href="${s.href}"${isActive}>${si}<span>${s.label}${sd}</span></a></li>`;
        }).join('');
        const isActiveGroup = item.group.some(g => g.href === active);
        const panelCls = item.group.length > 5 ? ' cols-2' : '';
        return `<li class="cpri-group${isActiveGroup ? ' active' : ''}">
          <a href="#" class="cpri-group-label" aria-haspopup="true" aria-expanded="false">${icon}<span>${item.label}</span><i class="bi bi-chevron-down cpri-caret-icon"></i></a>
          <ul class="cpri-submenu${panelCls}">${sub}</ul>
        </li>`;
      }
      const isActive = item.href === active ? ' class="active"' : '';
      return `<li><a href="${item.href}"${isActive}>${icon}<span>${item.label}</span></a></li>`;
    }).join('');

    const loggedIn = navItems.auth.some(a => a.action === 'logout');
    let authHtml;
    if (loggedIn) {
      authHtml = `<a class="cpri-icon-btn" href="admin-dashboard.html" aria-label="Quick dashboard" title="Dashboard"><i class="bi bi-grid-1x2"></i></a>
        <a class="cpri-avatar" href="account.html" aria-label="My account" title="My Account">CP</a>`;
    } else {
      authHtml = navItems.auth.map(item => {
        const cls = item.primary ? 'btn btn-gradient' : 'btn btn-outline-light';
        return `<a href="${item.href}" class="${cls}">${item.label}</a>`;
      }).join('');
    }

    const solid = active !== 'index.html' ? ' force-solid' : '';
    return `
    <header class="cpri-header">
      <div class="cpri-nav${solid}">
        <div class="container-xl nav-inner">
          <a class="cpri-brand" href="index.html">
            <span class="logo">C</span>
            <span>${SITE.shortName}<small>${SITE.name}</small></span>
          </a>
          <button class="cpri-nav-toggle" aria-label="Toggle navigation" aria-expanded="false"><i class="bi bi-list"></i></button>
          <ul class="cpri-nav-links">${links}</ul>
          <div class="cpri-util">
            <button class="cpri-icon-btn" id="nav-search" aria-label="Search"><i class="bi bi-search"></i></button>
            <button class="cpri-icon-btn" id="nav-theme" aria-label="Toggle dark mode" title="Dark mode"><i class="bi bi-moon-stars"></i></button>
            <button class="cpri-icon-btn" id="nav-lang" aria-label="Language"><i class="bi bi-translate"></i><span style="position:absolute;bottom:4px;right:4px;font-size:.5rem;font-weight:700;">EN</span></button>
            <button class="cpri-icon-btn" aria-label="Notifications"><i class="bi bi-bell"></i><span class="dot"></span></button>
            ${authHtml}
            <button class="cpri-icon-btn" id="nav-a11y" aria-label="Accessibility settings" title="Accessibility"><i class="bi bi-universal-access"></i></button>
            <button class="cpri-icon-btn mobile-nav-toggle" id="nav-offcanvas" aria-label="Menu"><i class="bi bi-list"></i></button>
          </div>
        </div>
      </div>
      ${breadcrumbHtml(active)}
    </header>`;
  }

  function footerHtml() {
    return `
    <footer class="cpri-footer">
      <div class="container-xl">
        <div class="f-grid">
          <div>
            <h4>${SITE.name}</h4>
            <p>Advancing evidence-based policy through rigorous research, collaboration, and capability building for a more equitable and resilient society.</p>
            <div class="socials">
              <a href="#" aria-label="Facebook"><i class="fa-brands fa-facebook-f"></i></a>
              <a href="#" aria-label="X"><i class="fa-brands fa-x-twitter"></i></a>
              <a href="#" aria-label="LinkedIn"><i class="fa-brands fa-linkedin-in"></i></a>
              <a href="#" aria-label="YouTube"><i class="fa-brands fa-youtube"></i></a>
            </div>
          </div>
          <div>
            <h4>Research Links</h4>
            <ul class="feature-list f-links">
              <li><a href="research-agenda.html">Research Agenda</a></li>
              <li><a href="publications.html">Publications</a></li>
              <li><a href="repository.html">Repository</a></li>
              <li><a href="ethics.html">Ethics Review</a></li>
              <li><a href="reports.html">Reports</a></li>
            </ul>
          </div>
          <div>
            <h4>Quick Links</h4>
            <ul class="feature-list f-links">
              <li><a href="index.html">Home</a></li>
              <li><a href="about.html">About CPRI</a></li>
              <li><a href="announcements.html">Announcements</a></li>
              <li><a href="events.html">Events</a></li>
              <li><a href="contact.html">Contact</a></li>
            </ul>
          </div>
          <div>
            <h4>Contact & Newsletter</h4>
            <p><i class="bi bi-envelope"></i> cpri@university.edu<br>
               <i class="bi bi-telephone"></i> +63 (2) 8123 4567</p>
            <form class="f-news" data-newsletter>
              <input type="email" placeholder="Your email" aria-label="Email" required>
              <button class="btn btn-accent" type="submit">Subscribe</button>
            </form>
          </div>
        </div>
        <div class="footer-bottom">
          &copy; ${new Date().getFullYear()} ${SITE.name}. All rights reserved. · <a href="about.html">Privacy</a> · <a href="about.html">Accessibility</a>
        </div>
      </div>
    </footer>`;
  }

  const CHROME = `
    <div class="scroll-progress" id="scrollProgress"></div>
    <button class="back-to-top" id="backToTop" aria-label="Back to top"><i class="bi bi-arrow-up"></i></button>

    <div class="search-pop" id="searchPop" role="dialog" aria-label="Search">
      <div class="sp-box">
        <div class="sp-input"><i class="bi bi-search"></i>
          <input type="text" id="searchInput" placeholder="Search research, people, events…" aria-label="Search query">
          <button class="btn btn-soft btn-sm" id="searchVoice" aria-label="Voice search"><i class="bi bi-mic"></i></button>
        </div>
        <div class="sp-body">
          <div class="sp-suggest">Quick suggestions</div>
          <a class="sp-item" href="publications.html"><i class="bi bi-journal-richtext"></i><div>Publications &amp; policy briefs<small>Open repository</small></div></a>
          <a class="sp-item" href="researchers.html"><i class="bi bi-people"></i><div>Researchers directory<small>Find experts</small></div></a>
          <a class="sp-item" href="events.html"><i class="bi bi-calendar-event"></i><div>Upcoming events<small>Conferences &amp; seminars</small></div></a>
          <a class="sp-item" href="research-agenda.html"><i class="bi bi-graph-up-arrow"></i><div>Research agenda<small>Priority themes</small></div></a>
        </div>
      </div>
    </div>

    <aside class="a11y-panel" id="a11yPanel" aria-label="Accessibility settings">
      <h4><i class="bi bi-universal-access"></i> Accessibility</h4>
      <div class="a11y-row"><div><div class="lbl">Dark mode</div><div class="sub">Switch color theme</div></div>
        <label class="switch"><input type="checkbox" id="a11yTheme"><span></span></label></div>
      <div class="a11y-row"><div><div class="lbl">High contrast</div><div class="sub">Stronger borders</div></div>
        <label class="switch"><input type="checkbox" id="a11yContrast"><span></span></label></div>
      <div class="a11y-row"><div><div class="lbl">Text size</div><div class="sub">Scale typography</div></div>
        <div class="seg" id="a11yFont"><button data-v="">A</button><button data-v="s">A-</button><button data-v="l">A+</button><button data-v="xl">A++</button></div></div>
      <div class="a11y-row"><div><div class="lbl">Reduce motion</div><div class="sub">Calmer animations</div></div>
        <label class="switch"><input type="checkbox" id="a11yMotion"><span></span></label></div>
      <button class="btn btn-outline-dark w-100 mt-3" id="a11yReset">Reset preferences</button>
    </aside>

    <button class="ai-fab" id="aiFab" aria-label="Open AI assistant"><i class="bi bi-robot"></i></button>
    <div class="ai-chat" id="aiChat" role="dialog" aria-label="AI Research Assistant">
      <header><span class="av"><i class="bi bi-robot"></i></span><div><b>AIRA</b><small>CPRI AI Research Assistant</small></div>
        <button class="close" id="aiClose" aria-label="Close"><i class="bi bi-x-lg"></i></button></header>
      <div class="ai-body" id="aiBody"></div>
      <div class="ai-chips" id="aiChips">
        <button>Summarize a paper</button><button>Find researchers</button><button>Suggest topics</button><button>Open access?</button>
      </div>
      <div class="ai-input"><input type="text" id="aiInput" placeholder="Ask about our research…"><button id="aiSend"><i class="bi bi-send"></i></button></div>
    </div>

    <nav class="mobile-offcanvas" id="mobileOff" aria-label="Mobile menu"></nav>
    <nav class="bottom-nav" id="bottomNav" aria-label="Quick">
      <a href="index.html" class="active"><i class="bi bi-house"></i>Home</a>
      <a href="research-agenda.html"><i class="bi bi-graph-up-arrow"></i>Research</a>
      <a href="publications.html"><i class="bi bi-journal-richtext"></i>Papers</a>
      <a href="events.html"><i class="bi bi-calendar-event"></i>Events</a>
      <a href="#" id="bnMenu"><i class="bi bi-grid"></i>More</a>
    </nav>

    <div class="toast-wrap" id="toastWrap"></div>`;

  function injectLayout() {
    const active = currentPage();
    const headerEl = document.getElementById('site-header');
    const footerEl = document.getElementById('site-footer');
    getNavItems().then(navItems => {
      if (headerEl) headerEl.outerHTML = headerHtml(active, navItems);
      if (footerEl) footerEl.outerHTML = footerHtml();
      document.body.insertAdjacentHTML('beforeend', CHROME);
      buildMobileNav(active, navItems);
      initNav();
      initChrome(active);
      initReveal();
      initCounters();
      initFaq();
      initNewsletter();
      initAuthActions();
      applySavedPrefs();
    });
  }

  function buildMobileNav(active, navItems) {
    const off = document.getElementById('mobileOff');
    if (!off) return;
    const links = navItems.nav.map(item => {
      if (item.group) {
        const sub = item.group.map(s => `<a href="${s.href}"><i class="${s.icon}"></i>${s.label}</a>`).join('');
        return `<div class="mo-group"><a href="#" class="mo-toggle"><i class="${item.icon}"></i>${item.label}<i class="bi bi-chevron-down" style="margin-left:auto"></i></a><div class="mo-sub">${sub}</div></div>`;
      }
      return `<a href="${item.href}" class="${item.href===active?'active':''}"><i class="${item.icon}"></i>${item.label}</a>`;
    }).join('');
    const auth = navItems.auth.map(a => `<a href="${a.href}" class="${a.primary?'':''}"><i class="bi bi-person"></i>${a.label}</a>`).join('');
    off.innerHTML = `<div class="mo-head"><span class="cpri-brand" style="color:#fff"><span class="logo">C</span><span>CPRI</span></span>
      <button class="mo-close" id="moClose" aria-label="Close"><i class="bi bi-x-lg"></i></button></div>${links}${auth}`;
  }

  function initNav() {
    const toggle = document.querySelector('.cpri-nav-toggle');
    const links = document.querySelector('.cpri-nav-links');
    if (toggle && links) {
      toggle.addEventListener('click', () => {
        const open = links.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
      });
    }
    document.querySelectorAll('.cpri-group').forEach(group => {
      const label = group.querySelector('.cpri-group-label');
      const open = () => {
        document.querySelectorAll('.cpri-group.open').forEach(g => {
          if (g !== group) { g.classList.remove('open'); g.querySelector('.cpri-group-label').setAttribute('aria-expanded','false'); }
        });
        group.classList.add('open'); label.setAttribute('aria-expanded','true');
      };
      const close = () => { group.classList.remove('open'); label.setAttribute('aria-expanded','false'); };
      group.addEventListener('mouseenter', open);
      group.addEventListener('mouseleave', close);
      label.addEventListener('click', (e) => { e.preventDefault(); group.classList.contains('open') ? close() : open(); });
    });
    document.addEventListener('click', (e) => {
      if (e.target.closest('.cpri-group')) return;
      document.querySelectorAll('.cpri-group.open').forEach(g => { g.classList.remove('open'); g.querySelector('.cpri-group-label').setAttribute('aria-expanded','false'); });
    });
    const nav = document.querySelector('.cpri-nav');
    if (nav) { const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24); onScroll(); window.addEventListener('scroll', onScroll, { passive: true }); }
    // mobile offcanvas groups
    document.querySelectorAll('.mo-toggle').forEach(t => t.addEventListener('click', (e) => { e.preventDefault(); t.parentElement.classList.toggle('open'); }));
  }

  function initChrome(active) {
    // scroll progress + back to top
    const prog = document.getElementById('scrollProgress');
    const btt = document.getElementById('backToTop');
    if (prog || btt) {
      window.addEventListener('scroll', () => {
        const h = document.documentElement.scrollHeight - window.innerHeight;
        const p = h > 0 ? (window.scrollY / h) * 100 : 0;
        if (prog) prog.style.width = p + '%';
        if (btt) btt.classList.toggle('show', window.scrollY > 400);
      }, { passive: true });
    }
    if (btt) btt.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

    // search popup
    const sp = document.getElementById('searchPop');
    const searchBtn = document.getElementById('nav-search');
    if (sp && searchBtn) {
      const open = () => { sp.classList.add('open'); setTimeout(() => document.getElementById('searchInput').focus(), 50); };
      searchBtn.addEventListener('click', open);
      sp.addEventListener('click', (e) => { if (e.target === sp) sp.classList.remove('open'); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') sp.classList.remove('open'); if ((e.key === '/' ) && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); open(); } });
    }

    // theme toggle
    const themeBtn = document.getElementById('nav-theme');
    if (themeBtn) themeBtn.addEventListener('click', () => toggleTheme());

    // language (demo cycle)
    const langBtn = document.getElementById('nav-lang');
    if (langBtn) langBtn.addEventListener('click', () => toast('Language', 'Multilingual interface is being prepared (EN · ES · FR).'));

    // a11y panel
    const a11yBtn = document.getElementById('nav-a11y');
    const a11y = document.getElementById('a11yPanel');
    if (a11yBtn && a11y) a11yBtn.addEventListener('click', () => a11y.classList.toggle('open'));

    // mobile offcanvas
    const offBtn = document.getElementById('nav-offcanvas');
    const off = document.getElementById('mobileOff');
    if (offBtn && off) {
      offBtn.addEventListener('click', () => off.classList.add('open'));
      const moClose = document.getElementById('moClose');
      if (moClose) moClose.addEventListener('click', () => off.classList.remove('open'));
      off.addEventListener('click', (e) => { if (e.target === off) off.classList.remove('open'); });
    }
    const bnMenu = document.getElementById('bnMenu');
    if (bnMenu && off) bnMenu.addEventListener('click', (e) => { e.preventDefault(); off.classList.add('open'); });

    // page loader
    window.addEventListener('load', () => { const l = document.getElementById('pageLoader'); if (l) setTimeout(() => l.classList.add('hide'), 500); });
    const l = document.getElementById('pageLoader'); if (l) setTimeout(() => l.classList.add('hide'), 1400);

    // AI chat
    const fab = document.getElementById('aiFab');
    const chat = document.getElementById('aiChat');
    if (fab && chat) {
      fab.addEventListener('click', () => chat.classList.toggle('open'));
      document.getElementById('aiClose').addEventListener('click', () => chat.classList.remove('open'));
      document.getElementById('aiChips').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { document.getElementById('aiInput').value = e.target.textContent; sendAi(); } });
      document.getElementById('aiSend').addEventListener('click', sendAi);
      document.getElementById('aiInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAi(); });
      aiGreet();
    }

    // AOS
    if (window.AOS) AOS.init({ duration: 700, once: true, offset: 60 });
  }

  // ---- Theme & accessibility preferences ----
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('cpri-theme', next);
    const btn = document.getElementById('nav-theme');
    if (btn) btn.querySelector('i').className = next === 'dark' ? 'bi bi-sun' : 'bi bi-moon-stars';
    const cb = document.getElementById('a11yTheme'); if (cb) cb.checked = next === 'dark';
  }
  function applySavedPrefs() {
    const t = localStorage.getItem('cpri-theme');
    if (t) { document.documentElement.setAttribute('data-theme', t); }
    else if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.setAttribute('data-theme','dark');
    const cb = document.getElementById('a11yTheme'); if (cb) cb.checked = document.documentElement.getAttribute('data-theme') === 'dark';
    const c = localStorage.getItem('cpri-contrast'); if (c) document.documentElement.setAttribute('data-contrast', c);
    const cb2 = document.getElementById('a11yContrast'); if (cb2) cb2.checked = !!c;
    const f = localStorage.getItem('cpri-font'); if (f) document.documentElement.setAttribute('data-fscale', f);
    const seg = document.querySelector('#a11yFont button.active'); if (seg) seg.classList.remove('active');
    const fb = document.querySelector(`#a11yFont button[data-v="${f||''}"]`); if (fb) fb.classList.add('active');
    const m = localStorage.getItem('cpri-motion'); if (m) document.documentElement.style.setProperty('--reduce-motion', m);
    const cb3 = document.getElementById('a11yMotion'); if (cb3) cb3.checked = !!m;

    const cbg = document.getElementById('a11yContrast');
    if (cbg) cbg.addEventListener('change', () => {
      if (cbg.checked) { document.documentElement.setAttribute('data-contrast','high'); localStorage.setItem('cpri-contrast','high'); }
      else { document.documentElement.removeAttribute('data-contrast'); localStorage.removeItem('cpri-contrast'); }
    });
    const fseg = document.getElementById('a11yFont');
    if (fseg) fseg.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      fseg.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      const v = e.target.dataset.v;
      if (v) { document.documentElement.setAttribute('data-fscale', v); localStorage.setItem('cpri-font', v); }
      else { document.documentElement.removeAttribute('data-fscale'); localStorage.removeItem('cpri-font'); }
    });
    const reset = document.getElementById('a11yReset');
    if (reset) reset.addEventListener('click', () => {
      ['cpri-theme','cpri-contrast','cpri-font','cpri-motion'].forEach(k => localStorage.removeItem(k));
      location.reload();
    });
  }

  function toast(title, msg, icon) {
    const wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'cpri-toast';
    el.innerHTML = `<i class="bi bi-${icon || 'check-circle-fill'}"></i><div><b>${title}</b><small>${msg}</small></div>`;
    wrap.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 3600);
  }

  // ---- Particle background ----
  function particles() {
    const c = document.getElementById('particles');
    if (!c) return;
    const ctx = c.getContext('2d');
    let w, h, pts;
    function resize() { const r = c.parentElement.getBoundingClientRect(); w = c.width = r.width; h = c.height = r.height; }
    function init() {
      resize();
      const n = Math.min(70, Math.floor(w / 18));
      pts = Array.from({ length: n }, () => ({ x: Math.random()*w, y: Math.random()*h, vx: (Math.random()-.5)*.4, vy: (Math.random()-.5)*.4, r: Math.random()*1.8+.6 }));
    }
    function draw() {
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      pts.forEach(p => { p.x += p.vx; p.y += p.vy; if (p.x<0||p.x>w) p.vx*=-1; if (p.y<0||p.y>h) p.vy*=-1; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,7); ctx.fill(); });
      for (let i=0;i<pts.length;i++) for (let j=i+1;j<pts.length;j++) {
        const dx = pts[i].x-pts[j].x, dy = pts[i].y-pts[j].y, d = Math.hypot(dx,dy);
        if (d < 120) { ctx.strokeStyle = `rgba(255,255,255,${.12*(1-d/120)})`; ctx.beginPath(); ctx.moveTo(pts[i].x,pts[i].y); ctx.lineTo(pts[j].x,pts[j].y); ctx.stroke(); }
      }
      requestAnimationFrame(draw);
    }
    init(); draw();
    window.addEventListener('resize', init);
  }

  // ---- Typing animation ----
  function typing() {
    const el = document.getElementById('typed');
    if (!el) return;
    const words = ['evidence-based policy','public health systems','inclusive education','climate resilience','digital governance'];
    let wi = 0, ci = 0, del = false;
    function tick() {
      const w = words[wi];
      el.textContent = del ? w.slice(0, ci--) : w.slice(0, ci++);
      if (!del && ci > w.length) { del = true; return setTimeout(tick, 1400); }
      if (del && ci < 0) { del = false; wi = (wi+1) % words.length; ci = 0; }
      setTimeout(tick, del ? 45 : 90);
    }
    tick();
  }

  // ---- Count-up statistics (CountUp.js or fallback) ----
  function animateCount(el) {
    const target = parseFloat(el.dataset.count);
    const suffix = el.dataset.suffix || '';
    const dur = 1600, start = performance.now();
    function tick(now) {
      const p = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.floor(eased * target).toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = target.toLocaleString() + suffix;
    }
    requestAnimationFrame(tick);
  }
  function initCounters() {
    const els = document.querySelectorAll('[data-count]');
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) { els.forEach(animateCount); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => { if (en.isIntersecting) { animateCount(en.target); io.unobserve(en.target); } });
    }, { threshold: 0.4 });
    els.forEach(e => io.observe(e));
  }

  // ---- Progress bars + rings (triggered on view) ----
  function initHeroExtras() {
    typing();
    particles();
    // progress bars
    const bars = document.querySelectorAll('.gc-bar > span[data-w]');
    if (bars.length) {
      const io = new IntersectionObserver((ents) => ents.forEach(e => { if (e.isIntersecting) { e.target.style.width = e.target.dataset.w; io.unobserve(e.target); } }), { threshold: 0.3 });
      bars.forEach(b => io.observe(b));
    }
    // circular rings
    document.querySelectorAll('.ring').forEach(ring => {
      const pct = parseFloat(ring.dataset.pct) || 0;
      const fg = ring.querySelector('.ring-fg');
      if (fg) { const r = 32, c = 2 * Math.PI * r; fg.style.strokeDasharray = c; fg.style.strokeDashoffset = c; requestAnimationFrame(() => { fg.style.transition = 'stroke-dashoffset 1.6s ease'; fg.style.strokeDashoffset = c * (1 - pct/100); }); }
    });
    // dashboard chart
    if (window.Chart && document.getElementById('dashChart')) initDashChart();
    // swipers
    if (window.Swiper) {
      if (document.querySelector('.newsSwiper')) new Swiper('.newsSwiper', { slidesPerView: 1.1, spaceBetween: 18, breakpoints: { 640:{slidesPerView:2.1}, 992:{slidesPerView:3.1} }, pagination: { el: '.newsSwiper .swiper-pagination', clickable: true } });
      if (document.querySelector('.testiSwiper')) new Swiper('.testiSwiper', { slidesPerView: 1.1, spaceBetween: 18, breakpoints: { 768:{slidesPerView:2.1}, 1200:{slidesPerView:3.1} }, pagination: { el: '.testiSwiper .swiper-pagination', clickable: true } });
    }
    // GSAP parallax on hero art
    if (window.gsap) {
      const art = document.querySelector('.hero-art');
      if (art) window.addEventListener('mousemove', (e) => {
        const x = (e.clientX / window.innerWidth - .5) * 16;
        const y = (e.clientY / window.innerHeight - .5) * 16;
        window.gsap.to(art, { x, y, duration: .6, ease: 'power2.out' });
      });
    }
  }

  function initDashChart() {
    const ctx = document.getElementById('dashChart').getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 120);
    g.addColorStop(0, 'rgba(20,184,166,.35)'); g.addColorStop(1, 'rgba(20,184,166,0)');
    new Chart(ctx, {
      type: 'line',
      data: { labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug'],
        datasets: [
          { label:'Submissions', data:[18,24,30,28,35,42,38,46], borderColor:'#1E3A8A', backgroundColor:g, fill:true, tension:.4, borderWidth:2.5 },
          { label:'Approvals', data:[15,20,26,24,30,38,33,42], borderColor:'#14B8A6', backgroundColor:'transparent', tension:.4, borderWidth:2.5 }
        ] },
      options: { plugins:{ legend:{ display:false } }, scales:{ x:{ grid:{ display:false } }, y:{ grid:{ color:'rgba(100,116,139,.15)' } } }, responsive:true, maintainAspectRatio:false }
    });
  }

  // ---- AI assistant ----
  const AI_REPLIES = {
    'summarize':'AIRA can auto-summarize any publication into a 3-bullet brief. Open a paper and tap "AI Summary" to generate it.',
    'researcher':'You can browse the Researchers directory to find experts by theme, or ask me to match a topic to a person.',
    'suggest':'Trending themes this quarter: AI in Education, Climate Adaptation Finance, and Digital Public Services.',
    'access':'All CPRI publications are open access by default via the Repository — no paywall, with DOIs.',
    'default':'I can help you find publications, summarize research, suggest topics, and connect you with researchers. Try a quick action above!'
  };
  function aiGreet() {
    const body = document.getElementById('aiBody'); if (!body) return;
    body.innerHTML = `<div class="ai-msg bot">Hi, I'm AIRA 👋 — your CPRI research assistant. Ask me to summarize a paper, find researchers, or suggest topics.</div>`;
  }
  function sendAi() {
    const input = document.getElementById('aiInput'); const body = document.getElementById('aiBody');
    if (!input || !body || !input.value.trim()) return;
    const q = input.value.trim(); input.value = '';
    body.insertAdjacentHTML('beforeend', `<div class="ai-msg me">${q}</div>`);
    body.insertAdjacentHTML('beforeend', `<div class="ai-typing" id="aiTyping"><span></span><span></span><span></span></div>`);
    body.scrollTop = body.scrollHeight;
    setTimeout(() => {
      const t = document.getElementById('aiTyping'); if (t) t.remove();
      const key = Object.keys(AI_REPLIES).find(k => q.toLowerCase().includes(k)) || 'default';
      body.insertAdjacentHTML('beforeend', `<div class="ai-msg bot">${AI_REPLIES[key]}</div>`);
      body.scrollTop = body.scrollHeight;
    }, 900);
  }

  // ---- Reveal animations ----
  function initReveal() {
    const els = document.querySelectorAll('.reveal-up, .reveal-left, .reveal-right, .reveal-zoom');
    if (!('IntersectionObserver' in window) || !els.length) { els.forEach(el => el.classList.add('in')); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    els.forEach(el => io.observe(el));
  }

  function initFaq() {
    document.querySelectorAll('.faq-q').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.parentElement; const ans = item.querySelector('.faq-a');
        const isOpen = item.classList.toggle('open');
        ans.style.maxHeight = isOpen ? ans.scrollHeight + 'px' : '0';
      });
    });
  }

  function initNewsletter() {
    document.querySelectorAll('[data-newsletter]').forEach(form => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = form.querySelector('input'); if (!input.value) return;
        const btn = form.querySelector('button');
        const orig = btn.innerHTML; btn.innerHTML = 'Subscribed <i class="bi bi-check-lg"></i>';
        btn.disabled = true; input.value = '';
        toast('Subscribed', 'You will receive our next newsletter.', 'envelope-check');
        setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2400);
      });
    });
  }

  function initAuthActions() {
    document.querySelectorAll('a[data-action="logout"]').forEach(link => {
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        try { const res = await fetch('/api/auth/logout', { method: 'POST' }); if (res.ok) window.location.href = 'login.html'; } catch {}
      });
    });
  }

  async function fetchJson(url) {
    try { const res = await fetch(url); if (!res.ok) throw new Error('fail'); return await res.json(); }
    catch (err) { console.warn('load failed', url); return null; }
  }
  function fmtDate(d) { const date = new Date(d); if (isNaN(date)) return d; return date.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }); }

  // ---- Builders ----
  const RESEARCH_CATS = { ai:'AI Research', policy:'Policy Studies', health:'Healthcare', edu:'Education', climate:'Climate', gov:'Governance' };
  function buildResearch(research, publications) {
    const el = document.getElementById('research-cards'); if (!el) return;
    const seed = [];
    let data = seed;
    if (research && research.length) data = research.slice(0,6).map((r,i) => ({ ...r, cat: Object.keys(RESEARCH_CATS)[i%6], views: 1000+(i*340) }));
    const icons = { ai:'bi-cpu', policy:'bi-bank2', health:'bi-heart-pulse', edu:'bi-book', climate:'bi-globe2', gov:'bi-building' };
    el.innerHTML = data.map(r => `
      <div class="col-lg-4 col-md-6 reveal-up" data-cat="${r.cat}">
        <article class="media-card">
          <div class="m-media"><div class="ph"><i class="bi ${icons[r.cat]||'bi-journal-richtext'}"></i></div>
            <span class="date-badge">${fmtDate(r.date)}</span></div>
          <div class="m-body">
            <span class="tag">${RESEARCH_CATS[r.cat]||'Research'}</span>
            <h3>${r.title}</h3>
            <p>${r.summary||r.excerpt||''}</p>
            <div class="meta"><span><i class="bi bi-person"></i>${r.author||'CPRI'}</span><span><i class="bi bi-clock"></i>${r.read||8} min</span><span><i class="bi bi-eye"></i>${(r.views||1200).toLocaleString()}</span></div>
            <div class="m-foot">
              <a class="btn btn-soft btn-sm" href="publications.html">Read <i class="bi bi-arrow-right"></i></a>
              <div class="m-actions">
                <a href="#" title="Download PDF" data-toast="PDF download started"><i class="bi bi-download"></i></a>
                <a href="#" title="Bookmark" data-toast="Saved to bookmarks"><i class="bi bi-bookmark"></i></a>
              </div>
            </div>
          </div>
        </article>
      </div>`).join('');
    // filter
    const filters = document.getElementById('researchFilters');
    const search = document.getElementById('researchSearch');
    if (filters) filters.addEventListener('click', (e) => {
      if (e.target.dataset.cat === undefined) return;
      filters.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active'); applyFilter();
    });
    if (search) search.addEventListener('input', applyFilter);
    function applyFilter() {
      const cat = filters.querySelector('.active')?.dataset.cat || 'all';
      const q = (search?.value || '').toLowerCase();
      el.querySelectorAll('[data-cat]').forEach(c => {
        const okCat = cat === 'all' || c.dataset.cat === cat;
        const okQ = !q || c.textContent.toLowerCase().includes(q);
        c.style.display = (okCat && okQ) ? '' : 'none';
      });
    }
    el.querySelectorAll('[data-toast]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); toast('Done', a.dataset.toast, 'bookmark-check'); }));
  }

  function buildNews(publications, announcements, events) {
    const feat = document.getElementById('featured-news');
    const trend = document.getElementById('trending-news');
    const slider = document.getElementById('news-slider');
    const items = [
      { type:'Featured', title:'New CPRI policy brief: Digital Governance', date:new Date().toISOString(), excerpt:'Recommendations for inclusive, accountable digital public services.', icon:'bi-journal-richtext' },
      { type:'Announcement', title:'Call for student researchers — 2026 cohort', date:new Date(Date.now()-2*864e5).toISOString(), excerpt:'Applications are open for the next research cohort.', icon:'bi-megaphone' },
      { type:'Event', title:'Annual Research Symposium', date:new Date(Date.now()+12*864e5).toISOString(), excerpt:'A day of presentations and panel discussions.', icon:'bi-calendar-event' }
    ];
    if (feat) {
      const f = items[0];
      feat.innerHTML = `<article class="media-card reveal-left" style="height:100%">
        <div class="m-media" style="aspect-ratio:16/8"><div class="ph"><i class="bi ${f.icon}"></i></div><span class="date-badge">${fmtDate(f.date)}</span></div>
        <div class="m-body"><span class="tag">${f.type}</span><h3 style="font-size:1.6rem">${f.title}</h3><p>${f.excerpt}</p>
        <div class="m-foot"><a class="btn btn-gradient btn-sm" href="announcements.html">Read story <i class="bi bi-arrow-right"></i></a></div></div></article>`;
    }
    if (trend) {
      trend.innerHTML = items.slice(1).map(n => `
        <a class="d-flex gap-3 mb-3 p-2 rounded" href="announcements.html" style="align-items:flex-start">
          <span class="c-icon" style="width:44px;height:44px;border-radius:12px;flex-shrink:0;display:grid;place-items:center;color:#fff;background:var(--grad-brand);font-size:1.1rem"><i class="bi ${n.icon}"></i></span>
          <div><div class="tag mb-1">${n.type}</div><b style="font-family:var(--font-head);color:var(--cpri-text)">${n.title}</b><small class="d-block" style="color:var(--cpri-muted)">${fmtDate(n.date)}</small></div>
        </a>`).join('') + `<a class="btn btn-soft btn-sm mt-2" href="announcements.html">All updates <i class="bi bi-arrow-right"></i></a>`;
    }
    if (slider) {
      slider.innerHTML = items.concat(items).map(n => `
        <div class="swiper-slide"><article class="media-card" style="height:100%">
          <div class="m-media"><div class="ph"><i class="bi ${n.icon}"></i></div><span class="date-badge">${fmtDate(n.date)}</span></div>
          <div class="m-body"><span class="tag">${n.type}</span><h3>${n.title}</h3><p>${n.excerpt}</p></div>
        </article></div>`).join('');
    }
  }

  function buildResearchers(researchers) {
    const el = document.getElementById('researchers'); if (!el) return;
    const list = (researchers && researchers.length ? researchers : []).slice(0,4);
    el.innerHTML = list.map(r => `
      <div class="col-lg-3 col-md-6 reveal-up">
        <article class="person-card">
          <div class="avatar">${r.initials || (r.name||'??').split(' ').map(w=>w[0]).join('').slice(0,2)}</div>
          <h3>${r.name}</h3>
          <div class="role">${r.role || 'Researcher'}</div>
          <div class="dept">${r.dept || ''}</div>
          <div class="interests">${(r.interests||[]).map(i=>`<span>${i}</span>`).join('')}</div>
          <div class="socials">
            <a href="#" aria-label="Email" data-toast="Email copied"><i class="bi bi-envelope"></i></a>
            <a href="#" aria-label="ORCID"><i class="bi bi-link-45deg"></i></a>
            <a href="#" aria-label="Google Scholar"><i class="bi bi-google"></i></a>
            <a href="#" aria-label="LinkedIn"><i class="bi bi-linkedin"></i></a>
          </div>
        </article>
      </div>`).join('');
    el.querySelectorAll('[data-toast]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); toast('Researcher', a.dataset.toast, 'person-check'); }));
  }

  function buildStats() {
    const el = document.getElementById('stats'); if (!el) return;
    const data = [];
    el.innerHTML = data.map(d => `
      <div class="col-lg-3 col-md-6 col-6 reveal-up">
        <div class="stat-card"><div class="stat-icon"><i class="bi ${d.i}"></i></div>
          <div class="stat-num" data-count="${d.n}">0</div><div class="stat-lbl">${d.l}</div></div>
      </div>`).join('');
    // observe the freshly-built counters
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => { entries.forEach(en => { if (en.isIntersecting) { animateCount(en.target); io.unobserve(en.target); } }); }, { threshold: 0.4 });
      el.querySelectorAll('[data-count]').forEach(e => io.observe(e));
    } else { el.querySelectorAll('[data-count]').forEach(animateCount); }
  }

  function buildPartners() {
    const el = document.getElementById('partnerTrack'); if (!el) return;
    const names = [];
    const html = names.map(n => `<div class="p-logo"><i class="bi bi-buildings"></i>${n}</div>`).join('');
    el.innerHTML = html + html; // duplicate for seamless loop
  }

  function buildTestimonials() {
    const el = document.getElementById('testimonials'); if (!el) return;
    const list = [];
    el.innerHTML = list.map(q => `
      <div class="swiper-slide"><article class="quote-card">
        <span class="testi-tag">${q.who}</span>
        <div class="stars"><i class="bi bi-star-fill"></i><i class="bi bi-star-fill"></i><i class="bi bi-star-fill"></i><i class="bi bi-star-fill"></i><i class="bi bi-star-fill"></i></div>
        <p class="q-text">“${q.text}”</p>
        <div class="q-who"><span class="av">${q.av}</span><div><b>${q.name}</b><small>${q.role}</small></div></div>
      </article></div>`).join('');
  }

  function buildEvents(events) {
    const el = document.getElementById('events'); if (!el) return;
    const list = (events && events.filter(e => new Date(e.date) >= new Date()).length ? events.filter(e => new Date(e.date) >= new Date()) : []).slice(0,3);
    el.innerHTML = list.map(e => {
      const d = new Date(e.date);
      return `<div class="col-lg-4 col-md-6 reveal-up">
        <article class="event-card">
          <div class="e-media"><i class="bi bi-calendar-event"></i>
            <div class="e-date"><b>${d.getDate()}</b>${d.toLocaleString('en-US',{month:'short'})}</div>
          </div>
          <div class="e-body">
            <span class="tag">${e.type}</span>
            <h3>${e.title}</h3>
            <div class="e-meta"><span><i class="bi bi-geo-alt"></i>${e.location}</span><span><i class="bi bi-clock"></i>${fmtDate(e.date)}</span></div>
            <div class="countdown" data-to="${d.getTime()}">
              <div class="cd"><b class="cd-d">--</b><small>Days</small></div>
              <div class="cd"><b class="cd-h">--</b><small>Hrs</small></div>
              <div class="cd"><b class="cd-m">--</b><small>Min</small></div>
              <div class="cd"><b class="cd-s">--</b><small>Sec</small></div>
            </div>
            <div class="e-foot">
              <a class="btn btn-gradient btn-sm" href="event-registration.html">Register</a>
              <a class="btn btn-outline-dark btn-sm" href="https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(e.title)}" target="_blank" rel="noopener"><i class="bi bi-google"></i> Calendar</a>
            </div>
          </div>
        </article></div>`;
    }).join('');
    tickCountdowns();
  }

  function tickCountdowns() {
    const all = document.querySelectorAll('.countdown');
    if (!all.length) return;
    function tick() {
      all.forEach(c => {
        const diff = c.dataset.to - Date.now();
        if (diff < 0) return;
        const s = Math.floor(diff/1000);
        c.querySelector('.cd-d').textContent = Math.floor(s/86400);
        c.querySelector('.cd-h').textContent = String(Math.floor(s%86400/3600)).padStart(2,'0');
        c.querySelector('.cd-m').textContent = String(Math.floor(s%3600/60)).padStart(2,'0');
        c.querySelector('.cd-s').textContent = String(s%60).padStart(2,'0');
      });
    }
    tick(); setInterval(tick, 1000);
  }

  function buildAiFeatures() {
    const el = document.getElementById('ai-features'); if (!el) return;
    const items = [
      { i:'bi-robot', t:'AI Research Assistant', d:'Chat with AIRA to find, summarize, and navigate research instantly.' },
      { i:'bi-search', t:'AI Semantic Search', d:'Natural-language search across publications, people, and projects.' },
      { i:'bi-lightbulb', t:'Smart Recommendations', d:'Personalized reading suggestions based on your interests.' },
      { i:'bi-file-earmark-text', t:'Auto Summaries', d:'One-click 3-bullet abstracts for any publication.' },
      { i:'bi-mic', t:'Voice Search', d:'Ask hands-free — speech-to-query research discovery.' },
      { i:'bi-tags', t:'Keyword Suggestions', d:'AI-suggested tags and topics to improve discoverability.' }
    ];
    el.innerHTML = items.map(it => `
      <div class="col-lg-4 col-md-6 reveal-up">
        <article class="ui-card"><span class="c-icon"><i class="bi ${it.i}"></i></span>
          <h3>${it.t}</h3><p>${it.d}</p>
          <div class="card-foot"><button class="btn btn-soft btn-sm" onclick="CPRI.toast('AI','${it.t} is ready to use.','robot')">Try it <i class="bi bi-arrow-right"></i></button></div>
        </article></div>`).join('');
  }

  function buildFaqs() {
    const fq = document.getElementById('faqs'); if (!fq) return;
    const list = [
      { q:'How can I collaborate with CPRI?', a:'Reach out via our contact page or email. We partner with universities, agencies, and communities on joint research and capacity-building.' },
      { q:'Are CPRI publications open access?', a:'Yes. Open access is the default for CPRI-funded publications, available through our repository with DOIs.' },
      { q:'How do I submit research?', a:'Faculty, students, advisers, and staff can submit through the Submissions page after logging in.' },
      { q:'Do you offer training?', a:'Yes. Our Capability Building Unit runs trainings, symposia, and extension services throughout the year.' }
    ];
    fq.innerHTML = list.map((f,i) => `
      <div class="faq-item${i===0?' open':''}">
        <button class="faq-q" type="button">${f.q} <i class="bi bi-plus-lg"></i></button>
        <div class="faq-a"${i===0?' style="max-height:200px"':''}><p>${f.a}</p></div>
      </div>`).join('');
  }

  document.addEventListener('DOMContentLoaded', () => { injectLayout(); });

  return {
    fetchJson, fmtDate, reveal: initReveal, toast, SITE,
    buildResearch, buildNews, buildResearchers, buildStats,
    buildPartners, buildTestimonials, buildEvents, buildAiFeatures,
    buildFaqs, initHeroExtras
  };
})();

