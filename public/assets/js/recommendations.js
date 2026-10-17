// ============================================================
//  CPRI — "Recommended Research" panel
//
//  Fills any element marked
//
//    <div data-recommend-endpoint="/api/repository/{id}/recommendations">
//
//  where {id} is replaced by the page's ?id= value. The server ranks related
//  public repository entries (shared keywords, then category, then
//  department) and says why each one matches; this only renders that.
//
//  The panel stays hidden when there is no id or the caller may not read the
//  record, so it never adds an error to a page that already explains itself.
//  Everything is written with textContent — titles come from user input.
// ============================================================
(function () {
  'use strict';

  function chip(text) {
    const span = document.createElement('span');
    span.textContent = text;
    span.style.cssText = 'display:inline-block;padding:2px 10px;border-radius:999px;font-size:.74rem;' +
      'font-weight:600;background:var(--maroon-tint);color:var(--cpri-secondary);margin:4px 6px 0 0;';
    return span;
  }

  function renderItem(rec) {
    const li = document.createElement('li');
    li.style.cssText = 'padding:12px 0;border-top:1px solid var(--cpri-border);list-style:none;';

    const link = document.createElement('a');
    link.href = rec.url;
    link.textContent = rec.title;
    link.style.fontWeight = '700';
    li.appendChild(link);

    const meta = [rec.authors, rec.department, rec.yearCompleted].filter(Boolean).join(' · ');
    if (meta) {
      const p = document.createElement('div');
      p.className = 'form-note';
      p.style.cssText = 'margin:2px 0 0;font-size:.85rem;';
      p.textContent = meta;
      li.appendChild(p);
    }

    const why = document.createElement('div');
    why.setAttribute('aria-label', 'Why this is recommended');
    for (const reason of rec.reasons || []) why.appendChild(chip(reason));
    li.appendChild(why);
    return li;
  }

  async function fill(panel, id) {
    const endpoint = panel.dataset.recommendEndpoint.replace('{id}', encodeURIComponent(id));
    let body;
    try {
      const res = await fetch(endpoint, { credentials: 'same-origin' });
      if (!res.ok) return;
      body = await res.json();
    } catch {
      return;
    }

    const list = panel.querySelector('[data-recommend-list]');
    const empty = panel.querySelector('[data-recommend-empty]');
    const items = Array.isArray(body && body.recommendations) ? body.recommendations : [];
    list.textContent = '';
    for (const rec of items) list.appendChild(renderItem(rec));
    if (empty) empty.style.display = items.length ? 'none' : '';
    panel.style.display = '';
  }

  function init() {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) return;
    document.querySelectorAll('[data-recommend-endpoint]').forEach(panel => fill(panel, id));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
