// ------------------------------------------------------------------
// Throughline — client logic
// One JSON document; vanilla DOM; hash-based routing; debounced PUT.
// Ports to a Node + JSON-file backend by swapping the API URL only.
// ------------------------------------------------------------------

import {
  buildStateSummary, buildProposed, buildNeedsClarification,
  assembleBundle, openActionsForContainer, OPENING_PROMPT, DECISION_PROMPT,
} from './ingest.js';
import { parseDecisionSet, isBundle, isDecisionSet, looksLikeJson, resolveDecisions } from './gate.js';

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
  return { schema_version: 3, containers: [], entries: [], atoms: [], people_meta: {} };
}

// Default the v3 optional fields on a container without dropping any existing
// keys. Universal fields (program_id, rag) apply to every container; framework
// fields only to projects; objective/key_results only to programs. A legacy
// container (no framework) ends up with framework:null and renders as before.
function normalizeContainer(c) {
  if (!c || typeof c !== 'object') return c;
  const out = {
    ...c,
    program_id: c.program_id ?? null,                 // link to a parent program; null = standalone
    rag: c.rag ?? null,                               // 'green'|'amber'|'red'|null (null = derive)
  };
  if (c.type === 'project' || c.type === 'reference_file') {
    out.folder = typeof c.folder === 'string' ? c.folder : null; // bound OneDrive folder (root-relative); null = unbound
  }
  if (c.type === 'project') {
    out.framework = c.framework ?? null;              // 'kanban'|'pdsa'|'milestone'|'timeline'|null
    out.framework_config = c.framework_config && typeof c.framework_config === 'object' ? c.framework_config : {};
  }
  if (c.type === 'program') {
    out.objective = typeof c.objective === 'string' ? c.objective : '';
    out.key_results = Array.isArray(c.key_results) ? c.key_results : [];
  }
  return out;
}

// Tolerate v1/v2 docs (no people_meta, no v2/v3 container fields). Unknown keys
// are preserved on save by the backend; here we guarantee the shapes we read
// and default the v3 optional fields so render code can rely on them.
function normalizeState(d) {
  return {
    ...(d && typeof d === 'object' ? d : {}),
    schema_version: 3,
    containers: Array.isArray(d?.containers) ? d.containers.map(normalizeContainer) : [],
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
    if (!r.ok) {
      // Surface the server's actual error, not a generic hint (T1) — an EPERM
      // from a OneDrive lock reads very differently from a network drop.
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${r.status}`);
    }
    lastSavedAt = Date.now();
    setStatus('saved');
  } catch (e) {
    console.error(e);
    setStatus('error', e.message);
  }
}

function setStatus(s, detail) {
  const el = document.getElementById('status');
  if (!el) return;
  if (s === 'saving') { el.textContent = 'saving…'; el.dataset.state = 'saving'; }
  else if (s === 'saved') { el.textContent = `saved ${fmtWhen(new Date(lastSavedAt).toISOString())}`; el.dataset.state = 'saved'; }
  else if (s === 'error') { el.textContent = `save failed — ${detail || 'check connection'}`; el.dataset.state = 'error'; el.title = detail || ''; }
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

// Minimal markdown → HTML for consult-chat assistant bubbles (T14). Escape-
// first by construction (everything passes through escHtml before any tag is
// emitted), so model output can never inject markup. Covers what gpt-5.4
// actually sends: headings, bold/italic, inline + fenced code, lists, rules.
function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}
function mdToHtml(src) {
  const lines = escHtml(src).split(/\r?\n/);
  const out = [];
  let list = null;   // 'ul' | 'ol' currently open
  let para = [];     // pending paragraph lines
  let code = null;   // lines inside an open ``` fence
  const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join('<br>'))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line.trim())) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; }
      else code.push(line);
      continue;
    }
    const t = line.trim();
    if (/^```/.test(t)) { flushPara(); flushList(); code = []; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); flushList();
      const n = Math.min(h[1].length + 2, 6); // bubble-sized: # → h3, ## → h4 …
      out.push(`<h${n}>${mdInline(h[2])}</h${n}>`);
      continue;
    }
    const ul = t.match(/^[-*•]\s+(.*)$/);
    const ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { flushList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${mdInline((ul || ol)[1])}</li>`);
      continue;
    }
    if (!t) { flushPara(); flushList(); continue; }
    para.push(t);
  }
  if (code) out.push(`<pre><code>${code.join('\n')}</code></pre>`); // unclosed fence
  flushPara(); flushList();
  return out.join('');
}

function tmpl(id) {
  return document.getElementById(id).content.cloneNode(true);
}

// ---------- Container type metadata --------------------------------

const INBOX_ID = 'inbox';

// Lookup so each new container type adds one row here, not N ternaries.
const CONTAINER_LABELS = {
  program:        { full: 'Program',        short: 'Program',   cls: 'program'   },
  project:        { full: 'Project',        short: 'Project',   cls: 'project'   },
  reference_file: { full: 'Reference File', short: 'Reference', cls: 'reference' },
  inbox:          { full: 'Inbox',          short: 'Inbox',     cls: 'inbox'     },
};
const containerLabel   = (c, form = 'full') => CONTAINER_LABELS[c?.type]?.[form] || 'Project';
const containerTypeCls = (c) => CONTAINER_LABELS[c?.type]?.cls || 'project';

// One source of truth for the PM-framework templates (Phases B/C read this).
// Each entry: a plain-English `label` for pickers (NO jargon shown to users in
// required flows), a one-line `blurb` for optional post-selection help, the
// default scaffold a project gets, and which metric fields the framework wants.
// `defaultConfig()` seeds a project's `framework_config` on selection.
const FRAMEWORKS = {
  kanban: {
    name: 'Kanban',
    label: 'A pipeline of content or tasks that move through stages',
    blurb: 'A board: work flows left-to-right through stages. Good for communications and any pipeline of discrete deliverables.',
    metricFields: ['throughput', 'cycle_time'],
    defaultConfig: () => ({ states: [
      { id: 'backlog',     label: 'Backlog' },
      { id: 'in_progress', label: 'In progress' },
      { id: 'in_review',   label: 'In review' },
      { id: 'done',        label: 'Done' },
    ] }),
  },
  pdsa: {
    name: 'PDSA',
    label: 'Improving a measurable outcome over time',
    blurb: 'A repeating Plan–Do–Study–Act cycle around a metric. Good for quality-improvement work with a measurable endpoint.',
    metricFields: ['aim', 'baseline', 'target', 'frequency'],
    defaultConfig: () => ({ aim: '', baseline: null, target: null, frequency: 'monthly', phase: 'plan' }),
  },
  milestone: {
    name: 'Milestone',
    label: 'A phased effort with milestones to hit',
    blurb: 'A checklist of milestones with owners and dates. Good for operational change with a clear before/after.',
    metricFields: ['baseline_state', 'target_state'],
    defaultConfig: () => ({ milestones: [], baseline_state: '', target_state: '' }),
  },
  timeline: {
    name: 'Timeline',
    label: 'A situation driven by key dates and events',
    blurb: 'A dated event log with the next important date floated to the top. Good for personnel matters and deadline-driven tracking.',
    metricFields: [],
    defaultConfig: () => ({ next_trigger: null }),
  },
};
const frameworkLabel = (id) => FRAMEWORKS[id]?.label || '';
const frameworkName  = (id) => FRAMEWORKS[id]?.name || '';
const frameworkBlurb = (id) => FRAMEWORKS[id]?.blurb || '';
const frameworkConfigFor = (id) => (FRAMEWORKS[id]?.defaultConfig ? FRAMEWORKS[id].defaultConfig() : {});

// A plain-English framework picker for project modals. The official PM-tool
// name is shown inline in parens — plain language leads, the proper noun helps
// the user associate it with the real method.
function frameworkSelectHtml(selected = '') {
  const opts = ['<option value="">No set structure — just capture entries</option>']
    .concat(Object.keys(FRAMEWORKS).map(id =>
      `<option value="${id}"${id === selected ? ' selected' : ''}>${escHtml(FRAMEWORKS[id].label)} (${escHtml(FRAMEWORKS[id].name)})</option>`));
  return `<select id="m-framework">${opts.join('')}</select>`;
}

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

