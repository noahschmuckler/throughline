// ------------------------------------------------------------------
// Throughline — client logic
// One JSON document; vanilla DOM; hash-based routing; debounced PUT.
// Ports to a Node + JSON-file backend by swapping the API URL only.
// ------------------------------------------------------------------

const STATE_URL = '/api/state';
const SAVE_DEBOUNCE_MS = 600;

let state = emptyState();
let saveTimer = null;
let lastSavedAt = null;
let currentDrawerEntryId = null;
const homeFilters = { search: '', activeTags: new Set() };

// ---------- State + persistence ------------------------------------

function emptyState() {
  return { schema_version: 1, containers: [], entries: [], atoms: [] };
}

function normalizeState(d) {
  return {
    schema_version: 1,
    containers: Array.isArray(d?.containers) ? d.containers : [],
    entries:    Array.isArray(d?.entries)    ? d.entries    : [],
    atoms:      Array.isArray(d?.atoms)      ? d.atoms      : [],
  };
}

async function loadState() {
  try {
    const r = await fetch(STATE_URL, { cache: 'no-store' });
    const data = await r.json();
    state = normalizeState(data);
  } catch (e) {
    console.error('load failed', e);
    state = emptyState();
    setStatus('error');
  }
}

function scheduleSave() {
  setStatus('dirty');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
}

async function doSave() {
  setStatus('saving');
  try {
    const r = await fetch(STATE_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (!r.ok) throw new Error(`save failed: ${r.status}`);
    lastSavedAt = Date.now();
    setStatus('saved');
  } catch (e) {
    console.error(e);
    setStatus('error');
  }
}

function setStatus(s) {
  const el = document.getElementById('status');
  if (!el) return;
  if (s === 'saving') { el.textContent = 'saving…'; el.dataset.state = 'saving'; }
  else if (s === 'saved') { el.textContent = `saved ${fmtWhen(new Date(lastSavedAt).toISOString())}`; el.dataset.state = 'saved'; }
  else if (s === 'error') { el.textContent = 'save failed — check connection'; el.dataset.state = 'error'; }
  else if (s === 'dirty') { el.textContent = 'editing…'; el.dataset.state = 'dirty'; }
  else { el.textContent = ''; el.dataset.state = ''; }
}

// ---------- Utilities ----------------------------------------------

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id_' + Math.random().toString(36).slice(2));

function slugify(s) {
  return (s || '').toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 64) || 'item';
}

function uniqueSlug(base) {
  let s = base;
  if (!state.containers.find(c => c.id === s)) return s;
  let i = 2;
  while (state.containers.find(c => c.id === `${s}_${i}`)) i++;
  return `${s}_${i}`;
}

