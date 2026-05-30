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

// Dashboard view state (home toggle + per-person/per-project tab selections).
const ui = { homeView: 'projects', personId: null, personTab: 'actions', projectTab: 'overview' };

// ---------- State + persistence ------------------------------------

function emptyState() {
  return { schema_version: 2, containers: [], entries: [], atoms: [], people_meta: {} };
}

// Tolerate v1 docs (no people_meta, no v2 container fields). Unknown keys are
// preserved on save by the backend; here we just guarantee the shapes we read.
function normalizeState(d) {
  return {
    ...(d && typeof d === 'object' ? d : {}),
    schema_version: 2,
    containers: Array.isArray(d?.containers) ? d.containers : [],
    entries:    Array.isArray(d?.entries)    ? d.entries    : [],
    atoms:      Array.isArray(d?.atoms)      ? d.atoms      : [],
    people_meta: d?.people_meta && typeof d.people_meta === 'object' ? d.people_meta : {},
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

// ---------- Container type metadata --------------------------------

const INBOX_ID = 'inbox';

// Lookup so each new container type adds one row here, not N ternaries.
const CONTAINER_LABELS = {
  project:        { full: 'Project',        short: 'Project',   cls: 'project'   },
  reference_file: { full: 'Reference File', short: 'Reference', cls: 'reference' },
  inbox:          { full: 'Inbox',          short: 'Inbox',     cls: 'inbox'     },
};
const containerLabel   = (c, form = 'full') => CONTAINER_LABELS[c?.type]?.[form] || 'Project';
const containerTypeCls = (c) => CONTAINER_LABELS[c?.type]?.cls || 'project';

function getOrCreateInbox() {
  let inbox = state.containers.find(c => c.id === INBOX_ID);
  if (inbox) return inbox;
  inbox = {
    id: INBOX_ID,
    type: 'inbox',
    title: 'Inbox',
    goal_or_purpose: '',
    summary: '',
    tags: [],
    status: 'active',
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  state.containers.push(inbox);
  scheduleSave();
  return inbox;
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

// First outcome atom (if any) that closes this action.
function outcomeForAction(actionId) {
  return state.atoms.find(a => a.kind === 'outcome' && a.parent_atom_id === actionId) || null;
}

function isOverdue(action) {
  if (!action.due_date) return false;
  if (action.kind === 'action' && outcomeForAction(action.id)) return false;
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

// ---------- Dashboard helpers --------------------------------------

const TONE = {
  g: { t: '#1a5c3a', b: '#d6ead8' }, // moss — on track
  a: { t: '#b8860b', b: '#fff3cd' }, // amber — watch
  r: { t: '#8b1a1a', b: '#fdecea' }, // rust — behind
};
function toneFor(v, lo = 40, hi = 70) { return v >= hi ? TONE.g : v >= lo ? TONE.a : TONE.r; }

// A stable fallback color for projects with no `color` set, keyed off the id so
// it doesn't flicker between renders.
const TILE_PALETTE = ['#2e7dbd', '#00788a', '#5a7a5e', '#6b5b9e', '#b05a2a', '#c8442a', '#2D6A4F', '#1565C0'];
function projectColor(c) {
  if (c?.color) return c.color;
  let h = 0;
  for (const ch of (c?.id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_PALETTE[h % TILE_PALETTE.length];
}

const projects     = () => state.containers.filter(c => c.type === 'project' && c.status !== 'archived');
const referenceFiles = () => state.containers.filter(c => c.type === 'reference_file' && c.status !== 'archived');

// Completion: explicit field if set, else a light derived proxy (share of
// actions closed) so a fresh project still shows a meaningful bar.
function completionOf(c) {
  if (typeof c.completion === 'number') return Math.max(0, Math.min(100, c.completion));
  const atoms = atomsOfContainer(c.id);
  const actions = atoms.filter(a => a.kind === 'action');
  if (!actions.length) return 0;
  const closed = actions.filter(a => outcomeForAction(a.id)).length;
  return Math.round((closed / actions.length) * 100);
}

function lastEntryDate(cid) {
  const lt = lastTouchedOf(cid);
  return lt ? fmtDate(lt) : null;
}

function miniBar(progress, color, h = 4) {
  return `<div class="minibar" style="height:${h}px"><span style="width:${Math.min(progress, 100)}%;background:${color}"></span></div>`;
}

function smoothPath(pts) {
  if (!pts.length) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const cx = ((x0 + x1) / 2).toFixed(1);
    d += ` C${cx},${y0.toFixed(1)} ${cx},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

// Glidepath SVG, driven by container.metrics. Each metric:
//   { label, target, color, data:number[], interventions:[{idx,label}] }
// Returns '' when there is nothing to plot (caller shows a placeholder).
function renderGlidepath(metrics) {
  const series = (metrics || []).filter(m => Array.isArray(m.data) && m.data.length >= 2);
  if (!series.length) return '';
  const MU = '#5a6070', BO = '#d8d3c8';
  const n = Math.max(...series.map(m => m.data.length));
  const W = 520, H = 196, PL = 42, PT = 34, PR = 16, PB = 30;
  const IW = W - PL - PR, IH = H - PT - PB;
  const xAt = i => PL + (n === 1 ? 0 : i * (IW / (n - 1)));
  const yAt = v => PT + IH - (Math.min(Math.max(v, 0), 110) / 100) * IH;
  const pts = data => data.map((v, i) => [xAt(i), yAt(v)]);

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">`;
  [0, 25, 50, 75, 100].forEach(v => {
    svg += `<line x1="${PL}" y1="${yAt(v).toFixed(1)}" x2="${W - PR}" y2="${yAt(v).toFixed(1)}" stroke="${v === 0 ? BO : '#ede9e2'}" stroke-width="${v === 0 ? 1 : 0.5}"/>`;
    svg += `<text x="${PL - 5}" y="${(yAt(v) + 4).toFixed(1)}" text-anchor="end" font-size="9" fill="${MU}">${v}%</text>`;
  });
  series.forEach((m, mi) => {
    const color = m.color || projectColorFallback(mi);
    const p = pts(m.data);
    const main = mi === 0;
    if (typeof m.target === 'number') {
      svg += `<line x1="${PL}" y1="${yAt(m.target).toFixed(1)}" x2="${W - PR}" y2="${yAt(m.target).toFixed(1)}" stroke="${color}" stroke-width="0.9" stroke-dasharray="5,3" opacity="0.4"/>`;
    }
    svg += `<path d="${smoothPath(p)}" fill="none" stroke="${color}" stroke-width="${main ? 2.5 : 1.5}" stroke-linecap="round" stroke-linejoin="round"/>`;
    p.forEach(([x, y]) => { svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${main ? 3 : 2}" fill="${color}"/>`; });
    (m.interventions || []).forEach(iv => {
      if (iv.idx == null || iv.idx >= m.data.length) return;
      const x = xAt(iv.idx), y = yAt(m.data[iv.idx]);
      svg += `<line x1="${x.toFixed(1)}" y1="${PT}" x2="${x.toFixed(1)}" y2="${(PT + IH).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="3,2" opacity="0.4"/>`;
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="${color}"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#fff"/>`;
      svg += `<text x="${x.toFixed(1)}" y="16" text-anchor="middle" font-size="8.5" fill="${color}" font-weight="700">${escHtml(iv.label || '')}</text>`;
    });
    svg += `<g transform="translate(${PL + mi * 200},${H - 16})"><line x1="0" y1="0" x2="14" y2="0" stroke="${color}" stroke-width="${main ? 2.5 : 1.5}"/><text x="18" y="4" font-size="9" fill="${MU}">${escHtml(m.label || 'metric')}${typeof m.target === 'number' ? ` — target ${m.target}%` : ''}</text></g>`;
  });
  svg += '</svg>';
  return svg;
}
function projectColorFallback(i) { return TILE_PALETTE[i % TILE_PALETTE.length]; }

// People are derived from atom assignees. Each person: their open + overdue
// actions across all containers, and the projects they touch. Optional stored
// overlay at state.people_meta[name] adds title / color / pathways / reports.
function derivePeople() {
  const byName = new Map();
  const ensure = (name) => {
    if (!byName.has(name)) byName.set(name, { name, actions: [], projectIds: new Set() });
    return byName.get(name);
  };
  for (const c of state.containers) {
    if (c.status === 'archived') continue;
    for (const a of openActionsOf(c.id)) {
      const who = (a.assigned_to || '').trim();
      if (!who) continue;
      const person = ensure(who);
      person.actions.push({ atom: a, container: c, overdue: isOverdue(a) });
      person.projectIds.add(c.id);
    }
  }
  const people = [...byName.values()].map(p => {
    const meta = state.people_meta?.[p.name] || {};
    return {
      ...p,
      projectIds: [...p.projectIds],
      title: meta.title || '',
      color: meta.color || stringColor(p.name),
      pathways: Array.isArray(meta.pathways) ? meta.pathways : [],
      reports: Array.isArray(meta.reports) ? meta.reports : [],
      overdueCount: p.actions.filter(a => a.overdue).length,
    };
  });
  people.sort((a, b) => b.overdueCount - a.overdueCount || b.actions.length - a.actions.length || a.name.localeCompare(b.name));
  return people;
}

function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}
function stringColor(s) {
  let h = 0;
  for (const ch of (s || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_PALETTE[h % TILE_PALETTE.length];
}

function dashboardSummary() {
  const ps = projects();
  let open = 0, overdue = 0;
  for (const c of state.containers) {
    if (c.status === 'archived') continue;
    const o = openActionsOf(c.id);
    open += o.length;
    overdue += o.filter(isOverdue).length;
  }
  const nexts = ps.map(c => c.next_meeting).filter(Boolean).sort();
  return { projectCount: ps.length, open, overdue, nextMeeting: nexts[0] || null };
}

// ---------- Routing -------------------------------------------------

function currentRoute() {
  const h = location.hash.replace(/^#/, '');
  if (!h || h === '/') return { kind: 'home', view: 'projects' };
  if (h === '/people') return { kind: 'home', view: 'people' };
  const m = h.match(/^\/c\/(.+)$/);
  if (m) return { kind: 'container', id: decodeURIComponent(m[1]) };
  return { kind: 'home', view: 'projects' };
}

window.addEventListener('hashchange', () => { closeDrawer(true); render(); });

// ---------- Render dispatcher --------------------------------------

function render() {
  const main = document.getElementById('main');
  main.innerHTML = '';
  const r = currentRoute();
  if (r.kind === 'home') {
    if (r.view) ui.homeView = r.view;
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
  main.querySelector('[data-act="new-adhoc"]').onclick =
    () => openAdHocEntryDrawer();
  main.querySelector('[data-act="import-file"]').onclick =
    () => openFileImport();

  // Drag-and-drop a Markdown/text file anywhere on the dashboard → ingest it.
  const section = main.querySelector('.home');
  section.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    section.classList.add('drag-over');
  });
  section.addEventListener('dragleave', (ev) => {
    if (ev.target === section) section.classList.remove('drag-over');
  });
  section.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer?.files?.length) return;
    ev.preventDefault();
    section.classList.remove('drag-over');
    const f = [...ev.dataTransfer.files].find(
      f => /\.(md|markdown|txt|text)$/i.test(f.name) || /^text\//.test(f.type)
    );
    if (f) importTextFile(f);
    else alert('Drop a Markdown or text file (.md / .txt).');
  });

  renderHomeSub();
  wireViewToggle();
  renderHomeView();
}

// The dark-header sub line: "N projects · X open · Y overdue · next <date>".
function renderHomeSub() {
  const el = document.getElementById('home-sub');
  if (!el) return;
  const s = dashboardSummary();
  const parts = [
    `${s.projectCount} ${s.projectCount === 1 ? 'project' : 'projects'}`,
    `${s.open} open`,
  ];
  if (s.overdue) parts.push(`<span class="hdr-warn">${s.overdue} overdue</span>`);
  if (s.nextMeeting) parts.push(`next ${fmtDate(s.nextMeeting)}`);
  el.innerHTML = parts.join(' · ');
}

function wireViewToggle() {
  const wrap = document.getElementById('home-view-toggle');
  if (!wrap) return;
  wrap.querySelectorAll('.vtbtn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === ui.homeView);
    btn.onclick = () => { location.hash = btn.dataset.view === 'people' ? '#/people' : '#/'; };
  });
}

function renderHomeView() {
  const body = document.getElementById('home-view-body');
  if (!body) return;
  body.innerHTML = '';
  if (ui.homeView === 'people') { renderPeopleView(body); return; }
  renderHomeProjects(body);
}

function renderHomeProjects(body) {
  body.appendChild(tmpl('tpl-home-projects'));
  const search = document.getElementById('home-search');
  search.value = homeFilters.search;
  search.oninput = () => {
    homeFilters.search = search.value.toLowerCase();
    renderProjectGrid();
    renderHomeBody();
  };
  renderHomeTagChips();
  renderProjectGrid();
  renderHomeBody();
  renderRecent();
}

function renderProjectGrid() {
  const grid = document.getElementById('project-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const items = filterContainers('project').sort((a, b) => {
    const ta = lastTouchedOf(a.id) || a.created_at || '';
    const tb = lastTouchedOf(b.id) || b.created_at || '';
    return tb.localeCompare(ta);
  });
  if (!items.length) {
    grid.innerHTML = `<div class="empty muted tile-empty">No projects yet. Click <strong>New project</strong> to start one.</div>`;
    return;
  }
  for (const c of items) grid.appendChild(renderProjectTile(c));
}

function renderProjectTile(c) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.style.background = projectColor(c);
  tile.onclick = () => { location.hash = `#/c/${encodeURIComponent(c.id)}`; };

  const open = openActionsOf(c.id);
  const overdue = open.filter(isOverdue).length;
  const pct = completionOf(c);
  const status = c.summary || c.goal_or_purpose || '';
  const last = lastEntryDate(c.id);

  tile.innerHTML = `
    <div class="tile-top">
      <span class="tile-emoji">${escHtml(c.emoji || '📁')}</span>
      <div class="tile-pct"><div class="tile-pct-num">${pct}%</div><div class="tile-pct-lbl">complete</div></div>
    </div>
    <div class="tile-title">${escHtml(c.title)}</div>
    <div class="tile-status">${escHtml(status)}</div>
    <div class="tile-bottom">
      <span class="tile-cat">${escHtml(c.category || 'Project')}</span>
      <span class="tile-open ${open.length ? 'has' : ''}">${open.length ? open.length + ' open' + (overdue ? ' · ' + overdue + ' overdue' : '') : '✓ clear'}</span>
    </div>
    <div class="tile-prog-wrap"><div class="tile-prog-fill" style="width:${pct}%"></div></div>
    <div class="tile-dates">${c.next_meeting ? 'Next: ' + fmtDate(c.next_meeting) : 'No meeting scheduled'}${last ? ' · Last: ' + last : ''}</div>
  `;
  return tile;
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

function filterContainers(type = null) {
  const q = homeFilters.search;
  const tags = homeFilters.activeTags;
  return state.containers.filter(c => {
    if (c.type === 'inbox') return false; // Inbox lives in its own pinned row.
    if (type && c.type !== type) return false;
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

// The secondary list under the project grid: pinned Inbox row + reference
// files (projects live in the tile grid above).
function renderHomeBody() {
  const list = document.getElementById('container-list');
  if (!list) return;
  list.innerHTML = '';

  list.appendChild(renderInboxRow());

  const items = filterContainers('reference_file').sort((a, b) => {
    const ta = lastTouchedOf(a.id) || a.created_at || '';
    const tb = lastTouchedOf(b.id) || b.created_at || '';
    return tb.localeCompare(ta);
  });
  for (const c of items) list.appendChild(renderContainerRow(c));
}

function renderInboxRow() {
  const row = document.createElement('div');
  row.className = 'container-row inbox-row';
  row.onclick = () => {
    getOrCreateInbox();
    location.hash = `#/c/${INBOX_ID}`;
  };

  const inbox = state.containers.find(c => c.id === INBOX_ID);
  if (!inbox || entriesOf(INBOX_ID).length === 0) {
    row.innerHTML = `
      <div class="container-row-left">
        <div class="container-row-title">
          <span class="type-mark inbox">Inbox</span>
          Inbox
        </div>
        <p class="container-row-tagline muted">Empty. Click <em>Ad-hoc</em> above to capture an entry.</p>
      </div>
      <div class="container-row-right">—</div>
    `;
    return row;
  }

  const count   = entriesOf(INBOX_ID).length;
  const open    = openActionsOf(INBOX_ID);
  const overdue = open.filter(isOverdue).length;
  const lt      = lastTouchedOf(INBOX_ID);

  row.innerHTML = `
    <div class="container-row-left">
      <div class="container-row-title">
        <span class="type-mark inbox">Inbox</span>
        Inbox
      </div>
      <p class="container-row-tagline">${count} ${count === 1 ? 'entry' : 'entries'} waiting to be filed</p>
      <div class="container-row-meta">
        ${open.length ? `<span class="open-pill">${open.length} open${overdue ? ' · ' + overdue + ' overdue' : ''}</span>` : ''}
      </div>
    </div>
    <div class="container-row-right">${lt ? fmtWhen(lt) : 'no activity'}</div>
  `;
  return row;
}

function renderContainerRow(c) {
  const row = document.createElement('div');
  row.className = 'container-row';
  row.onclick = () => { location.hash = `#/c/${encodeURIComponent(c.id)}`; };

  const open = openActionsOf(c.id);
  const overdue = open.filter(isOverdue).length;
  const lt = lastTouchedOf(c.id);
  const typeLabel = containerLabel(c, 'short');
  const typeCls   = containerTypeCls(c);

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

// ---------- People view (derived from atom assignees) --------------

function renderPeopleView(body) {
  const people = derivePeople();
  if (!people.length) {
    body.innerHTML = `<div class="empty muted people-empty">
      No people yet. Assign an action to someone (an action atom's <em>assigned&nbsp;to</em>
      field) and they'll appear here with their open work across every project.
    </div>`;
    return;
  }
  if (!ui.personId || !people.find(p => p.name === ui.personId)) ui.personId = people[0].name;
  const person = people.find(p => p.name === ui.personId);

  const sidebar = `<div class="people-sidebar">
    <div class="ps-hdr">People (${people.length})</div>
    ${people.map(p => `
      <div class="person-row ${p.name === ui.personId ? 'active' : ''}" data-person="${escHtml(p.name)}"
           style="${p.name === ui.personId ? `border-left:3px solid ${p.color}` : ''}">
        <div class="person-row-top">
          <div class="person-init" style="background:${p.color}">${escHtml(initials(p.name))}</div>
          <div class="person-row-id">
            <div class="person-name">${escHtml(p.name)}</div>
            <div class="person-role">${escHtml(p.title || (p.actions.length + ' open'))}</div>
          </div>
          ${p.overdueCount ? `<span class="late-badge" style="color:${TONE.r.t};background:${TONE.r.b}">${p.overdueCount} late</span>` : ''}
        </div>
        ${(p.pathways || []).map(pw => `<div class="pw-row">
          <span class="pw-label">${escHtml(pw.label)}</span>
          <span class="pw-bar">${miniBar(pw.progress, pw.color || p.color, 3)}</span>
          <span class="pw-val">${pw.progress}%</span>
        </div>`).join('')}
      </div>`).join('')}
  </div>`;

  body.innerHTML = `<div class="people-wrap">${sidebar}${renderPersonDetail(person)}</div>`;

  body.querySelectorAll('[data-person]').forEach(el => {
    el.onclick = () => { ui.personId = el.dataset.person; ui.personTab = 'actions'; renderHomeView(); };
  });
  body.querySelectorAll('[data-ptabperson]').forEach(el => {
    el.onclick = () => { ui.personTab = el.dataset.ptabperson; renderHomeView(); };
  });
  body.querySelectorAll('[data-open-entry]').forEach(el => {
    el.onclick = () => {
      const a = state.atoms.find(x => x.id === el.dataset.openEntry);
      const e = a && state.entries.find(en => en.id === a.entry_id);
      if (e) { location.hash = `#/c/${encodeURIComponent(e.container_id)}`; setTimeout(() => openEntryDrawer(e.container_id, e.id, a.id), 60); }
    };
  });
}

function renderPersonDetail(person) {
  const tab = ui.personTab || 'actions';
  const projChips = person.projectIds.map(id => getContainer(id)).filter(Boolean)
    .map(c => `<span class="proj-chip" style="background:${projectColor(c)}">${escHtml(c.emoji || '')} ${escHtml(c.title)}</span>`).join('');

  let detail = '';
  if (tab === 'actions') {
    const actions = [...person.actions].sort((a, b) => (b.overdue - a.overdue) || (a.atom.due_date || '').localeCompare(b.atom.due_date || ''));
    detail = actions.length ? actions.map(({ atom, container, overdue }) => `
      <div class="paction-row">
        <div class="paction-body">
          <div>${escHtml(atom.body)}</div>
          <div class="paction-proj">${escHtml(container.title)}</div>
        </div>
        <span class="due-badge" style="color:${overdue ? TONE.r.t : TONE.a.t};background:${overdue ? TONE.r.b : TONE.a.b}">${overdue ? '⚠ Overdue' : (atom.due_date ? 'Due ' + fmtDate(atom.due_date) : 'No date')}</span>
        <button class="btn tiny" data-open-entry="${escHtml(atom.id)}">Open</button>
      </div>`).join('') : `<div class="empty muted small">No open actions assigned.</div>`;
  } else {
    detail = (person.reports || []).length
      ? person.reports.map(r => `<div class="report-card" style="border-left:3px solid ${person.color}">
          <div class="report-top">
            <div><div class="report-name">${escHtml(r.name)}</div><div class="report-role">${escHtml(r.role || '')}</div></div>
            <span class="open-badge" style="color:${r.open > 2 ? TONE.r.t : r.open > 0 ? TONE.a.t : TONE.g.t};background:${r.open > 2 ? TONE.r.b : r.open > 0 ? TONE.a.b : TONE.g.b}">${r.open || 0} open</span>
          </div>
          ${miniBar(r.progress || 0, person.color)}
          <div class="report-pct">${r.progress || 0}% overall</div>
        </div>`).join('')
      : `<div class="empty muted small">No direct reports recorded for ${escHtml(person.name)}.
         Reports are optional metadata — add them under <code>people_meta</code> when useful.</div>`;
  }

  return `<div class="person-detail">
    <div class="pd-hdr">
      <div class="pd-init" style="background:${person.color}">${escHtml(initials(person.name))}</div>
      <div class="pd-id">
        <div class="pd-name">${escHtml(person.name)}</div>
        <div class="pd-title">${escHtml(person.title || 'Assignee')}</div>
        ${(person.pathways || []).map(pw => `<div class="pd-pathway">
          <span class="pd-pw-label">${escHtml(pw.label)}</span>
          <span class="pd-pw-bar">${miniBar(pw.progress, pw.color || person.color)}</span>
          <span class="pd-pw-val" style="color:${pw.color || person.color}">${pw.progress}%</span>
        </div>`).join('')}
      </div>
      <div class="pd-chips">${projChips}</div>
    </div>
    <div class="pd-tabs">
      <button class="pd-tab ${tab === 'actions' ? 'active' : ''}" data-ptabperson="actions">Actions (${person.actions.length})</button>
      <button class="pd-tab ${tab === 'reports' ? 'active' : ''}" data-ptabperson="reports">Reports (${(person.reports || []).length})</button>
    </div>
    <div class="pd-body">${detail}</div>
  </div>`;
}

// ---------- Container detail ---------------------------------------

function renderContainer(main, c) {
  main.appendChild(tmpl('tpl-project'));

  main.querySelector('#project-title').textContent = c.title;

  // Panel-header emoji + sub line (category for projects, type label otherwise).
  const emojiEl = main.querySelector('#project-emoji');
  if (c.type === 'project' && c.emoji) {
    emojiEl.textContent = c.emoji;
    emojiEl.hidden = false;
  }
  const subEl = main.querySelector('#project-sub');
  if (c.type === 'project') {
    const bits = [c.category || 'Project'];
    bits.push(`${completionOf(c)}% complete`);
    subEl.textContent = bits.join(' · ');
  } else {
    subEl.textContent = containerLabel(c, 'full');
  }

  const backLink = main.querySelector('#project-back-link');
  if (backLink && c.type === 'inbox') backLink.textContent = '← Home';

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

  const editBtn = main.querySelector('[data-act="edit-project"]');
  if (c.type === 'inbox') {
    editBtn.remove();
  } else {
    editBtn.onclick = () => openEditContainerModal(c);
  }

  // Tabs: only projects get the Overview tab; references + inbox go straight
  // to the entries body (no glidepath/owners to show).
  const tabs = main.querySelector('#project-tabs');
  if (c.type === 'project') {
    tabs.hidden = false;
    if (ui.projectTab !== 'overview' && ui.projectTab !== 'entries') ui.projectTab = 'overview';
    tabs.querySelectorAll('.tab-btn').forEach(btn => {
      btn.onclick = () => { ui.projectTab = btn.dataset.ptab; renderContainerTab(c); };
    });
  }
  renderContainerTab(c);
}

function renderContainerTab(c) {
  const body = document.getElementById('project-tabbody');
  if (!body) return;
  const tab = c.type === 'project' ? ui.projectTab : 'entries';
  const tabs = document.getElementById('project-tabs');
  if (tabs) tabs.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.ptab === tab));

  body.innerHTML = '';
  if (tab === 'overview') {
    renderProjectOverview(body, c);
    return;
  }
  body.appendChild(tmpl('tpl-project-entries'));
  body.querySelector('[data-act="new-entry"]').onclick = () => openEntryDrawer(c.id, null);
  renderEntryStack(c.id);
  renderActionRail(c.id);
}

function renderProjectOverview(body, c) {
  const open = openActionsOf(c.id);
  const pct = completionOf(c);
  const last = lastEntryDate(c.id);
  const kpis = [
    { label: 'Completion', value: pct + '%', tone: toneFor(pct) },
    { label: 'Open actions', value: open.length, tone: open.length === 0 ? TONE.g : open.length <= 3 ? TONE.a : TONE.r },
    { label: 'Last entry', value: last || '—', tone: null },
    { label: 'Next meeting', value: c.next_meeting ? fmtDate(c.next_meeting) : '—', tone: null },
  ];
  const glide = renderGlidepath(c.metrics);
  const owners = c.owners || [];

  body.innerHTML = `
    <div class="overview">
      <div class="kpi-grid">${kpis.map(k => `
        <div class="kpi-card" style="background:${k.tone ? k.tone.b : '#fff'}">
          <div class="kpi-label" style="color:${k.tone ? k.tone.t : '#5a6070'}">${k.label}</div>
          <div class="kpi-value" style="color:${k.tone ? k.tone.t : '#1a2744'}">${k.value}</div>
        </div>`).join('')}
      </div>
      <div class="chart-card">
        <div class="chart-label">Glidepath</div>
        ${glide || `<div class="empty muted small glide-empty">No glidepath yet. Add a metric series under <strong>Edit</strong> to track progress over time.</div>`}
        ${glide ? `<div class="chart-note">● marker = an intervention recorded at that point</div>` : ''}
      </div>
      ${owners.length ? `<div class="owners-block">
        <div class="sec-label">Owners</div>
        <div class="owners-row">${owners.map(o => `<div class="owner-card">
          <div class="owner-init" style="background:${stringColor(o)}">${escHtml(initials(o))}</div>
          <div class="owner-name">${escHtml(o)}</div>
        </div>`).join('')}</div>
      </div>` : ''}
    </div>`;
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
  const isInbox = entry.container_id === INBOX_ID;

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
    ${isInbox ? `
      <div class="entry-card-promote">
        <button class="btn tiny" data-act="promote" data-promote-type="project">Promote to project</button>
        <button class="btn tiny" data-act="promote" data-promote-type="reference_file">Promote to reference file</button>
      </div>
    ` : ''}
  `;

  if (isInbox) {
    card.querySelectorAll('[data-act="promote"]').forEach(btn => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        openNewContainerModal(btn.dataset.promoteType, {
          presetTitle: entry.title || '',
          onCreate: (newC) => {
            entry.container_id = newC.id;
            entry.updated_at = nowIso();
            scheduleSave();
          },
        });
      };
    });
  }

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

// Quick-capture path: lazy-creates the Inbox container, opens an empty
// entry drawer pointing at it. The user can change the container picker
// in the drawer to file the entry directly into a project/reference.
function openAdHocEntryDrawer() {
  const inbox = getOrCreateInbox();
  openEntryDrawer(inbox.id, null);
}

// File-import path: pick a .md/.txt (e.g. an extracted .loop AI summary), drop
// its text into a fresh Inbox entry's notes, and open the drawer so the user
// can hit "Atomize notes" → triage. Works the same on the Linux test box and
// the orange Windows box (standard browser file picker; OneDrive files appear
// in the OS dialog). Drag-and-drop on the dashboard routes here too.
function openFileImport() {
  let input = document.getElementById('md-file-input');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.id = 'md-file-input';
    input.accept = '.md,.markdown,.txt,.text,text/markdown,text/plain';
    input.hidden = true;
    document.body.appendChild(input);
  }
  input.value = '';
  input.onchange = () => { const f = input.files && input.files[0]; if (f) importTextFile(f); };
  input.click();
}

// First markdown heading → title; else first non-empty line; else filename.
function titleFromMarkdown(text, filename) {
  const lines = String(text || '').split(/\r?\n/);
  for (const l of lines) {
    const h = l.match(/^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/);
    if (h) return h[1].trim().slice(0, 140);
  }
  for (const l of lines) {
    const t = l.trim().replace(/^#+\s*/, '');
    if (t) return t.slice(0, 140);
  }
  return (filename || 'Imported note').replace(/\.[^.]+$/, '');
}

function importTextFile(file) {
  const reader = new FileReader();
  reader.onerror = () => alert('Could not read that file.');
  reader.onload = () => {
    const text = String(reader.result || '');
    const inbox = getOrCreateInbox();
    const e = {
      id: uid(),
      container_id: inbox.id,
      kind: 'meeting',          // .loop summaries are meeting recaps
      occurred_at: nowIso(),
      title: titleFromMarkdown(text, file.name),
      participants: [],
      tags: [],
      notes: text,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    state.entries.push(e);
    scheduleSave();
    // Land in the drawer with notes pre-filled — one click from "Atomize notes".
    openEntryDrawer(inbox.id, e.id);
  };
  reader.readAsText(file);
}

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
        <span class="label">In</span>
        <select data-field="container_id">
          ${renderContainerPickerOptions(e.container_id)}
        </select>
      </label>

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

      <div class="atomize-row">
        <button class="btn" data-act="atomize" type="button">✦ Atomize notes</button>
        <span class="atomize-hint">Propose atoms from the notes and file them into projects.</span>
      </div>

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
  drawer.querySelector('[data-act="atomize"]').onclick = () => openTriageModal(entryId);
  drawer.querySelector('[data-act="delete-entry"]').onclick = () => {
    if (!confirm('Delete this entry and all of its atoms?')) return;
    state.atoms = state.atoms.filter(a => a.entry_id !== entryId);
    state.entries = state.entries.filter(en => en.id !== entryId);
    scheduleSave();
    closeDrawer();
  };
}

function renderContainerPickerOptions(selectedId) {
  const projects   = state.containers.filter(c => c.type === 'project'        && c.status !== 'archived');
  const references = state.containers.filter(c => c.type === 'reference_file' && c.status !== 'archived');
  const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '');
  projects.sort(byTitle);
  references.sort(byTitle);

  const opt = (id, label) =>
    `<option value="${escHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escHtml(label)}</option>`;

  return `
    <optgroup label="Inbox">
      ${opt(INBOX_ID, 'Inbox')}
    </optgroup>
    ${projects.length ? `<optgroup label="Projects">${projects.map(c => opt(c.id, c.title)).join('')}</optgroup>` : ''}
    ${references.length ? `<optgroup label="Reference files">${references.map(c => opt(c.id, c.title)).join('')}</optgroup>` : ''}
  `;
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
  drawer.querySelector('[data-field="container_id"]').onchange = (ev) => {
    const newId = ev.target.value;
    if (newId === INBOX_ID) getOrCreateInbox();
    e.container_id = newId;
    e.updated_at = nowIso();
    scheduleSave();
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
  const closingOutcome = atom.kind === 'action' ? outcomeForAction(atom.id) : null;
  const itemCls = cls + (closingOutcome ? ' closed' : '');

  let metaHtml = '';
  let outcomeRefHtml = '';
  if (atom.kind === 'action') {
    const overdue = !closingOutcome && isOverdue(atom);
    metaHtml = `
      <div class="atom-meta">
        <input type="text" data-action-field="assigned_to" placeholder="assigned to…"
               value="${escHtml(atom.assigned_to || '')}" list="dl-participants" />
        <input type="date" data-action-field="due_date" value="${escHtml(atom.due_date || '')}" />
        ${closingOutcome ? '<span class="closed-mark">✓ closed</span>' : ''}
        ${overdue ? '<span class="due overdue">overdue</span>' : ''}
      </div>
    `;
    if (closingOutcome) {
      const body = (closingOutcome.body || '').trim() || '(no outcome text)';
      const shown = body.length > 240 ? body.slice(0, 240) + '…' : body;
      outcomeRefHtml = `
        <div class="atom-outcome-ref">
          <span class="glyph u">U</span>
          <span class="outcome-body">${escHtml(shown)}</span>
        </div>
      `;
    }
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
    <div class="atom-item ${itemCls}" data-atom-id="${atom.id}">
      <div class="rail"></div>
      <textarea class="atom-body" data-atom-body rows="1">${escHtml(atom.body)}</textarea>
      <div class="tools"><button class="btn ghost tiny" data-atom-delete title="Delete">×</button></div>
      ${metaHtml}
      ${outcomeRefHtml}
    </div>
  `;
}

function wireAtomSections(entryId) {
  const drawer = document.getElementById('drawer');
  drawer.querySelectorAll('.atom-item').forEach(item => wireAtomItem(item, entryId));
  // Add-row click handling is delegated globally; see setupDrawerDelegation().
}

function handleAddAtom(row) {
  const entryId = currentDrawerEntryId;
  if (!entryId) return;
  const kind = row.dataset.addKind;
  const input = row.querySelector('[data-add-body]');
  const body = input?.value.trim();
  if (!body) { input?.focus(); return; }
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
  if (input) input.value = '';
  renderDrawerInner(entryId);
  const newRow = document.querySelector(`[data-atom-id="${newAtom.id}"]`);
  if (newRow) newRow.querySelector('[data-atom-body]')?.focus();
}

// Delegated handlers on the drawer — attached once at boot. Survives any
// number of inner re-renders without needing to re-wire per-element.
let _drawerDelegated = false;
function setupDrawerDelegation() {
  if (_drawerDelegated) return;
  const drawer = document.getElementById('drawer');
  if (!drawer) return;
  _drawerDelegated = true;

  drawer.addEventListener('click', (ev) => {
    const addBtn = ev.target.closest('[data-add-submit]');
    if (addBtn) {
      ev.preventDefault();
      const row = addBtn.closest('.atom-add-row');
      if (row) handleAddAtom(row);
    }
  });

  drawer.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const input = ev.target.closest('[data-add-body]');
    if (!input) return;
    ev.preventDefault();
    const row = input.closest('.atom-add-row');
    if (row) handleAddAtom(row);
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
        // Re-render so the now-closed (or freshly re-opened) parent
        // action in the same drawer reflects the new linkage.
        renderDrawerInner(entryId);
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

// Metrics editor uses a compact one-series-per-line text format so v1 needs no
// bespoke widget:  Label | target | 38,41,44,47 | 5:Protocol updated
function metricsToText(metrics) {
  return (metrics || []).map(m => {
    const ivs = (m.interventions || []).map(iv => `${iv.idx}:${iv.label}`).join(';');
    return [m.label || '', m.target ?? '', (m.data || []).join(','), ivs].join(' | ').replace(/( \| )+$/, '');
  }).join('\n');
}
function textToMetrics(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [label, target, data, ivs] = line.split('|').map(s => (s || '').trim());
    const series = { label: label || 'metric' };
    if (target !== '' && target != null && !isNaN(parseFloat(target))) series.target = parseFloat(target);
    series.data = (data || '').split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    series.interventions = (ivs || '').split(';').map(s => s.trim()).filter(Boolean).map(tok => {
      const [idx, ...rest] = tok.split(':');
      return { idx: parseInt(idx, 10), label: rest.join(':').trim() };
    }).filter(iv => !isNaN(iv.idx));
    if (series.data.length) out.push(series);
  }
  return out;
}

function openNewContainerModal(type, opts = {}) {
  const { presetTitle = '', onCreate } = opts;
  const typeLabel = type === 'project' ? 'project' : 'reference file';
  const goalLabel = type === 'project' ? 'Goal' : 'Purpose';
  const goalHint  = type === 'project'
    ? 'What does done look like?'
    : 'What is this file for?';
  const projectExtra = type === 'project' ? `
    <div class="field-row">
      <label class="field narrow">
        <span class="label">Emoji</span>
        <input type="text" id="m-emoji" maxlength="2" placeholder="📁" />
      </label>
      <label class="field">
        <span class="label">Category</span>
        <input type="text" id="m-category" placeholder="e.g. Quality Improvement" />
      </label>
    </div>` : '';
  openModal(`
    <h2>New ${typeLabel}</h2>
    <label class="field">
      <span class="label">Title</span>
      <input type="text" id="m-title" value="${escHtml(presetTitle)}" autofocus />
    </label>
    ${projectExtra}
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
      if (type === 'project') {
        const emoji = modal.querySelector('#m-emoji')?.value.trim();
        const category = modal.querySelector('#m-category')?.value.trim();
        if (emoji) c.emoji = emoji;
        if (category) c.category = category;
      }
      state.containers.push(c);
      onCreate?.(c);
      scheduleSave();
      closeModal();
      location.hash = `#/c/${encodeURIComponent(id)}`;
    };
  });
}

function openEditContainerModal(c) {
  const isProject = c.type === 'project';
  const typeLabel = isProject ? 'project' : 'reference file';
  const goalLabel = isProject ? 'Goal' : 'Purpose';
  const projectFields = isProject ? `
    <div class="field-row">
      <label class="field narrow">
        <span class="label">Emoji</span>
        <input type="text" id="m-emoji" maxlength="2" value="${escHtml(c.emoji || '')}" placeholder="📁" />
      </label>
      <label class="field narrow">
        <span class="label">Color</span>
        <input type="color" id="m-color" value="${escHtml(c.color || projectColor(c))}" />
      </label>
      <label class="field">
        <span class="label">Category</span>
        <input type="text" id="m-category" value="${escHtml(c.category || '')}" placeholder="e.g. Operations" />
      </label>
    </div>
    <div class="field-row">
      <label class="field narrow">
        <span class="label">Completion %</span>
        <input type="number" id="m-completion" min="0" max="100" value="${typeof c.completion === 'number' ? c.completion : ''}" placeholder="auto" />
      </label>
      <label class="field">
        <span class="label">Next meeting</span>
        <input type="date" id="m-next" value="${escHtml(c.next_meeting || '')}" />
      </label>
    </div>
    <label class="field">
      <span class="label">Owners</span>
      <div class="chips-input" id="m-owners"></div>
    </label>
    <label class="field">
      <span class="label">Glidepath metrics</span>
      <textarea id="m-metrics" class="metrics-input" placeholder="Label | target | 38,41,44,47 | 5:Protocol updated">${escHtml(metricsToText(c.metrics))}</textarea>
      <span class="field-hint">One series per line: <code>Label | target | comma,data | idx:intervention</code></span>
    </label>` : '';
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
    ${projectFields}
    <div class="modal-actions">
      <button class="btn danger" data-act="archive">${c.status === 'archived' ? 'Unarchive' : 'Archive'}</button>
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="save">Save</button>
    </div>
  `, (modal) => {
    const draftTags = [...(c.tags || [])];
    wireChipEditor(modal.querySelector('#m-tags'), draftTags, { prefix: '#', placeholder: 'add tag…', datalist: 'dl-tags', suggest: allTags });

    let draftOwners = null;
    if (isProject) {
      draftOwners = [...(c.owners || [])];
      wireChipEditor(modal.querySelector('#m-owners'), draftOwners, { placeholder: 'add owner…', datalist: 'dl-participants', suggest: allParticipants });
    }

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
      if (isProject) {
        const emoji = modal.querySelector('#m-emoji').value.trim();
        const color = modal.querySelector('#m-color').value.trim();
        const category = modal.querySelector('#m-category').value.trim();
        const completion = modal.querySelector('#m-completion').value.trim();
        const next = modal.querySelector('#m-next').value.trim();
        if (emoji) c.emoji = emoji; else delete c.emoji;
        if (color) c.color = color; else delete c.color;
        if (category) c.category = category; else delete c.category;
        if (completion !== '' && !isNaN(parseInt(completion, 10))) c.completion = Math.max(0, Math.min(100, parseInt(completion, 10)));
        else delete c.completion;
        if (next) c.next_meeting = next; else delete c.next_meeting;
        c.owners = draftOwners;
        c.metrics = textToMetrics(modal.querySelector('#m-metrics').value);
        if (!c.metrics.length) delete c.metrics;
      }
      c.updated_at = nowIso();
      scheduleSave();
      closeModal();
      render();
    };
  });
}

// Reusable chip editor — shared by tags + owners (and any future chip field).
// Mutates `draft` in place. `suggest` is a function returning a string[].
function wireChipEditor(wrap, draft, { prefix = '', placeholder = 'add…', datalist, suggest } = {}) {
  function refresh() {
    wrap.innerHTML = '';
    for (const v of draft) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `${escHtml(prefix + v)} <button type="button" aria-label="Remove">×</button>`;
      chip.querySelector('button').onclick = () => {
        const i = draft.indexOf(v);
        if (i >= 0) draft.splice(i, 1);
        refresh();
      };
      wrap.appendChild(chip);
    }
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = placeholder;
    if (datalist) inp.setAttribute('list', datalist);
    inp.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ',') {
        ev.preventDefault();
        const v = inp.value.trim().replace(/^#/, '');
        if (v && !draft.includes(v)) draft.push(v);
        inp.value = '';
        refresh();
      }
    };
    wrap.appendChild(inp);
    if (datalist) {
      if (!document.getElementById(datalist)) {
        const dl = document.createElement('datalist');
        dl.id = datalist;
        document.body.appendChild(dl);
      }
      document.getElementById(datalist).innerHTML =
        (suggest ? suggest() : []).map(s => `<option value="${escHtml(s)}"></option>`).join('');
    }
  }
  refresh();
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

// ---------- Entry triage (AI-assisted ingestion) -------------------
//
// Posts the entry's notes to /api/atomize (heuristic stub today, model later),
// then opens a triage overlay ported from the throughline_entry_triage artifact:
// proposed atom clusters → assign each to a project (or Inbox / new project) →
// commit. Commit writes real atoms; atoms fan out to sibling entries when a
// single capture spans multiple projects.

let triage = null; // working state while the triage overlay is open

const TRIAGE_ATOM = {
  observation: { lbl: 'OBS', cls: 'o' },
  decision:    { lbl: 'DEC', cls: 'd' },
  action:      { lbl: 'ACT', cls: 'a' },
  outcome:     { lbl: 'OUT', cls: 'u' },
};

function triageTarget(c, key) {
  return Object.prototype.hasOwnProperty.call(c.overrides, key) ? c.overrides[key] : c.projectId;
}
function triageTotals() {
  let total = 0, assigned = 0;
  for (const c of triage.clusters) for (const a of c.atoms) { total++; if (triageTarget(c, a.key)) assigned++; }
  return { total, assigned };
}

async function openTriageModal(entryId) {
  const entry = state.entries.find(e => e.id === entryId);
  if (!entry) return;
  if (!(entry.notes || '').trim()) {
    alert('Add some notes first — the atomizer reads the entry notes.');
    return;
  }

  const shroud = document.getElementById('triage-shroud');
  const panel = document.getElementById('triage');
  shroud.hidden = false;
  shroud.onclick = (ev) => { if (ev.target === shroud) closeTriage(); };
  panel.innerHTML = `<div class="triage-loading">Atomizing notes…</div>`;

  const projList = projects().map(p => ({ id: p.id, title: p.title, tags: p.tags || [], goal_or_purpose: p.goal_or_purpose || '' }));

  let data;
  try {
    const r = await fetch('/api/atomize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entry: { title: entry.title, notes: entry.notes, occurred_at: entry.occurred_at, participants: entry.participants || [] },
        projects: projList,
      }),
    });
    if (!r.ok) throw new Error(`atomize ${r.status}`);
    data = await r.json();
  } catch (err) {
    panel.innerHTML = `<div class="triage-loading">Atomize failed: ${escHtml(err.message)}<br/><button class="btn" data-act="t-close">Close</button></div>`;
    panel.querySelector('[data-act="t-close"]').onclick = closeTriage;
    return;
  }

  triage = {
    entryId,
    source: data.source || 'heuristic',
    clusters: (data.clusters || []).map((c, ci) => ({
      id: c.id || 'cl_' + ci,
      name: c.name || 'Cluster',
      suggestedId: (c.suggestedId && getContainer(c.suggestedId)) ? c.suggestedId : null,
      projectId: null,
      overrides: {},
      atoms: (c.atoms || []).map((a, ai) => ({ key: `${ci}_${ai}`, type: a.type, body: a.body, owner: a.owner, due: a.due })),
    })),
    expanded: {},
    newForm: {},
  };
  renderTriage();
}

function closeTriage() {
  const shroud = document.getElementById('triage-shroud');
  if (shroud) shroud.hidden = true;
  triage = null;
}

function renderTriage() {
  if (!triage) return;
  const panel = document.getElementById('triage');
  const entry = state.entries.find(e => e.id === triage.entryId);
  if (!entry) { closeTriage(); return; }
  const { total, assigned } = triageTotals();
  const done = total > 0 && assigned === total;
  const projs = projects();

  const optionsFor = (cur) => {
    let opts = `<option value="__none__"${!cur ? ' selected' : ''}>— Unassigned —</option>`;
    for (const p of projs) opts += `<option value="${escHtml(p.id)}"${cur === p.id ? ' selected' : ''}>${escHtml(p.title)}</option>`;
    opts += `<option value="__new__">+ New project…</option>`;
    opts += `<option value="__inbox__"${cur === '__inbox__' ? ' selected' : ''}>Inbox only</option>`;
    return opts;
  };

  const clustersHTML = triage.clusters.map(c => {
    const expanded = !!triage.expanded[c.id];
    const counts = { obs: 0, dec: 0, act: 0 };
    c.atoms.forEach(a => { if (a.type === 'decision') counts.dec++; else if (a.type === 'action') counts.act++; else counts.obs++; });
    const targets = c.atoms.map(a => triageTarget(c, a.key));
    const allAssigned = targets.length > 0 && targets.every(Boolean);
    const same = allAssigned && new Set(targets).size === 1;
    const assignedC = same && targets[0] !== '__inbox__' ? getContainer(targets[0]) : null;

    let badge = '';
    if (same && targets[0] === '__inbox__') badge = `<span class="t-suggest">→ Inbox</span>`;
    else if (assignedC) badge = `<span class="t-assigned" style="background:${projectColor(assignedC)}">✓ ${escHtml(assignedC.title)}</span>`;
    else if (allAssigned) badge = `<span class="t-suggest">split across projects</span>`;
    else if (!c.suggestedId) badge = `<span class="t-orphan">⚠ no matching project</span>`;
    else { const s = getContainer(c.suggestedId); badge = s ? `<span class="t-suggest" style="color:${projectColor(s)}">AI suggests: ${escHtml(s.title)}</span>` : ''; }

    const pills = [];
    if (counts.obs) pills.push(`<span class="t-pill o">OBS ${counts.obs}</span>`);
    if (counts.dec) pills.push(`<span class="t-pill d">DEC ${counts.dec}</span>`);
    if (counts.act) pills.push(`<span class="t-pill a">ACT ${counts.act}</span>`);

    let control;
    if (triage.newForm[c.id]) {
      control = `<div class="t-newform">
        <input type="text" data-tnew="${escHtml(c.id)}" placeholder="Project name…" value="${escHtml(triage.newForm[c.id] === true ? '' : triage.newForm[c.id])}" />
        <button class="btn tiny primary" data-tnew-create="${escHtml(c.id)}">Create</button>
        <button class="btn tiny" data-tnew-cancel="${escHtml(c.id)}">✕</button>
      </div>`;
    } else {
      const accept = (!allAssigned && c.suggestedId)
        ? `<button class="btn tiny" data-taccept="${escHtml(c.id)}" data-tpid="${escHtml(c.suggestedId)}">Accept →</button>` : '';
      control = `<div class="t-control">${accept}
        <select data-tcluster="${escHtml(c.id)}">${optionsFor(c.projectId)}</select></div>`;
    }

    let atomsHTML = '';
    if (expanded) {
      atomsHTML = `<div class="t-atoms">${c.atoms.map(a => {
        const st = TRIAGE_ATOM[a.type] || TRIAGE_ATOM.observation;
        const cur = triageTarget(c, a.key);
        const isOverride = Object.prototype.hasOwnProperty.call(c.overrides, a.key);
        return `<div class="t-atom${isOverride ? ' override' : ''}">
          <span class="atom-badge glyph ${st.cls}">${st.lbl}</span>
          <div class="t-atom-body">${escHtml(a.body)}${a.owner ? `<div class="t-atom-owner">→ ${escHtml(a.owner)}${a.due ? ' · due ' + escHtml(a.due) : ''}</div>` : ''}</div>
          <select data-tatom="${escHtml(c.id)}" data-takey="${escHtml(a.key)}">${optionsFor(cur)}</select>
        </div>`;
      }).join('')}</div>`;
    }

    return `<div class="t-cluster${assignedC ? ' assigned' : ''}${(!allAssigned && !c.suggestedId) ? ' orphan' : ''}"${assignedC ? ` style="border-color:${projectColor(assignedC)}"` : ''}>
      <div class="t-cluster-head" data-ttoggle="${escHtml(c.id)}">
        <span class="t-toggle">${expanded ? '▼' : '▶'}</span>
        <div class="t-cluster-meta">
          <div class="t-cluster-name-row"><span class="t-cluster-name">${escHtml(c.name)}</span>${badge}</div>
          <div class="t-pills">${pills.join('')}</div>
        </div>
        <div class="t-cluster-controls" data-stop>${control}</div>
      </div>
      ${atomsHTML}
    </div>`;
  }).join('');

  const projChips = projs.map(p => {
    let n = 0;
    for (const c of triage.clusters) for (const a of c.atoms) if (triageTarget(c, a.key) === p.id) n++;
    return `<div class="t-projchip${n ? ' active' : ''}"${n ? ` style="border-color:${projectColor(p)}"` : ''}>
      <span>${escHtml(p.title)}</span>${n ? `<span class="t-projchip-n" style="background:${projectColor(p)}">${n}</span>` : ''}
    </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="t-header">
      <div>
        <div class="t-eyebrow">Throughline · Entry triage${triage.source === 'heuristic' ? ' · heuristic' : ' · AI'}</div>
        <div class="t-title">${escHtml(entry.title || '(untitled)')}</div>
        <div class="t-sub">${fmtDate(entry.occurred_at)}${(entry.participants || []).length ? ' · ' + escHtml(entry.participants.join(', ')) : ''}</div>
      </div>
      <div class="t-progress">
        <div class="t-progress-count${done ? ' done' : ''}">${assigned}/${total}</div>
        <div class="t-progress-label">atoms assigned</div>
        <button class="triage-close" aria-label="Close">×</button>
      </div>
    </div>
    <div class="t-body">
      <div class="t-clusters">${clustersHTML || '<div class="empty muted">Nothing to atomize.</div>'}</div>
      <div class="t-sidebar">
        <div class="t-sidebar-label">Projects</div>
        ${projChips || '<div class="muted small">No projects yet.</div>'}
        <div class="t-commit">
          <button class="btn primary ${done ? 'ready' : ''}" data-act="t-commit">${done ? '✓ Commit entry' : 'Commit entry →'}</button>
          ${total - assigned ? `<div class="t-commit-hint">${total - assigned} unassigned → stay on this entry</div>` : ''}
        </div>
      </div>
    </div>`;

  wireTriage();
}

function wireTriage() {
  const panel = document.getElementById('triage');
  panel.querySelector('.triage-close')?.addEventListener('click', closeTriage);
  panel.querySelector('[data-act="t-commit"]')?.addEventListener('click', commitTriage);

  panel.querySelectorAll('[data-ttoggle]').forEach(el => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-stop]')) return; // clicks on the control don't toggle
      const id = el.dataset.ttoggle;
      triage.expanded[id] = !triage.expanded[id];
      renderTriage();
    });
  });
  panel.querySelectorAll('[data-stop]').forEach(el => el.addEventListener('click', e => e.stopPropagation()));

  panel.querySelectorAll('[data-taccept]').forEach(el => {
    el.addEventListener('click', (ev) => { ev.stopPropagation(); assignTriageCluster(el.dataset.taccept, el.dataset.tpid); });
  });

  panel.querySelectorAll('[data-tcluster]').forEach(sel => {
    sel.addEventListener('change', () => {
      const id = sel.dataset.tcluster;
      const v = sel.value;
      if (v === '__new__') { triage.newForm[id] = true; renderTriage(); return; }
      assignTriageCluster(id, v === '__none__' ? null : v);
    });
  });

  panel.querySelectorAll('[data-tatom]').forEach(sel => {
    sel.addEventListener('change', () => {
      const v = sel.value;
      if (v === '__new__') { sel.value = '__none__'; return; } // new-project only at cluster level
      overrideTriageAtom(sel.dataset.tatom, sel.dataset.takey, v === '__none__' ? null : v);
    });
  });

  panel.querySelectorAll('[data-tnew]').forEach(inp => {
    inp.addEventListener('input', () => { triage.newForm[inp.dataset.tnew] = inp.value; });
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') triageCreateProject(inp.dataset.tnew, inp.value);
      if (ev.key === 'Escape') { delete triage.newForm[inp.dataset.tnew]; renderTriage(); }
    });
    inp.focus();
  });
  panel.querySelectorAll('[data-tnew-create]').forEach(b => b.addEventListener('click', () => triageCreateProject(b.dataset.tnewCreate, triage.newForm[b.dataset.tnewCreate])));
  panel.querySelectorAll('[data-tnew-cancel]').forEach(b => b.addEventListener('click', () => { delete triage.newForm[b.dataset.tnewCancel]; renderTriage(); }));
}

function assignTriageCluster(clusterId, target) {
  const c = triage.clusters.find(x => x.id === clusterId);
  if (!c) return;
  c.projectId = target;
  c.overrides = {};
  renderTriage();
}

function overrideTriageAtom(clusterId, key, target) {
  const c = triage.clusters.find(x => x.id === clusterId);
  if (!c) return;
  if (target === c.projectId) delete c.overrides[key];
  else c.overrides[key] = target;
  renderTriage();
}

function triageCreateProject(clusterId, title) {
  title = (typeof title === 'string' ? title : '').trim();
  if (!title) return;
  const id = uniqueSlug(slugify(title));
  const c = {
    id, type: 'project', title, goal_or_purpose: '', summary: '',
    tags: [], status: 'active', created_at: nowIso(), updated_at: nowIso(),
  };
  state.containers.push(c);
  scheduleSave();
  delete triage.newForm[clusterId];
  assignTriageCluster(clusterId, id);
}

// Commit: resolve every proposed atom to a concrete container, then write.
// The container holding the most atoms keeps the source entry; atoms bound for
// other containers fan out into sibling entries cloned from the source.
function commitTriage() {
  if (!triage) return;
  const entry = state.entries.find(e => e.id === triage.entryId);
  if (!entry) { closeTriage(); return; }
  const source = entry.container_id;

  const byTarget = new Map();
  for (const c of triage.clusters) {
    for (const a of c.atoms) {
      let t = triageTarget(c, a.key);
      if (!t) t = source;                          // unassigned → stay with source
      else if (t === '__inbox__') t = getOrCreateInbox().id;
      if (!byTarget.has(t)) byTarget.set(t, []);
      byTarget.get(t).push(a);
    }
  }
  if (!byTarget.size) { closeTriage(); return; }

  let dominant = source, best = -1;
  for (const [t, atoms] of byTarget) if (atoms.length > best) { best = atoms.length; dominant = t; }

  const makeAtom = (a, entryId) => {
    const atom = { id: uid(), entry_id: entryId, kind: a.type, body: a.body, tags: [], created_at: nowIso(), updated_at: nowIso() };
    if (a.type === 'action') { atom.assigned_to = a.owner || ''; atom.due_date = a.due || ''; }
    return atom;
  };

  // Source entry → dominant container.
  entry.container_id = dominant;
  entry.updated_at = nowIso();
  for (const a of (byTarget.get(dominant) || [])) state.atoms.push(makeAtom(a, entry.id));

  // Sibling entries for every other target.
  for (const [t, atoms] of byTarget) {
    if (t === dominant) continue;
    const sib = {
      id: uid(), container_id: t, kind: entry.kind, occurred_at: entry.occurred_at,
      title: entry.title, participants: [...(entry.participants || [])], tags: [...(entry.tags || [])],
      notes: '', created_at: nowIso(), updated_at: nowIso(),
    };
    state.entries.push(sib);
    for (const a of atoms) state.atoms.push(makeAtom(a, sib.id));
  }

  scheduleSave();
  closeTriage();
  closeDrawer(true);
  location.hash = `#/c/${encodeURIComponent(dominant)}`;
  render();
}

// ---------- Boot ---------------------------------------------------

(async function boot() {
  console.log('[throughline] client v0.4 — playground theme');
  setupDrawerDelegation();
  const meta = document.getElementById('hdr-meta');
  if (meta) {
    const d = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    meta.textContent = `Dyad workspace · ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }
  await loadState();
  render();
})();