// Open actions in a container = action atoms with no closing outcome.
// Delegates to shared/ingest so the UI and the export bundle use one rule.
function openActionsOf(cid) {
  return openActionsForContainer(state, cid);
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

// RAG status for a container. Manual `c.rag` wins; otherwise derive from work:
// any overdue open action → red, a pile of open actions → amber, else green.
// (E1/E2 add the manual-override UI and the program rollup; this is the shared
// derivation both rely on.)
function ragOf(c) {
  if (c && (c.rag === 'red' || c.rag === 'amber' || c.rag === 'green')) return c.rag;
  if (c && c.type === 'program') return programRag(c);
  const open = openActionsOf(c.id);
  if (open.some(isOverdue)) return 'red';
  if (open.length > 4) return 'amber';
  return 'green';
}
// A program's derived status = the worst of its children (manual override above).
function programRag(p) {
  const kids = childProjectsOf(p.id);
  const order = { green: 0, amber: 1, red: 2 };
  let worst = 'green';
  for (const k of kids) { const r = ragOf(k); if (order[r] > order[worst]) worst = r; }
  return worst;
}
const childProjectsOf = (pid) => state.containers.filter(c => c.program_id === pid && c.status !== 'archived');
const RAG_COLOR = { green: '#3f8f5b', amber: '#c98a1b', red: '#b3372f' };
const RAG_LABEL = { green: 'On track', amber: 'Watch', red: 'Needs attention' };

// A status picker. "" = auto (derive from work). Manual choice overrides.
function ragSelectHtml(selected = '') {
  const opts = [['', 'Auto (from open work)'], ['green', 'On track'], ['amber', 'Watch'], ['red', 'Needs attention']];
  return `<select id="m-rag">${opts.map(([v, l]) => `<option value="${v}"${v === (selected || '') ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
}

// A small status chip (the authoritative color at this level).
function ragChip(c) {
  const rag = ragOf(c);
  return `<span class="rag-chip" style="background:${RAG_COLOR[rag]}">${RAG_LABEL[rag]}</span>`;
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
    p.forEach(([x, y], i) => {
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${main ? 3 : 2}" fill="${color}"/>`;
      // Invisible larger hit target on the main series for click-to-annotate (F2/F3).
      if (main) svg += `<circle class="glide-hit" data-mi="${mi}" data-idx="${i}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="transparent" style="cursor:pointer"/>`;
    });
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
  if (h === '/setup') return { kind: 'setup' };
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
  if (r.kind === 'setup') {
    renderSetup(main);
  } else if (r.kind === 'home') {
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

  main.querySelector('[data-act="new-project-guided"]').onclick =
    () => openProjectWizard();
  main.querySelector('[data-act="new-program"]').onclick =
    () => openNewProgramModal();
  main.querySelector('[data-act="new-reference-file"]').onclick =
    () => openNewContainerModal('reference_file');
  main.querySelector('[data-act="new-adhoc"]').onclick =
    () => openAdHocEntryDrawer();
  main.querySelector('[data-act="import-file"]').onclick =
    () => openFileImport();
  main.querySelector('[data-act="paste-copilot"]').onclick =
    () => openCopilotImport();

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

  // At-a-glance status grid: count top-level items (programs + standalone
  // projects) by RAG — the scannable "weekly status" artifact.
  const grid = document.getElementById('home-rag');
  if (grid) {
    const tops = state.containers.filter(c =>
      c.status !== 'archived' && (c.type === 'program' || (c.type === 'project' && !c.program_id)));
    const counts = { red: 0, amber: 0, green: 0 };
    for (const c of tops) counts[ragOf(c)]++;
    grid.innerHTML = ['red', 'amber', 'green']
      .filter(k => counts[k])
      .map(k => `<span class="rag-count"><span class="rag-dot" style="background:${RAG_COLOR[k]}"></span>${counts[k]} ${RAG_LABEL[k]}</span>`)
      .join('');
  }
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
  const byRecent = (a, b) => {
    const ta = lastTouchedOf(a.id) || a.created_at || '';
    const tb = lastTouchedOf(b.id) || b.created_at || '';
    return tb.localeCompare(ta);
  };
  const progs = filterContainers('program').sort(byRecent);
  // Projects inside a program live under it — only standalone projects here.
  const projects = filterContainers('project').filter(c => !c.program_id).sort(byRecent);
  if (!progs.length && !projects.length) {
    grid.innerHTML = `<div class="empty muted tile-empty">No projects yet. Click <strong>✦ New project</strong> to start one.</div>`;
    return;
  }
  for (const p of progs) grid.appendChild(renderProgramTile(p));
  for (const c of projects) grid.appendChild(renderProjectTile(c));
}

// A program shows as a distinct top-level tile (navy, "PROGRAM" badge, objective,
// child count + aggregate RAG) that links through to its dashboard.
function renderProgramTile(p) {
  const tile = document.createElement('div');
  tile.className = 'tile program-tile';
  tile.onclick = () => { location.hash = `#/c/${encodeURIComponent(p.id)}`; };
  const kids = childProjectsOf(p.id).filter(k => k.type !== 'program');
  const open = kids.reduce((n, k) => n + openActionsOf(k.id).length, 0);
  const rag = ragOf(p);
  tile.innerHTML = `
    <div class="tile-top">
      <span class="prog-badge">PROGRAM</span>
      <span class="rag-dot lg" style="background:${RAG_COLOR[rag]}" title="${rag}"></span>
    </div>
    <div class="tile-title">${escHtml(p.title)}</div>
    <div class="tile-status">${escHtml(p.objective || '')}</div>
    <div class="tile-bottom">
      <span class="tile-cat">${kids.length} project${kids.length === 1 ? '' : 's'}</span>
      <span class="tile-open ${open ? 'has' : ''}">${open ? open + ' open' : '✓ clear'}</span>
    </div>
  `;
  return tile;
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
      <span class="tile-emoji">${escHtml(c.emoji || '📁')}<span class="rag-dot tile-rag" style="background:${RAG_COLOR[ragOf(c)]}" title="${RAG_LABEL[ragOf(c)]}"></span></span>
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
// (The old copy-attachments upload surface was removed — it's superseded by the
// folder lens, which shows a container's real OneDrive files in place. The Node
// /api/attachments endpoints remain for any previously-uploaded files but are no
// longer offered in the UI.)

// ---------- Folder lens (Epic E1) ----------------------------------
// A container can be BOUND to a real OneDrive folder (root-relative path under
// ONEDRIVE_ROOT). Its files are a live view of that folder — Throughline reads
// and opens them but never writes/deletes. fs endpoints are local-Node only;
// the cloud demo 501s and the UI degrades to a clear message.

const fbParent = (p) => (p && p.includes('/')) ? p.slice(0, p.lastIndexOf('/')) : '';
const fbJoin = (base, name) => base ? `${base}/${name}` : name;
function fbBreadcrumb(path) {
  const parts = path ? path.split('/') : [];
  let acc = '';
  const crumbs = [`<button class="fb-crumb" data-nav="">⌂ root</button>`];
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    crumbs.push(`<button class="fb-crumb" data-nav="${escHtml(acc)}">${escHtml(p)}</button>`);
  }
  return crumbs.join('<span class="fb-sep">›</span>');
}

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fileIcon(ext) {
  const e = (ext || '').toLowerCase();
  if (['xlsx', 'xls', 'csv', 'xlsm'].includes(e)) return '📊';
  if (['docx', 'doc', 'rtf'].includes(e)) return '📝';
  if (['pptx', 'ppt'].includes(e)) return '📽️';
  if (['pdf'].includes(e)) return '📕';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(e)) return '🖼️';
  return '📄';
}

// E1.3 — the bound folder as an expandable tree. The root level shows the bound
// folder's contents; each subfolder lazily loads its own children via
// /api/fs/list on first expand (keeps a big tree fast — nothing loads until you
// open it). Files open in their native app (E1.4).
async function renderFolderFiles(el, c) {
  if (!el || c.folder == null) return;
  el.innerHTML = `<div class="fs-tree"></div>`;
  await mountFsLevel(el.querySelector('.fs-tree'), c.folder || '');
}

// Load one folder's children into `mountEl` (folders first, then files). A
// folder row toggles a nested child container, fetched lazily the first time
// it's opened. Recurses to arbitrary depth.
async function mountFsLevel(mountEl, path) {
  mountEl.innerHTML = `<div class="muted small fs-loading">Loading…</div>`;
  let data;
  try {
    const r = await fetch(`/api/fs/list?path=${encodeURIComponent(path)}`);
    if (r.status === 501) { mountEl.innerHTML = `<div class="muted small">Live folder files are only available in the local app, not the cloud demo.</div>`; return; }
    if (r.status === 404) { mountEl.innerHTML = `<div class="folder-missing">⚠ Folder is missing on disk — re-bind or restore it.</div>`; return; }
    if (!r.ok) throw new Error(`list ${r.status}`);
    data = await r.json();
  } catch (e) {
    console.error(e);
    mountEl.innerHTML = `<div class="muted small">Couldn't read this folder.</div>`;
    return;
  }
  const folders = data.folders || [];
  const files = data.files || [];
  mountEl.innerHTML = '';
  if (!folders.length && !files.length) {
    mountEl.innerHTML = `<div class="muted small fs-empty">Empty folder.</div>`;
    return;
  }
  for (const f of folders) {
    const childPath = fbJoin(path, f.name);
    const row = document.createElement('button');
    row.className = 'fs-row fs-folder';
    row.innerHTML = `<span class="fs-twisty">▸</span><span class="fs-icon">📁</span><span class="fs-name">${escHtml(f.name)}</span>`;
    const kids = document.createElement('div');
    kids.className = 'fs-children';
    kids.hidden = true;
    let loaded = false;
    row.onclick = async () => {
      const twisty = row.querySelector('.fs-twisty');
      if (!kids.hidden) { kids.hidden = true; twisty.textContent = '▸'; return; }
      kids.hidden = false; twisty.textContent = '▾';
      if (!loaded) { loaded = true; await mountFsLevel(kids, childPath); }
    };
    mountEl.appendChild(row);
    mountEl.appendChild(kids);
  }
  for (const f of files) {
    const filePath = fbJoin(path, f.name);
    const row = document.createElement('button');
    row.className = 'fs-row fs-file';
    row.title = `Open ${f.name} in its app`;
    row.innerHTML = `<span class="fs-twisty"></span><span class="fs-icon">${fileIcon(f.ext)}</span><span class="fs-name">${escHtml(f.name)}</span><span class="folder-meta">${fmtBytes(f.size)}</span>`;
    row.onclick = () => openBoundFile(filePath);
    mountEl.appendChild(row);
  }
}

// Open a bound file in its native app (Excel/Word/…) via the local server,
// instead of downloading it. Local-Node only — the cloud demo 501s.
async function openBoundFile(path) {
  try {
    const r = await fetch('/api/fs/open', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (r.status === 501) { alert('Opening files in their native app is only available in the local app, not the cloud demo.'); return; }
    if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.error || "Couldn't open that file."); return; }
  } catch (e) {
    console.error(e);
    alert("Couldn't reach the file service.");
  }
}

function renderFolderLens(main, c) {
  const wrap = main.querySelector('#project-folder');
  if (!wrap) return;
  if (c.folder != null) {
    wrap.innerHTML = `
      <div class="folder-head"><span class="sec-label">📁 Folder</span>
        <span class="folder-bound" title="bound OneDrive folder">${escHtml(c.folder || '(root)')}</span>
        <button class="btn ghost tiny" data-act="change-folder">Change</button>
        <button class="btn ghost tiny" data-act="unbind-folder">Unbind</button></div>
      <div class="folder-files" id="folder-files"></div>`;
    wrap.querySelector('[data-act="change-folder"]').onclick = () => openFolderBrowser(c);
    wrap.querySelector('[data-act="unbind-folder"]').onclick = () => {
      if (!confirm('Unbind this folder? The folder and its files on disk are not touched.')) return;
      c.folder = null; c.updated_at = nowIso(); scheduleSave(); render();
    };
    renderFolderFiles(wrap.querySelector('#folder-files'), c);
  } else {
    wrap.innerHTML = `
      <div class="folder-head"><span class="sec-label">📁 Folder</span>
        <button class="btn ghost tiny" data-act="bind-folder">🔗 Bind a folder</button>
        <span class="muted small">Show this ${escHtml(containerLabel(c))}'s real OneDrive files.</span></div>`;
    wrap.querySelector('[data-act="bind-folder"]').onclick = () => openFolderBrowser(c);
  }
}

// In-app folder browser over ONEDRIVE_ROOT: list folders via /api/fs/list,
// navigate in, and "Use this folder" binds the current path (root-relative).
// Shared lazy folder browser used by BOTH the lens binder (rooted at
// ONEDRIVE_ROOT via /api/fs/list) and the first-run setup wizard (rooted at the
// user's HOME via /api/setup/browse). Renders into `mountEl`, navigates folders
// by their list-relative path, and calls opts.onLoad({path, absPath}) after each
// successful load (null on 501/error) so the caller can enable its "use" button
// and read the current selection. `absPath` is only present from setup/browse.
function mountBrowser(mountEl, opts) {
  let cur = opts.initialPath || '';
  let curAbs = '';
  function paint(data) {
    const folders = data.folders || [];
    const files = data.files || [];
    mountEl.innerHTML = `
      <div class="fb-crumbs">${fbBreadcrumb(cur)}</div>
      <div class="fb-list">
        ${cur ? `<button class="fb-row fb-up" data-nav="${escHtml(fbParent(cur))}">↑ ..</button>` : ''}
        ${folders.map(f => `<button class="fb-row fb-folder" data-nav="${escHtml(fbJoin(cur, f.name))}">📁 ${escHtml(f.name)}</button>`).join('')}
        ${files.map(f => `<div class="fb-row fb-file muted">📄 ${escHtml(f.name)}</div>`).join('')}
        ${(!folders.length && !files.length) ? `<div class="muted small fb-empty">(empty folder)</div>` : ''}
      </div>
      <div class="fb-current small">${opts.bindLabel || 'Bind to'}: <strong>${escHtml(curAbs || cur || '(root)')}</strong></div>`;
    mountEl.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => load(b.dataset.nav));
  }
  async function load(path) {
    mountEl.innerHTML = `<div class="muted small">Loading…</div>`;
    try {
      const r = await fetch(`${opts.listUrl}?path=${encodeURIComponent(path)}`);
      if (r.status === 501) {
        mountEl.innerHTML = `<div class="muted small">Folder browsing is only available in the local app, not the cloud demo.</div>`;
        opts.onLoad && opts.onLoad(null);
        return;
      }
      if (!r.ok) {
        const msg = r.status === 404 ? 'That folder is missing.' : `Couldn't read that folder (${r.status}).`;
        mountEl.innerHTML = `<div class="muted small">${msg} ${path ? `<button class="btn ghost tiny" data-nav-up="1">↑ Up</button>` : ''}</div>`;
        const up = mountEl.querySelector('[data-nav-up]'); if (up) up.onclick = () => load(fbParent(path));
        opts.onLoad && opts.onLoad(null);
        return;
      }
      const data = await r.json();
      cur = data.path;
      curAbs = data.absPath || '';
      paint(data);
      opts.onLoad && opts.onLoad({ path: cur, absPath: curAbs });
    } catch (e) {
      console.error(e);
      mountEl.innerHTML = `<div class="muted small">Couldn't reach the file service.</div>`;
      opts.onLoad && opts.onLoad(null);
    }
  }
  load(cur);
}

function openFolderBrowser(c) {
  const initial = (typeof c.folder === 'string') ? c.folder : '';
  let picked = { path: initial, absPath: '' };
  openModal(`
    <h2 class="modal-title">Bind a folder</h2>
    <p class="muted small">Pick the OneDrive folder whose files this ${escHtml(containerLabel(c))} should show. Throughline only reads and opens them — it never changes the folder.</p>
    <div class="fb" id="fb"><div class="muted small">Loading…</div></div>
    <div class="modal-actions">
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="use">Use this folder</button>
    </div>`, (modal) => {
    const fb = modal.querySelector('#fb');
    const useBtn = modal.querySelector('[data-act="use"]');
    modal.querySelector('[data-act="cancel"]').onclick = () => closeModal();
    useBtn.onclick = () => {
      c.folder = picked.path; c.updated_at = nowIso(); scheduleSave(); closeModal(); render();
    };
    mountBrowser(fb, {
      listUrl: '/api/fs/list',
      initialPath: initial,
      bindLabel: 'Bind to',
      onLoad: (st) => { if (st) picked = st; useBtn.disabled = !st; },
    });
  });
}

// First-run setup wizard (#/setup). Browses from the user's HOME so they can find
// the shared OneDrive folder, then POSTs /api/setup/bind (writes .env + restarts
// the server task) and polls /api/setup/status until the restarted server reports
// it's configured. Only reachable on the local Node backend.
function renderSetup(main) {
  main.innerHTML = `<section class="setup-wizard"><p class="muted small">Loading…</p></section>`;
  // A configured install (e.g. an update that kept a bound .env) should never
  // show the wizard, even if the installer navigated straight to #/setup.
  fetch('/api/setup/status', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (s && s.configured) { location.hash = '#/'; render(); } else renderSetupWizard(main);
    })
    .catch(() => renderSetupWizard(main));
}

// Step 1 — pick the shared OneDrive folder (the lens root).
function renderSetupWizard(main) {
  main.innerHTML = `
    <section class="setup-wizard">
      <h1 class="setup-title">Set up Throughline</h1>
      <p class="setup-lead">Pick your shared OneDrive folder — the one shared with your dyad partner (look under <strong>OneDrive&nbsp;-&nbsp;…</strong>). Throughline reads its files and keeps your shared projects there. It never changes your files.</p>
      <div class="fb" id="setup-fb"><div class="muted small">Loading…</div></div>
      <div class="setup-actions">
        <button class="btn primary" id="setup-use" disabled>Next →</button>
      </div>
    </section>`;
  const fb = main.querySelector('#setup-fb');
  const useBtn = main.querySelector('#setup-use');
  let picked = { path: '', absPath: '' };
  mountBrowser(fb, {
    listUrl: '/api/setup/browse',
    initialPath: '',
    bindLabel: 'Use folder',
    onLoad: (st) => { if (st) picked = st; useBtn.disabled = !st || !st.absPath; },
  });
  useBtn.onclick = () => { if (picked.absPath) renderSetupDbStep(main, picked); };
}

// Step 2 — choose where the workspace data (state.json) lives. Defaults to the
// tidy `Throughline` subfolder and surfaces an existing workspace (with counts)
// to reuse — so a second dyad member just confirms the team's workspace.
function renderSetupDbStep(main, root) {
  main.innerHTML = `
    <section class="setup-wizard">
      <h1 class="setup-title">Where should your workspace live?</h1>
      <p class="setup-lead">Inside <strong>${escHtml(root.path || root.absPath)}</strong>. We recommend a <strong>Throughline</strong> subfolder so the shared root stays tidy.</p>
      <div id="db-choices"><div class="muted small">Checking this folder…</div></div>
      <div class="setup-actions">
        <button class="btn ghost" id="db-back">← Back</button>
        <button class="btn primary" id="db-use" disabled>Use this location</button>
      </div>
      <div class="setup-msg small" id="setup-msg"></div>
    </section>`;
  const choices = main.querySelector('#db-choices');
  const useBtn = main.querySelector('#db-use');
  const msg = main.querySelector('#setup-msg');
  main.querySelector('#db-back').onclick = () => renderSetupWizard(main);
  let selectedDb = '';

  fetch(`/api/setup/dbinfo?folder=${encodeURIComponent(root.absPath)}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((info) => {
      const cands = info.candidates || [];
      choices.innerHTML = cands.map((c, i) => {
        const s = c.summary;
        const plur = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
        const detail = c.exists
          ? (s ? `✓ Existing workspace — ${plur(s.projects, 'project')}, ${plur(s.programs, 'program')}, ${plur(s.references, 'reference')}` : '✓ Existing workspace')
          : (c.recommended ? 'New — will be created here' : 'New — empty');
        const label = escHtml(c.rel) + (c.recommended ? ' <span class="muted small">(recommended)</span>' : '');
        return `<label class="db-choice"><input type="radio" name="db" value="${escHtml(c.path)}" data-i="${i}">
          <span class="db-rel">${label}</span><span class="db-detail">${escHtml(detail)}</span></label>`;
      }).join('') || `<div class="muted small">No options found.</div>`;
      const radios = [...choices.querySelectorAll('input[name=db]')];
      radios.forEach((rd) => { rd.onchange = () => { selectedDb = rd.value; useBtn.disabled = false; }; });
      // Default: first existing workspace (reuse the team's data), else recommended.
      let idx = cands.findIndex((c) => c.exists);
      if (idx < 0) idx = cands.findIndex((c) => c.recommended);
      if (idx < 0) idx = 0;
      if (radios[idx]) { radios[idx].checked = true; selectedDb = radios[idx].value; useBtn.disabled = false; }
    })
    .catch(() => {
      choices.innerHTML = `<div class="muted small">Couldn't read this folder — we'll create the default Throughline workspace.</div>`;
      selectedDb = ''; // bind falls back to the Throughline-subfolder default
      useBtn.disabled = false;
    });

  useBtn.onclick = async () => {
    useBtn.disabled = true;
    msg.textContent = 'Saving your workspace…';
    try {
      const r = await fetch('/api/setup/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderAbsPath: root.absPath, dbAbsPath: selectedDb || undefined }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        msg.textContent = `Couldn't save: ${e.error || r.status}`;
        useBtn.disabled = false;
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (data.warning) msg.textContent = data.warning;
      location.hash = '#/';
      await loadState();
      render();
    } catch (e) {
      msg.textContent = "Saved, but couldn't reach the server — refresh this page.";
      useBtn.disabled = false;
    }
  };
}