const nowIso = () => new Date().toISOString();

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60)       return 'just now';
  if (diff < 3600)     return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)    return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400*6)  return `${Math.floor(diff / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(0, 10);
}

function isoToLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToIso(local) {
  if (!local) return null;
  const d = new Date(local);
  return isNaN(d) ? null : d.toISOString();
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function tmpl(id) {
  return document.getElementById(id).content.cloneNode(true);
}

// ---------- Derived selectors --------------------------------------

const getContainer = (id) => state.containers.find(c => c.id === id);
const entriesOf    = (cid) => state.entries.filter(e => e.container_id === cid);
const atomsOf      = (eid) => state.atoms.filter(a => a.entry_id === eid);

function atomsOfContainer(cid) {
  const ids = new Set(entriesOf(cid).map(e => e.id));
  return state.atoms.filter(a => ids.has(a.entry_id));
}

function openActionsOf(cid) {
  const atoms = atomsOfContainer(cid);
  const actions = atoms.filter(a => a.kind === 'action');
  const closed = new Set(
    atoms.filter(a => a.kind === 'outcome' && a.parent_atom_id).map(a => a.parent_atom_id)
  );
  return actions.filter(a => !closed.has(a.id));
}

function isOverdue(action) {
  if (!action.due_date) return false;
  return action.due_date < new Date().toISOString().slice(0, 10);
}

function lastTouchedOf(cid) {
  const ents = entriesOf(cid);
  if (!ents.length) {
    const c = getContainer(cid);
    return c?.updated_at || c?.created_at || '';
  }
  return ents.reduce((max, e) => (e.occurred_at || '') > max ? e.occurred_at : max, '');
}

function allTags() {
  const set = new Set();
  for (const c of state.containers) (c.tags || []).forEach(t => set.add(t));
  for (const e of state.entries)    (e.tags || []).forEach(t => set.add(t));
  for (const a of state.atoms)      (a.tags || []).forEach(t => set.add(t));
  return [...set].sort((a, b) => a.localeCompare(b));
}

function allParticipants() {
  const set = new Set();
  for (const e of state.entries) (e.participants || []).forEach(p => set.add(p));
  for (const a of state.atoms) if (a.assigned_to) set.add(a.assigned_to);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// ---------- Routing -------------------------------------------------

function currentRoute() {
  const h = location.hash.replace(/^#/, '');
  if (!h || h === '/') return { kind: 'home' };
  const m = h.match(/^\/c\/(.+)$/);
  if (m) return { kind: 'container', id: decodeURIComponent(m[1]) };
  return { kind: 'home' };
}

window.addEventListener('hashchange', () => { closeDrawer(true); render(); });

// ---------- Render dispatcher --------------------------------------

function render() {
  const main = document.getElementById('main');
  main.innerHTML = '';
  const r = currentRoute();
  if (r.kind === 'home') {
    renderHome(main);
  } else if (r.kind === 'container') {
    const c = getContainer(r.id);
    if (!c) {
      main.innerHTML = `<div class="empty">No project with id <code>${escHtml(r.id)}</code>. <a href="#/">Back home</a>.</div>`;
    } else {
      renderContainer(main, c);
    }
  }
}

// ---------- Home view ----------------------------------------------

function renderHome(main) {
  main.appendChild(tmpl('tpl-home'));

  main.querySelector('[data-act="new-project"]').onclick =
    () => openNewContainerModal('project');
  main.querySelector('[data-act="new-reference-file"]').onclick =
    () => openNewContainerModal('reference_file');

  const search = main.querySelector('#home-search');
  search.value = homeFilters.search;
  search.oninput = () => {
    homeFilters.search = search.value.toLowerCase();
    renderHomeBody();
  };

  renderHomeTagChips();
  renderHomeBody();
  renderRecent();
}

function renderHomeTagChips() {
  const wrap = document.getElementById('home-tag-chips');
  if (!wrap) return;
  wrap.innerHTML = '';
  const tags = allTags();
  if (!tags.length) return;
  for (const t of tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip' + (homeFilters.activeTags.has(t) ? ' active' : '');
    chip.textContent = '#' + t;
    chip.onclick = () => {
      if (homeFilters.activeTags.has(t)) homeFilters.activeTags.delete(t);
      else homeFilters.activeTags.add(t);
      renderHomeTagChips();
      renderHomeBody();
    };
    wrap.appendChild(chip);
  }
}

function filterContainers() {
  const q = homeFilters.search;
  const tags = homeFilters.activeTags;
  return state.containers.filter(c => {
    if (c.status === 'archived') return false;
    if (tags.size && ![...tags].every(t => (c.tags || []).includes(t))) return false;
    if (q) {
      const hay = [
        c.title, c.goal_or_purpose, c.summary, (c.tags || []).join(' ')
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderHomeBody() {
  const list = document.getElementById('container-list');
  if (!list) return;
  list.innerHTML = '';
  const items = filterContainers().sort((a, b) => {
    const ta = lastTouchedOf(a.id) || a.created_at || '';
    const tb = lastTouchedOf(b.id) || b.created_at || '';
    return tb.localeCompare(ta);
  });
  if (!items.length) {
    list.appendChild(tmpl('tpl-empty-home'));
    return;
  }
  for (const c of items) list.appendChild(renderContainerRow(c));
}

function renderContainerRow(c) {
  const row = document.createElement('div');
  row.className = 'container-row';
  row.onclick = () => { location.hash = `#/c/${encodeURIComponent(c.id)}`; };

  const open = openActionsOf(c.id);
  const overdue = open.filter(isOverdue).length;
  const lt = lastTouchedOf(c.id);
  const typeLabel = c.type === 'project' ? 'Project' : 'Reference';
  const typeCls   = c.type === 'project' ? 'project' : 'reference';

  row.innerHTML = `
    <div class="container-row-left">
      <div class="container-row-title">
        <span class="type-mark ${typeCls}">${typeLabel}</span>
        ${escHtml(c.title)}
      </div>
      ${c.goal_or_purpose ? `<p class="container-row-tagline">${escHtml(c.goal_or_purpose)}</p>` : ''}
      <div class="container-row-meta">
        <span class="open-pill ${open.length === 0 ? 'zero' : ''}">
          ${open.length} open${overdue ? ' · ' + overdue + ' overdue' : ''}
        </span>
        ${(c.tags || []).map(t => `<span>#${escHtml(t)}</span>`).join('')}
      </div>
    </div>
    <div class="container-row-right">${lt ? fmtWhen(lt) : 'no activity'}</div>
  `;
  return row;
}

function renderRecent() {
  const list = document.getElementById('recent-list');
  if (!list) return;
  list.innerHTML = '';
  const recent = [...state.entries]
    .filter(e => {
      const c = getContainer(e.container_id);
      return c && c.status !== 'archived';
    })
    .sort((a, b) => (b.occurred_at || '').localeCompare(a.occurred_at || ''))
    .slice(0, 8);
  if (!recent.length) {
    list.innerHTML = '<div class="empty muted small">No entries yet — add the first one inside a project.</div>';
    return;
  }
  for (const e of recent) {
    const c = getContainer(e.container_id);
    const row = document.createElement('div');
    row.className = 'recent-row';
    row.innerHTML = `
      <div class="when">${fmtDate(e.occurred_at)}</div>
      <div class="what">
        <a href="#/c/${encodeURIComponent(c.id)}">${escHtml(e.title || '(untitled)')}</a>
        <span class="where">in ${escHtml(c.title)}</span>
      </div>
    `;
    list.appendChild(row);
  }
}

// ---------- Container detail ---------------------------------------

function renderContainer(main, c) {
  main.appendChild(tmpl('tpl-project'));

  main.querySelector('#project-title').textContent = c.title;

  const typeBadge = main.querySelector('#project-type-badge');
  typeBadge.textContent = c.type === 'project' ? 'Project' : 'Reference File';
  if (c.type === 'reference_file') typeBadge.classList.add('reference');

  const tagline = main.querySelector('#project-tagline');
  if (c.goal_or_purpose) tagline.textContent = c.goal_or_purpose;
  else tagline.remove();

  if (c.summary) {
    const det = main.querySelector('#project-summary-details');
    det.hidden = false;
    main.querySelector('#project-summary-body').textContent = c.summary;
  }

  const tagsDiv = main.querySelector('#project-tags');
  for (const t of (c.tags || [])) {
    const span = document.createElement('span');
    span.className = 'chip';
    span.textContent = '#' + t;
    tagsDiv.appendChild(span);
  }

  main.querySelector('[data-act="edit-project"]').onclick = () => openEditContainerModal(c);
  main.querySelector('[data-act="new-entry"]').onclick = () => openEntryDrawer(c.id, null);

  renderEntryStack(c.id);
  renderActionRail(c.id);
}

function renderEntryStack(containerId) {
  const stack = document.getElementById('entry-stack');
  if (!stack) return;
  stack.innerHTML = '';
  const entries = entriesOf(containerId)
    .sort((a, b) => (b.occurred_at || '').localeCompare(a.occurred_at || ''));
  if (!entries.length) {
    stack.appendChild(tmpl('tpl-empty-entries'));
    return;
  }
  for (const e of entries) stack.appendChild(renderEntryCard(e));
}

function renderEntryCard(entry) {
  const card = document.createElement('div');
  card.className = 'entry-card';
  card.onclick = () => openEntryDrawer(entry.container_id, entry.id);

  const atoms = atomsOf(entry.id);
  const counts = {
    o: atoms.filter(a => a.kind === 'observation').length,
    d: atoms.filter(a => a.kind === 'decision').length,
    a: atoms.filter(a => a.kind === 'action').length,
    u: atoms.filter(a => a.kind === 'outcome').length,
  };
  const participants = entry.participants || [];
  const kindLabel = { meeting: 'Meeting', email: 'Email', freetext: 'Freetext' }[entry.kind] || 'Entry';

  card.innerHTML = `
    <div class="entry-card-head">
      <span class="kind-badge ${entry.kind}">${kindLabel}</span>
      <span class="entry-card-when">${fmtDate(entry.occurred_at)}</span>
    </div>
    <div class="entry-card-title">${escHtml(entry.title || '(untitled)')}</div>
    ${participants.length ? `<div class="entry-card-participants">${participants.map(p => `<span class="person">${escHtml(p)}</span>`).join('')}</div>` : ''}
    <div class="entry-card-counts">
      <span class="count"><span class="glyph o">O</span>${counts.o}</span>
      <span class="count"><span class="glyph d">D</span>${counts.d}</span>
      <span class="count"><span class="glyph a">A</span>${counts.a}</span>
      <span class="count"><span class="glyph u">U</span>${counts.u}</span>
    </div>
  `;
  return card;
}

function renderActionRail(containerId) {
  const list = document.getElementById('rail-list');
  const counters = document.getElementById('rail-counters');
  if (!list) return;

  const open = openActionsOf(containerId).sort((a, b) => {
    const ao = isOverdue(a), bo = isOverdue(b);
    if (ao !== bo) return ao ? -1 : 1;
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
  const overdueCount = open.filter(isOverdue).length;
  counters.innerHTML = !open.length
    ? '<span>0 open</span>'
    : `<span>${open.length} open</span>${overdueCount ? ` · <span class="overdue">${overdueCount} overdue</span>` : ''}`;

  list.innerHTML = '';
  if (!open.length) { list.appendChild(tmpl('tpl-empty-rail')); return; }
  for (const a of open) list.appendChild(renderRailItem(a));
}

function renderRailItem(action) {
  const div = document.createElement('div');
  const overdue = isOverdue(action);
  div.className = 'rail-item' + (overdue ? ' overdue' : '');
  div.innerHTML = `
    <div class="rail-item-line1">
      <span class="assignee">${escHtml(action.assigned_to || '(unassigned)')}</span>
      <span class="due${overdue ? ' overdue' : ''}">${action.due_date ? fmtDate(action.due_date) : ''}</span>
    </div>
    <div class="rail-item-body">${escHtml(action.body)}</div>
    <div class="rail-item-tools">
      <button class="btn tiny" data-act="open-source">Open entry</button>
      <button class="btn tiny primary" data-act="close-action">Close…</button>
    </div>
  `;
  const entry = state.entries.find(e => e.id === action.entry_id);
  div.querySelector('[data-act="open-source"]').onclick = (ev) => {
    ev.stopPropagation();
    if (entry) openEntryDrawer(entry.container_id, entry.id, action.id);
  };
  div.querySelector('[data-act="close-action"]').onclick = (ev) => {
    ev.stopPropagation();
    openCloseActionModal(action);
  };
  return div;
}

// ---------- Drawer (entry detail / composer) -----------------------

function openEntryDrawer(containerId, entryId, scrollToAtomId = null) {
  const drawer = document.getElementById('drawer');
  const shroud = document.getElementById('drawer-shroud');
  drawer.hidden = false;
  shroud.hidden = false;
  requestAnimationFrame(() => {
    drawer.classList.add('open');
    shroud.classList.add('open');
  });
  shroud.onclick = () => closeDrawer();

  if (!entryId) {
    const e = {
      id: uid(),
      container_id: containerId,
      kind: 'meeting',
      occurred_at: nowIso(),
      title: '',
      participants: [],
      tags: [],
      notes: '',
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    state.entries.push(e);
    entryId = e.id;
    scheduleSave();
  }
  currentDrawerEntryId = entryId;
  renderDrawerInner(entryId);

  if (scrollToAtomId) {
    requestAnimationFrame(() => {
      const target = drawer.querySelector(`[data-atom-id="${scrollToAtomId}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  } else {
    requestAnimationFrame(() => {
      const titleField = drawer.querySelector('.entry-title-input');
      if (titleField && !titleField.value) titleField.focus();
    });
  }
}

