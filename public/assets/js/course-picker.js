/* ============================================================
   CPRI course picker — ONE searchable, department-grouped course
   dropdown shared by register.html and the Admin Console.

   The list always comes from GET /api/courses (the `courses` table);
   nothing here keeps its own copy of it.

     CPRICourses.load({ all })      -> Promise<{ courses, groups }>
     CPRICourses.picker(options)    -> picker instance

   options
     value        current courses.id, 'other', or null
     other        text for "Other (please specify)"
     allowOther   offer "Other (please specify)" (registration only)
     placeholder  trigger text while empty (default "Select course")
     name         hidden input name for the id (default none)
     otherName    text input name for the "Other" value (default none)
     otherPlaceholder  placeholder of the "Other" text field (default "Type your course")
     otherLabel   accessible name of the "Other" text field
     highlightEmpty  gold border while empty (admin table: "no course yet")
     compact      smaller trigger for table cells
     ariaLabel    accessible name of the trigger
     onChange     ({ courseId, courseOther }) => void
   ============================================================ */
(function () {
  'use strict';

  const OTHER = 'other';
  const cache = { active: null, all: null };
  let uid = 0;
  let openPicker = null;

  function esc(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function norm(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function apiFetch(path) {
    // main.js declares CPRI with a top-level const (not a window property);
    // its apiFetch applies the configured API base.
    if (typeof CPRI !== 'undefined' && typeof CPRI.apiFetch === 'function') {
      return CPRI.apiFetch(path, { credentials: 'include' }).then(({ res, data }) => {
        if (!res.ok) throw new Error((data && data.error) || 'The course list could not be loaded.');
        return data || {};
      });
    }
    return fetch(path, { credentials: 'include' }).then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The course list could not be loaded.');
      return data;
    });
  }

  function groupList(list) {
    const groups = new Map();
    list.forEach(c => {
      const key = c.department || 'Other programs';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    });
    return [...groups.entries()].map(([department, courses]) => ({ department, courses }));
  }

  // { all: true } (admins) also returns inactive courses, so a student who
  // holds a course that was deactivated later still shows its name.
  function load(opts) {
    const all = Boolean(opts && opts.all);
    const force = Boolean(opts && opts.force);
    const key = all ? 'all' : 'active';
    if (!force && cache[key]) return cache[key];
    cache[key] = apiFetch('/api/courses' + (all ? '?all=1' : '')).then(data => {
      const courses = Array.isArray(data.courses) ? data.courses : [];
      const active = courses.filter(c => c.isActive !== false);
      return {
        courses,
        active,
        groups: groupList(active),
        departments: data.departments || [...new Set(courses.map(c => c.department).filter(Boolean))],
        byId: new Map(courses.map(c => [Number(c.id), c]))
      };
    }).catch(err => {
      cache[key] = null;
      throw err;
    });
    return cache[key];
  }

  function invalidate() {
    cache.active = null;
    cache.all = null;
  }

  function closeOpen() {
    if (openPicker) openPicker.close();
  }

  document.addEventListener('mousedown', (e) => {
    if (openPicker && !openPicker.contains(e.target)) openPicker.close();
  });
  window.addEventListener('resize', () => { if (openPicker) openPicker.position(); });
  // Table cells scroll inside .table-scroll; keep the panel glued to its trigger.
  document.addEventListener('scroll', (e) => {
    if (openPicker && !openPicker.panel.contains(e.target)) openPicker.position();
  }, true);

  function picker(options) {
    const o = Object.assign({
      value: null,
      other: '',
      allowOther: false,
      placeholder: 'Select course',
      name: '',
      otherName: '',
      otherPlaceholder: 'Type your course',
      otherLabel: 'Your course (please specify)',
      highlightEmpty: false,
      compact: false,
      ariaLabel: 'Course',
      data: null,
      onChange: null
    }, options || {});

    const id = 'cp-' + (++uid);
    const root = document.createElement('div');
    root.className = 'course-picker' + (o.compact ? ' cp-compact' : '');
    root.innerHTML = `
      <button type="button" class="cp-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}-panel" aria-label="${esc(o.ariaLabel)}">
        <span class="cp-label"></span><i class="bi bi-chevron-down cp-caret" aria-hidden="true"></i>
      </button>
      ${o.name ? `<input type="hidden" name="${esc(o.name)}" class="cp-value">` : ''}
      <input type="text" class="cp-other" ${o.otherName ? `name="${esc(o.otherName)}"` : ''} maxlength="180" placeholder="${esc(o.otherPlaceholder)}" aria-label="${esc(o.otherLabel)}" hidden>`;
    const trigger = root.querySelector('.cp-trigger');
    const labelEl = root.querySelector('.cp-label');
    const hidden = root.querySelector('.cp-value');
    const otherInput = root.querySelector('.cp-other');

    // The panel lives on <body> so table overflow never clips it.
    const panel = document.createElement('div');
    panel.className = 'cp-panel';
    panel.id = id + '-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="cp-search-wrap"><i class="bi bi-search" aria-hidden="true"></i>
        <input type="search" class="cp-search" placeholder="Search courses or departments" aria-label="Search courses" autocomplete="off">
      </div>
      <div class="cp-list" role="listbox" id="${id}-list" aria-label="${esc(o.ariaLabel)}"></div>
      <p class="cp-none" hidden>No course matches your search.</p>`;
    document.body.appendChild(panel);
    const search = panel.querySelector('.cp-search');
    const list = panel.querySelector('.cp-list');
    const none = panel.querySelector('.cp-none');

    let data = null;
    let value = o.value === null || o.value === undefined || o.value === '' ? null : (o.value === OTHER ? OTHER : Number(o.value));
    let otherText = o.other || '';
    if (value === null && otherText) value = OTHER;

    function currentLabel() {
      if (value === OTHER) return otherText ? 'Other: ' + otherText : 'Other (please specify)';
      if (value === null) return '';
      const course = data && data.byId.get(Number(value));
      if (!course) return 'Course #' + value;
      return course.isActive === false ? course.name + ' (no longer offered)' : course.name;
    }

    function render() {
      const text = currentLabel();
      labelEl.textContent = text || o.placeholder;
      // The full name is always one hover away, however narrow the cell.
      trigger.title = text || o.placeholder;
      root.classList.toggle('cp-empty', !text);
      root.classList.toggle('cp-missing', o.highlightEmpty && !text);
      if (hidden) hidden.value = value === null ? '' : String(value);
      const showOther = o.allowOther && value === OTHER;
      otherInput.hidden = !showOther;
      if (!showOther) otherInput.value = '';
      else if (otherInput.value !== otherText) otherInput.value = otherText;
    }

    function optionHtml(c) {
      const selected = value !== OTHER && Number(value) === Number(c.id);
      return `<button type="button" class="cp-option${selected ? ' is-selected' : ''}" role="option" aria-selected="${selected}" data-id="${c.id}" data-search="${esc(norm(c.name + ' ' + (c.department || '')))}" title="${esc(c.name)}">
        <span>${esc(c.name)}</span>${selected ? '<i class="bi bi-check2" aria-hidden="true"></i>' : ''}</button>`;
    }

    function buildList() {
      if (!data) {
        list.innerHTML = '<p class="cp-loading">Loading courses…</p>';
        return;
      }
      let html = data.groups.map((g, i) => `
        <div class="cp-group" role="group" aria-labelledby="${id}-g${i}">
          <div class="cp-group-label" id="${id}-g${i}">${esc(g.department)}</div>
          ${g.courses.map(optionHtml).join('')}
        </div>`).join('');
      if (o.allowOther) {
        const selected = value === OTHER;
        html += `<div class="cp-group cp-group-other" role="group">
          <button type="button" class="cp-option cp-option-other${selected ? ' is-selected' : ''}" role="option" aria-selected="${selected}" data-id="${OTHER}" data-search="other please specify">
            <span><i class="bi bi-pencil-square" aria-hidden="true"></i> Other (please specify)</span></button></div>`;
      }
      list.innerHTML = html || '<p class="cp-loading">No courses are available yet.</p>';
    }

    function filter() {
      const q = norm(search.value);
      let realShown = 0;
      list.querySelectorAll('.cp-group').forEach(group => {
        let groupShown = 0;
        group.querySelectorAll('.cp-option').forEach(opt => {
          // "Other" stays visible so a student whose course is missing can say so.
          const match = !q || opt.dataset.search.includes(q) || opt.dataset.id === OTHER;
          opt.hidden = !match;
          if (match) groupShown++;
          if (match && opt.dataset.id !== OTHER) realShown++;
        });
        group.hidden = groupShown === 0;
      });
      none.hidden = !(q && realShown === 0);
    }

    function visibleOptions() {
      return [...list.querySelectorAll('.cp-option')].filter(b => !b.hidden && !b.closest('.cp-group').hidden);
    }

    function position() {
      if (panel.hidden) return;
      const r = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(r.width, 320), window.innerWidth - 16);
      let left = Math.min(r.left, window.innerWidth - width - 8);
      left = Math.max(8, left);
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const wanted = 360;
      panel.style.width = width + 'px';
      panel.style.left = left + 'px';
      if (below >= Math.min(wanted, 240) || below >= above) {
        panel.style.top = (r.bottom + 6) + 'px';
        panel.style.bottom = '';
        panel.style.maxHeight = Math.max(180, Math.min(wanted, below)) + 'px';
      } else {
        panel.style.top = '';
        panel.style.bottom = (window.innerHeight - r.top + 6) + 'px';
        panel.style.maxHeight = Math.max(180, Math.min(wanted, above)) + 'px';
      }
    }

    function open() {
      if (trigger.disabled) return;
      if (openPicker && openPicker !== api) openPicker.close();
      openPicker = api;
      buildList();
      search.value = '';
      filter();
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      root.classList.add('is-open');
      position();
      const selected = list.querySelector('.cp-option.is-selected');
      if (selected) selected.scrollIntoView({ block: 'nearest' });
      // The panel is already placed next to the trigger; never scroll the page.
      search.focus({ preventScroll: true });
    }

    function close(focusTrigger) {
      if (panel.hidden) return;
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      root.classList.remove('is-open');
      if (openPicker === api) openPicker = null;
      if (focusTrigger) trigger.focus();
    }

    function emit() {
      if (typeof o.onChange === 'function') o.onChange(api.getValue());
      root.dispatchEvent(new CustomEvent('coursechange', { bubbles: true, detail: api.getValue() }));
    }

    function choose(raw) {
      const next = raw === OTHER ? OTHER : Number(raw);
      const changed = next !== value;
      value = next;
      if (value !== OTHER) otherText = '';
      render();
      close(value !== OTHER);
      if (value === OTHER) {
        otherInput.focus();
      }
      api.setInvalid(false);
      if (changed || value === OTHER) emit();
    }

    trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
    });
    search.addEventListener('input', filter);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); const first = visibleOptions()[0]; if (first) first.focus(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const opts = visibleOptions().filter(b => b.dataset.id !== OTHER);
        if (opts.length === 1) choose(opts[0].dataset.id);
      } else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') close();
    });
    list.addEventListener('click', (e) => {
      const opt = e.target.closest('.cp-option');
      if (opt) choose(opt.dataset.id);
    });
    list.addEventListener('keydown', (e) => {
      const opts = visibleOptions();
      const i = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (opts[i + 1] || opts[i]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) search.focus(); else opts[i - 1].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); if (opts[0]) opts[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); if (opts.length) opts[opts.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') close();
    });
    otherInput.addEventListener('input', () => {
      otherText = otherInput.value;
      trigger.title = currentLabel();
      labelEl.textContent = currentLabel();
      api.setInvalid(false);
    });
    otherInput.addEventListener('change', emit);

    const api = {
      el: root,
      panel,
      contains(node) { return root.contains(node) || panel.contains(node); },
      open,
      close,
      position,
      getValue() {
        if (value === OTHER) return { courseId: OTHER, courseOther: (otherInput.value || otherText || '').trim() };
        return { courseId: value, courseOther: '' };
      },
      isEmpty() {
        const v = api.getValue();
        return v.courseId === null || (v.courseId === OTHER && !v.courseOther);
      },
      setValue(next, other) {
        value = next === null || next === undefined || next === '' ? null : (next === OTHER ? OTHER : Number(next));
        otherText = other || '';
        if (value === null && otherText) value = OTHER;
        render();
      },
      clear() { api.setValue(null, ''); },
      setInvalid(flag) {
        root.classList.toggle('cp-invalid', Boolean(flag));
        trigger.setAttribute('aria-invalid', String(Boolean(flag)));
      },
      setDisabled(flag) {
        trigger.disabled = Boolean(flag);
        otherInput.disabled = Boolean(flag);
        if (flag) close();
      },
      focus() {
        if (value === OTHER && !otherInput.hidden) otherInput.focus();
        else trigger.focus();
      },
      describedBy(ids) {
        trigger.setAttribute('aria-describedby', ids);
        otherInput.setAttribute('aria-describedby', ids);
      },
      destroy() {
        close();
        panel.remove();
        root.remove();
      }
    };

    render();
    const source = o.data ? Promise.resolve(o.data) : load({ all: false });
    source.then(d => {
      data = d;
      render();
      if (!panel.hidden) { buildList(); filter(); }
    }).catch(err => {
      list.innerHTML = `<p class="cp-loading cp-error">${esc(err.message)}</p>`;
    });
    return api;
  }

  window.CPRICourses = { load, invalidate, picker, closeOpen, OTHER };
})();