// On a fresh local install ONEDRIVE_ROOT isn't configured yet — send the user to
// the wizard. Silent no-op on the cloud Worker (no setup endpoint) or offline.
async function maybeRedirectToSetup() {
  if (location.hash.replace(/^#/, '') === '/setup') return;
  try {
    const r = await fetch('/api/setup/status', { cache: 'no-store' });
    if (!r.ok) return;
    const s = await r.json();
    if (!s.configured) location.hash = '#/setup';
  } catch (e) { /* no setup endpoint (cloud) / offline → behave as today */ }
}

function renderContainer(main, c) {
  main.appendChild(tmpl('tpl-project'));

  main.querySelector('#project-title').textContent = c.title;

  // Authoritative status chip in the header (not for the inbox singleton).
  if (c.type !== 'inbox') {
    const titleWrap = main.querySelector('.panel-hdr-id');
    if (titleWrap) titleWrap.insertAdjacentHTML('beforeend', `<div class="panel-rag">${ragChip(c)}</div>`);
  }

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
  // A project/reference inside a program lives UNDER it (its tile is hidden
  // from home) — back goes to the program, not the dashboard (T23).
  const parentProg = c.program_id ? getContainer(c.program_id) : null;
  if (backLink && parentProg && parentProg.type === 'program') {
    backLink.href = `#/c/${encodeURIComponent(parentProg.id)}`;
    backLink.textContent = `← ${parentProg.title || 'Program'}`;
  }

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

  // Folder lens (Epic E1) — projects + reference files show their bound
  // OneDrive folder's live files in place (replaces the old attachments block).
  if (c.type === 'project' || c.type === 'reference_file') {
    renderFolderLens(main, c);
  }

  const editBtn = main.querySelector('[data-act="edit-project"]');
  if (c.type === 'inbox') {
    editBtn.remove();
  } else if (c.type === 'program') {
    editBtn.onclick = () => openEditProgramModal(c);
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
  if (c.type === 'program') {
    renderProgramDashboard(body, c);
    return;
  }
  if (tab === 'overview') {
    renderProjectOverview(body, c);
    return;
  }
  body.appendChild(tmpl('tpl-project-entries'));
  body.querySelector('[data-act="new-entry"]').onclick = () => openEntryDrawer(c.id, null);
  renderEntryStack(c.id);
  renderActionRail(c.id);
}

// Program dashboard (OKR-shaped): objective, key results as progress bars, a
// subproject grid (each child with RAG + one-line status + open-action count),
// and a recent-entries feed across all children.
function renderProgramDashboard(body, c) {
  const kids = childProjectsOf(c.id).filter(k => k.type !== 'program');
  const krs = c.key_results || [];

  const krRows = krs.map(k => {
    const haveNums = typeof k.current === 'number' && typeof k.target === 'number' && k.target !== 0;
    const pct = haveNums ? Math.max(0, Math.min(100, Math.round((k.current / k.target) * 100))) : null;
    const val = [k.current, k.target].filter(v => v !== '' && v != null).join(' / ') + (k.unit ? ' ' + k.unit : '');
    return `<div class="kr-row">
      <div class="kr-head"><span class="kr-label">${escHtml(k.label)}</span><span class="kr-val">${escHtml(val)}</span></div>
      ${pct != null ? miniBar(pct, 'var(--thread)', 7) : ''}
    </div>`;
  }).join('');

  const tiles = kids.map(k => {
    const rag = ragOf(k);
    const open = openActionsOf(k.id);
    const overdue = open.filter(isOverdue).length;
    const status = k.goal_or_purpose || k.summary || '';
    return `<a class="sub-tile" href="#/c/${encodeURIComponent(k.id)}">
      <div class="sub-top">
        <span class="rag-dot" style="background:${RAG_COLOR[rag]}" title="${rag}"></span>
        <span class="sub-title">${escHtml(k.emoji ? k.emoji + ' ' : '')}${escHtml(k.title)}</span>
      </div>
      ${status ? `<div class="sub-status">${escHtml(status.length > 90 ? status.slice(0, 87) + '…' : status)}</div>` : ''}
      <div class="sub-meta">
        <span>${completionOf(k)}% complete</span>
        <span>${open.length} open${overdue ? ` · <span class="sub-overdue">${overdue} overdue</span>` : ''}</span>
      </div>
    </a>`;
  }).join('');

  // Recent entries across all children.
  const kidIds = new Set(kids.map(k => k.id));
  const feed = state.entries
    .filter(e => kidIds.has(e.container_id))
    .sort((a, b) => (b.occurred_at || '').localeCompare(a.occurred_at || ''))
    .slice(0, 6);
  const byId = Object.fromEntries(kids.map(k => [k.id, k]));
  const feedRows = feed.map(e => `<div class="pf-row">
      <span class="pf-date">${escHtml(fmtDate((e.occurred_at || '').slice(0, 10)))}</span>
      <span class="pf-title">${escHtml(e.title || '(untitled)')}</span>
      <span class="pf-proj">${escHtml(byId[e.container_id]?.title || '')}</span>
    </div>`).join('');

  body.innerHTML = `
    <div class="program-dash">
      <div class="prog-objective">
        <span class="sec-label">Objective</span>
        <div class="prog-obj-text">${escHtml(c.objective || 'No objective set yet — add one under Edit.')}</div>
      </div>
      ${krs.length ? `<div class="chart-card"><div class="chart-label">Key results</div>${krRows}</div>` : ''}
      <div class="sec-label">Projects in this program</div>
      ${kids.length ? `<div class="sub-grid">${tiles}</div>`
        : `<div class="empty muted small glide-empty">No projects linked yet. Open a project and set <strong>“Part of a program?”</strong> to this one under Edit.</div>`}
      ${feed.length ? `<div class="chart-card"><div class="chart-label">Recent activity</div>${feedRows}</div>` : ''}
    </div>`;
}

// Find or create the per-project "Chart annotations" entry that holds atoms
// created from the glidepath.
function getOrCreateAnnotationEntry(cid) {
  let e = state.entries.find(x => x.container_id === cid && x.title === 'Chart annotations');
  if (!e) {
    e = {
      id: uid(), container_id: cid, kind: 'freetext',
      occurred_at: nowIso(), title: 'Chart annotations', participants: [], tags: [],
      notes: '', created_at: nowIso(), updated_at: nowIso(),
    };
    state.entries.push(e);
  }
  return e;
}

// Click a glidepath point → add a note (creates an observation atom + marks the
// point, F2) or mark an intervention start (F3). Annotations are keyed by point
// index (our metric data is index-based, not dated).
function openChartAnnotation(c, mi, idx) {
  const metric = (c.metrics || [])[mi];
  if (!metric) return;
  const val = metric.data?.[idx];
  const existing = (metric.interventions || []).find(iv => iv.idx === idx);
  const isPdsa = c.framework === 'pdsa';
  const phaseLabel = isPdsa ? (PDSA_STEPS.find(s => s.id === (c.framework_config?.phase || 'plan'))?.label || 'Plan') : '';
  openModal(`
    <h2>Annotate “${escHtml(metric.label || 'metric')}”</h2>
    <p class="wiz-lede">Point ${idx + 1}${val != null ? ` · ${val}%` : ''}${existing ? ` · currently marked “${escHtml(existing.label)}”` : ''}.</p>
    <label class="field">
      <span class="label">Note</span>
      <input type="text" id="anno-note" placeholder="What happened at this point?" value="${escHtml(existing && !existing.atom_id ? existing.label : '')}" autofocus />
    </label>
    <div class="modal-actions">
      ${isPdsa ? `<button class="btn ghost" data-act="intervention">Mark “${escHtml(phaseLabel)}” start</button>` : ''}
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="add">Add note</button>
    </div>
  `, (modal) => {
    modal.querySelector('[data-act="cancel"]').onclick = closeModal;
    const setIntervention = (label, atomId) => {
      metric.interventions = (metric.interventions || []).filter(iv => iv.idx !== idx);
      const iv = { idx, label };
      if (atomId) iv.atom_id = atomId;
      metric.interventions.push(iv);
      c.updated_at = nowIso();
      scheduleSave();
      closeModal();
      renderContainerTab(c);
    };
    modal.querySelector('[data-act="add"]').onclick = () => {
      const note = modal.querySelector('#anno-note').value.trim();
      if (!note) { modal.querySelector('#anno-note').focus(); return; }
      const entry = getOrCreateAnnotationEntry(c.id);
      const atom = { id: uid(), entry_id: entry.id, kind: 'observation', body: note, tags: ['chart'], created_at: nowIso(), updated_at: nowIso() };
      state.atoms.push(atom);
      setIntervention(note.length > 22 ? note.slice(0, 20) + '…' : note, atom.id);
    };
    const ib = modal.querySelector('[data-act="intervention"]');
    if (ib) ib.onclick = () => setIntervention(phaseLabel, null);
  });
}

// Kanban columns for a project: its configured states (or the framework
// default). A "card" is an action atom; it sits in its `workflow_state`, or —
// if closed by an outcome — the last column, or else the first column.
function kanbanStates(c) {
  const st = c.framework_config?.states;
  return Array.isArray(st) && st.length ? st : frameworkConfigFor('kanban').states;
}

function renderKanbanBoard(c) {
  const states = kanbanStates(c);
  const lastId = states[states.length - 1].id;
  const ids = new Set(states.map(s => s.id));
  const actions = atomsOfContainer(c.id).filter(a => a.kind === 'action');
  const colOf = (a) => {
    if (a.workflow_state && ids.has(a.workflow_state)) return a.workflow_state;
    if (outcomeForAction(a.id)) return lastId;     // closed → Done
    return states[0].id;
  };
  const byCol = Object.fromEntries(states.map(s => [s.id, []]));
  for (const a of actions) byCol[colOf(a)].push(a);

  const moveSelect = (a) => `<select class="kanban-move" data-atom="${a.id}">${
    states.map(s => `<option value="${s.id}"${s.id === colOf(a) ? ' selected' : ''}>${escHtml(s.label)}</option>`).join('')
  }</select>`;
  const card = (a) => {
    const closed = !!outcomeForAction(a.id);
    const meta = [a.assigned_to, a.due_date ? `due ${fmtDate(a.due_date)}` : ''].filter(Boolean).join(' · ');
    return `<div class="kanban-card${closed ? ' done' : ''}">
      <div class="kanban-card-body" data-entry="${a.entry_id}">${escHtml(a.body)}</div>
      ${meta ? `<div class="kanban-card-meta">${escHtml(meta)}</div>` : ''}
      ${moveSelect(a)}
    </div>`;
  };
  return `<div class="kanban-board">${states.map(s => `
    <div class="kanban-col">
      <div class="kanban-col-hdr">${escHtml(s.label)} <span class="kanban-count">${byCol[s.id].length}</span></div>
      <div class="kanban-cards">${byCol[s.id].map(card).join('') || '<div class="kanban-empty muted small">—</div>'}</div>
    </div>`).join('')}</div>`;
}

// The four-step improvement cycle for a pdsa project. Current step (from
// framework_config.phase) is highlighted; clicking a step sets it. Plain-English
// step names — the "PDSA" acronym is never shown in this required view.
const PDSA_STEPS = [
  { id: 'plan',  label: 'Plan' },
  { id: 'do',    label: 'Do' },
  { id: 'study', label: 'Study' },
  { id: 'act',   label: 'Act' },
];
function renderPdsaCycle(c) {
  const cur = c.framework_config?.phase || 'plan';
  const fc = c.framework_config || {};
  const steps = PDSA_STEPS.map((s, i) =>
    `<button type="button" class="pdsa-step${s.id === cur ? ' active' : ''}" data-phase="${s.id}">
       <span class="pdsa-step-n">${i + 1}</span>${escHtml(s.label)}
     </button>`).join('<span class="pdsa-arrow">→</span>');
  const facts = [
    fc.aim ? `<strong>Aim:</strong> ${escHtml(fc.aim)}` : '',
    (fc.baseline != null && fc.baseline !== '') ? `<strong>Baseline:</strong> ${escHtml(String(fc.baseline))}` : '',
    (fc.target != null && fc.target !== '') ? `<strong>Target:</strong> ${escHtml(String(fc.target))}` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  return `<div class="pdsa-cycle">${steps}</div>${facts ? `<div class="pdsa-facts">${facts}</div>` : ''}`;
}

// Milestones <-> compact text (one per line), mirroring metricsToText/textToMetrics.
// Line format: `Label | Owner | YYYY-MM-DD | go/no-go criteria | x`  (trailing x = done)
function milestonesToText(ms) {
  return (ms || []).map(m =>
    [m.label || '', m.owner || '', m.due_date || '', m.criteria || '', m.done ? 'x' : ''].join(' | ').replace(/(\s\|\s*)+$/, '')
  ).join('\n');
}
function textToMilestones(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map((line, i) => {
    const [label = '', owner = '', due = '', criteria = '', done = ''] = line.split('|').map(s => s.trim());
    return {
      id: `ms_${i}_${slugify(label).slice(0, 20)}`,
      label, owner,
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : '',
      criteria,
      done: /^(x|done|✓|yes|true)$/i.test(done),
    };
  }).filter(m => m.label);
}

function renderMilestoneList(c) {
  const ms = c.framework_config?.milestones || [];
  const fc = c.framework_config || {};
  if (!ms.length) {
    return `<div class="empty muted small glide-empty">No milestones yet. Add them under <strong>Edit</strong> — one per line.</div>`;
  }
  const nextIdx = ms.findIndex(m => !m.done);
  const rows = ms.map((m, i) => {
    const overdue = !m.done && m.due_date && m.due_date < new Date().toISOString().slice(0, 10);
    return `<div class="ms-row${m.done ? ' done' : ''}${i === nextIdx ? ' next' : ''}">
      <button type="button" class="ms-check" data-i="${i}" aria-label="Toggle done">${m.done ? '✓' : ''}</button>
      <div class="ms-main">
        <div class="ms-label">${escHtml(m.label)}</div>
        ${m.criteria ? `<div class="ms-criteria">${escHtml(m.criteria)}</div>` : ''}
      </div>
      <div class="ms-meta">
        ${m.owner ? `<span class="ms-owner">${escHtml(m.owner)}</span>` : ''}
        ${m.due_date ? `<span class="ms-due${overdue ? ' overdue' : ''}">${escHtml(fmtDate(m.due_date))}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  const states = [
    fc.baseline_state ? `<strong>From:</strong> ${escHtml(fc.baseline_state)}` : '',
    fc.target_state ? `<strong>To:</strong> ${escHtml(fc.target_state)}` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  return `${states ? `<div class="ms-states">${states}</div>` : ''}<div class="ms-list">${rows}</div>`;
}

// Timeline project: a floated "next trigger" (soonest upcoming next_meeting or
// open-action due date) plus a reverse-chronological event log of entries.
function nextTriggerFor(c) {
  const today = new Date().toISOString().slice(0, 10);
  const cand = [];
  if (c.next_meeting) cand.push({ date: c.next_meeting, label: 'Next meeting' });
  for (const a of openActionsOf(c.id)) if (a.due_date) cand.push({ date: a.due_date, label: a.body });
  if (!cand.length) return null;
  const upcoming = cand.filter(x => x.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length) return { ...upcoming[0], overdue: false };
  const past = cand.sort((a, b) => b.date.localeCompare(a.date)); // most recent overdue
  return { ...past[0], overdue: true };
}
function renderTimeline(c) {
  const trig = nextTriggerFor(c);
  const head = trig
    ? `<div class="tl-next${trig.overdue ? ' overdue' : ''}">
         <span class="tl-next-tag">${trig.overdue ? 'Overdue' : 'Next'}</span>
         <span class="tl-next-date">${escHtml(fmtDate(trig.date))}</span>
         <span class="tl-next-label">${escHtml(trig.label)}</span>
       </div>`
    : `<div class="tl-next none muted small">No upcoming date set.</div>`;
  const entries = entriesOf(c.id).sort((a, b) => (b.occurred_at || '').localeCompare(a.occurred_at || ''));
  const log = entries.length
    ? `<div class="tl-log">${entries.map(e => `
        <div class="tl-event" data-entry="${e.id}">
          <span class="tl-date">${escHtml(fmtDate((e.occurred_at || '').slice(0, 10)))}</span>
          <span class="tl-kind ${escHtml(e.kind || '')}">${escHtml(e.kind || '')}</span>
          <span class="tl-title">${escHtml(e.title || '(untitled)')}</span>
        </div>`).join('')}</div>`
    : `<div class="empty muted small glide-empty">No events yet. Capture an entry to start the log.</div>`;
  return head + log;
}

function renderProjectOverview(body, c) {
  const open = openActionsOf(c.id);
  const pct = completionOf(c);
  const last = lastEntryDate(c.id);
  const isKanban = c.framework === 'kanban';
  const isPdsa = c.framework === 'pdsa';
  const isMilestone = c.framework === 'milestone';
  const isTimeline = c.framework === 'timeline';
  const kpis = [
    { label: 'Completion', value: pct + '%', tone: toneFor(pct) },
    { label: 'Open actions', value: open.length, tone: open.length === 0 ? TONE.g : open.length <= 3 ? TONE.a : TONE.r },
    { label: 'Last entry', value: last || '—', tone: null },
    { label: 'Next meeting', value: c.next_meeting ? fmtDate(c.next_meeting) : '—', tone: null },
  ];
  const owners = c.owners || [];

  // Framework-appropriate main panel: a board for kanban, a cycle+chart for
  // pdsa, else the plain glidepath.
  let panel;
  if (isKanban) {
    panel = `<div class="board-card">
      <div class="chart-label">Board <span class="framework-name">· ${escHtml(frameworkName('kanban'))}</span> <span class="framework-blurb">${escHtml(frameworkBlurb('kanban'))}</span></div>
      ${renderKanbanBoard(c)}
    </div>`;
  } else if (isPdsa) {
    const glide = renderGlidepath(c.metrics);
    panel = `<div class="chart-card">
      <div class="chart-label">Cycle <span class="framework-name">· ${escHtml(frameworkName('pdsa'))}</span> <span class="framework-blurb">${escHtml(frameworkBlurb('pdsa'))}</span></div>
      ${renderPdsaCycle(c)}
      ${glide || `<div class="empty muted small glide-empty">No measure yet. Add a metric series under <strong>Edit</strong> to track it over time.</div>`}
      ${glide ? `<div class="chart-note">● marker = an intervention recorded at that point</div>` : ''}
    </div>`;
  } else if (isMilestone) {
    panel = `<div class="chart-card">
      <div class="chart-label">Milestones <span class="framework-name">· ${escHtml(frameworkName('milestone'))}</span> <span class="framework-blurb">${escHtml(frameworkBlurb('milestone'))}</span></div>
      ${renderMilestoneList(c)}
    </div>`;
  } else if (isTimeline) {
    panel = `<div class="chart-card">
      <div class="chart-label">Timeline <span class="framework-name">· ${escHtml(frameworkName('timeline'))}</span> <span class="framework-blurb">${escHtml(frameworkBlurb('timeline'))}</span></div>
      ${renderTimeline(c)}
    </div>`;
  } else {
    const glide = renderGlidepath(c.metrics);
    panel = `<div class="chart-card">
      <div class="chart-label">Glidepath</div>
      ${glide || `<div class="empty muted small glide-empty">No glidepath yet. Add a metric series under <strong>Edit</strong> to track progress over time.</div>`}
      ${glide ? `<div class="chart-note">● marker = an intervention recorded at that point</div>` : ''}
    </div>`;
  }

  body.innerHTML = `
    <div class="overview">
      <div class="kpi-grid">${kpis.map(k => `
        <div class="kpi-card" style="background:${k.tone ? k.tone.b : '#fff'}">
          <div class="kpi-label" style="color:${k.tone ? k.tone.t : '#5a6070'}">${k.label}</div>
          <div class="kpi-value" style="color:${k.tone ? k.tone.t : '#1a2744'}">${k.value}</div>
        </div>`).join('')}
      </div>
      ${panel}
      ${owners.length ? `<div class="owners-block">
        <div class="sec-label">Owners</div>
        <div class="owners-row">${owners.map(o => `<div class="owner-card">
          <div class="owner-init" style="background:${stringColor(o)}">${escHtml(initials(o))}</div>
          <div class="owner-name">${escHtml(o)}</div>
        </div>`).join('')}</div>
      </div>` : ''}
    </div>`;

  // Wire card moves (change workflow_state) and card→entry navigation.
  body.querySelectorAll('.kanban-move').forEach(sel => {
    sel.onchange = () => {
      const a = state.atoms.find(x => x.id === sel.dataset.atom);
      if (!a) return;
      a.workflow_state = sel.value;
      a.updated_at = nowIso();
      scheduleSave();
      renderProjectOverview(body, c);
    };
  });
  body.querySelectorAll('.kanban-card-body[data-entry]').forEach(el => {
    el.onclick = () => openEntryDrawer(c.id, el.dataset.entry);
  });
  // Wire pdsa phase selection.
  body.querySelectorAll('.pdsa-step[data-phase]').forEach(btn => {
    btn.onclick = () => {
      c.framework_config = { ...(c.framework_config || {}), phase: btn.dataset.phase };
      c.updated_at = nowIso();
      scheduleSave();
      renderProjectOverview(body, c);
    };
  });
  // Wire timeline event navigation.
  body.querySelectorAll('.tl-event[data-entry]').forEach(el => {
    el.onclick = () => openEntryDrawer(c.id, el.dataset.entry);
  });
  // Wire glidepath point clicks → annotate (F2/F3).
  body.querySelectorAll('.glide-hit').forEach(el => {
    el.addEventListener('click', () => openChartAnnotation(c, Number(el.dataset.mi), Number(el.dataset.idx)));
  });
  // Wire milestone done toggles.
  body.querySelectorAll('.ms-check[data-i]').forEach(btn => {
    btn.onclick = () => {
      const ms = c.framework_config?.milestones;
      const i = Number(btn.dataset.i);
      if (!Array.isArray(ms) || !ms[i]) return;
      ms[i].done = !ms[i].done;
      c.updated_at = nowIso();
      scheduleSave();
      renderProjectOverview(body, c);
    };
  });
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

// Core text intake: any raw text → an Inbox entry, one click from Atomize.
// Shared by file import, the Paste-from-Copilot freetext path, and the
// decisions-review stale-entry fallback.
function importText(text, { title, kind = 'freetext', open = true } = {}) {
  const inbox = getOrCreateInbox();
  const e = {
    id: uid(),
    container_id: inbox.id,
    kind,
    occurred_at: nowIso(),
    title: title || titleFromMarkdown(text, 'Imported note'),
    participants: [],
    tags: [],
    notes: text,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  state.entries.push(e);
  scheduleSave();
  // Land in the drawer with notes pre-filled — one click from "Atomize notes".
  if (open) openEntryDrawer(inbox.id, e.id);
  return e;
}

function importTextFile(file) {
  const reader = new FileReader();
  reader.onerror = () => alert('Could not read that file.');
  reader.onload = () => {
    const text = String(reader.result || '');
    // kind 'meeting': imported files are typically .loop/meeting recaps.
    importText(text, { title: titleFromMarkdown(text, file.name), kind: 'meeting' });
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

// Group projects under their parent program for <optgroup> pickers (T24) —
// a dozen projects across several programs is unscannable as one flat list.
// Returns [{label, items}] in program-title order; standalone projects last.
function groupProjectsByProgram(projs) {
  const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '');
  const programs = state.containers
    .filter(c => c.type === 'program' && c.status !== 'archived')
    .sort(byTitle);
  const groups = [];
  const used = new Set();
  for (const g of programs) {
    const kids = projs.filter(p => p.program_id === g.id).sort(byTitle);
    if (!kids.length) continue;
    kids.forEach(k => used.add(k.id));
    groups.push({ label: g.title || 'Program', items: kids });
  }
  const rest = projs.filter(p => !used.has(p.id)).sort(byTitle);
  if (rest.length) groups.push({ label: groups.length ? 'Projects — no program' : 'Projects', items: rest });
  return groups;
}

function renderContainerPickerOptions(selectedId) {
  const projects   = state.containers.filter(c => c.type === 'project'        && c.status !== 'archived');
  const references = state.containers.filter(c => c.type === 'reference_file' && c.status !== 'archived');
  const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '');
  references.sort(byTitle);

  const opt = (id, label) =>
    `<option value="${escHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escHtml(label)}</option>`;

  return `
    <optgroup label="Inbox">
      ${opt(INBOX_ID, 'Inbox')}
    </optgroup>
    ${groupProjectsByProgram(projects).map(g =>
      `<optgroup label="${escHtml(g.label)}">${g.items.map(c => opt(c.id, c.title)).join('')}</optgroup>`).join('')}
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
      <div class="tools">
        <select class="atom-kind-sel" data-atom-kind title="Change type">
          <option value="observation"${atom.kind === 'observation' ? ' selected' : ''}>Observation</option>
          <option value="decision"${atom.kind === 'decision' ? ' selected' : ''}>Decision</option>
          <option value="action"${atom.kind === 'action' ? ' selected' : ''}>Action</option>
          <option value="outcome"${atom.kind === 'outcome' ? ' selected' : ''}>Outcome</option>
        </select>
        <button class="btn ghost tiny" data-atom-delete title="Delete">×</button>
      </div>
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

// Re-type an atom (the AI mis-classifies ~30-50% of the time, so this is a
// frequent correction). Fix up kind-specific fields: gaining 'action' seeds
// assigned_to/due_date, leaving it drops them; gaining 'outcome' seeds
// parent_atom_id, leaving it drops the link so it no longer closes whatever
// action it pointed at. Open/closed stays a derived property.
function changeAtomKind(atom, newKind) {
  if (!atom || atom.kind === newKind) return;
  atom.kind = newKind;
  if (newKind === 'action') {
    if (typeof atom.assigned_to !== 'string') atom.assigned_to = '';
    if (typeof atom.due_date !== 'string') atom.due_date = '';
  } else {
    delete atom.assigned_to;
    delete atom.due_date;
  }
  if (newKind === 'outcome') {
    if (!('parent_atom_id' in atom)) atom.parent_atom_id = null;
  } else {
    delete atom.parent_atom_id;
  }
  atom.updated_at = nowIso();
  scheduleSave();
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

  item.querySelector('[data-atom-kind]')?.addEventListener('change', (ev) => {
    const newKind = ev.target.value;
    if (newKind === atom.kind) return;
    changeAtomKind(atom, newKind);
    renderDrawerInner(entryId); // re-buckets the atom into its new section
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
// The text format encodes interventions as `idx:label`. An intervention may
// ALSO carry an optional `atom_id` (set by clicking the chart, F2/F3) — that
// isn't in the text, so we preserve it from `prevMetrics` by matching label+idx
// so editing the metric text doesn't drop chart-linked atoms.
function textToMetrics(text, prevMetrics = null) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [label, target, data, ivs] = line.split('|').map(s => (s || '').trim());
    const series = { label: label || 'metric' };
    if (target !== '' && target != null && !isNaN(parseFloat(target))) series.target = parseFloat(target);
    series.data = (data || '').split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    const prev = Array.isArray(prevMetrics) ? prevMetrics.find(m => m.label === series.label) : null;
    series.interventions = (ivs || '').split(';').map(s => s.trim()).filter(Boolean).map(tok => {
      const [idx, ...rest] = tok.split(':');
      const iv = { idx: parseInt(idx, 10), label: rest.join(':').trim() };
      const prevIv = prev && (prev.interventions || []).find(p => p.idx === iv.idx);
      if (prevIv && prevIv.atom_id) iv.atom_id = prevIv.atom_id;
      return iv;
    }).filter(iv => !isNaN(iv.idx));
    if (series.data.length) out.push(series);
  }
  return out;
}

// ---------- Guided project wizard (shape wizard) -------------------
// Three plain-English questions (no PM jargon) + a description → POST
// /api/classify → an editable recommendation (openProjectRecommendation, C4).

const WIZARD_Q1 = [
  { v: 'outcome',  label: 'Improving a number or outcome over time' },
  { v: 'build',    label: 'Building or rolling out something in phases' },
  { v: 'pipeline', label: 'Moving pieces of work through stages' },
  { v: 'dates',    label: 'Staying on top of key dates and deadlines' },
];
const WIZARD_Q2 = [
  { v: 'metric',     label: 'When a number reaches a target' },
  { v: 'tasks',      label: 'When a set of tasks is finished' },
  { v: 'published',  label: 'When something is published or goes live' },
  { v: 'open_ended', label: "It doesn't really have a finish line" },
];

function radioGroup(name, options, checked) {
  return `<div class="wiz-options">${options.map(o => `
    <label class="wiz-opt">
      <input type="radio" name="${name}" value="${o.v}"${o.v === checked ? ' checked' : ''} />
      <span>${escHtml(o.label)}</span>
    </label>`).join('')}</div>`;
}

function openProjectWizard() {
  openModal(`
    <h2>✦ New project</h2>
    <p class="wiz-lede">Answer a couple of quick questions and Throughline will set it up the right way. You can change anything afterward.</p>
    <label class="field">
      <span class="label">What is this about?</span>
      <textarea id="wiz-desc" placeholder="A sentence or two — e.g. “Improve our lagging CAHPS access measure with provider coaching and a comms push.”"></textarea>
    </label>
    <div class="field">
      <span class="label">What are you working toward?</span>
      ${radioGroup('wiz-q1', WIZARD_Q1)}
    </div>
    <div class="field">
      <span class="label">How will you know it's done?</span>
      ${radioGroup('wiz-q2', WIZARD_Q2)}
    </div>
    <div class="field" id="wiz-q3-wrap" hidden>
      <span class="label">Do you already know the measure and how to track it?</span>
      ${radioGroup('wiz-q3', [{ v: 'yes', label: 'Yes, I know the measure' }, { v: 'no', label: 'Not yet' }])}
    </div>
    <details class="wiz-excerpt">
      <summary>Paste text from a document (optional)</summary>
      <textarea id="wiz-excerpt" placeholder="Paste any relevant excerpt — used only to suggest a structure."></textarea>
    </details>
    <div id="wiz-error" class="wiz-error" hidden></div>
    <div class="modal-actions">
      <button class="btn ghost" data-act="manual">Skip — set up manually</button>
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="suggest">Get suggestion →</button>
    </div>
  `, (modal) => {
    // Q3 only matters when the goal is a measurable outcome.
    const toggleQ3 = () => {
      const g = modal.querySelector('input[name="wiz-q1"]:checked')?.value;
      modal.querySelector('#wiz-q3-wrap').hidden = g !== 'outcome';
    };
    modal.querySelectorAll('input[name="wiz-q1"]').forEach(r => r.addEventListener('change', toggleQ3));

    modal.querySelector('[data-act="cancel"]').onclick = closeModal;
    modal.querySelector('[data-act="manual"]').onclick = () => { closeModal(); openNewContainerModal('project'); };
    modal.querySelector('[data-act="suggest"]').onclick = async () => {
      const description = modal.querySelector('#wiz-desc').value.trim();
      const excerpt = modal.querySelector('#wiz-excerpt').value.trim();
      const goal = modal.querySelector('input[name="wiz-q1"]:checked')?.value;
      const done = modal.querySelector('input[name="wiz-q2"]:checked')?.value;
      const metric_known = modal.querySelector('input[name="wiz-q3"]:checked')?.value;
      const err = modal.querySelector('#wiz-error');
      if (!description) { err.textContent = 'Add a sentence about what this is.'; err.hidden = false; return; }

      // "No defined end" → this is reference material, not a project.
      if (done === 'open_ended') {
        closeModal();
        openNewContainerModal('reference_file', { presetTitle: titleFromDescription(description) });
        return;
      }

      const btn = modal.querySelector('[data-act="suggest"]');
      btn.disabled = true; btn.textContent = 'Thinking…'; err.hidden = true;
      try {
        const r = await fetch('/api/classify', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ description, excerpt, answers: { goal, done, metric_known } }),
        });
        if (!r.ok) throw new Error(`classify ${r.status}`);
        const rec = await r.json();
        openProjectRecommendation(rec, { description });
      } catch (e) {
        console.error(e);
        btn.disabled = false; btn.textContent = 'Get suggestion →';
        err.textContent = "Couldn't get a suggestion. You can still set it up manually.";
        err.hidden = false;
      }
    };
  });
}

// First heading-ish words of a description → a starter title.
function titleFromDescription(desc) {
  const first = String(desc || '').split(/[.\n]/)[0].trim();
  return first.length > 60 ? first.slice(0, 57) + '…' : first;
}

// Editable recommendation preview. The user can adjust the title, the shape
// (framework), the measure, and the first step before committing. Program
// recommendations show their subprojects; full program provisioning lands in
// D4 — until then a program is created as one project the user can split later.
function openProjectRecommendation(rec, { description = '' } = {}) {
  if (rec.is_program) return openProgramRecommendation(rec, { description });
  const presetTitle = titleFromDescription(description);
  const phases = (rec.suggested_phases_or_states || []);
  openModal(`
    <h2>Here's a suggested setup</h2>
    <p class="wiz-lede">${escHtml(rec.reason || '')}</p>
    <label class="field">
      <span class="label">Project name</span>
      <input type="text" id="rec-title" value="${escHtml(presetTitle)}" />
    </label>
    <label class="field">
      <span class="label">How will you work this?</span>
      ${frameworkSelectHtml(rec.framework || 'milestone')}
    </label>
    ${phases.length ? `<div class="field"><span class="label">Suggested steps</span>
      <div class="rec-chips">${phases.map(p => `<span class="chip-static">${escHtml(p)}</span>`).join('')}</div></div>` : ''}
    <label class="field">
      <span class="label">Measure (optional)</span>
      <input type="text" id="rec-metric" value="${escHtml(rec.suggested_metric || '')}" placeholder="What number tells you it's working?" />
    </label>
    <label class="field">
      <span class="label">First step</span>
      <input type="text" id="rec-first" value="${escHtml(rec.first_action || '')}" />
    </label>
    <div class="modal-actions">
      <button class="btn ghost" data-act="back">← Back</button>
      <button class="btn primary" data-act="create">Create it</button>
    </div>
  `, (modal) => {
    modal.querySelector('[data-act="back"]').onclick = () => openProjectWizard();
    modal.querySelector('[data-act="create"]').onclick = () => {
      provisionFromRecommendation(rec, {
        description,
        title: modal.querySelector('#rec-title').value.trim() || presetTitle || 'New project',
        framework: modal.querySelector('#m-framework').value || '',
        metric: modal.querySelector('#rec-metric').value.trim(),
        first_action: modal.querySelector('#rec-first').value.trim(),
      });
    };
  });
}

// Program recommendation: an editable program name + objective and the list of
// suggested subprojects (each name + framework editable), provisioned together.
function openProgramRecommendation(rec, { description = '' } = {}) {
  const presetTitle = titleFromDescription(description);
  const subs = rec.if_program_subprojects;
  openModal(`
    <h2>This looks like a program</h2>
    <p class="wiz-lede">${escHtml(rec.reason || '')} You can adjust anything before creating it.</p>
    <label class="field">
      <span class="label">Program name</span>
      <input type="text" id="rec-title" value="${escHtml(presetTitle)}" />
    </label>
    <label class="field">
      <span class="label">Objective</span>
      <input type="text" id="rec-objective" value="${escHtml(description)}" />
    </label>
    <div class="field">
      <span class="label">Projects to create (${subs.length})</span>
      <div class="rec-sublist">${subs.map((s, i) => `
        <div class="rec-subedit">
          <input type="text" class="sub-name" data-i="${i}" value="${escHtml(s.name)}" />
          ${frameworkSelectHtml(s.framework).replace('id="m-framework"', `class="sub-fw" data-i="${i}"`)}
        </div>`).join('')}</div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" data-act="back">← Back</button>
      <button class="btn primary" data-act="create">Create program</button>
    </div>
  `, (modal) => {
    modal.querySelector('[data-act="back"]').onclick = () => openProjectWizard();
    modal.querySelector('[data-act="create"]').onclick = () => {
      const editedSubs = subs.map((s, i) => ({
        name: modal.querySelector(`.sub-name[data-i="${i}"]`).value.trim() || s.name,
        framework: modal.querySelector(`.sub-fw[data-i="${i}"]`).value || s.framework,
      }));
      provisionProgram(rec, {
        description,
        title: modal.querySelector('#rec-title').value.trim() || presetTitle || 'New program',
        objective: modal.querySelector('#rec-objective').value.trim(),
        subprojects: editedSubs,
      });
    };
  });
}

// Create a program + each subproject (with framework + a first action) and
// navigate to the program dashboard.
function provisionProgram(rec, { description = '', title = '', objective = '', subprojects = [] } = {}) {
  const pid = uniqueSlug(slugify(title || 'program'));
  state.containers.push({
    id: pid, type: 'program', title: title || 'New program',
    goal_or_purpose: '', summary: description, tags: [], status: 'active',
    objective: objective || '', key_results: [],
    created_at: nowIso(), updated_at: nowIso(),
  });
  for (const s of subprojects) {
    const cid = uniqueSlug(slugify(s.name || 'project'));
    const c = {
      id: cid, type: 'project', title: s.name || 'Project',
      goal_or_purpose: '', summary: '', tags: [], status: 'active',
      program_id: pid, created_at: nowIso(), updated_at: nowIso(),
    };
    if (s.framework && FRAMEWORKS[s.framework]) {
      c.framework = s.framework;
      c.framework_config = frameworkConfigFor(s.framework);
    }
    state.containers.push(c);
    seedFirstAction(cid, 'Outline the first concrete step for this project.');
  }
  if (rec.first_action) seedFirstAction(pid, rec.first_action);
  scheduleSave();
  closeModal();
  location.hash = `#/c/${encodeURIComponent(pid)}`;
}

// Provision a single project from the (possibly edited) recommendation. Seeds
// the chosen framework + a first-action atom so the project starts with
// momentum. For pdsa, an entered measure is stored as the cycle aim.
function provisionFromRecommendation(rec, { description = '', title = '', framework = '', metric = '', first_action = '' } = {}) {
  const id = uniqueSlug(slugify(title || 'project'));
  const c = {
    id, type: 'project', title: title || 'New project',
    goal_or_purpose: '', summary: description, tags: [], status: 'active',
    created_at: nowIso(), updated_at: nowIso(),
  };
  if (framework && FRAMEWORKS[framework]) {
    c.framework = framework;
    c.framework_config = frameworkConfigFor(framework);
    if (framework === 'pdsa' && metric) c.framework_config.aim = metric;
  }
  state.containers.push(c);
  if (first_action) seedFirstAction(c.id, first_action);
  scheduleSave();
  closeModal();
  location.hash = `#/c/${encodeURIComponent(id)}`;
}

// Create an entry + a single open action atom holding the suggested first step.
// Entries/atoms use uid() (globally unique) — NOT uniqueSlug, which only dedupes
// container ids and would collide across multiple seeded entries.
function seedFirstAction(containerId, body) {
  const eid = uid();
  state.entries.push({
    id: eid, container_id: containerId, kind: 'freetext',
    occurred_at: nowIso(), title: 'Getting started', participants: [], tags: [],
    notes: '', created_at: nowIso(), updated_at: nowIso(),
  });
  state.atoms.push({
    id: uid(), entry_id: eid, kind: 'action',
    body: String(body), tags: [], created_at: nowIso(), updated_at: nowIso(),
  });
}

// ---------- Programs (strategic tier above projects) ---------------

const programs = () => state.containers.filter(c => c.type === 'program' && c.status !== 'archived');

// Key results <-> compact text. Line: `Label | current | target | unit`.
function keyResultsToText(krs) {
  return (krs || []).map(k =>
    [k.label || '', k.current ?? '', k.target ?? '', k.unit || ''].join(' | ').replace(/(\s\|\s*)+$/, '')
  ).join('\n');
}
function textToKeyResults(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map((line, i) => {
    const [label = '', current = '', target = '', unit = ''] = line.split('|').map(s => s.trim());
    const num = (v) => (v === '' || isNaN(Number(v)) ? v : Number(v));
    return { id: `kr_${i}_${slugify(label).slice(0, 16)}`, label, current: num(current), target: num(target), unit };
  }).filter(k => k.label);
}

// A <select> of existing programs (for linking a project/reference). Empty =
// standalone. Used in the project create/edit modals.
function programSelectHtml(selected = '') {
  const opts = ['<option value="">— none (standalone) —</option>']
    .concat(programs().map(p => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${escHtml(p.title)}</option>`));
  return `<select id="m-program">${opts.join('')}</select>`;
}

function openNewProgramModal() {
  openModal(`
    <h2>New program</h2>
    <p class="wiz-lede">A program groups a few related projects under one goal — use it when work spans several different efforts.</p>
    <label class="field">
      <span class="label">Title</span>
      <input type="text" id="m-title" autofocus />
    </label>
    <label class="field">
      <span class="label">Objective</span>
      <input type="text" id="m-objective" placeholder="The one outcome this program is driving toward" />
    </label>
    <label class="field">
      <span class="label">Key results (optional)</span>
      <textarea id="m-krs" class="metrics-input" placeholder="Transfer-rate variance | 12 | 5 | %"></textarea>
      <span class="field-hint">One per line: <code>Label | current | target | unit</code></span>
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
      const id = uniqueSlug(slugify(title));
      const c = {
        id, type: 'program', title,
        goal_or_purpose: '', summary: '', tags: [], status: 'active',
        objective: modal.querySelector('#m-objective').value.trim(),
        key_results: textToKeyResults(modal.querySelector('#m-krs').value),
        created_at: nowIso(), updated_at: nowIso(),
      };
      state.containers.push(c);
      scheduleSave();
      closeModal();
      location.hash = `#/c/${encodeURIComponent(id)}`;
    };
  });
}

function openEditProgramModal(c) {
  openModal(`
    <h2>Edit program</h2>
    <label class="field"><span class="label">Title</span>
      <input type="text" id="m-title" value="${escHtml(c.title)}" /></label>
    <label class="field"><span class="label">Objective</span>
      <input type="text" id="m-objective" value="${escHtml(c.objective || '')}" placeholder="The one outcome this program is driving toward" /></label>
    <label class="field"><span class="label">Key results</span>
      <textarea id="m-krs" class="metrics-input" placeholder="Transfer-rate variance | 12 | 5 | %">${escHtml(keyResultsToText(c.key_results))}</textarea>
      <span class="field-hint">One per line: <code>Label | current | target | unit</code></span></label>
    <label class="field"><span class="label">Status (RAG)</span>
      ${ragSelectHtml(c.rag || '')}
      <span class="field-hint">Auto = the worst status among this program's projects.</span></label>
    <div class="modal-actions">
      <button class="btn danger" data-act="archive">${c.status === 'archived' ? 'Unarchive' : 'Archive'}</button>
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="save">Save</button>
    </div>
  `, (modal) => {
    modal.querySelector('[data-act="cancel"]').onclick = closeModal;
    modal.querySelector('[data-act="archive"]').onclick = () => {
      c.status = c.status === 'archived' ? 'active' : 'archived';
      c.updated_at = nowIso(); scheduleSave(); closeModal();
      location.hash = c.status === 'archived' ? '#/' : `#/c/${encodeURIComponent(c.id)}`;
      if (c.status !== 'archived') render();
    };
    modal.querySelector('[data-act="save"]').onclick = () => {
      c.title = modal.querySelector('#m-title').value.trim() || c.title;
      c.objective = modal.querySelector('#m-objective').value.trim();
      c.key_results = textToKeyResults(modal.querySelector('#m-krs').value);
      const ragVal = modal.querySelector('#m-rag')?.value || '';
      if (ragVal) c.rag = ragVal; else delete c.rag;
      c.updated_at = nowIso(); scheduleSave(); closeModal(); render();
    };
  });
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
    </div>
    <label class="field">
      <span class="label">How will you work this?</span>
      ${frameworkSelectHtml('')}
      <span class="field-hint">Pick the shape that fits — it sets up the right view. You can change it later.</span>
    </label>
    ${programs().length ? `<label class="field">
      <span class="label">Part of a program?</span>
      ${programSelectHtml('')}
    </label>` : ''}` : '';
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
        const framework = modal.querySelector('#m-framework')?.value || '';
        if (framework && FRAMEWORKS[framework]) {
          c.framework = framework;
          c.framework_config = frameworkConfigFor(framework);
        }
        const programId = modal.querySelector('#m-program')?.value || '';
        if (programId) c.program_id = programId;
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
      <span class="label">How will you work this?</span>
      ${frameworkSelectHtml(c.framework || '')}
      <span class="field-hint">Changing the shape resets that view's scaffold.</span>
    </label>
    ${programs().length ? `<label class="field">
      <span class="label">Part of a program?</span>
      ${programSelectHtml(c.program_id || '')}
    </label>` : ''}
    <label class="field">
      <span class="label">Milestones</span>
      <textarea id="m-milestones" class="metrics-input" placeholder="Pick vendor | Noah | 2026-06-15 | signed SOW | x">${escHtml(milestonesToText(c.framework_config?.milestones))}</textarea>
      <span class="field-hint">One per line: <code>Label | owner | YYYY-MM-DD | criteria | x</code> (trailing <code>x</code> = done). Shown when this project's shape is milestones.</span>
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
    <label class="field">
      <span class="label">Status (RAG)</span>
      ${ragSelectHtml(c.rag || '')}
      <span class="field-hint">Leave on Auto to derive from open/overdue work, or set it by hand.</span>
    </label>
    ${projectFields}
    <div class="modal-actions">
      ${isProject ? `<button class="btn ghost" data-act="to-reference" title="Turn this into an ongoing reference file (keeps all entries)">→ Reference file</button>` : ''}
      ${c.type === 'reference_file' ? `<button class="btn ghost" data-act="to-project" title="Turn this into a tracked project (Overview, framework, glidepath)">→ Project</button>` : ''}
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
    modal.querySelector('[data-act="to-reference"]')?.addEventListener('click', () => convertProjectToReference(c));
    modal.querySelector('[data-act="to-project"]')?.addEventListener('click', () => convertReferenceToProject(c));
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
      const ragVal = modal.querySelector('#m-rag')?.value || '';
      if (ragVal) c.rag = ragVal; else delete c.rag;
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
        const framework = modal.querySelector('#m-framework').value || '';
        if (framework && FRAMEWORKS[framework]) {
          if (c.framework !== framework) c.framework_config = frameworkConfigFor(framework);
          c.framework = framework;
          if (framework === 'milestone') {
            const milestones = textToMilestones(modal.querySelector('#m-milestones').value);
            c.framework_config = { ...(c.framework_config || {}), milestones };
          }
        } else {
          delete c.framework;
          delete c.framework_config;
        }
        c.metrics = textToMetrics(modal.querySelector('#m-metrics').value, c.metrics);
        if (!c.metrics.length) delete c.metrics;
        const programSel = modal.querySelector('#m-program');
        if (programSel) {
          const pid = programSel.value || '';
          if (pid) c.program_id = pid; else delete c.program_id;
        }
      }
      c.updated_at = nowIso();
      scheduleSave();
      closeModal();
      render();
    };
  });
}

// Convert a project → reference file. Non-destructive: all entries/atoms stay
// attached (they key off the stable container id), and the project-only fields
// (framework/framework_config/metrics/owners/completion/next_meeting/category/
// emoji/color) are KEPT but go dormant — the reference view just doesn't read
// them, so the change is reversible. The program link is cleared (a reference
// isn't shown as a subproject). A warning summarizes what stops showing.
function convertProjectToReference(c) {
  if (c.type !== 'project') return;
  const atoms = atomsOfContainer(c.id);
  const openActions = atoms.filter(a => a.kind === 'action' && !outcomeForAction(a.id)).length;
  const dormant = [];
  if (c.framework) dormant.push(`the ${frameworkName(c.framework) || 'framework'} view`);
  if ((c.metrics || []).length) dormant.push(`${c.metrics.length} glidepath metric${c.metrics.length > 1 ? 's' : ''}`);
  if ((c.owners || []).length) dormant.push('the owners list');

  const lines = [
    `Convert “${c.title}” from a project into a reference file?`,
    ``,
    `Nothing is deleted — every entry and atom stays exactly where it is. What changes:`,
    `• The project Overview goes away${dormant.length ? ` (${dormant.join(', ')} stop showing)` : ''}. That data is kept on the record and comes back if you convert it to a project again.`,
  ];
  if (openActions) lines.push(`• ${openActions} open action${openActions > 1 ? 's' : ''} won't be summarized here anymore, but stay in the entry list and the People view.`);
  if (c.program_id) lines.push(`• It will be unlinked from its program (references aren't shown as subprojects).`);
  lines.push(``, `Proceed?`);

  if (!confirm(lines.join('\n'))) return;
  c.type = 'reference_file';
  if (c.program_id) delete c.program_id;
  c.updated_at = nowIso();
  scheduleSave();
  closeModal();
  render();
}

// Convert a reference file → project (the reverse of the above). Non-destructive:
// entries/atoms stay attached, and any dormant project fields kept from a prior
// project→reference round-trip light back up. A reference that was never a
// project simply becomes an unstructured project (framework null) — pick a shape
// and add owners/metrics in the same Edit modal. Ensures the project shape
// (framework/framework_config) so render code can rely on it this session.
function convertReferenceToProject(c) {
  if (c.type !== 'reference_file') return;
  const hadMeta = !!(c.framework || (c.metrics || []).length || (c.owners || []).length);
  const lines = [
    `Convert “${c.title}” from a reference file into a project?`,
    ``,
    `Every entry and atom stays attached. It gains the project Overview — KPIs, a framework view, owners and a glidepath.`,
    hadMeta
      ? `Its previous project settings (framework / metrics / owners) come back.`
      : `It starts unstructured — pick a framework (or leave it as-is) and add owners/metrics here in Edit.`,
    ``,
    `Proceed?`,
  ];
  if (!confirm(lines.join('\n'))) return;
  c.type = 'project';
  if (c.framework === undefined) c.framework = null;
  if (!c.framework_config || typeof c.framework_config !== 'object') c.framework_config = {};
  c.updated_at = nowIso();
  scheduleSave();
  closeModal();
  render();
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

// Who produced this draft (T8). Three states: the model ran; the model was
// configured but degraded to the heuristic (the previously-invisible case);
// no model configured at all. Decisions mode (v2) names the session instead.
function triageProvenance() {
  if (triage.mode === 'decisions') {
    return `${triage.engine || 'Copilot'} decision set · ${triage.sessionId || 'unknown session'}${triage.info?.versionStale ? ' · ⚠ answers an older draft' : ''}`;
  }
  if (triage.source === 'llm') return `draft by ${triage.llm || 'model'}`;
  if (triage.llm) return `heuristic draft — ${triage.llm} failed${triage.fail ? `: ${triage.fail}` : ''}`;
  return 'heuristic draft (no model configured)';
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
  // T12: model runs on a big entry can take a minute+ — show a live elapsed
  // counter + Cancel (same pattern as the consult chat) instead of freezing.
  panel.innerHTML = `<div class="triage-loading">Atomizing notes… <span id="atomize-elapsed">0</span>s
    <div class="muted small" style="margin-top:6px">Model runs can take a minute or two on large entries.</div>
    <button class="btn" data-act="t-cancel" style="margin-top:10px">Cancel</button></div>`;
  const abort = new AbortController();
  const ticker = setInterval(() => {
    const el = document.getElementById('atomize-elapsed');
    if (el) el.textContent = String(Number(el.textContent) + 1);
    else clearInterval(ticker); // overlay replaced/closed
  }, 1000);
  panel.querySelector('[data-act="t-cancel"]').onclick = () => abort.abort();

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
      signal: abort.signal,
    });
    if (!r.ok) throw new Error(`atomize ${r.status}`);
    data = await r.json();
  } catch (err) {
    clearInterval(ticker);
    if (err.name === 'AbortError') { closeTriage(); return; } // user cancelled
    panel.innerHTML = `<div class="triage-loading">Atomize failed: ${escHtml(err.message)}<br/><button class="btn" data-act="t-close">Close</button></div>`;
    panel.querySelector('[data-act="t-close"]').onclick = closeTriage;
    return;
  }
  clearInterval(ticker);

  // ATOMIZE_ON_FAIL=error (T20): no fallback draft — show the failure and let
  // the user retry, rather than handing them a heuristic spray to clean up.
  if (data.source === 'none') {
    panel.innerHTML = `<div class="triage-loading">Atomize failed: ${escHtml(data.fail || 'model error')}<br/>
      <span class="muted small">No draft was produced (fallback is disabled). Re-run Atomize to retry.</span><br/>
      <button class="btn" data-act="t-close" style="margin-top:10px">Close</button></div>`;
    panel.querySelector('[data-act="t-close"]').onclick = closeTriage;
    return;
  }

  triage = {
    entryId,
    source: data.source || 'heuristic',
    llm: data.llm || null, // model the provider would use; null = heuristic-only config (T8)
    fail: data.fail || null, // why the model path degraded, when it did (T20)
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
    createdIds: [], // containers created during THIS triage (→ proposed{} in the export bundle)
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
  const refs = referenceFiles();

  const optionsFor = (cur) => {
    let opts = `<option value="__none__"${!cur ? ' selected' : ''}>— Unassigned —</option>`;
    for (const g of groupProjectsByProgram(projs)) {
      opts += `<optgroup label="${escHtml(g.label)}">`;
      for (const p of g.items) opts += `<option value="${escHtml(p.id)}"${cur === p.id ? ' selected' : ''}>${escHtml(p.title)}</option>`;
      opts += `</optgroup>`;
    }
    if (refs.length) {
      opts += `<optgroup label="Reference files">`;
      for (const p of refs) opts += `<option value="${escHtml(p.id)}"${cur === p.id ? ' selected' : ''}>${escHtml(p.title)}</option>`;
      opts += `</optgroup>`;
    }
    // Decisions mode (v2): Copilot's proposed new containers as commit-time
    // placeholders — selectable now, created only when the user commits.
    if (triage.mode === 'decisions' && (triage.pendingCreates || []).length) {
      opts += `<optgroup label="New — created on commit">`;
      for (const pc of triage.pendingCreates) {
        const v = `__pending__:${pc.pid}`;
        opts += `<option value="${escHtml(v)}"${cur === v ? ' selected' : ''}>+ ${escHtml(pc.title)} (${pc.kind === 'project' ? 'project' : 'reference'})</option>`;
      }
      opts += `</optgroup>`;
    }
    opts += `<option value="__new__">+ New project…</option>`;
    opts += `<option value="__newref__">+ New reference file…</option>`;
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
    else if (same && String(targets[0]).startsWith('__pending__:')) badge = `<span class="t-suggest">＋ new container on commit</span>`;
    else if (allAssigned) badge = `<span class="t-suggest">split across projects</span>`;
    else if (!c.suggestedId) badge = `<span class="t-orphan">⚠ no matching project</span>`;
    // "AI suggests" only when a model actually produced the draft — a heuristic
    // keyword match labeled as AI was indistinguishable from a real run (T8).
    else { const s = getContainer(c.suggestedId); badge = s ? `<span class="t-suggest" style="color:${projectColor(s)}">${triage.source === 'llm' ? 'AI suggests' : 'keyword match'}: ${escHtml(s.title)}</span>` : ''; }

    const pills = [];
    if (counts.obs) pills.push(`<span class="t-pill o">OBS ${counts.obs}</span>`);
    if (counts.dec) pills.push(`<span class="t-pill d">DEC ${counts.dec}</span>`);
    if (counts.act) pills.push(`<span class="t-pill a">ACT ${counts.act}</span>`);

    let control;
    if (triage.newForm[c.id]) {
      const nf = triage.newForm[c.id];
      const isRef = nf.type === 'reference_file';
      control = `<div class="t-newform">
        <input type="text" data-tnew="${escHtml(c.id)}" placeholder="${isRef ? 'Reference file name…' : 'Project name…'}" value="${escHtml(nf.value || '')}" />
        <button class="btn tiny primary" data-tnew-create="${escHtml(c.id)}">Create ${isRef ? 'reference' : 'project'}</button>
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

  const countTarget = (p) => {
    let n = 0;
    for (const c of triage.clusters) for (const a of c.atoms) if (triageTarget(c, a.key) === p.id) n++;
    return n;
  };
  const chipHtml = (p, n) => `<div class="t-projchip${n ? ' active' : ''}"${n ? ` style="border-color:${projectColor(p)}"` : ''}>
      <span>${escHtml(p.title)}</span>${n ? `<span class="t-projchip-n" style="background:${projectColor(p)}">${n}</span>` : ''}
    </div>`;
  const projChips = projs.map(p => chipHtml(p, countTarget(p))).join('');
  const refChips = refs.map(p => [p, countTarget(p)]).filter(([, n]) => n).map(([p, n]) => chipHtml(p, n)).join('');

  // Decisions mode (v2): the gate's warnings + what Copilot dropped or never
  // addressed — visible, never silently lost (the raw dump keeps everything).
  let extras = '';
  if (triage.mode === 'decisions') {
    const warns = triage.warnings || [];
    const drops = triage.dropped || [];
    const unaddr = triage.unaddressed || [];
    extras =
      (warns.length ? `<div class="t-warnings">${warns.map(w => `<div class="t-warning">⚠ ${escHtml(w.msg)}</div>`).join('')}</div>` : '') +
      ((drops.length || unaddr.length) ? `<div class="t-dropped">
        ${drops.length ? `<details><summary>Dropped by Copilot (${drops.length})</summary>${drops.map(d => `<div class="t-dropped-item">${escHtml(d.body)}${d.note ? ` <span class="muted">— ${escHtml(d.note)}</span>` : ''}</div>`).join('')}</details>` : ''}
        ${unaddr.length ? `<details><summary>Not addressed by Copilot (${unaddr.length}) — kept only in the entry notes</summary>${unaddr.map(d => `<div class="t-dropped-item">${escHtml(d.body)}</div>`).join('')}</details>` : ''}
      </div>` : '');
  }

  panel.innerHTML = `
    <div class="t-header">
      <div>
        <div class="t-eyebrow">Throughline · ${triage.mode === 'decisions' ? 'Decision review' : 'Entry triage'} · ${escHtml(triageProvenance())}</div>
        <div class="t-title">${escHtml(entry.title || '(untitled)')}</div>
        <div class="t-sub">${fmtDate(entry.occurred_at)}${(entry.participants || []).length ? ' · ' + escHtml(entry.participants.join(', ')) : ''}</div>
      </div>
      <div class="t-progress">
        <div class="t-progress-count${done ? ' done' : ''}">${assigned}/${total}</div>
        <div class="t-progress-label">atoms assigned</div>
        <button class="triage-close" aria-label="Close">×</button>
      </div>
    </div>
    ${extras}
    <div class="t-body">
      <div class="t-clusters">${clustersHTML || '<div class="empty muted">Nothing to atomize.</div>'}</div>
      <div class="t-sidebar">
        <div class="t-sidebar-label">Projects</div>
        ${projChips || '<div class="muted small">No projects yet.</div>'}
        ${refChips ? `<div class="t-sidebar-label">Reference files</div>${refChips}` : ''}
        <div class="t-commit">
          <button class="btn primary ${done ? 'ready' : ''}" data-act="t-commit">${done ? '✓ Commit entry' : 'Commit entry →'}</button>
          ${total - assigned ? `<div class="t-commit-hint">${total - assigned} unassigned → stay on this entry</div>` : ''}
          <button class="btn t-chat-btn" data-act="t-consult">💬 Chat about this</button>
          <div class="t-commit-hint">Native consult — read-only, files nothing.</div>
          <button class="btn t-chat-btn" data-act="t-export">⬇ Export for Copilot</button>
          <div class="t-commit-hint">Secondary engine — bundle file + paste loop.</div>
        </div>
      </div>
    </div>`;

  wireTriage();
}

function wireTriage() {
  const panel = document.getElementById('triage');
  panel.querySelector('.triage-close')?.addEventListener('click', closeTriage);
  panel.querySelector('[data-act="t-commit"]')?.addEventListener('click', commitTriage);
  panel.querySelector('[data-act="t-consult"]')?.addEventListener('click', openConsultChat);
  panel.querySelector('[data-act="t-export"]')?.addEventListener('click', chatAboutThis);

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
      if (v === '__new__') { triage.newForm[id] = { type: 'project', value: '' }; renderTriage(); return; }
      if (v === '__newref__') { triage.newForm[id] = { type: 'reference_file', value: '' }; renderTriage(); return; }
      assignTriageCluster(id, v === '__none__' ? null : v);
    });
  });

  panel.querySelectorAll('[data-tatom]').forEach(sel => {
    sel.addEventListener('change', () => {
      const v = sel.value;
      if (v === '__new__' || v === '__newref__') { sel.value = '__none__'; return; } // new container only at cluster level
      overrideTriageAtom(sel.dataset.tatom, sel.dataset.takey, v === '__none__' ? null : v);
    });
  });

  panel.querySelectorAll('[data-tnew]').forEach(inp => {
    inp.addEventListener('input', () => { if (triage.newForm[inp.dataset.tnew]) triage.newForm[inp.dataset.tnew].value = inp.value; });
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') triageCreateContainer(inp.dataset.tnew, inp.value);
      if (ev.key === 'Escape') { delete triage.newForm[inp.dataset.tnew]; renderTriage(); }
    });
    inp.focus();
  });
  panel.querySelectorAll('[data-tnew-create]').forEach(b => b.addEventListener('click', () => triageCreateContainer(b.dataset.tnewCreate, triage.newForm[b.dataset.tnewCreate]?.value)));
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

function triageCreateContainer(clusterId, title) {
  title = (typeof title === 'string' ? title : '').trim();
  if (!title) return;
  const nf = triage.newForm[clusterId];
  const type = (nf && nf.type === 'reference_file') ? 'reference_file' : 'project';
  const id = uniqueSlug(slugify(title));
  const c = {
    id, type, title, goal_or_purpose: '', summary: '',
    tags: [], status: 'active', created_at: nowIso(), updated_at: nowIso(),
  };
  state.containers.push(c);
  if (triage && !triage.createdIds.includes(id)) triage.createdIds.push(id);
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

  // v2 decisions mode: materialize the REFERENCED pending creates now — the
  // only moment Copilot-proposed containers are written (nothing pre-creates;
  // an unreferenced create is simply never made). Then rewrite the
  // __pending__:<pid> placeholders to the real ids so the normal grouping
  // below sees ordinary container targets.
  if (triage.mode === 'decisions' && (triage.pendingCreates || []).length) {
    const referenced = new Set();
    for (const c of triage.clusters) {
      for (const a of c.atoms) {
        const t = triageTarget(c, a.key);
        if (typeof t === 'string' && t.startsWith('__pending__:')) referenced.add(t.slice('__pending__:'.length));
      }
    }
    const realByPid = new Map();
    for (const pc of triage.pendingCreates) {
      if (!referenced.has(pc.pid)) continue;
      const id = uniqueSlug(slugify(pc.title || pc.pid));
      const c = {
        id, type: pc.kind, title: pc.title || pc.pid,
        goal_or_purpose: pc.goal_or_purpose || '', summary: '',
        tags: [], status: 'active', created_at: nowIso(), updated_at: nowIso(),
      };
      if (pc.kind === 'project') {
        const fw = pc.framework && FRAMEWORKS[pc.framework] ? pc.framework : null;
        c.framework = fw;
        c.framework_config = fw ? frameworkConfigFor(fw) : {};
      }
      state.containers.push(c);
      if (!triage.createdIds.includes(id)) triage.createdIds.push(id);
      realByPid.set(pc.pid, id);
    }
    const remap = (t) => (typeof t === 'string' && t.startsWith('__pending__:'))
      ? (realByPid.get(t.slice('__pending__:'.length)) || null)
      : t;
    for (const c of triage.clusters) {
      c.projectId = remap(c.projectId);
      for (const k of Object.keys(c.overrides)) c.overrides[k] = remap(c.overrides[k]);
    }
  }

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
  // A committed decisions-review consumes its pending export.
  if (triage.mode === 'decisions' && triage.sessionId) deletePendingIngest(triage.sessionId);
  closeTriage();
  closeDrawer(true);
  location.hash = `#/c/${encodeURIComponent(dominant)}`;
  render();
}

// ---------- Chat about this (Copilot-assisted ingestion · v1) -------
// Export the current triage draft as a `chat_about_this` bundle the user
// attaches to a Copilot chat (plus any source docs) for a read-only consult.
// Writes nothing to state and adds no server endpoint — same no-upload spirit
// as file import. Spec: copilot-ingestion-spec.md §2 / §8 (v1).

// ---------- v2: pending-export stash (localStorage) -----------------
// Pairs a pasted decision set back with the bundle it answers — `accept`
// verdicts carry no body (it lives in proposed{}), so the import NEEDS the
// original bundle. Export and import may be hours apart, across reloads.
// Per-browser by design (orange runs both steps in one browser); the import
// modal's paste/pick-the-bundle fallback covers everything else.
// Stash shape: { bundle, entryId, newContainerIds, savedAt } —
// entryId = the triaged entry (NOT in the bundle artifact; Copilot doesn't
// need it), newContainerIds = real ids of containers created during that
// triage, in order, so the gate can resolve bundle p1..pN (pRealIds).

const STASH_PREFIX = 'throughline:pending_ingest:';

function listPendingIngests() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(STASH_PREFIX)) continue;
      try {
        const s = JSON.parse(localStorage.getItem(k));
        if (s && s.bundle) out.push(s);
      } catch { /* corrupt stash — ignore */ }
    }
  } catch { /* storage unavailable */ }
  return out;
}

function stashPendingIngest(bundle, entryId, newContainerIds) {
  try {
    localStorage.setItem(
      STASH_PREFIX + bundle.session_id,
      JSON.stringify({ bundle, entryId, newContainerIds: newContainerIds || [], savedAt: Date.now() }),
    );
    // Keep the last 5; evict oldest.
    const all = listPendingIngests().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    for (const s of all.slice(5)) localStorage.removeItem(STASH_PREFIX + s.bundle.session_id);
  } catch { /* storage unavailable/full — the bundle file fallback still works */ }
}

function findPendingIngest(sessionId) {
  const all = listPendingIngests();
  if (sessionId) return all.find(s => s.bundle.session_id === sessionId) || null;
  return all.length === 1 ? all[0] : null; // no _meta echo: only safe if unambiguous
}

function deletePendingIngest(sessionId) {
  try { localStorage.removeItem(STASH_PREFIX + sessionId); } catch { /* ignore */ }
}

// One-time identity for prompt personalization (no real multi-user identity
// exists yet — that's E2 M0). Asked once, stored per-browser; an empty answer
// is remembered too ('' = declined: prompts say "the user" and the gate warns
// instead of aliasing "narrator" owners).
function getUserName() {
  let n = null;
  try { n = localStorage.getItem('throughline:user_name'); } catch { /* storage unavailable */ }
  if (n !== null) return n;
  const asked = (prompt('Your name? (used to attribute "I\'ll…" commitments in Copilot prompts)') || '').trim();
  try { localStorage.setItem('throughline:user_name', asked); } catch { /* ignore */ }
  return asked;
}

// Settings → Profile (T15). The narrator identity above was previously
// write-once via prompt(); this is the editable surface for it, plus an
// optional role blurb (stored now, seasoned into consult prompts later).
// Per-browser localStorage on purpose — real multi-user identity is E2/§M3.
function openSettingsModal() {
  let name = '', role = '';
  try { name = localStorage.getItem('throughline:user_name') || ''; } catch { /* storage unavailable */ }
  try { role = localStorage.getItem('throughline:user_role') || ''; } catch { /* storage unavailable */ }
  openModal(`
    <h2>Settings</h2>
    <label class="field">
      <span class="label">My name is</span>
      <input type="text" id="set-name" value="${escHtml(name)}" placeholder="e.g. Noah Schmuckler" />
    </label>
    <p class="muted small">Used to attribute "I'll…" commitments when a consult turns your words into
    actions — make it match the name you assign actions to. Stored in this browser only.</p>
    <label class="field">
      <span class="label">Role (optional)</span>
      <input type="text" id="set-role" value="${escHtml(role)}" placeholder="e.g. Program manager, IMFM Provider Corner" />
    </label>
    <div class="modal-actions">
      <button class="btn" data-act="set-cancel">Cancel</button>
      <button class="btn primary" data-act="set-save">Save</button>
    </div>
  `, (modal) => {
    modal.querySelector('[data-act="set-cancel"]').onclick = closeModal;
    modal.querySelector('[data-act="set-save"]').onclick = () => {
      try {
        localStorage.setItem('throughline:user_name', modal.querySelector('#set-name').value.trim());
        localStorage.setItem('throughline:user_role', modal.querySelector('#set-role').value.trim());
      } catch { /* storage unavailable */ }
      closeModal();
    };
  });
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Snapshot the live triage state into the §2 bundle + the context the gate
// needs later. One builder for BOTH outbound paths: the native consult chat
// (primary) and the Copilot file export (secondary). Returns null when there
// is no live triage/entry.
async function buildChatBundle() {
  if (!triage) return null;
  const entry = state.entries.find(e => e.id === triage.entryId);
  if (!entry) return null;

  // Snapshot the live triage state into a DOM-free draft.
  const draftAtoms = [];
  for (const c of triage.clusters) {
    for (const a of c.atoms) {
      const t = triageTarget(c, a.key);
      const target = !t ? null : (t === '__inbox__' ? 'inbox' : t);
      // suggested = the local model's pick for this cluster (probe 2 showed an
      // untriaged draft exported all targets null, discarding this signal).
      draftAtoms.push({ type: a.type, body: a.body, owner: a.owner, due: a.due, target, suggested: c.suggestedId || null });
    }
  }
  const newContainers = (triage.createdIds || [])
    .map(id => getContainer(id))
    .filter(Boolean)
    .map(c => ({
      id: c.id, type: c.type, title: c.title,
      goal_or_purpose: c.goal_or_purpose || '', framework: c.framework || null, folder: c.folder || null,
    }));
  const draft = { atoms: draftAtoms, newContainers };

  const bundle = assembleBundle({
    raw_dump: entry.notes || '',
    file_refs: await dominantBoundFileRefs(draftAtoms),
    state_summary: buildStateSummary(state, { excludeIds: triage.createdIds || [] }),
    proposed: buildProposed(draft),
    needs_clarification: buildNeedsClarification(draft),
    now: nowIso(),
  });

  return { bundle, entryId: triage.entryId, newContainerIds: newContainers.map(c => c.id) };
}

async function chatAboutThis() {
  const ctx = await buildChatBundle();
  if (!ctx) return;
  const { bundle, entryId, newContainerIds } = ctx;

  downloadJson(bundle, `chat-about-this-${bundle.session_id}.json`);

  // Stash the export so a decision set pasted later (even after a reload)
  // pairs back with this bundle — accept verdicts have no body of their own.
  stashPendingIngest(bundle, entryId, newContainerIds);

  // Hand the user the opening ask too — the first live consult showed that a
  // bare "does this look right?" makes Copilot critique the JSON format instead
  // of the breakdown. The prompt points Copilot at the bundle's _instructions.
  let copied = false;
  try { await navigator.clipboard.writeText(OPENING_PROMPT); copied = true; } catch { /* http / no permission */ }
  alert(
    'Exported the chat-about-this bundle to your Downloads.\n\n' +
    'Attach it to a Copilot chat (plus any source files it references) and paste this opening prompt' +
    (copied ? ' — it\'s on your clipboard:' : ':') + '\n\n' +
    `"${OPENING_PROMPT}"\n\n` +
    'Step 2 — when Copilot replies, click "📋 Paste from Copilot" on the dashboard; ' +
    'the decision-set prompt and the paste box are both in there.\n\n' +
    'Read-only: nothing was filed.'
  );
}

// file_refs = files in the dominant existing target's bound OneDrive folder, if
// any. Dominant = the real container holding the most atoms. Empty when it is
// unbound or the lens is unavailable (the Worker 501s /api/fs/*).
async function dominantBoundFileRefs(draftAtoms) {
  const counts = new Map();
  for (const a of draftAtoms) {
    if (!a.target || a.target === 'inbox') continue;
    counts.set(a.target, (counts.get(a.target) || 0) + 1);
  }
  let dominant = null, best = 0;
  for (const [t, n] of counts) if (n > best) { best = n; dominant = t; }
  if (!dominant) return [];
  const c = getContainer(dominant);
  if (!c || c.folder == null) return [];
  try {
    const r = await fetch(`/api/fs/list?path=${encodeURIComponent(c.folder || '')}`);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.files || []).map((f, i) => ({
      ref_id: 'f' + (i + 1),
      path: fbJoin(c.folder || '', f.name),
      kind: (f.ext || '').replace(/^\./, '') || null,
      note: '',
    }));
  } catch {
    return [];
  }
}

// ---------- Native consult chat (T13: /api/consult · gpt-5.4) --------
// The PRIMARY consult path: an in-app chat over the same bundle, replacing
// the copy-paste Copilot loop (which hard-refused unpredictably — the export/
// paste path below survives as the secondary engine). Conversation state is
// EPHEMERAL — in memory only, gone on close/reload; the triage draft stays
// alive underneath the overlay. "→ Decision set" sends DECISION_PROMPT and
// routes the reply through the existing parseDecisionSet → resolveDecisions →
// openDecisionsReview back-half, no copy-paste.

let chat = null; // { bundle, entryId, newContainerIds, messages, busy, llm, elapsed, timer, abort, awaitingDecisionSet }

async function openConsultChat() {
  const ctx = await buildChatBundle();
  if (!ctx) return;
  chat = {
    ...ctx,
    messages: [], busy: false, llm: null,
    elapsed: 0, timer: null, abort: null, awaitingDecisionSet: false,
  };
  const shroud = document.getElementById('chat-shroud');
  shroud.hidden = false;
  renderConsultChat();
  // Name the engine in the header from the start (T25) — don't wait for the
  // first reply. Reply-time `llm` still wins (it reflects what actually ran).
  fetch('/api/consult').then(r => r.json()).then(d => {
    if (chat && !chat.llm && d.llm) { chat.llm = d.llm; renderConsultChat(); }
  }).catch(() => { /* header just says "native model" until a reply */ });
  // Seed turn 1 with the opening ask so the model engages with the bundle's
  // _instructions immediately (the first live Copilot consult showed a bare
  // "does this look right?" gets a JSON-format critique instead).
  sendConsultTurn(OPENING_PROMPT);
}

function closeConsultChat() {
  if (chat?.abort) chat.abort.abort();
  if (chat?.timer) clearInterval(chat.timer);
  chat = null;
  document.getElementById('chat-shroud').hidden = true;
  // The triage overlay (and draft) underneath is untouched.
}

function renderConsultChat() {
  if (!chat) return;
  const panel = document.getElementById('chat-panel');
  const msgs = chat.messages.map(m =>
    m.role === 'assistant'
      ? `<div class="chat-msg assistant md">${mdToHtml(m.content)}</div>` // model replies are markdown (T14)
      : `<div class="chat-msg ${m.role === 'error' ? 'error' : 'user'}">${escHtml(m.content)}</div>`
  ).join('');
  const busy = chat.busy
    ? `<div class="chat-busy" id="chat-busy">Consulting ${escHtml(chat.llm || '…')} — <span id="chat-elapsed">${chat.elapsed}</span>s
         <button class="btn" data-act="chat-cancel">Cancel</button></div>`
    : '';
  panel.innerHTML = `
    <div class="chat-head">
      <div>
        <div class="t-eyebrow">Consult — ${escHtml(chat.llm || 'native model')}</div>
        <div class="chat-title">Chat about this entry</div>
      </div>
      <button class="chat-close" aria-label="Close">×</button>
    </div>
    <div class="chat-msgs" id="chat-msgs">${msgs}${busy}</div>
    <div class="chat-input-row">
      <textarea id="chat-input" rows="2" placeholder="Ask about the breakdown…" ${chat.busy ? 'disabled' : ''}></textarea>
      <div class="chat-actions">
        <button class="btn primary" data-act="chat-send" ${chat.busy ? 'disabled' : ''}>Send</button>
        <button class="btn" data-act="chat-decisions" ${chat.busy ? 'disabled' : ''}>→ Decision set</button>
      </div>
    </div>
    <div class="chat-hint">Read-only consult — nothing files until you review and commit a decision set. Close returns to your draft.</div>`;

  panel.querySelector('.chat-close').onclick = closeConsultChat;
  panel.querySelector('[data-act="chat-send"]')?.addEventListener('click', () => {
    const ta = panel.querySelector('#chat-input');
    const text = (ta?.value || '').trim();
    if (text) sendConsultTurn(text);
  });
  panel.querySelector('#chat-input')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      const text = ev.target.value.trim();
      if (text && !chat.busy) sendConsultTurn(text);
    }
  });
  panel.querySelector('[data-act="chat-decisions"]')?.addEventListener('click', requestDecisionSet);
  panel.querySelector('[data-act="chat-cancel"]')?.addEventListener('click', () => {
    chat?.abort?.abort();
  });
  const list = panel.querySelector('#chat-msgs');
  if (list) list.scrollTop = list.scrollHeight;
}

async function sendConsultTurn(content) {
  if (!chat || chat.busy) return;
  chat.messages.push({ role: 'user', content });
  chat.busy = true;
  chat.elapsed = 0;
  chat.abort = new AbortController();
  // gpt-5.4 is SLOW (T12: gpt-mini alone took ~90 s on an 8 KB dump) — show
  // a live elapsed counter + Cancel instead of a frozen overlay.
  chat.timer = setInterval(() => {
    if (!chat) return;
    chat.elapsed++;
    const el = document.getElementById('chat-elapsed');
    if (el) el.textContent = chat.elapsed;
  }, 1000);
  renderConsultChat();

  const awaiting = chat.awaitingDecisionSet;
  try {
    const r = await fetch('/api/consult', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bundle: chat.bundle,
        // Stateless provider: the whole history travels every round.
        messages: chat.messages.filter(m => m.role !== 'error'),
      }),
      signal: chat.abort.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!chat) return; // closed mid-flight
    if (!r.ok) throw new Error(data.error || `consult ${r.status}`);
    chat.llm = data.llm || chat.llm;
    finishConsultTurn();
    chat.messages.push({ role: 'assistant', content: data.reply });
    // Only the reply to the "→ Decision set" turn is parsed as one — a normal
    // prose reply containing {…} must not false-positive into the gate.
    if (awaiting) routeDecisionSetReply(data.reply);
    else renderConsultChat();
  } catch (err) {
    if (!chat) return; // closed mid-flight
    finishConsultTurn();
    chat.awaitingDecisionSet = false;
    // Visible failure, intact transcript — no silent fallback (the whole
    // point of the native engine after Copilot's opaque refusal).
    chat.messages.push({
      role: 'error',
      content: err.name === 'AbortError'
        ? 'Cancelled. The turn was not completed — send again to retry.'
        : `Consult failed: ${err.message}`,
    });
    renderConsultChat();
  }
}