function closeDrawer(silent = false) {
  const drawer = document.getElementById('drawer');
  const shroud = document.getElementById('drawer-shroud');
  if (!drawer || drawer.hidden) return;
  drawer.classList.remove('open');
  shroud.classList.remove('open');
  setTimeout(() => {
    drawer.hidden = true;
    shroud.hidden = true;
    drawer.innerHTML = '';
  }, 240);
  currentDrawerEntryId = null;

  if (silent) return;
  // Reflect any drawer-side changes in the underlying view.
  const r = currentRoute();
  if (r.kind === 'container') {
    renderEntryStack(r.id);
    renderActionRail(r.id);
  } else if (r.kind === 'home') {
    renderHomeBody();
    renderRecent();
    renderHomeTagChips();
  }
}

function renderDrawerInner(entryId) {
  const drawer = document.getElementById('drawer');
  const e = state.entries.find(en => en.id === entryId);
  if (!e) { closeDrawer(); return; }

  const kindLabel = { meeting: 'Meeting', email: 'Email', freetext: 'Freetext' };

  drawer.innerHTML = `
    <div class="drawer-inner">
      <div class="drawer-head">
        <div class="drawer-head-meta">${kindLabel[e.kind] || 'Entry'} · ${fmtDate(e.occurred_at)}</div>
        <button class="drawer-close" aria-label="Close">×</button>
      </div>

      <input class="entry-title-input" data-field="title" placeholder="Untitled entry"
             value="${escHtml(e.title || '')}" />

      <div class="entry-meta-row">
        <select data-field="kind">
          <option value="meeting"  ${e.kind === 'meeting'  ? 'selected' : ''}>Meeting</option>
          <option value="email"    ${e.kind === 'email'    ? 'selected' : ''}>Email</option>
          <option value="freetext" ${e.kind === 'freetext' ? 'selected' : ''}>Freetext</option>
        </select>
        <input type="datetime-local" data-field="occurred_at" value="${escHtml(isoToLocal(e.occurred_at))}" />
        <button class="btn ghost tiny" data-act="delete-entry" title="Delete this entry">Delete entry</button>
      </div>

      <label class="field">
        <span class="label">Participants</span>
        <div class="chips-input" data-chips="participants"></div>
      </label>

      <label class="field">
        <span class="label">Tags</span>
        <div class="chips-input" data-chips="tags"></div>
      </label>

      <label class="field">
        <span class="label">Notes</span>
        <textarea data-field="notes" placeholder="Optional preamble — context for this entry as a whole.">${escHtml(e.notes || '')}</textarea>
      </label>

      ${renderAtomSection('observation', 'Observations', 'O', 'o', entryId)}
      ${renderAtomSection('decision',    'Decisions',    'D', 'd', entryId)}
      ${renderAtomSection('action',      'Actions',      'A', 'a', entryId)}
      ${renderAtomSection('outcome',     'Outcomes',     'U', 'u', entryId)}
    </div>
  `;

  wireDrawerEntryFields(entryId);
  wireChipsInput(entryId, 'participants');
  wireChipsInput(entryId, 'tags');
  wireAtomSections(entryId);

  drawer.querySelector('.drawer-close').onclick = () => closeDrawer();
  drawer.querySelector('[data-act="delete-entry"]').onclick = () => {
    if (!confirm('Delete this entry and all of its atoms?')) return;
    state.atoms = state.atoms.filter(a => a.entry_id !== entryId);
    state.entries = state.entries.filter(en => en.id !== entryId);
    scheduleSave();
    closeDrawer();
  };
}

