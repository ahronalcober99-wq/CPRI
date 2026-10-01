// ============================================================
//  CPRI — shared front-end (Premium 2026 redesign)
//  Injects navbar + footer + global UX chrome, handles nav,
//  dark mode, search, AI assistant, particles, counters,
//  charts, reveals, toasts, a11y, mobile nav, and content.
// ============================================================
// Guaranteed page-loader dismissal (runs no matter what else happens)
setTimeout(() => { const l = document.getElementById('pageLoader'); if (l) l.classList.add('hide'); }, 2200);

// ============================================================
//  DEPLOYMENT SETTING — the ONE place the API address lives.
//
//  Every /api/... request in this project goes through this value; there are no
//  scattered API URLs to edit.
//
//  • Served by the Express server (`npm start` → http://localhost:3000)?
//      leave it as '' and the front end calls the API on its own origin.
//  • Static front end on GitHub Pages with the API hosted elsewhere?
//      put that origin here, e.g. 'https://cpri-api.onrender.com'
//      (scheme required, no trailing slash).
//
//  A per-browser override, useful for testing without redeploying, wins over this:
//      localStorage.setItem('cpri-api-base', 'https://my-api.example.com')
// ============================================================
window.CPRI_API_BASE = window.CPRI_API_BASE || 'https://YOUR-RENDER-URL.onrender.com';