function finishConsultTurn() {
  if (chat.timer) clearInterval(chat.timer);
  chat.timer = null;
  chat.busy = false;
  chat.abort = null;
}

function requestDecisionSet() {
  if (!chat || chat.busy) return;
  chat.awaitingDecisionSet = true;
  sendConsultTurn(DECISION_PROMPT(getUserName()));
}

function routeDecisionSetReply(reply) {
  chat.awaitingDecisionSet = false;
  const obj = parseDecisionSet(reply);
  if (obj && isDecisionSet(obj)) {
    const stash = { bundle: chat.bundle, entryId: chat.entryId, newContainerIds: chat.newContainerIds };
    const engine = chat.llm || 'Native consult';
    closeConsultChat();
    openDecisionsReview(stash, obj, { engine });
    return;
  }
  chat.messages.push({
    role: 'error',
    content: 'That reply didn\'t parse as a decision set — ask the model to re-emit the complete raw JSON, or click "→ Decision set" again.',
  });
  renderConsultChat();
}

// ---------- Paste from Copilot (Copilot-assisted ingestion · v2) -----
// The inbound channel. Paste field first (probe 2: Copilot prints in-chat
// far more reliably than it produces downloads), file picker fallback.
// Three grades of input, one surface (spec §7b):
//   §3 decision-set JSON → the gate → decisions-mode review overlay
//   the bundle JSON      → paired in-memory for the next paste
//   anything else        → freetext → Inbox entry → Atomize (existing path)