function wireDrawerEntryFields(entryId) {
  const drawer = document.getElementById('drawer');
  const e = state.entries.find(en => en.id === entryId);
  if (!e) return;

  const refreshMeta = () => {
    const meta = drawer.querySelector('.drawer-head-meta');
    if (meta) meta.textContent = `${({meeting:'Meeting',email:'Email',freetext:'Freetext'}[e.kind])} · ${fmtDate(e.occurred_at)}`;
  };

  drawer.querySelector('[data-field="title"]').addEventListener('input', (ev) => {
    e.title = ev.target.value;
    e.updated_at = nowIso();
    scheduleSave();
  });
  drawer.querySelector('[data-field="kind"]').onchange = (ev) => {
    e.kind = ev.target.value;
    e.updated_at = nowIso();
    scheduleSave();
    refreshMeta();
  };
  drawer.querySelector('[data-field="occurred_at"]').onchange = (ev) => {
    const iso = localToIso(ev.target.value);
    if (iso) e.occurred_at = iso;
    e.updated_at = nowIso();
    scheduleSave();
    refreshMeta();
  };
  drawer.querySelector('[data-field="notes"]').addEventListener('input', (ev) => {
    e.notes = ev.target.value;
    e.updated_at = nowIso();
    scheduleSave();
  });
}