const CPRI = (() => {
     const CPRI_API_BASE = "https://cpri-api.onrender.com";
  // ---- API base / transport ------------------------------------------------
  // The front-end talks to the Express back end. When the site is served BY that
  // server (`npm start` -> http://localhost:3000) root-relative '/api/...' calls
  // just work. A statically hosted copy (GitHub Pages) has no back end, so point
  // it at a deployed API either before this script loads:
  //   <script>window.CPRI_API_BASE = 'https://your-api.example.com';</script>
  // or at runtime:
  //   localStorage.setItem('cpri-api-base', 'https://your-api.example.com')
  // Leaving it unset keeps every call same-origin, so local dev is untouched.
  function apiBase() {
    let override = null;
    try { override = window.CPRI_API_BASE || localStorage.getItem('cpri-api-base'); } catch { /* storage blocked */ }
    if (override) return String(override).replace(/\/+$/, '');
    if (location.protocol === 'file:') return 'http://localhost:3000';
    return '';
  }

  const API_BASE = apiBase();

  // True when the page is served by a local dev server (Express already serves the API too).
  function isLocalHost() {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  }

  // A statically hosted copy with no API configured fails in a confusing way: the
  // web host answers /api/* itself, rejecting POST with 405 and returning HTML. Say
  // so up front in the console instead of leaving it to be decoded from a response.
  if (!API_BASE && location.protocol.startsWith('http') && !isLocalHost()) {
    console.warn('[CPRI] No API address is configured on ' + location.host +
      ', so /api/* requests will be answered by this static host (POST → 405, HTML bodies).' +
      " Set CPRI_API_BASE in public/assets/js/main.js to the hosted HTTPS API address.");
  }

  // Rewrite root-relative API calls to the configured origin so ONE setting moves
  // the whole site (there are ~168 fetch('/api/...') call sites). Only installed
  // when a base is configured, so same-origin behaviour is unchanged.
  if (API_BASE && typeof window.fetch === 'function') {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (typeof input === 'string' && input.startsWith('/api/')) {
        input = API_BASE + input;
        // The session cookie is what keeps a visitor signed in, and a cross-origin
        // fetch omits it unless credentials are requested. An explicit value wins.
        init = { credentials: 'include', ...(init || {}) };
      } else if (typeof Request !== 'undefined' && input instanceof Request) {
        const u = new URL(input.url, location.href);
        if (u.pathname.startsWith('/api/')) input = new Request(API_BASE + u.pathname + u.search, input);
      }
      return nativeFetch(input, init);
    };
  }

  // Downloads and other plain links cannot go through fetch: 46 anchors in the site
  // are generated as href="/api/..." (report exports, uploaded files, certificates).
  // A capture-phase click listener rewrites them at click time, which also covers
  // links created later by innerHTML, so no page needs its own API logic.
  if (API_BASE) {
    document.addEventListener('click', (event) => {
      const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('/api/')) anchor.setAttribute('href', API_BASE + href);
    }, true);
  }

  // Build an absolute API URL, for the rare places that need a plain link
  // (window.open, <img src>, and so on) instead of a fetch.
  function apiUrl(path) {
    if (!API_BASE || !path.startsWith('/api/')) return path;
    return API_BASE + path;
  }

  // Read a JSON reply without choking on an HTML error page: static hosts answer
  // /api/* with a 404 HTML document, which reached users as
  // `Unexpected token '<', "<html> <he"... is not valid JSON`.
  async function apiFetch(path, options) {
    if (API_BASE && path.startsWith('/api/')) {
      path = API_BASE + path;
      options = { credentials: 'include', ...(options || {}) };
    }
    let response;
    try {
      response = await fetch(path, options);
    } catch {
      // The API address is configured but nothing answered (DNS, refused
      // connection, certificate, or a host that is asleep).
      throw new Error(API_BASE
        ? 'Unable to connect to the CPRI server at ' + API_BASE + '. The API host may be starting up or unreachable — please try again in a moment.'
        : 'Could not reach the CPRI server. Start it with `npm start` (http://localhost:3000), or set CPRI_API_BASE in public/assets/js/main.js to your hosted API address.');
    }
    const text = await response.text();
    if (!text) return { res: response, data: null };
    try {
      return { res: response, data: JSON.parse(text) };
    } catch {
      // Two very different situations produce a non-JSON reply:
      //  • no API address is configured, so the static host (GitHub Pages) answered the
      //    request itself — it rejects non-GET methods with 405 and returns an HTML error;
      //  • the configured API replied with something unexpected.
      if (!API_BASE && !isLocalHost()) {
        throw new Error('This deployment has no API address configured, so /api/... is answered by the static host (' +
          location.host + ', HTTP ' + response.status + ') instead of the CPRI server. Set CPRI_API_BASE in ' +
          'public/assets/js/main.js to the HTTPS address of the hosted API and redeploy the site.');
      }
      if (response.status >= 500) {
        throw new Error('The CPRI server hit a problem handling ' + path + ' (HTTP ' + response.status +
          '). Please try again in a moment; if it keeps failing, check the API logs.');
      }
      throw new Error('The CPRI server at ' + (API_BASE || location.origin) + ' answered ' + path +
        ' with a non-JSON response (HTTP ' + response.status + ').');
    }
  }

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
      // Large menus can be split into labeled sections; each section renders
      // as its own column with a heading (desktop) / a small label (mobile)
      // instead of one long flat list.
      { label: 'Research', icon: 'bi-journal-richtext', group: [
        { section: 'Get involved', items: [
          { label: 'Student Researcher Portal', href: 'student-researchers.html', icon: 'bi-mortarboard', desc: 'Submit capstone and research outputs' },
          { label: 'Submissions', href: 'submissions.html', icon: 'bi-send', desc: 'Submit research' },
          { label: 'Ethics Review', href: 'ethics.html', icon: 'bi-shield-check', desc: 'Ethics clearance' }
        ]},
        { section: 'Explore', items: [
          { label: 'Repository', href: 'repository.html', icon: 'bi-archive', desc: 'Open repository' },
          { label: 'Publications', href: 'publications.html', icon: 'bi-journal-richtext', desc: 'Papers & briefs' },
          { label: 'Researchers', href: 'researchers.html', icon: 'bi-people', desc: 'Our people' },
          { label: 'Innovation & Extension', href: 'innovation-extension.html', icon: 'bi-lightbulb', desc: 'Applied work' },
          { label: 'Reports', href: 'reports.html', icon: 'bi-file-earmark-bar-graph', desc: 'Annual reports' }
        ]}
      ]},
    ]
  };

  const currentPage = () => location.pathname.split('/').pop() || 'index.html';

  // /api/auth/me with one retry: the file-backed session store can transiently
  // drop a read (Windows AV / handle race) and answer 401 even for a live
  // session, which would otherwise render the guest Login/Register header for
  // a signed-in visitor. Retry once before giving up.
  async function fetchMe() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch('/api/auth/me');
        if (r.ok) return await r.json();
      } catch { /* fall through to retry */ }
      if (attempt === 0) await new Promise(res => setTimeout(res, 80));
    }
    return null;
  }

  async function getNavItems() {
    const auth = [];
    let isAdmin = false;
    let me = null;
    try {
      me = await fetchMe();
      if (me && me.user) {
        isAdmin = me.user.role === 'admin';
        // The Admin console is admin-only — hidden from the nav for every other
        // role (mirrors the server's requireAdmin gate on /api/admin/*).
        if (isAdmin) {
          auth.push({ label: 'Dashboard', href: 'admin-dashboard.html', primary: true });
        }
        // Direct messaging is for all registered roles — mirror the server's DM gate.
        if (['admin','cpri_staff','faculty_researcher','adviser','ethics_reviewer','student_researcher','public_visitor'].includes(me.user.role)) {
          auth.push({ label: 'Messages', href: 'messages.html' });
        }
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
    // Desktop navbar entry for admins only. The mobile menu already surfaces
    // the console via the Dashboard auth item, so buildMobileNav skips desktopOnly.
    const nav = SITE.baseNav.slice();
    if (isAdmin) {
      nav.push({ label: 'Admin Console', href: 'admin-dashboard.html', icon: 'bi-speedometer2', desktopOnly: true });
    }
    // Avatar photo (Google OAuth URL or uploaded file) + display name, used by
    // headerHtml to render the My Account circle as a photo when one exists.
    return {
      nav,
      auth,
      photo: (me && me.user && me.user.profilePhoto) || '',
      name: (me && me.user && (me.user.fullName || me.user.username)) || '',
      // First-time Google sign-ins must finish profile setup (pick a role).
      needsSetup: !!(me && me.user && me.user.needsSetup)
    };
  }

  // Shared avatar helpers (desktop navbar, mobile menu, bottom nav):
  // name-based initials fallback, and an <img> (or initials) with an onerror
  // fallback so a missing/broken photo never shows a broken-image icon.
  function avatarInitials(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'CP';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function avatarHtml(photo, name) {
    const fallback = avatarInitials(name);
    if (photo) {
      return `<img src="${escapeHtml(String(photo))}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${escapeHtml(fallback)}';">`;
    }
    return escapeHtml(fallback);
  }

  function headerHtml(active, navItems) {
    const links = navItems.nav.map(item => {
      const icon = item.icon ? `<i class="bi ${item.icon}"></i>` : '';
      if (item.group) {
        const submenuItem = s => {
          const isActive = s.href === active ? ' class="active"' : '';
          const si = s.icon ? `<i class="bi ${s.icon}"></i>` : '';
          const sd = s.desc ? `<small>${s.desc}</small>` : '';
          return `<li><a href="${s.href}"${isActive}>${si}<span>${s.label}${sd}</span></a></li>`;
        };
        // Sectioned groups (e.g. Research) render each labeled section as its
        // own column; plain groups stay a flat list (2 columns when long).
        const isSectioned = item.group.some(g => g.items);
        let sub, panelCls;
        if (isSectioned) {
          sub = item.group.map(sec => `
            <li class="cpri-submenu-section">
              <span class="cpri-submenu-heading">${sec.section}</span>
              <ul class="cpri-submenu-items">${sec.items.map(submenuItem).join('')}</ul>
            </li>`).join('');
          panelCls = ' cols-sections';
        } else {
          sub = item.group.map(submenuItem).join('');
          panelCls = item.group.length > 5 ? ' cols-2' : '';
        }
        const isActiveGroup = item.group.some(g => (g.items ? g.items : [g]).some(s => s.href === active));
        return `<li class="cpri-group${isActiveGroup ? ' active' : ''}">
          <a href="#" class="cpri-group-label" aria-haspopup="true" aria-expanded="false">${icon}<span>${item.label}</span><i class="bi bi-chevron-down cpri-caret-icon"></i></a>
          <ul class="cpri-submenu${panelCls}">${sub}</ul>
        </li>`;
      }
      const isActive = item.href === active ? ' class="active"' : '';
      return `<li><a href="${item.href}"${isActive}>${icon}<span>${item.label}</span></a></li>`;
    }).join('');

    const loggedIn = navItems.auth.some(a => a.action === 'logout');
    // The quick dashboard icon is admin-only — the Dashboard auth item is only
    // pushed into navItems.auth for role === 'admin'.
    const isAdmin = navItems.auth.some(a => a.href === 'admin-dashboard.html');
    // The messages icon shows for all registered roles (matches getNavItems push).
    const isMessenger = navItems.auth.some(a => a.href === 'messages.html');
    let authHtml;
    if (loggedIn) {
      // My Account avatar: show the profile photo when one exists (Google OAuth
      // picture URL or an uploaded file), otherwise fall back to the user's
      // name initials. A missing/broken photo hides the img and shows initials.
      const avatarInner = avatarHtml(navItems.photo, navItems.name);
      authHtml = `${isAdmin ? `<a class="cpri-icon-btn" href="admin-dashboard.html" aria-label="Quick dashboard" title="Dashboard"><i class="bi bi-grid-1x2"></i></a>
        ` : ''}${isMessenger ? `<a class="cpri-icon-btn" href="messages.html" aria-label="Direct messages" title="Messages"><i class="bi bi-chat-left-text"></i></a>
        ` : ''}<button class="cpri-icon-btn cpri-bell-mobile" id="nav-bell-m" aria-label="Notifications" title="Notifications"><i class="bi bi-bell"></i><span class="dot" id="notifBadgeM" style="display:none"></span></button><a class="cpri-avatar" href="account.html" aria-label="My account" title="My Account">${avatarInner}</a>`;
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
            <button class="cpri-icon-btn" id="nav-settings" aria-label="Notification settings" title="Notification settings"><i class="bi bi-gear"></i></button>
            <button class="cpri-icon-btn" id="nav-bell" aria-label="Notifications" title="Notifications"><i class="bi bi-bell"></i><span class="dot" id="notifBadge" style="display:none"></span></button>
            <button class="cpri-icon-btn" id="nav-search" aria-label="Search"><i class="bi bi-search"></i></button>
            <button class="cpri-icon-btn" id="nav-theme" aria-label="Toggle dark mode" title="Dark mode"><i class="bi bi-moon-stars"></i></button>
            <button class="cpri-icon-btn" id="nav-lang" aria-label="Language"><i class="bi bi-translate"></i><span style="position:absolute;bottom:4px;right:4px;font-size:.5rem;font-weight:700;">EN</span></button>
            ${authHtml}
            <button class="cpri-icon-btn" id="nav-a11y" aria-label="Accessibility settings" title="Accessibility"><i class="bi bi-universal-access"></i></button>
            <button class="cpri-icon-btn mobile-nav-toggle" id="nav-offcanvas" aria-label="Menu"><i class="bi bi-list"></i></button>
          </div>
        </div>
      </div>
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
    <a class="contact-fab" href="contact.html" aria-label="Contact us" title="Contact us"><i class="bi bi-envelope"></i><span>Contact us</span></a>

    <div class="search-pop" id="searchPop" role="dialog" aria-label="Search">
      <div class="sp-box">
        <div class="sp-input"><i class="bi bi-search"></i>
          <input type="text" id="searchInput" placeholder="Search research, people, events…" aria-label="Search query">
          <button class="btn btn-soft btn-sm" id="searchVoice" aria-label="Voice search"><i class="bi bi-mic"></i></button>
        </div>
        <div class="sp-body">
          <div class="sp-suggest" id="searchHint">Quick suggestions</div>
          <div id="searchResults"></div>
          <a class="sp-item" href="publications.html" data-quick><i class="bi bi-journal-richtext"></i><div>Publications &amp; policy briefs<small>Open repository</small></div></a>
          <a class="sp-item" href="researchers.html" data-quick><i class="bi bi-people"></i><div>Researchers directory<small>Find experts</small></div></a>
          <a class="sp-item" href="events.html" data-quick><i class="bi bi-calendar-event"></i><div>Upcoming events<small>Conferences &amp; seminars</small></div></a>
          <a class="sp-item" href="research-agenda.html" data-quick><i class="bi bi-graph-up-arrow"></i><div>Research agenda<small>Priority themes</small></div></a>
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

    <nav class="mobile-offcanvas" id="mobileOff" aria-label="Mobile menu"></nav>
    <div class="more-backdrop" id="moreBackdrop"></div>
    <nav class="more-sheet" id="moreSheet" aria-label="Explore"></nav>
    <nav class="bottom-nav" id="bottomNav" aria-label="Quick">
      <a href="index.html" data-tab="home"><i class="bi bi-house"></i>Home</a>
      <a href="research-agenda.html" data-tab="research"><i class="bi bi-graph-up-arrow"></i>Research</a>
      <a href="#" id="bnMenu" class="bn-fab" aria-label="Open menu"><i class="bi bi-grid-1x2"></i><span>More</span></a>
      <a href="publications.html" data-tab="papers"><i class="bi bi-journal-richtext"></i>Papers</a>
      <a href="events.html" data-tab="events"><i class="bi bi-calendar-event"></i>Events</a>
    </nav>

    <div class="notif-panel" id="notifPanel" role="dialog" aria-label="Notifications">
      <div class="np-head"><b><i class="bi bi-bell"></i> Notifications <span class="np-role" id="npRole"></span></b>
        <div class="np-actions">
          <a class="np-mark" id="npMarkAll" href="#" title="Mark all as read"><i class="bi bi-check2-all"></i> Mark all read</a>
          <a class="np-mark" id="npMessages" href="messages.html" title="Direct messages" style="display:none;"><i class="bi bi-chat-left-text"></i> Messages</a>
          <a class="np-mark" id="npSettings" href="profile.html#prefs" title="Notification settings"><i class="bi bi-gear"></i> Settings</a>
        </div>
      </div>
      <div class="np-body" id="npBody"></div>
    </div>

    <div class="toast-wrap" id="toastWrap"></div>`;

  function injectLayout() {
    const active = currentPage();
    const headerEl = document.getElementById('site-header');
    const footerEl = document.getElementById('site-footer');
    getNavItems().then(navItems => {
      // A brand-new Google account must pick a role before using the site.
      if (navItems.needsSetup && active !== 'complete-profile.html') {
        window.location.replace('complete-profile.html');
        return;
      }
      if (headerEl) headerEl.outerHTML = headerHtml(active, navItems);
      if (footerEl) footerEl.outerHTML = footerHtml();
      document.body.insertAdjacentHTML('beforeend', CHROME);
      buildMobileNav(active, navItems);
      initNav();
      initChrome(active);
      initAdminSidebar();
      initSpotlight();
      initTilt();
      initMagnetic();
      initCursorGlow();
      initHeroParallax();
      initReveal();
      initCounters();
      initFaq();
      initNewsletter();
      initAuthActions();
      applySavedPrefs();
      initPasswordReveal();
    });
  }

  // ---- Hold-to-see password reveal ----
  // Any password input wrapped in .pwd-field with a .pwd-toggle button shows
  // the value only while the eye is held down (pointer/mouse/touch), hiding it
  // again on release or when the pointer leaves. Safe for autofill browsers:
  // the value is only ever toggled between password and text on the SAME input.
  function initPasswordReveal() {
    document.querySelectorAll('.pwd-field').forEach(field => {
      const input = field.querySelector('input[type="password"]');
      const btn = field.querySelector('.pwd-toggle');
      if (!input || !btn) return;
      let revealed = false;
      const icon = btn.querySelector('i');
      const show = () => {
        if (revealed) return;
        // Keep the caret position when flipping the type (only meaningful while
        // the input itself is focused — selectionStart is null otherwise).
        const focused = input === document.activeElement;
        const pos = focused ? input.selectionStart : null;
        input.type = 'text';
        if (focused && pos !== null) input.setSelectionRange(pos, pos);
        revealed = true;
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        btn.title = 'Release to hide';
        if (icon) icon.className = 'bi bi-eye-slash';
      };
      const hide = () => {
        if (!revealed) return;
        const focused = input === document.activeElement;
        const pos = focused ? input.selectionStart : null;
        input.type = 'password';
        if (focused && pos !== null) input.setSelectionRange(pos, pos);
        revealed = false;
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
        btn.title = 'Hold to see';
        if (icon) icon.className = 'bi bi-eye';
      };
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); show(); });
      btn.addEventListener('pointerup', hide);
      btn.addEventListener('pointerleave', hide);
      btn.addEventListener('pointercancel', hide);
      // Touch fallback: pointercancel/leave can fire before touchend on some
      // mobile browsers; release on window pointerup as a safety net.
      window.addEventListener('pointerup', hide);
      // Keyboard users can also toggle with Space/Enter on the focused button.
      btn.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (revealed) hide(); else show(); }
      });
      btn.addEventListener('blur', hide);
    });
  }

  function buildMobileNav(active, navItems) {
    const off = document.getElementById('mobileOff');
    if (!off) return;
    // desktopOnly items (the desktop Admin Console link) stay out of the mobile
    // menu — admins reach the console there via the Dashboard auth item instead.
    const links = navItems.nav.filter(i => !i.desktopOnly).map(item => {
      if (item.group) {
        // Sectioned groups keep their small headings in the offcanvas too;
        // plain groups render as a flat list of links.
        const flatLink = s => `<a href="${s.href}"><i class="${s.icon}"></i>${s.label}</a>`;
        const isSectioned = item.group.some(g => g.items);
        const sub = isSectioned
          ? item.group.map(sec => `<span class="mo-section">${sec.section}</span>${sec.items.map(flatLink).join('')}`).join('')
          : item.group.map(flatLink).join('');
        return `<div class="mo-group"><a href="#" class="mo-toggle"><i class="${item.icon}"></i>${item.label}<i class="bi bi-chevron-down" style="margin-left:auto"></i></a><div class="mo-sub">${sub}</div></div>`;
      }
      return `<a href="${item.href}" class="${item.href===active?'active':''}"><i class="${item.icon}"></i>${item.label}</a>`;
    }).join('');
    const auth = navItems.auth.map(a => {
      const actionAttr = a.action ? ` data-action="${a.action}"` : '';
      if (a.href === 'account.html') {
        // My Account carries the user's avatar (photo or initials) instead of
        // the generic person icon — same fallback logic as the desktop navbar.
        return `<a href="${a.href}" class="mo-account"><span class="mo-avatar">${avatarHtml(navItems.photo, navItems.name)}</span>${a.label}</a>`;
      }
      const icon = a.action === 'logout' ? 'bi-box-arrow-right' : 'bi-person';
      return `<a href="${a.href}"${actionAttr} class="${a.primary?'':''}"><i class="bi ${icon}"></i>${a.label}</a>`;
    }).join('');
    // AI Repository-style drawer: for guests, a prominent Login/Create account
    // block right under the header (no scrolling); then the menu links and the
    // highlighted CTA. Signed-in users get the ACCOUNT section + auth rows.
    const loggedIn = navItems.auth.some(a => a.action === 'logout');
    const guestAuth = loggedIn ? '' : `<div class="mo-guest">
        <a class="mo-guest-login" href="login.html"><i class="bi bi-person"></i>Login</a>
        <a class="mo-guest-register" href="register.html">Create account</a>
      </div>`;
    off.innerHTML = `<div class="mo-head"><span class="cpri-brand" style="color:#fff"><span class="logo">C</span><span>CPRI</span></span>
      <button class="mo-close" id="moClose" aria-label="Close"><i class="bi bi-x-lg"></i></button></div>
      ${guestAuth}
      ${links}
      <a class="mo-submit" href="submit.html"><i class="bi bi-cloud-arrow-up"></i><span>Submission Record<small>Submit new research</small></span></a>
      ${loggedIn ? '<span class="mo-section">Account</span>' + auth : ''}`;

    // Highlight the bottom-nav tab matching the current page.
    const page = currentPage();
    const TAB_MAP = [
      ['home', /^index\.html$/],
      ['research', /^(research-agenda|repository|researchers|student-researchers|innovation-extension|submissions|ethics|reports)\.html$/],
      ['papers', /^publications\.html$/],
      ['events', /^(events|events-module|announcements)\.html/]
    ];
    document.querySelectorAll('#bottomNav a[data-tab]').forEach(a => {
      const key = a.dataset.tab;
      if (TAB_MAP.some(([k, re]) => k === key && re.test(page))) a.classList.add('active');
    });

    // ---- Bottom sheet ("More" button) ----
    // A quick-launch grid of the site's key destinations plus account actions,
    // sliding up over the content — the mobile equivalent of a command palette.
    const sheet = document.getElementById('moreSheet');
    if (sheet) {
      const loggedIn = navItems.auth.some(a => a.action === 'logout');
      const isAdmin = navItems.auth.some(a => a.href === 'admin-dashboard.html');
      const TILES = [
        { label: 'Search', icon: 'bi-search', action: 'search' },
        { label: 'About CPRI', href: 'about.html', icon: 'bi-info-circle' },
        { label: 'Announcements', href: 'announcements.html', icon: 'bi-megaphone' },
        { label: 'Events', href: 'events.html', icon: 'bi-calendar-event' },
        { label: 'Publications', href: 'publications.html', icon: 'bi-journal-richtext' },
        { label: 'Repository', href: 'repository.html', icon: 'bi-archive' },
        { label: 'Researchers', href: 'researchers.html', icon: 'bi-people' },
        { label: 'Ethics Review', href: 'ethics.html', icon: 'bi-shield-check' },
        { label: 'Innovation & Extension', href: 'innovation-extension.html', icon: 'bi-lightbulb' },
        { label: 'Reports', href: 'reports.html', icon: 'bi-file-earmark-bar-graph' },
        { label: 'Contact', href: 'contact.html', icon: 'bi-envelope' }
      ];
      const tiles = TILES.map(t => t.action
        ? `<button type="button" class="ms-tile" data-action="${t.action}"><i class="bi ${t.icon}"></i><span>${t.label}</span></button>`
        : `<a class="ms-tile" href="${t.href}"><i class="bi ${t.icon}"></i><span>${t.label}</span></a>`
      ).join('');
      const head = loggedIn
        ? `<span class="ms-avatar">${avatarHtml(navItems.photo, navItems.name)}</span><div class="ms-id"><b>${escapeHtml(navItems.name || 'My Account')}</b><small>Account</small></div>`
        : `<span class="ms-logo">C</span><div class="ms-id"><b>Explore CPRI</b><small>Quick access</small></div>`;
      const accountRows = loggedIn
        ? `${isAdmin ? `<a class="ms-row" href="admin-dashboard.html"><i class="bi bi-speedometer2"></i>Dashboard</a>` : ''}
           <a class="ms-row" href="messages.html"><i class="bi bi-chat-left-text"></i>Messages</a>
           <a class="ms-row" href="account.html"><i class="bi bi-person-circle"></i>My Account</a>
           <a class="ms-row" href="#" data-action="logout"><i class="bi bi-box-arrow-right"></i>Logout</a>`
        : `<div class="ms-cta">
             <a class="btn btn-gradient" href="login.html"><i class="bi bi-person"></i>Login</a>
             <a class="btn btn-outline-dark" href="register.html">Create account</a>
           </div>`;
      sheet.innerHTML = `<div class="ms-head">${head}
          <button type="button" class="ms-close" id="msClose" aria-label="Close menu"><i class="bi bi-x-lg"></i></button>
        </div>
        <div class="ms-grid">${tiles}</div>
        ${loggedIn ? '<span class="ms-label">Account</span>' + accountRows : accountRows}`;
    }
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
    // Desktop hover-hold: closing is delayed so the pointer can travel from the
    // label across the small gap into the submenu (or between its items) without
    // accidentally dismissing it. Re-entering the menu cancels the pending close.
    const SUBMENU_HOVER_HOLD_MS = 250;
    document.querySelectorAll('.cpri-group').forEach(group => {
      const label = group.querySelector('.cpri-group-label');
      const submenu = group.querySelector('.cpri-submenu');
      let closeTimer = null;
      const open = () => {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        document.querySelectorAll('.cpri-group.open').forEach(g => {
          if (g !== group) { g.classList.remove('open'); g.querySelector('.cpri-group-label').setAttribute('aria-expanded','false'); }
        });
        group.classList.add('open'); label.setAttribute('aria-expanded','true');
      };
      const close = () => {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        group.classList.remove('open'); label.setAttribute('aria-expanded','false');
      };
      const scheduleClose = () => {
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(() => { closeTimer = null; close(); }, SUBMENU_HOVER_HOLD_MS);
      };
      const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } };
      group.addEventListener('mouseenter', open);
      group.addEventListener('mouseleave', scheduleClose);
      if (submenu) {
        submenu.addEventListener('mouseenter', cancelClose);
        submenu.addEventListener('mouseleave', scheduleClose);
      }
      label.addEventListener('click', (e) => { e.preventDefault(); group.classList.contains('open') ? close() : open(); });
    });
    const closeAllMenus = () => {
      document.querySelectorAll('.cpri-group.open').forEach(g => {
        g.classList.remove('open');
        const l = g.querySelector('.cpri-group-label');
        if (l) l.setAttribute('aria-expanded', 'false');
      });
    };
    document.addEventListener('click', (e) => {
      // Clicks inside the group label are handled by the label's own toggle;
      // clicking a submenu item closes the panel (navigation proceeds normally),
      // and clicking anywhere outside closes everything.
      if (e.target.closest('.cpri-group') && !e.target.closest('.cpri-submenu a')) return;
      closeAllMenus();
    });
    // Escape closes any open dropdown.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllMenus();
    });
    const nav = document.querySelector('.cpri-nav');
    if (nav) {
      const onScroll = () => {
        nav.classList.toggle('scrolled', window.scrollY > 24);
        // Dismiss open dropdowns on scroll so a mega menu never keeps covering
        // the page content while the user scrolls (the header is sticky).
        document.querySelectorAll('.cpri-group.open').forEach(g => {
          g.classList.remove('open');
          g.querySelector('.cpri-group-label').setAttribute('aria-expanded', 'false');
        });
      };
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
    }
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
        const hero = document.getElementById('homeHero');
        if (hero) hero.classList.toggle('scrolled', window.scrollY > 140);
      }, { passive: true });
    }
    if (btt) btt.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

    // ---- Search popup: live results across research, events, publications,
    // researchers, and the research agenda. Falls back to the static quick
    // links whenever the query box is empty.
    const sp = document.getElementById('searchPop');
    const searchBtn = document.getElementById('nav-search');
    if (sp && searchBtn) {
      const input = document.getElementById('searchInput');
      const resultsEl = document.getElementById('searchResults');
      const hint = document.getElementById('searchHint');
      let searchTimer = null;
      let activeIdx = -1;
      let resultLinks = [];

      const open = () => { sp.classList.add('open'); setTimeout(() => input.focus(), 50); };
      const close = () => sp.classList.remove('open');
      searchBtn.addEventListener('click', open);
      sp.addEventListener('click', (e) => { if (e.target === sp) close(); });

      const showQuickLinks = () => {
        resultsEl.innerHTML = '';
        if (hint) hint.style.display = '';
        document.querySelectorAll('#searchPop .sp-item[data-quick]').forEach(a => a.style.display = '');
        activeIdx = -1; resultLinks = [];
      };

      const showMessage = (icon, text) => {
        resultsEl.innerHTML = `<div class="sp-empty"><i class="bi ${icon}"></i>${text}</div>`;
      };

      const normalize = s => String(s || '').toLowerCase();

      let datasetsPromise = null;
      async function getDatasets() {
        if (datasetsPromise) return datasetsPromise;
        datasetsPromise = Promise.all([
          CPRI.fetchJson('/api/research'),
          CPRI.fetchJson('/api/events'),
          CPRI.fetchJson('/api/publications'),
          CPRI.fetchJson('/api/researchers'),
          CPRI.fetchJson('/api/agenda')
        ]).then(([research, events, pubs, people, agenda]) => ({
          research: Array.isArray(research) ? research : [],
          events: Array.isArray(events) ? events : [],
          publications: (pubs && Array.isArray(pubs.publications)) ? pubs.publications : [],
          researchers: (people && Array.isArray(people.researchers)) ? people.researchers : [],
          agenda: agenda || []  // object shape { institutional, programBased[] }
        }));
        return datasetsPromise;
      }

      function renderResults(results) {
        activeIdx = -1; resultLinks = [];
        if (hint) hint.style.display = 'none';
        document.querySelectorAll('#searchPop .sp-item[data-quick]').forEach(a => a.style.display = 'none');
        if (!results.length) { showMessage('bi-search', 'No matches found for this query.'); return; }
        resultsEl.innerHTML = results.map((r, i) => `
          <a class="sp-item" href="${r.href}" data-idx="${i}">
            <i class="bi ${r.icon}"></i>
            <div>${CPRI.escapeHtml(r.title)}<small>${CPRI.escapeHtml(r.sub)}</small></div>
          </a>`).join('');
        resultLinks = [...resultsEl.querySelectorAll('.sp-item')];
        resultLinks.forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); close(); window.location.href = a.href; }));
      }

      let searchSeq = 0;  // guards against stale renders from out-of-order fetches
      async function runSearch(query) {
        const q = query.trim().toLowerCase();
        const mySeq = ++searchSeq;
        if (!q) { showQuickLinks(); return; }
        const data = await getDatasets();
        if (mySeq !== searchSeq) return;  // a newer keystroke superseded this one
        const score = t => { const s = normalize(t); let sc = 0; if (s === q) sc = 100; else if (s.startsWith(q)) sc = 80; else if (s.includes(q)) sc = 60; return sc; };
        const picks = [];

        (data.research || []).forEach(r => {
          const sc = Math.max(score(r.title), score(r.summary), score(r.author));
          if (sc) picks.push({ sc, icon: 'bi-journal-richtext', title: r.title, sub: (r.author || 'Research') + ' · Research output', href: 'publications.html' });
        });
        (data.events || []).forEach(e => {
          const sc = Math.max(score(e.title), score(e.type), score(e.location), score(e.description));
          if (sc) picks.push({ sc, icon: 'bi-calendar-event', title: e.title, sub: (e.type || 'Event') + ' · ' + (e.date || '').slice(0, 10), href: 'event-detail.html?id=' + encodeURIComponent(e.id) });
        });
        (data.publications || []).forEach(p => {
          const sc = Math.max(score(p.title), score(p.authors), score(p.journalOrConference));
          if (sc) picks.push({ sc, icon: 'bi-file-earmark-text', title: p.title, sub: (p.authors || 'Publication') + ' · Publication', href: 'publication-detail.html?id=' + encodeURIComponent(p.id) });
        });
        (data.researchers || []).forEach(p => {
          const sc = Math.max(score(p.fullName), score(p.department), score(p.program), score(p.researchTitle));
          if (sc) picks.push({ sc, icon: 'bi-people', title: p.fullName, sub: (p.department || p.program || 'Researcher') + ' · Researcher', href: 'researcher-detail.html?id=' + encodeURIComponent(p.id) });
        });
        // Agenda is stored as { institutional, programBased: [{program, focus}] }.
        const agendaItems = Array.isArray(data.agenda) ? data.agenda
          : (data.agenda && Array.isArray(data.agenda.programBased)) ? data.agenda.programBased
          : [];
        agendaItems.forEach(a => {
          const sc = Math.max(score(a.program || a.title), score(a.focus || a.description));
          if (sc) picks.push({ sc, icon: 'bi-graph-up-arrow', title: a.program || a.title, sub: 'Research agenda · ' + (a.focus || 'priority theme').slice(0, 60), href: 'research-agenda.html' });
        });

        picks.sort((a, b) => b.sc - a.sc);
        renderResults(picks.slice(0, 8));
      }

      input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => runSearch(input.value), 180);
      });

      // Keyboard navigation: arrows move the active result, Enter opens it.
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!resultLinks.length) return;
          activeIdx = e.key === 'ArrowDown' ? Math.min(activeIdx + 1, resultLinks.length - 1) : Math.max(activeIdx - 1, 0);
          resultLinks.forEach((a, i) => a.classList.toggle('active', i === activeIdx));
          resultLinks[activeIdx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
          if (activeIdx >= 0 && resultLinks[activeIdx]) { e.preventDefault(); resultLinks[activeIdx].click(); }
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
        if (e.key === '/' && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); open(); }
      });
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

    // in-app notifications (bell + settings gear)
    initNotifications();

    // mobile offcanvas
    const offBtn = document.getElementById('nav-offcanvas');
    const off = document.getElementById('mobileOff');
    if (offBtn && off) {
      offBtn.addEventListener('click', () => off.classList.add('open'));
      const moClose = document.getElementById('moClose');
      if (moClose) moClose.addEventListener('click', () => off.classList.remove('open'));
      off.addEventListener('click', (e) => { if (e.target === off) off.classList.remove('open'); });
    }
    // Bottom sheet ("More") — slides up from the bottom with a blurred backdrop.
    const bnMenu = document.getElementById('bnMenu');
    const sheet = document.getElementById('moreSheet');
    const sheetBackdrop = document.getElementById('moreBackdrop');
    const openSheet = () => {
      if (!sheet) return;
      sheet.classList.add('open');
      if (sheetBackdrop) sheetBackdrop.classList.add('open');
      document.body.style.overflow = 'hidden';
    };
    const closeSheet = () => {
      if (!sheet) return;
      sheet.classList.remove('open');
      if (sheetBackdrop) sheetBackdrop.classList.remove('open');
      document.body.style.overflow = '';
    };
    if (bnMenu && sheet) bnMenu.addEventListener('click', (e) => { e.preventDefault(); openSheet(); });
    if (sheetBackdrop) sheetBackdrop.addEventListener('click', closeSheet);
    const msClose = document.getElementById('msClose');
    if (msClose) msClose.addEventListener('click', closeSheet);
    if (sheet) {
      // Search tile opens the existing search popup; logout closes the sheet first.
      sheet.addEventListener('click', (e) => {
        const tile = e.target.closest('[data-action]');
        if (!tile) return;
        if (tile.dataset.action === 'search') {
          const btn = document.getElementById('nav-search');
          if (btn) btn.click();
          closeSheet();
        }
        if (tile.dataset.action === 'logout') closeSheet();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
    }

    // page loader
    window.addEventListener('load', () => { const l = document.getElementById('pageLoader'); if (l) setTimeout(() => l.classList.add('hide'), 500); });
    const l = document.getElementById('pageLoader'); if (l) setTimeout(() => l.classList.add('hide'), 1400);

    // AOS
    if (window.AOS) AOS.init({ duration: 700, once: true, offset: 60 });
  }

  // ---- Theme & accessibility preferences ----
  function toggleTheme() {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    // Crossfade surfaces/colors instead of an instant snap: a temporary class
    // on <html> enables a global transition, removed once the fade completes.
    root.classList.add('theme-transition');
    try {
      root.setAttribute('data-theme', next);
      localStorage.setItem('cpri-theme', next);
      const btn = document.getElementById('nav-theme');
      if (btn) btn.querySelector('i').className = next === 'dark' ? 'bi bi-sun' : 'bi bi-moon-stars';
      const cb = document.getElementById('a11yTheme'); if (cb) cb.checked = next === 'dark';
    } finally {
      // Guaranteed cleanup: even if storage throws, the crossfade class can
      // never get stuck and flatten every transition for the whole session.
      setTimeout(() => root.classList.remove('theme-transition'), 420);
    }
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

  // ---- Cursor-follow spotlight on cards ----
  // A soft radial glow tracks the pointer inside cards (research/events/people/
  // feature/stat cards). One delegated listener covers cards added later by the
  // content builders. Mouse-only — touch and hybrid devices skip it entirely.
  function initSpotlight() {
    if (!window.matchMedia('(hover: hover)').matches) return;
    const CARD_SEL = '.card, .media-card, .event-card, .person-card, .ui-card, .stat-card';
    document.addEventListener('pointermove', (e) => {
      const card = e.target.closest(CARD_SEL);
      if (!card) return;
      card.classList.add('spotlight');
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left).toFixed(1) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top).toFixed(1) + 'px');
    });
  }

  // ---- 3D tilt on cards ----
  // Cards lean toward the pointer (rotateX/rotateY) while hovered, creating a
  // depth effect. One delegated pointermove handler covers dynamically built
  // cards; a one-time pointerleave per card eases it back flat.
  function initTilt() {
    if (!window.matchMedia('(hover: hover)').matches) return;
    const CARD_SEL = '.media-card, .event-card, .person-card, .ui-card, .stat-card';
    const MAX_DEG = 7;
    document.addEventListener('pointermove', (e) => {
      const card = e.target.closest(CARD_SEL);
      if (!card) return;
      if (!card._tiltInit) {
        card._tiltInit = true;
        card.classList.add('tilt');
        card.addEventListener('pointerleave', () => { card.style.transform = ''; });
      }
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - .5;
      const py = (e.clientY - r.top) / r.height - .5;
      card.style.transform = `perspective(900px) rotateX(${(-py * MAX_DEG).toFixed(2)}deg) rotateY(${(px * MAX_DEG).toFixed(2)}deg) translateY(-4px)`;
    }, { passive: true });
  }

  // ---- Admin sidebar toggle (mobile) ----
  // On narrow screens the sidebar collapses to just the brand row so the
  // content panel (Users, Content, Logs) starts at the fold. Tapping the
  // chevron or the brand row expands the navigation. Clicking a link
  // collapses it again.
  function initAdminSidebar() {
    const side = document.querySelector('.admin-side');
    if (!side) return;
    const brand = side.querySelector('.as-brand');
    if (!brand) return;
    let toggle = brand.querySelector('.as-toggle');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'as-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Toggle admin navigation');
      toggle.innerHTML = '<i class="bi bi-chevron-down"></i>';
      brand.appendChild(toggle);
    }
    toggle.addEventListener('click', () => {
      const open = side.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    // Also toggle when the brand row itself is tapped (helps before the
    // toggle button renders or as a larger hit target).
    brand.addEventListener('click', (e) => {
      if (e.target.closest('.as-toggle')) return;
      if (window.innerWidth <= 991) {
        const open = side.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
      }
    });
    // Close sidebar when a nav link is tapped on mobile
    side.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        if (window.innerWidth <= 991) side.classList.remove('open');
      });
    });
  }

  // ---- Magnetic buttons ----
  // Hero CTAs and the contact FAB gently pull toward the cursor.
  function initMagnetic() {
    if (!window.matchMedia('(hover: hover)').matches) return;
    document.querySelectorAll('.hero-cta .btn, .contact-fab').forEach(el => {
      el.classList.add('btn-magnetic');
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        el.style.setProperty('--mxx', (dx * .18).toFixed(1) + 'px');
        el.style.setProperty('--myy', (dy * .18).toFixed(1) + 'px');
      });
      el.addEventListener('pointerleave', () => {
        el.style.setProperty('--mxx', '0px');
        el.style.setProperty('--myy', '0px');
      });
    });
  }

  // ---- Global cursor glow ----
  // A soft teal light trails the pointer behind the content (mouse devices
  // only), giving the whole site a subtle "live system" feel.
  function initCursorGlow() {
    if (!window.matchMedia('(hover: hover)').matches) return;
    const glow = document.createElement('div');
    glow.className = 'cursor-glow';
    document.body.appendChild(glow);
    let x = innerWidth / 2, y = innerHeight / 2, tx = x, ty = y, raf = null;
    const loop = () => {
      x += (tx - x) * .12;
      y += (ty - y) * .12;
      glow.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
      raf = (Math.abs(tx - x) > .3 || Math.abs(ty - y) > .3) ? requestAnimationFrame(loop) : null;
    };
    document.addEventListener('pointermove', (e) => {
      tx = e.clientX; ty = e.clientY;
      if (!raf) raf = requestAnimationFrame(loop);
    }, { passive: true });
  }

  // ---- Hero parallax ----
  // Background drifts opposite the cursor; the headline block lags the page
  // scroll slightly for a depth effect as the hero exits.
  function initHeroParallax() {
    const hero = document.getElementById('homeHero');
    if (!hero) return;
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      hero.style.setProperty('--hx', ((e.clientX - r.left) / r.width - .5).toFixed(3));
      hero.style.setProperty('--hy', ((e.clientY - r.top) / r.height - .5).toFixed(3));
    }, { passive: true });
    hero.addEventListener('pointerleave', () => {
      hero.style.setProperty('--hx', '0');
      hero.style.setProperty('--hy', '0');
    });
    const onScroll = () => {
      const r = hero.getBoundingClientRect();
      hero.style.setProperty('--sp', Math.max(0, Math.min(1, -r.top / (r.height || 1))).toFixed(3));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ---- Reveal animations ----
  function initReveal() {
    const els = document.querySelectorAll('.reveal-up, .reveal-left, .reveal-right, .reveal-zoom');
    if (!('IntersectionObserver' in window) || !els.length) { els.forEach(el => el.classList.add('in')); return; }
    // Anything already inside the viewport is revealed immediately, so content
    // below the hero is never left invisible at first paint waiting on the
    // first IntersectionObserver callback (which some browsers delay) — the
    // desktop fold used to show a blank white band where the next section's
    // heading should be. Below-the-fold elements still animate in on scroll.
    els.forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) el.classList.add('in');
    });
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    els.forEach(el => io.observe(el));
    // Safety net: IntersectionObserver can miss elements during fast/jumped
    // scrolls (e.g. dragging the scrollbar or End/PageDown), leaving them stuck
    // at opacity 0. A cheap scroll check reveals anything in view that never
    // fired, so content can never be permanently invisible.
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        els.forEach(el => {
          if (el.classList.contains('in')) return;
          const r = el.getBoundingClientRect();
          if (r.top < window.innerHeight && r.bottom > 0) { el.classList.add('in'); io.unobserve(el); }
        });
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
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
        // Close the mobile offcanvas/hamburger panel before leaving the page.
        const off = document.getElementById('mobileOff');
        if (off) off.classList.remove('open');
        try {
          const res = await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
          });
          if (res.ok) {
            window.location.href = 'login.html';
          } else {
            const out = await res.json().catch(() => null);
            toast('Logout failed', (out && out.error) || 'Could not log out. Please try again.', 'exclamation-triangle');
          }
        } catch (err) {
          toast('Logout failed', 'Network error. Please try again.', 'exclamation-triangle');
        }
      });
    });
  }

  // ---- In-app notifications (bell) ----
  // Role-aware: guests see a public feed of announcements/events; logged-in
  // users see their personal notifications with an unread count + role pill.
  let notifUnread = 0;
  let notifPublic = false;
  let notifRoleLabel = '';
  let notifTimer = null;

  function initNotifications() {
    const bell = document.getElementById('nav-bell');
    const panel = document.getElementById('notifPanel');
    if (!panel) return;

    // Open/close the dropdown anchored under the clicked bell button. Clicking
    // the same bell toggles it shut; clicking a different bell re-anchors it.
    const openFor = (btn) => {
      const sameBell = panel._bell === btn;
      if (sameBell && panel.classList.contains('open')) {
        panel.classList.remove('open');
        return;
      }
      panel._bell = btn;
      panel.classList.add('open');
      const r = btn.getBoundingClientRect();
      const pw = panel.offsetWidth || 380;
      const ph = panel.offsetHeight || 420;
      let right = Math.max(8, window.innerWidth - r.right);
      if (right + pw > window.innerWidth - 8) right = Math.max(8, window.innerWidth - pw - 8);
      // Prefer anchoring below the bell; flip above it when there is no room
      // (e.g. the admin toolbar sits lower on narrow/stacked layouts).
      let top = r.bottom + 10;
      if (top + ph > window.innerHeight - 12 && r.top - ph - 10 > 12) {
        top = r.top - ph - 10;
      }
      panel.style.right = right + 'px';
      panel.style.top = top + 'px';
      loadNotifications();
    };

    if (bell) bell.addEventListener('click', (e) => { e.stopPropagation(); openFor(bell); });

    // Mobile bell button (beside avatar) — same panel + badge logic.
    const bellMobile = document.getElementById('nav-bell-m');
    if (bellMobile) bellMobile.addEventListener('click', (e) => { e.stopPropagation(); openFor(bellMobile); });

    // Admin dashboard toolbar bell — shares the same panel + badge logic.
    const dashBell = document.getElementById('dash-bell');
    if (dashBell) dashBell.addEventListener('click', (e) => { e.stopPropagation(); openFor(dashBell); });

    // Close on outside click / Escape.
    document.addEventListener('click', (e) => {
      if (e.target.closest('#notifPanel') || e.target.closest('#nav-bell') || e.target.closest('#nav-bell-m') || e.target.closest('#dash-bell')) return;
      panel.classList.remove('open');
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.classList.remove('open'); });

    // Settings gear: logged-in → profile prefs; guests → login page. Checks the
    // session directly instead of the notifPublic flag so a fast click before the
    // first notifications fetch resolves still lands in the right place.
    const goSettings = async () => {
      const me = await fetch('/api/auth/me').then(r => r.ok).catch(() => false);
      window.location.href = me ? 'profile.html#prefs' : 'login.html';
    };
    const gear = document.getElementById('nav-settings');
    if (gear) gear.addEventListener('click', goSettings);
    const dashSettings = document.getElementById('dash-settings');
    if (dashSettings) dashSettings.addEventListener('click', goSettings);
    const npSettings = document.getElementById('npSettings');
    if (npSettings) npSettings.addEventListener('click', (e) => { e.preventDefault(); goSettings(); });

    // Mark all read (logged-in only — hidden for guests).
    const markAll = document.getElementById('npMarkAll');
    if (markAll) markAll.addEventListener('click', async (e) => {
      e.preventDefault();
      if (notifPublic) return;
      try {
        await fetch('/api/notifications/read', { method: 'POST', credentials: 'include' });
      } catch { /* keep optimistic state */ }
      notifUnread = 0;
      document.querySelectorAll('#npBody .np-item.unread').forEach(el => { el.classList.remove('unread'); el.classList.add('read'); });
      updateNotifBadge();
    });

    loadNotifications();
    // Keep the badge fresh: refresh on an interval and whenever the tab regains
    // focus, but never while the panel is open (avoid resetting the scroll).
    if (notifTimer) return;
    notifTimer = setInterval(() => { if (!document.hidden && !panel.classList.contains('open')) loadNotifications(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !panel.classList.contains('open')) loadNotifications(); });
    window.addEventListener('focus', () => { if (!panel.classList.contains('open')) loadNotifications(); });
  }

  async function loadNotifications() {
    try {
      const res = await fetch('/api/notifications', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      notifPublic = data.public === true;
      notifRoleLabel = data.roleLabel || '';
      notifUnread = Number(data.unread) || 0;
      renderNotifications(Array.isArray(data.notifications) ? data.notifications : []);
      // Direct messages are for all registered roles — mirror the server DM gate.
      const npMessages = document.getElementById('npMessages');
      if (npMessages) npMessages.style.display = (!notifPublic && ['admin','cpri_staff','faculty_researcher','adviser','ethics_reviewer','student_researcher','public_visitor'].includes(data.role)) ? '' : 'none';
    } catch { /* keep last known state */ }
  }

  function renderNotifications(list) {
    const body = document.getElementById('npBody');
    const pill = document.getElementById('npRole');
    if (!body) return;
    if (pill) pill.textContent = notifRoleLabel ? '· ' + notifRoleLabel : '';
    const markAll = document.getElementById('npMarkAll');
    if (markAll) markAll.style.display = notifPublic ? 'none' : '';

    if (notifPublic) {
      // Guests: read-only public feed + sign-in CTA.
      if (!list.length) {
        body.innerHTML = '<div class="np-empty"><i class="bi bi-bell-slash"></i><span>No announcements yet.</span></div>';
      } else {
        body.innerHTML = list.map(n => `
          <a class="np-item" href="${escapeHtml(n.link || '#')}">
            <span class="np-icon"><i class="bi bi-megaphone"></i></span>
            <span class="np-text"><b>${escapeHtml(n.title)}</b><small>${escapeHtml(n.message)}</small></span>
          </a>`).join('')
          + '<a class="np-view-all" href="login.html"><i class="bi bi-box-arrow-in-right"></i> Sign in for personal notifications</a>';
      }
      updateNotifBadge();
      return;
    }

    if (!list.length) {
      body.innerHTML = '<div class="np-empty"><i class="bi bi-bell-slash"></i><span>No notifications yet.</span></div>';
      updateNotifBadge();
      return;
    }

    body.innerHTML = list.map(n => `
      <a class="np-item${n.readAt ? ' read' : ' unread'}" href="${escapeHtml(n.link || '#')}" data-id="${escapeHtml(n.id)}">
        <span class="np-icon"><i class="bi bi-bell"></i></span>
        <span class="np-text"><b>${escapeHtml(n.title)}</b><small>${escapeHtml(n.message)}</small><span class="np-time">${fmtAgo(n.createdAt)}</span></span>
      </a>`).join('');

    // Clicking a row marks it read server-side and keeps it visible (styled as
    // read), then follows the link. Rows without data-id (the guest feed) never
    // trigger the authenticated mark-read endpoint.
    body.querySelectorAll('.np-item[data-id]').forEach(row => {
      row.addEventListener('click', async (e) => {
        const alreadyRead = !row.classList.contains('unread');
        if (!alreadyRead) {
          // Mark read + persist immediately so a reload doesn't bring it back.
          row.classList.add('read');
          row.classList.remove('unread');
          if (notifUnread > 0) { notifUnread -= 1; updateNotifBadge(); }
          try {
            await fetch('/api/notifications/read/' + encodeURIComponent(row.dataset.id), { method: 'POST', credentials: 'include' });
          } catch { /* keep optimistic state */ }
        }
        // Let the default navigation happen (the row is an <a>).
      });
    });
    updateNotifBadge();
  }

  function updateNotifBadge() {
    const show = !notifPublic && notifUnread > 0;
    const count = show ? (notifUnread > 9 ? '9+' : String(notifUnread)) : '';
    // Navbar bell + admin dashboard toolbar bell stay in sync.
    ['notifBadge', 'dashNotifBadge', 'notifBadgeM'].forEach(id => {
      const badge = document.getElementById(id);
      if (!badge) return;
      badge.style.display = show ? 'grid' : 'none';
      badge.textContent = count;
    });
  }

  function fmtAgo(d) {
    const t = new Date(d);
    if (isNaN(t.getTime())) return '';
    const s = Math.max(1, Math.round((Date.now() - t.getTime()) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  async function fetchJson(url) {
    try { const res = await fetch(url); if (!res.ok) throw new Error('fail'); return await res.json(); }
    catch (err) { console.warn('load failed', url); return null; }
  }
  function fmtDate(d) { const date = new Date(d); if (isNaN(date)) return d; return date.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }); }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---- Builders ----
  const RESEARCH_CATS = { ai:'AI Research', policy:'Policy Studies', health:'Healthcare', edu:'Education', climate:'Climate', gov:'Governance' };
  function buildResearch(research, publications) {
    const el = document.getElementById('research-cards'); if (!el) return;
    let data = (research && research.length) ? research.slice(0,6).map((r,i) => ({ ...r, cat: Object.keys(RESEARCH_CATS)[i%6], views: 1000+(i*340) })) : [];
    // No curated publications yet: hide the search/filter toolbar and show a
    // tidy empty state instead of a blank section.
    if (!data.length) {
      const toolbar = document.getElementById('researchToolbar');
      if (toolbar) toolbar.style.display = 'none';
      el.innerHTML = '<div class="empty-state"><i class="bi bi-journal-richtext" style="font-size:1.6rem;display:block;margin-bottom:8px;color:var(--cpri-accent);"></i>No featured research yet — publications will appear here as they are curated.</div>';
      return;
    }
    const icons = { ai:'bi-cpu', policy:'bi-bank2', health:'bi-heart-pulse', edu:'bi-book', climate:'bi-globe2', gov:'bi-building' };
    el.innerHTML = data.map(r => `
      <div class="col-lg-4 col-md-6 reveal-up" data-cat="${r.cat}">
        <article class="media-card">
          <div class="m-media"><div class="ph"><i class="bi ${icons[r.cat]||'bi-journal-richtext'}"></i></div>
            <span class="date-badge">${fmtDate(r.date)}</span></div>
          <div class="m-body">
            <span class="tag">${RESEARCH_CATS[r.cat]||'Research'}</span>
            <h3>${escapeHtml(r.title)}</h3>
            <p>${escapeHtml(r.summary||r.excerpt||'')}</p>
            <div class="meta"><span><i class="bi bi-person"></i>${escapeHtml(r.author||'CPRI')}</span><span><i class="bi bi-clock"></i>${Number(r.read)||8} min</span><span><i class="bi bi-eye"></i>${(Number(r.views)||1200).toLocaleString()}</span></div>
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

  // ---- Public Research Impact Dashboard (live data) ----
  // Fetches the same MySQL-backed summary the Admin Dashboard Operations
  // Overview uses (/api/admin/public-summary), renders every field from real
  // records, and shows a single consistent empty state when the dataset is empty.
  async function loadPublicDashboard() {
    const el = document.getElementById('impact-dashboard');
    if (!el) return;
    let summary = null;
    try {
      const res = await fetch('/api/admin/public-summary');
      if (res.ok) { const data = await res.json(); summary = data.summary || null; }
    } catch { summary = null; }

    const isEmpty = !summary || (
      summary.totalSubmissions === 0 &&
      summary.publications === 0 &&
      summary.activeProjects === 0 &&
      summary.rejectedResearches === 0 &&
      summary.researchers === 0 &&
      summary.innovationProjects === 0
    );

    if (isEmpty) {
      el.innerHTML = `
        <div class="impact-empty">
          <div class="impact-empty-icon"><i class="bi bi-graph-up-arrow"></i></div>
          <h3>Dashboard activating</h3>
          <p>Figures will appear as research is submitted, published, and documented.</p>
          <small>All metrics come live from the same source as the Admin Dashboard Operations Overview. There is no data yet — check back after the first submissions are logged.</small>
        </div>`;
      return;
    }

    const months = Array.isArray(summary.monthlyOutput) ? summary.monthlyOutput : [];
    const labels = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push(d.toLocaleString('en-US', { month: 'short' }));
    }
    const maxMonth = Math.max(1, ...months);
    const bars = months.map((m, i) => `
      <div class="impact-bar-col" title="${labels[i] || ''} · ${m}">
        <div class="impact-bar" style="height:${Math.max(4, Math.round((m / maxMonth) * 100))}%"></div>
        <small>${labels[i] || ''}</small>
      </div>`).join('');

    el.innerHTML = `
      <div class="impact-panel reveal-up in">
        <div class="impact-head">
          <span class="impact-head-icon"><i class="bi bi-speedometer2"></i></span>
          <div><b>Live Research Impact</b><small>Updated ${new Date(summary.lastUpdated).toLocaleString()}</small></div>
        </div>
        <div class="impact-stats">
          <div class="impact-stat"><div class="is-num" data-count>${summary.publications || 0}</div><div class="is-lbl">Publications</div><small>status &ldquo;Published&rdquo;</small></div>
          <div class="impact-stat"><div class="is-num">${summary.activeProjects || 0}</div><div class="is-lbl">Active Projects</div><small>non-archived / non-rejected</small></div>
          <div class="impact-stat"><div class="is-num">${summary.rejectedResearches || 0}</div><div class="is-lbl">Rejected Researches</div><small>status &ldquo;Rejected&rdquo;</small></div>
          <div class="impact-stat"><div class="is-num">${summary.researchers || 0}</div><div class="is-lbl">Researchers</div><small>distinct users w/ submissions</small></div>
          <div class="impact-stat"><div class="is-num">${summary.innovationProjects || 0}</div><div class="is-lbl">Innovation Programs</div><small>Innovation &amp; Extension records</small></div>
        </div>
        <div class="impact-grid">
          <div class="impact-chart">
            <div class="impact-subhead"><i class="bi bi-bar-chart-line"></i> Monthly output · trailing 7 months</div>
            <div class="impact-bars">${bars || '<p class="form-note">No monthly data yet.</p>'}</div>
          </div>
          <div class="impact-progress">
            <div class="impact-subhead"><i class="bi bi-check2-circle"></i> Quality &amp; delivery</div>
            <div class="ip-row"><span>Approval rate</span><b>${summary.approvalRate || 0}%</b></div>
            <div class="ip-bar"><span style="width:${Math.min(100, summary.approvalRate || 0)}%"></span></div>
            <div class="ip-row"><span>On-time delivery</span><b>${summary.onTimeDelivery || 0}%</b></div>
            <div class="ip-bar"><span style="width:${Math.min(100, summary.onTimeDelivery || 0)}%"></span></div>
            <div class="ip-note"><i class="bi bi-info-circle"></i> Approval = (approved &divide; total submitted) &times; 100. On-time = approved within the 14-day review window.</div>
          </div>
          <div class="impact-goal">
            <div class="impact-subhead"><i class="bi bi-bullseye"></i> Research goals</div>
            <div class="impact-ring-wrap">
              <div class="impact-ring" style="--pct:${Math.min(100, summary.goalProgress || 0)}">
                <span class="ir-num">${summary.goalProgress || 0}%</span>
              </div>
              <div class="impact-ring-info">
                <b>${summary.goalLabel || 'On track for 2026'}</b>
                <small>${summary.goalSubtext || '+0% citations YoY'}</small>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ---- Hero stat chips (Publications & briefs / Review approval rate) ----
  // Same source as the Research Analytics dashboard: the chips update in place
  // with the live publication count and submission approval rate, keeping the
  // static markup values as an offline fallback.
  async function loadHeroStats() {
    const pubEl = document.getElementById('heroStatPub');
    const rateEl = document.getElementById('heroStatRate');
    if (!pubEl && !rateEl) return;
    try {
      const res = await fetch('/api/admin/hero-stats');
      if (!res.ok) return;
      const data = await res.json();
      const stats = data && data.stats;
      if (!stats) return;
      if (pubEl && typeof stats.publicationsAndBriefs === 'number') {
        pubEl.textContent = stats.publicationsAndBriefs.toLocaleString() + '+';
      }
      if (rateEl && typeof stats.reviewApprovalRate === 'number') {
        rateEl.textContent = stats.reviewApprovalRate + '%';
      }
    } catch { /* keep the static fallback values */ }
  }

  function buildEvents(events) {
    const el = document.getElementById('events'); if (!el) return;
    // Shared date logic with calendar.html: module events carry `dateTime`,
    // content events carry `date`, and records with an unparseable date are
    // still shown as upcoming (calendar treats those the same way).
    const parseDate = e => new Date(e.dateTime || e.date || 0);
    const evDate = e => {
      const t = parseDate(e).getTime();
      return isNaN(t) ? Infinity : t;
    };
    const now = Date.now();
    const upcoming = (events && Array.isArray(events))
      ? events.filter(e => evDate(e) >= now).sort((a, b) => evDate(a) - evDate(b))
      : [];
    const list = upcoming.slice(0,3);
    // No upcoming events yet: show a tidy empty state instead of a blank grid.
    if (!list.length) {
      el.innerHTML = '<div class="empty-state"><i class="bi bi-calendar-event" style="font-size:1.6rem;display:block;margin-bottom:8px;color:var(--cpri-accent);"></i>No upcoming events scheduled — check back soon for seminars, symposia, and conferences.</div>';
      return;
    }
    el.innerHTML = list.map(e => {
      const raw = parseDate(e);
      const hasDate = !isNaN(raw.getTime());
      const d = hasDate ? raw : new Date(now);
      // Module events (Events & Conferences) have real detail/registration pages;
      // content events (Admin Console) link back to the events listing instead.
      const isModule = e.source !== 'content';
      const detailHref = isModule ? 'event-detail.html?id=' + e.id : 'events.html';
      const regHref = isModule ? 'event-registration.html?id=' + e.id : 'events.html';
      const regLabel = isModule ? 'Register' : 'View';
      return `<div class="col-lg-4 col-md-6 reveal-up">
        <article class="event-card">
          <a class="e-media" href="${detailHref}" style="display:block;">${e.photo ? `<img src="${escapeHtml(e.photo)}" alt="${escapeHtml(e.title)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;">` : '<i class="bi bi-calendar-event"></i>'}
            <div class="e-date"><b>${d.getDate()}</b>${d.toLocaleString('en-US',{month:'short'})}</div>
          </a>
          <div class="e-body">
            <span class="tag">${escapeHtml(e.type || 'Event')}</span>
            <h3><a href="${detailHref}">${escapeHtml(e.title)}</a></h3>
            <div class="e-meta"><span><i class="bi bi-geo-alt"></i>${escapeHtml(e.location || e.venue || '')}</span><span><i class="bi bi-clock"></i>${fmtDate(e.dateTime || e.date)}</span></div>
            ${hasDate ? `<div class="countdown" data-to="${d.getTime()}">
              <div class="cd"><b class="cd-d">--</b><small>Days</small></div>
              <div class="cd"><b class="cd-h">--</b><small>Hrs</small></div>
              <div class="cd"><b class="cd-m">--</b><small>Min</small></div>
              <div class="cd"><b class="cd-s">--</b><small>Sec</small></div>
            </div>` : ''}
            <div class="e-foot">
              <a class="btn btn-gradient btn-sm" href="${regHref}">${regLabel}</a>
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

  // ---- Shared in-page confirm dialog ----
  // Native confirm() is silently blocked in sandboxed iframes (e.g. the
  // Freebuff preview), so destructive actions confirm via an in-page overlay.
  // Exposed globally as window.confirmDialog(message, okLabel) -> Promise<boolean>.
  let cpriConfirmResolve = null;
  function confirmDialog(message, okLabel) {
    if (cpriConfirmResolve) { cpriConfirmResolve(false); cpriConfirmResolve = null; }
    const overlay = document.getElementById('cpriConfirmOverlay');
    if (!overlay) return Promise.resolve(false);
    overlay.querySelector('#cpriConfirmMsg').textContent = message;
    overlay.querySelector('#cpriConfirmOk').textContent = okLabel || 'Confirm';
    overlay.hidden = false;
    overlay.querySelector('#cpriConfirmOk').focus();
    return new Promise(resolve => { cpriConfirmResolve = resolve; });
  }
  function injectConfirmDialog() {
    if (document.getElementById('cpriConfirmOverlay')) return;
    const el = document.createElement('div');
    el.className = 'confirm-overlay';
    el.id = 'cpriConfirmOverlay';
    el.hidden = true;
    el.innerHTML = `
      <div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="cpriConfirmTitle">
        <div class="confirm-icon"><i class="bi bi-exclamation-triangle"></i></div>
        <h3 id="cpriConfirmTitle">Are you sure?</h3>
        <p id="cpriConfirmMsg"></p>
        <div class="confirm-actions">
          <button type="button" class="btn btn-navy" id="cpriConfirmCancel">Cancel</button>
          <button type="button" class="btn btn-danger" id="cpriConfirmOk">Confirm</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    const close = (result) => {
      el.hidden = true;
      if (cpriConfirmResolve) { cpriConfirmResolve(result); cpriConfirmResolve = null; }
    };
    el.querySelector('#cpriConfirmOk').addEventListener('click', () => close(true));
    el.querySelector('#cpriConfirmCancel').addEventListener('click', () => close(false));
    el.addEventListener('click', (e) => { if (e.target === el) close(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden) close(false); });
    window.confirmDialog = confirmDialog;
  }

  // ---- Google sign-in (system-browser bridge) ----
  // Google blocks its OAuth consent screen inside embedded browsers (Electron /
  // WebView user agents) with "This browser or app may not be secure". The
  // "Complete sign-in in your browser" link hands the flow to a real browser via
  // ?external=1 and adopts the resulting session with a one-time code.
  function openGoogleBridge(authUrl) {
    let overlay = document.getElementById('googleBridge');
    if (overlay) { overlay.classList.add('open'); return; }
    overlay = document.createElement('div');
    overlay.id = 'googleBridge';
    overlay.className = 'gbridge-overlay';
    overlay.innerHTML = `
      <div class="gbridge-card" role="dialog" aria-modal="true" aria-label="Google sign-in">
        <button type="button" class="gbridge-close" aria-label="Close"><i class="bi bi-x-lg"></i></button>
        <div class="gbridge-icon"><i class="bi bi-google"></i></div>
        <h3>Complete sign-in in your browser</h3>
        <p>Google blocks sign-in inside this app's built-in browser. Pick a browser below (or copy the link), sign in with Google, then enter the code it shows you.</p>
        <a class="btn btn-gradient gbridge-open" href="${authUrl}" target="_blank" rel="noopener"><i class="bi bi-box-arrow-up-right"></i> Open default browser</a>
        <div class="gbridge-or">or choose a browser</div>
        <div class="gbridge-browsers" aria-label="Choose a browser"></div>
        <div class="gbridge-or">or copy this link</div>
        <input class="gbridge-url" readonly aria-label="Google sign-in link" value="${authUrl}" spellcheck="false">
        <div class="gbridge-code-row">
          <input class="gbridge-code" maxlength="6" placeholder="Enter code" autocomplete="one-time-code" aria-label="One-time code" spellcheck="false">
          <button type="button" class="btn btn-gradient gbridge-verify">Verify</button>
        </div>
        <div class="gbridge-msg" role="status"></div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.classList.remove('open');
    overlay.querySelector('.gbridge-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });
    overlay.querySelector('.gbridge-url').addEventListener('click', (e) => {
      e.target.select();
      if (navigator.clipboard) navigator.clipboard.writeText(authUrl).catch(() => {});
    });
    const msg = overlay.querySelector('.gbridge-msg');
    const codeInput = overlay.querySelector('.gbridge-code');
    const verify = async () => {
      const code = codeInput.value.trim().toUpperCase();
      if (!code) { msg.className = 'gbridge-msg error'; msg.textContent = 'Enter the code from your browser.'; return; }
      const btn = overlay.querySelector('.gbridge-verify');
      btn.disabled = true; msg.className = 'gbridge-msg'; msg.textContent = 'Verifying…';
      try {
        const res = await fetch('/api/auth/google/bridge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ code })
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((out && out.error) || 'Invalid code.');
        // Session adopted — route like the normal Google callback would.
        const me = await fetchMe();
        const user = me && me.user;
        window.location.href = user
          ? (user.needsSetup ? 'complete-profile.html' : user.role === 'admin' ? 'admin-dashboard.html' : 'account.html')
          : 'login.html';
      } catch (err) {
        msg.className = 'gbridge-msg error';
        msg.textContent = (err && err.message) || 'Verification failed. Please try again.';
        btn.disabled = false;
      }
    };
    overlay.querySelector('.gbridge-verify').addEventListener('click', verify);
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });

    // Populate the installed-browser chooser from the server (a web page can't
    // enumerate the machine's browsers by itself).
    const browserRow = overlay.querySelector('.gbridge-browsers');
    fetch('/api/auth/browsers')
      .then((r) => r.json())
      .then((list) => {
        if (!Array.isArray(list) || !list.length) return;
        browserRow.innerHTML = list.map((b) =>
          `<button type="button" class="gbrowser" data-browser="${b.id}"><span class="gbrowser-dot"></span>${b.name}</button>`
        ).join('');
        browserRow.querySelectorAll('.gbrowser').forEach((btn) => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              const res = await fetch('/api/auth/browser-open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ browser: btn.dataset.browser, url: authUrl })
              });
              const out = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error((out && out.error) || 'Could not open that browser.');
              msg.className = 'gbridge-msg';
              msg.textContent = `Opened ${btn.textContent.trim()} — sign in there, then enter the code here.`;
            } catch (err) {
              msg.className = 'gbridge-msg error';
              msg.textContent = (err && err.message) || 'Could not open that browser.';
            }
            btn.disabled = false;
          });
        });
      })
      .catch(() => { /* chooser is progressive enhancement; the copy link stays */ });

    requestAnimationFrame(() => overlay.classList.add('open'));
  }

  // Shared entry point for the login/register "Continue with Google" buttons.
  // Always navigates directly to Google's consent screen — the code-based
  // bridge dialog is only for the explicit "Complete sign-in in your browser"
  // link below the button. Resolves false when Google sign-in is not configured
  // server-side (the page shows its own message).
  async function startGoogleLogin(btn) {
    const res = await fetch('/api/auth/google/status', { credentials: 'include' });
    const out = await res.json().catch(() => ({}));
    if (!(out && out.enabled)) return false;
    // Tell the server which page started the flow so error bounces (cancel,
    // disabled, pending, failure) come back to that same page.
    const fromParam = currentPage() === 'register.html' ? 'from=register' : '';
    if (btn && !btn.disabled) {
      // Loading state: remember the original label so a canceled attempt that
      // returns here (browser Back / bfcache) can restore the button.
      if (!btn.dataset.googleOrig) btn.dataset.googleOrig = btn.innerHTML;
      btn.classList.add('is-loading');
      btn.disabled = true;
    }
    // Remember this attempt: if the visitor comes back here without being
    // signed in (e.g. Google blocked the embedded browser and they pressed
    // Back), we offer the code-based flow instead of leaving them stuck.
    sessionStorage.setItem('cpriGoogleAttempt', '1');
    // apiUrl() keeps the OAuth start on the API host when the front end is
    // hosted elsewhere (GitHub Pages), instead of the static host.
    window.location.href = apiUrl('/api/auth/google') + (fromParam ? '?' + fromParam : '');
    return true;
  }

  // Entry point for the "Complete sign-in in your browser" option under the
  // Google button. Always shows the bridge dialog — in any browser — so users
  // who prefer (or need) to finish Google sign-in in their default browser
  // with a one-time code have a direct path to it.
  async function startBrowserSignIn() {
    const res = await fetch('/api/auth/google/status', { credentials: 'include' });
    const out = await res.json().catch(() => ({}));
    if (!(out && out.enabled)) return false;
    const fromParam = currentPage() === 'register.html' ? 'from=register' : '';
    const authUrl = location.origin + '/api/auth/google?external=1' + (fromParam ? '&' + fromParam : '');
    openGoogleBridge(authUrl);
    return true;
  }

  // One-click rescue after a blocked Google attempt: a banner that appears on
  // login/register when the visitor returns from the Google hop without being
  // signed in (typical in the embedded preview, where Google refuses consent)
  // and routes them straight into the code-based flow.
  function showGoogleBlockedBanner() {
    if (document.getElementById('googleBlockFlag')) return;
    const flag = document.createElement('div');
    flag.id = 'googleBlockFlag';
    flag.className = 'gbridge-flag';
    flag.innerHTML = `
      <span class="gf-icon"><i class="bi bi-exclamation-triangle"></i></span>
      <div class="gf-msg"><b>Google sign-in didn't complete.</b> If Google blocked this app's built-in browser, finish it in your own browser with a one-time code.</div>
      <button type="button" class="btn btn-gradient btn-sm gf-btn">Switch to code flow</button>
      <button type="button" class="gf-close" aria-label="Dismiss"><i class="bi bi-x-lg"></i></button>`;
    document.body.appendChild(flag);
    flag.querySelector('.gf-btn').addEventListener('click', () => {
      startBrowserSignIn();
    });
    flag.querySelector('.gf-close').addEventListener('click', () => flag.remove());
  }

  // A canceled Google attempt can return the visitor to the auth page via the
  // browser's Back button, which restores the page from bfcache — including the
  // Google button's disabled "loading" state. Re-enable it whenever we land on
  // an auth page so it is never left stuck.
  function restoreGoogleButton() {
    const page = currentPage();
    if (page !== 'login.html' && page !== 'register.html') return;
    const btn = document.getElementById('google-btn');
    if (!btn) return;
    if (btn.dataset.googleOrig) {
      btn.innerHTML = btn.dataset.googleOrig;
      delete btn.dataset.googleOrig;
    }
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }

  // Track Google attempts: pageshow fires on every load and on bfcache
  // restore, so coming Back from a blocked Google page is caught either way.
  window.addEventListener('pageshow', () => {
    const page = currentPage();
    if (page === 'login.html' || page === 'register.html') restoreGoogleButton();
    if (!sessionStorage.getItem('cpriGoogleAttempt')) return;
    if (page === 'login.html' || page === 'register.html') {
      sessionStorage.removeItem('cpriGoogleAttempt');
      fetchMe().then((me) => {
        if (me && me.user) return; // signed in — the attempt succeeded
        showGoogleBlockedBanner();
      });
    } else {
      // Landed elsewhere (account/admin/complete-profile) — attempt resolved.
      sessionStorage.removeItem('cpriGoogleAttempt');
    }
  });

  document.addEventListener('DOMContentLoaded', () => { injectLayout(); injectConfirmDialog(); });

  return {
    fetchJson, apiBase, apiUrl, apiFetch, fmtDate, escapeHtml, reveal: initReveal, toast, SITE,
    buildResearch, buildNews, buildResearchers, buildStats,
    buildEvents,
    buildFaqs, initHeroExtras, loadPublicDashboard, loadHeroStats,
    startGoogleLogin, startBrowserSignIn
  };
})();