let ciPendingBundle = null; // a bundle pasted in this modal session (in-memory pairing)

function openCopilotImport() {
  ciPendingBundle = null;
  openModal(`
    <div class="modal-title">📋 Paste from Copilot</div>
    <p class="muted small">Paste Copilot's <b>decision set</b> (the JSON it returns to the
    decision-set prompt). It runs through the verify gate into a review screen — nothing
    is filed until you commit there. Plain text becomes an Inbox entry ready to atomize.</p>
    <textarea id="ci-paste" rows="10" style="width:100%" placeholder="Paste here — the decision-set JSON, the bundle JSON, or plain text…"></textarea>
    <div class="modal-actions">
      <button class="btn" data-act="ci-prompt">Copy decision-set prompt</button>
      <button class="btn" data-act="ci-file">…or pick a file</button>
      <button class="btn primary" data-act="ci-go">Import</button>
    </div>
    <div class="muted small" id="ci-hint"></div>
  `, (modal) => {
    const hint = (msg) => { const el = modal.querySelector('#ci-hint'); if (el) el.textContent = msg; };
    modal.querySelector('[data-act="ci-prompt"]').onclick = async () => {
      const p = DECISION_PROMPT(getUserName());
      try { await navigator.clipboard.writeText(p); hint('Prompt copied — paste it to Copilot after the consult.'); }
      catch { hint(p); } // http / no clipboard permission: show it instead
    };
    modal.querySelector('[data-act="ci-file"]').onclick = () => {
      let input = document.getElementById('ci-file-input');
      if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = 'ci-file-input';
        input.accept = '.json,.txt,application/json,text/plain';
        input.hidden = true;
        document.body.appendChild(input);
      }
      input.value = '';
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onerror = () => hint('Could not read that file.');
        reader.onload = () => handleCopilotIntake(String(reader.result || ''), modal);
        reader.readAsText(f);
      };
      input.click();
    };
    modal.querySelector('[data-act="ci-go"]').onclick = () =>
      handleCopilotIntake(modal.querySelector('#ci-paste')?.value, modal);
  });
}