function wireChipsInput(entryId, field) {
  const drawer = document.getElementById('drawer');
  const wrap = drawer.querySelector(`[data-chips="${field}"]`);
  const e = state.entries.find(en => en.id === entryId);
  if (!wrap || !e) return;

  const suggestions = field === 'participants' ? allParticipants() : allTags();
  const datalistId = `dl-${field}`;

  function refresh() {
    wrap.innerHTML = '';
    const vals = e[field] || [];
    for (const v of vals) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `${escHtml(field === 'tags' ? '#' + v : v)} <button type="button" aria-label="Remove">×</button>`;
      chip.querySelector('button').onclick = () => {
        e[field] = vals.filter(x => x !== v);
        e.updated_at = nowIso();
        scheduleSave();
        refresh();
      };
      wrap.appendChild(chip);
    }
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = field === 'tags' ? 'add tag…' : 'add person…';
    inp.setAttribute('list', datalistId);
    inp.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ',') {
        ev.preventDefault();
        const v = inp.value.trim().replace(/^#/, '');
        const list = e[field] || [];
        if (v && !list.includes(v)) {
          e[field] = [...list, v];
          e.updated_at = nowIso();
          scheduleSave();
          refresh();
        } else {
          inp.value = '';
        }
      } else if (ev.key === 'Backspace' && inp.value === '' && (e[field] || []).length) {
        e[field] = (e[field] || []).slice(0, -1);
        e.updated_at = nowIso();
        scheduleSave();
        refresh();
      }
    };
    wrap.appendChild(inp);

    if (!document.getElementById(datalistId)) {
      const dl = document.createElement('datalist');
      dl.id = datalistId;
      document.body.appendChild(dl);
    }
    const dl = document.getElementById(datalistId);
    dl.innerHTML = suggestions.map(s => `<option value="${escHtml(s)}"></option>`).join('');
  }
  refresh();
}

// ---------- Atom sections ------------------------------------------

function renderAtomSection(kind, label, glyph, glyphCls, entryId) {
  const atoms = atomsOf(entryId).filter(a => a.kind === kind);
  return `
    <section class="atom-section" data-section="${kind}">
      <div class="atom-section-head">
        <span class="section-glyph glyph ${glyphCls}">${glyph}</span>
        <h3>${label}</h3>
        <span class="count">${atoms.length}</span>
      </div>
      <div class="atom-list" data-atom-list="${kind}">
        ${atoms.map(renderAtomItem).join('')}
      </div>
      <div class="atom-add-row ${glyphCls}" data-add-kind="${kind}">
        <input type="text" placeholder="Add a ${singular(label).toLowerCase()}…" data-add-body />
        <button type="button" class="btn tiny" data-add-submit>Add</button>
      </div>
    </section>
  `;
}

function singular(label) {
  // "Observations" → "Observation"
  if (label.endsWith('s')) return label.slice(0, -1);
  return label;
}

function renderAtomItem(atom) {
  const cls = { observation: 'o', decision: 'd', action: 'a', outcome: 'u' }[atom.kind];
  let metaHtml = '';
  if (atom.kind === 'action') {
    const overdue = isOverdue(atom);
    metaHtml = `
      <div class="atom-meta">
        <input type="text" data-action-field="assigned_to" placeholder="assigned to…"
               value="${escHtml(atom.assigned_to || '')}" list="dl-participants" />
        <input type="date" data-action-field="due_date" value="${escHtml(atom.due_date || '')}" />
        ${overdue ? '<span class="due overdue">overdue</span>' : ''}
      </div>
    `;
  } else if (atom.kind === 'outcome') {
    metaHtml = `
      <div class="atom-meta">
        <select data-outcome-field="parent_atom_id" data-current-parent="${escHtml(atom.parent_atom_id || '')}">
          <!-- options injected on wire -->
        </select>
      </div>
    `;
  }
  return `
    <div class="atom-item ${cls}" data-atom-id="${atom.id}">
      <div class="rail"></div>
      <textarea class="atom-body" data-atom-body rows="1">${escHtml(atom.body)}</textarea>
      <div class="tools"><button class="btn ghost tiny" data-atom-delete title="Delete">×</button></div>
      ${metaHtml}
    </div>
  `;
}

function wireAtomSections(entryId) {
  const drawer = document.getElementById('drawer');
  drawer.querySelectorAll('.atom-item').forEach(item => wireAtomItem(item, entryId));

  drawer.querySelectorAll('.atom-add-row').forEach(row => {
    const kind = row.dataset.addKind;
    const input = row.querySelector('[data-add-body]');
    const submit = row.querySelector('[data-add-submit]');
    const add = () => {
      const body = input.value.trim();
      if (!body) return;
      const newAtom = {
        id: uid(),
        entry_id: entryId,
        kind,
        body,
        tags: [],
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      if (kind === 'action') {
        newAtom.assigned_to = '';
        newAtom.due_date = '';
      } else if (kind === 'outcome') {
        newAtom.parent_atom_id = null;
      }
      state.atoms.push(newAtom);
      scheduleSave();
      input.value = '';
      renderDrawerInner(entryId);
      const newRow = document.querySelector(`[data-atom-id="${newAtom.id}"]`);
      if (newRow) newRow.querySelector('[data-atom-body]')?.focus();
    };
    input.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } };
    submit.onclick = add;
  });
}