function handleCopilotIntake(text, modal) {
  const t = String(text || '').trim();
  if (!t) return;
  const hint = (msg) => { const el = modal?.querySelector('#ci-hint'); if (el) el.textContent = msg; };
  const obj = parseDecisionSet(t);

  // Tried to be JSON but didn't parse (even after the repair pass): error
  // visibly and keep the modal open. Never entry-ify broken JSON — the first
  // live run turned a malformed paste into a garbage entry titled "{".
  if (!obj && looksLikeJson(t)) {
    hint('That looks like JSON but it didn\'t parse — it\'s probably truncated or malformed. ' +
      'Ask Copilot for "the same JSON again, complete and raw, no commentary", then paste that. Nothing was imported.');
    return;
  }

  if (obj && isBundle(obj)) {
    // The bundle itself — pair it for the decision set that follows (covers
    // pre-stash exports and cross-device imports).
    ciPendingBundle = { bundle: obj, entryId: null, newContainerIds: [] };
    const ta = modal?.querySelector('#ci-paste');
    if (ta) ta.value = '';
    hint(`Bundle ${obj.session_id || ''} loaded — now paste Copilot's decision set.`);
    return;
  }

  if (obj && isDecisionSet(obj)) {
    const sid = (obj._meta && obj._meta.session_id) || null;
    const stash = findPendingIngest(sid) || ciPendingBundle;
    if (!stash) {
      hint(sid
        ? `No pending export matches session ${sid} on this browser — paste or pick the bundle JSON first.`
        : 'No pending export found on this browser — paste or pick the bundle JSON first.');
      return;
    }
    closeModal();
    ciPendingBundle = null;
    openDecisionsReview(stash, obj);
    return;
  }

  if (obj) {
    // Valid JSON, but neither artifact — don't guess, don't entry-ify.
    hint('That JSON parsed, but it isn\'t a chat-about-this bundle or a decision set — nothing was imported.');
    return;
  }

  // Genuine freetext (a prose Copilot reply, an email, anything) → the
  // existing capture path: Inbox entry, one click from Atomize.
  closeModal();
  ciPendingBundle = null;
  importText(t);
}