function wireAtomItem(item, entryId) {
  const id = item.dataset.atomId;
  const atom = state.atoms.find(a => a.id === id);
  if (!atom) return;

  const body = item.querySelector('[data-atom-body]');
  const autoresize = () => {
    body.style.height = 'auto';
    body.style.height = body.scrollHeight + 'px';
  };
  autoresize();
  body.addEventListener('input', () => {
    atom.body = body.value;
    atom.updated_at = nowIso();
    autoresize();
    scheduleSave();
  });

  item.querySelector('[data-atom-delete]')?.addEventListener('click', () => {
    state.atoms = state.atoms.filter(a => a.id !== id);
    scheduleSave();
    renderDrawerInner(entryId);
  });

  if (atom.kind === 'action') {
    item.querySelector('[data-action-field="assigned_to"]')?.addEventListener('input', (ev) => {
      atom.assigned_to = ev.target.value;
      atom.updated_at = nowIso();
      scheduleSave();
    });
    item.querySelector('[data-action-field="due_date"]')?.addEventListener('change', (ev) => {
      atom.due_date = ev.target.value;
      atom.updated_at = nowIso();
      scheduleSave();
      renderDrawerInner(entryId);
    });
  } else if (atom.kind === 'outcome') {
    const sel = item.querySelector('[data-outcome-field="parent_atom_id"]');
    if (sel) {
      const e = state.entries.find(en => en.id === entryId);
      const containerId = e?.container_id;
      const parents = atomsOfContainer(containerId).filter(a => a.kind === 'action' || a.kind === 'decision');
      const current = atom.parent_atom_id || '';
      sel.innerHTML = `<option value="">— no parent —</option>` + parents.map(p => {
        const label = `[${p.kind[0].toUpperCase()}] ${(p.body || '').slice(0, 80)}`;
        return `<option value="${escHtml(p.id)}" ${p.id === current ? 'selected' : ''}>${escHtml(label)}</option>`;
      }).join('');
      sel.onchange = (ev) => {
        atom.parent_atom_id = ev.target.value || null;
        atom.updated_at = nowIso();
        scheduleSave();
      };
    }
  }
}

// ---------- Modals -------------------------------------------------

function openModal(html, wireFn) {
  const shroud = document.getElementById('modal-shroud');
  const modal = document.getElementById('modal');
  modal.innerHTML = html;
  shroud.hidden = false;
  shroud.onclick = (ev) => { if (ev.target === shroud) closeModal(); };
  document.addEventListener('keydown', escapeModal);
  wireFn?.(modal);
}

function closeModal() {
  document.getElementById('modal-shroud').hidden = true;
  document.removeEventListener('keydown', escapeModal);
}

function escapeModal(ev) { if (ev.key === 'Escape') closeModal(); }

function openNewContainerModal(type) {
  const typeLabel = type === 'project' ? 'project' : 'reference file';
  const goalLabel = type === 'project' ? 'Goal' : 'Purpose';
  const goalHint  = type === 'project'
    ? 'What does done look like?'
    : 'What is this file for?';
  openModal(`
    <h2>New ${typeLabel}</h2>
    <label class="field">
      <span class="label">Title</span>
      <input type="text" id="m-title" autofocus />
    </label>
    <label class="field">
      <span class="label">${goalLabel}</span>
      <input type="text" id="m-goal" placeholder="${escHtml(goalHint)}" />
    </label>
    <label class="field">
      <span class="label">Summary (optional)</span>
      <textarea id="m-summary" placeholder="Longer context — read on demand from the project header."></textarea>
    </label>
    <div class="modal-actions">
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="create">Create</button>
    </div>
  `, (modal) => {
    modal.querySelector('[data-act="cancel"]').onclick = closeModal;
    modal.querySelector('[data-act="create"]').onclick = () => {
      const title = modal.querySelector('#m-title').value.trim();
      if (!title) { modal.querySelector('#m-title').focus(); return; }
      const goal = modal.querySelector('#m-goal').value.trim();
      const summary = modal.querySelector('#m-summary').value.trim();
      const id = uniqueSlug(slugify(title));
      const c = {
        id, type, title, goal_or_purpose: goal, summary,
        tags: [], status: 'active',
        created_at: nowIso(), updated_at: nowIso(),
      };
      state.containers.push(c);
      scheduleSave();
      closeModal();
      location.hash = `#/c/${encodeURIComponent(id)}`;
    };
  });
}

function openEditContainerModal(c) {
  const typeLabel = c.type === 'project' ? 'project' : 'reference file';
  const goalLabel = c.type === 'project' ? 'Goal' : 'Purpose';
  openModal(`
    <h2>Edit ${typeLabel}</h2>
    <label class="field">
      <span class="label">Title</span>
      <input type="text" id="m-title" value="${escHtml(c.title)}" />
    </label>
    <label class="field">
      <span class="label">${goalLabel}</span>
      <input type="text" id="m-goal" value="${escHtml(c.goal_or_purpose || '')}" />
    </label>
    <label class="field">
      <span class="label">Summary</span>
      <textarea id="m-summary">${escHtml(c.summary || '')}</textarea>
    </label>
    <label class="field">
      <span class="label">Tags</span>
      <div class="chips-input" id="m-tags"></div>
    </label>
    <div class="modal-actions">
      <button class="btn danger" data-act="archive">${c.status === 'archived' ? 'Unarchive' : 'Archive'}</button>
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="save">Save</button>
    </div>
  `, (modal) => {
    const chipsWrap = modal.querySelector('#m-tags');
    const draftTags = [...(c.tags || [])];
    function refreshChips() {
      chipsWrap.innerHTML = '';
      for (const t of draftTags) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = `#${escHtml(t)} <button type="button">×</button>`;
        chip.querySelector('button').onclick = () => {
          const idx = draftTags.indexOf(t);
          if (idx >= 0) draftTags.splice(idx, 1);
          refreshChips();
        };
        chipsWrap.appendChild(chip);
      }
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = 'add tag…';
      inp.setAttribute('list', 'dl-tags');
      inp.onkeydown = (ev) => {
        if (ev.key === 'Enter' || ev.key === ',') {
          ev.preventDefault();
          const v = inp.value.trim().replace(/^#/, '');
          if (v && !draftTags.includes(v)) draftTags.push(v);
          inp.value = '';
          refreshChips();
        }
      };
      chipsWrap.appendChild(inp);
      if (!document.getElementById('dl-tags')) {
        const dl = document.createElement('datalist');
        dl.id = 'dl-tags';
        document.body.appendChild(dl);
      }
      document.getElementById('dl-tags').innerHTML =
        allTags().map(t => `<option value="${escHtml(t)}"></option>`).join('');
    }
    refreshChips();

    modal.querySelector('[data-act="cancel"]').onclick = closeModal;
    modal.querySelector('[data-act="archive"]').onclick = () => {
      c.status = c.status === 'archived' ? 'active' : 'archived';
      c.updated_at = nowIso();
      scheduleSave();
      closeModal();
      if (c.status === 'archived') location.hash = '#/';
      else render();
    };
    modal.querySelector('[data-act="save"]').onclick = () => {
      c.title = modal.querySelector('#m-title').value.trim() || c.title;
      c.goal_or_purpose = modal.querySelector('#m-goal').value.trim();
      c.summary = modal.querySelector('#m-summary').value.trim();
      c.tags = draftTags;
      c.updated_at = nowIso();
      scheduleSave();
      closeModal();
      render();
    };
  });
}

function openCloseActionModal(action) {
  const entry = state.entries.find(e => e.id === action.entry_id);
  const containerId = entry?.container_id;
  const containerEntries = entriesOf(containerId)
    .sort((a, b) => (b.occurred_at || '').localeCompare(a.occurred_at || ''));

  openModal(`
    <h2>Close this action</h2>
    <p class="muted small">
      "${escHtml(action.body)}"${action.assigned_to ? `<br/>assigned to ${escHtml(action.assigned_to)}` : ''}
    </p>
    <label class="field">
      <span class="label">Outcome — what actually happened?</span>
      <textarea id="m-outcome" autofocus></textarea>
    </label>
    <label class="field">
      <span class="label">File this outcome in</span>
      <select id="m-attach">
        <option value="__new__">— New freetext entry, dated today —</option>
        ${containerEntries.map(e =>
          `<option value="${escHtml(e.id)}">${escHtml(e.title || '(untitled)')} · ${fmtDate(e.occurred_at)}</option>`
        ).join('')}
      </select>
    </label>
    <div class="modal-actions">
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="close-action">Record outcome</button>
    </div>
  `, (modal) => {
    modal.querySelector('[data-act="cancel"]').onclick = closeModal;
    modal.querySelector('[data-act="close-action"]').onclick = () => {
      const body = modal.querySelector('#m-outcome').value.trim();
      if (!body) { modal.querySelector('#m-outcome').focus(); return; }
      let targetEntryId = modal.querySelector('#m-attach').value;
      if (targetEntryId === '__new__') {
        const newEntry = {
          id: uid(),
          container_id: containerId,
          kind: 'freetext',
          occurred_at: nowIso(),
          title: 'Closure',
          participants: [],
          tags: [],
          notes: '',
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        state.entries.push(newEntry);
        targetEntryId = newEntry.id;
      }
      const outcome = {
        id: uid(),
        entry_id: targetEntryId,
        kind: 'outcome',
        body,
        tags: [],
        parent_atom_id: action.id,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      state.atoms.push(outcome);
      scheduleSave();
      closeModal();
      const r = currentRoute();
      if (r.kind === 'container') {
        renderEntryStack(r.id);
        renderActionRail(r.id);
      }
    };
  });
}

// ---------- Boot ---------------------------------------------------

(async function boot() {
  await loadState();
  render();
})();