// Gate the decision set against its bundle and open the review overlay —
// a decisions-mode triage. NOTHING mutates atom/container state here (the
// stale-entry fallback may add one entry to hold raw_dump); all real writes
// happen in commitTriage when the user commits.
function openDecisionsReview(stash, decisions, { engine = null } = {}) {
  const { bundle, entryId, newContainerIds = [] } = stash;
  const plan = resolveDecisions(bundle, decisions, {
    state,
    userName: getUserName(),
    pRealIds: newContainerIds,
  });

  // The source entry: the originally-triaged one, else re-created from
  // raw_dump (so §6's "raw dump preserved first" holds across deletion).
  let entry = entryId ? state.entries.find(e => e.id === entryId) : null;
  if (!entry) {
    entry = importText(bundle.raw_dump || '', {
      title: `Copilot ingest ${bundle.session_id || ''}`.trim(),
      open: false,
    });
    plan.warnings.push({ code: 'entry_recreated', msg: 'The original entry was not found — re-created it from the bundle\'s raw_dump.', ids: [] });
  }

  // Group resolved atoms by target → triage-shaped clusters. Null targets
  // collect in an "Unassigned / needs attention" cluster (always last).
  const byTarget = new Map();
  for (const a of plan.atoms) {
    const key = a.target == null ? '__none__' : a.target;
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(a);
  }
  const keys = [...byTarget.keys()].sort((x, y) => (x === '__none__') - (y === '__none__'));
  const clusters = keys.map((t, ci) => {
    const pendingC = t !== '__none__' ? plan.containerCreates.find(c => c.pid === t) : null;
    const real = (t !== '__none__' && !pendingC) ? getContainer(t) : null;
    // Cross-program misfiles hide behind a good project NAME (T21) — when the
    // target lives inside a program, say which one so provenance is reviewable.
    const realProg = real && real.program_id ? getContainer(real.program_id) : null;
    const name = t === '__none__' ? '⚠ Unassigned / needs attention'
      : pendingC ? `${pendingC.title} (new ${pendingC.kind === 'project' ? 'project' : 'reference'})`
        : t === 'inbox' ? 'Inbox'
          : (real ? `${real.title}${realProg ? ` · in program: ${realProg.title}` : ''}` : t);
    const projectId = t === '__none__' ? null
      : pendingC ? `__pending__:${t}`
        : t === 'inbox' ? '__inbox__'
          : t;
    return {
      id: 'dc_' + ci,
      name,
      suggestedId: null,
      projectId,
      overrides: {},
      atoms: byTarget.get(t).map((a, ai) => ({
        key: `${ci}_${ai}`, type: a.type, body: a.body,
        owner: a.owner || undefined, due: a.due || undefined,
      })),
    };
  });

  triage = {
    entryId: entry.id,
    source: 'decisions',
    llm: null,
    engine, // who produced the decision set (null → 'Copilot', the paste path)
    mode: 'decisions',
    clusters,
    expanded: {},
    newForm: {},
    createdIds: [],
    // decisions-mode extras (consumed by renderTriage + commitTriage):
    pendingCreates: plan.containerCreates,
    warnings: plan.warnings,
    dropped: plan.dropped,
    unaddressed: plan.unaddressed,
    sessionId: bundle.session_id || null,
    info: plan.info,
  };
  const shroud = document.getElementById('triage-shroud');
  shroud.hidden = false;
  shroud.onclick = (ev) => { if (ev.target === shroud) closeTriage(); };
  renderTriage();
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
  document.getElementById('hdr-settings')?.addEventListener('click', openSettingsModal);
  await loadState();
  await maybeRedirectToSetup();
  render();
})();
