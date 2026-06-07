// ------------------------------------------------------------------
// Copilot-assisted ingestion — pure helpers (Epic: Copilot ingestion).
// v1 = read-only consult: this module only BUILDS the outbound export
// bundle ("Chat about this"). No import, no gate, no decision-set parsing,
// no SheetJS — those are v2. Spec: copilot-ingestion-spec.md §2.
//
// Runtime-agnostic ESM: NO DOM, NO node:* — imported by both the browser
// (public/app.js, served at /ingest.js) and the tests (test/ingest.test.mjs,
// imported as ../public/ingest.js). Every function takes `state`/inputs
// explicitly so it stays pure and testable.
// ------------------------------------------------------------------

export const BUNDLE_ARTIFACT = 'throughline.chat_about_this';
export const BUNDLE_SCHEMA = 'ingest-v1';

// The task brief embedded in every bundle (`_instructions`). Lesson from the
// first live consult: a bare JSON file + "does this look right" makes Copilot
// review the JSON *format* instead of the breakdown. The bundle must be
// self-describing — the probe proved Copilot follows instructions inside
// attached content. Keep it consult-shaped (v1): prose advice, no decision set.
export const BUNDLE_INSTRUCTIONS =
  'You are consulting on a draft ingestion for Throughline, a project-management tool. ' +
  'raw_dump is the user\'s unstructured brain dump. proposed{} is a local model\'s draft ' +
  'breakdown of it into atoms (kinds: observation | decision | action | outcome) filed ' +
  'against containers (programs / projects / reference files) — state_summary{} lists the ' +
  'user\'s real workspace containers (program_id links a project to its parent program). ' +
  'Do NOT review the JSON formatting; it is machine-generated. Instead, help the user ' +
  'process the dump: (1) critique the breakdown — is each atom correctly typed and filed ' +
  'against the best container, and should any be split or merged? (2) say what in raw_dump ' +
  'the draft missed or mis-grouped; (3) help answer the needs_clarification[] questions; ' +
  '(4) prefer filing into existing state_summary containers — propose a new container only ' +
  'when nothing fits. Reply in plain prose for a human reader.';

// The one-line ask the user pastes to open the Copilot chat (copied to the
// clipboard by "Chat about this"). Points at _instructions so the chat starts
// on the consult, not on JSON critique.
export const OPENING_PROMPT =
  'I\'ve attached a Throughline ingestion bundle (JSON). Follow its _instructions field: ' +
  'help me break down and file the raw_dump — don\'t critique the JSON format.';

// The SECOND prompt (kept separate from _instructions on purpose — folding the
// output format into the bundle invites Copilot to skip the conversation and
// jump straight to JSON; spec §7b). Pasted after the consult to request the
// spec §3 decision set. Probe-2 calibrations baked in: demand the _meta echo
// explicitly (it won't come back otherwise), forbid program targets (atoms
// would be invisible on the program dashboard), and name the user so
// first-person commitments don't land on a "narrator" placeholder.
export function DECISION_PROMPT(userName) {
  const name = (userName || '').trim() || 'the user';
  return (
    'Now return your verdicts as ONE raw JSON object — no prose, no code fences, nothing before ' +
    'the opening { or after the closing }. Key it by my item ids exactly as they appear in the ' +
    "bundle's proposed{} (the a… atoms and p… containers). Use new n… keys for atoms you are adding " +
    'and new p… keys for new containers. Each value is a verdict object: a "verb" — one of accept | ' +
    'edit | drop | recategorize | create | merge_into — plus only the fields you are setting: "kind" ' +
    '(observation | decision | action | outcome; containers: project | reference_file), "body" or ' +
    '"title", "goal_or_purpose" (new containers), "program_id" (new containers only — a real ' +
    'type:"program" id from state_summary, to place the new project/reference inside that program), ' +
    '"target" (a real container id from state_summary, ' +
    'one of my p…/n… ids, or "inbox"; for merge_into, the surviving atom id), "framework" (projects ' +
    'only), "assigned_to", "due_date" (YYYY-MM-DD), "source_ref" (quote the raw_dump line that grounds ' +
    'it), "note" (one line of reasoning), "confidence" (0.0–1.0). RULES: programs cannot hold atoms — ' +
    'never set target to a type:"program" container; file into a project or reference file within ' +
    'that program, creating one if needed. Never emit the same atom twice — one verdict per distinct ' +
    'fact/decision/action; before filing into an existing project, check its program_id in ' +
    "state_summary so you don't route work into a project whose parent program is unrelated. " +
    `The user is ${name} — attribute first-person commitments ` +
    `("I'll…", "my…") to ${name}, never to a placeholder like "narrator". Include a "_meta" object ` +
    "echoing the bundle's version_hash and session_id verbatim so the import can confirm you answered " +
    'against the current draft.'
  );
}

// Open action atoms in a container: action atoms with no closing outcome.
// This is the single source for the open-action rule — app.js's openActionsOf()
// delegates here so the browser UI and the bundle never drift.
export function openActionsForContainer(state, cid) {
  const entryIds = new Set((state.entries || []).filter(e => e.container_id === cid).map(e => e.id));
  const atoms = (state.atoms || []).filter(a => entryIds.has(a.entry_id));
  const closed = new Set(
    atoms.filter(a => a.kind === 'outcome' && a.parent_atom_id).map(a => a.parent_atom_id),
  );
  return atoms.filter(a => a.kind === 'action' && !closed.has(a.id));
}

// People with open work → [{ name, open }], busiest first. A lean reducer for
// the summary; distinct from app.js derivePeople() (which overlays people_meta
// and drives the People view). Each action atom lives in one container, so it is
// counted once.
export function keyPeopleOpen(state) {
  const counts = new Map();
  for (const c of (state.containers || [])) {
    for (const a of openActionsForContainer(state, c.id)) {
      const who = (a.assigned_to || '').trim();
      if (who) counts.set(who, (counts.get(who) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, open]) => ({ name, open }))
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
}

// Reduced working-memory view of the whole workspace (spec §2). Never the full
// state.json — just enough that Copilot can place atoms against REAL container
// ids. `excludeIds` drops containers represented in proposed{} (e.g. ones just
// created during this triage) so they don't appear twice.
export function buildStateSummary(state, { maxRecentActions = 12, excludeIds = [] } = {}) {
  const skip = new Set(excludeIds);
  const containers = (state.containers || [])
    .filter(c => c && c.type !== 'inbox' && c.status !== 'archived' && !skip.has(c.id))
    .map(c => {
      const out = {
        id: c.id,
        type: c.type,
        title: c.title || '',
        summary: c.summary || c.goal_or_purpose || '',
        // Hierarchy stays visible in the flat list: program_id links a
        // project/reference to its parent program (null = standalone), so
        // Copilot can reconstruct program → projects without nesting.
        program_id: c.program_id || null,
        open_actions: openActionsForContainer(state, c.id).length,
      };
      if (c.type === 'project') out.framework = c.framework || null;
      if (c.type === 'program') {
        out.objective = c.objective || '';
        // Lean KR view — label + numbers only; internal kr ids never leave.
        out.key_results = (c.key_results || []).map(kr => ({
          label: kr.label || '',
          current: kr.current ?? null,
          target: kr.target ?? null,
          unit: kr.unit || '',
        }));
      }
      return out;
    });

  const entryById = new Map((state.entries || []).map(e => [e.id, e]));
  const closed = new Set(
    (state.atoms || []).filter(a => a.kind === 'outcome' && a.parent_atom_id).map(a => a.parent_atom_id),
  );
  const recent = (state.atoms || [])
    .filter(a => a.kind === 'action' && !closed.has(a.id))
    .map(a => {
      const e = entryById.get(a.entry_id);
      return {
        id: a.id,
        body: a.body || '',
        container_id: e ? e.container_id : null,
        due_date: a.due_date || null,
        _created: a.created_at || '',
      };
    })
    .sort((x, y) => (y._created).localeCompare(x._created))
    .slice(0, maxRecentActions)
    .map(({ _created, ...rest }) => rest);

  return { containers, recent_actions: recent, key_people: keyPeopleOpen(state) };
}

// Map the current triage draft → proposed{} (spec §2). `draft` is a plain,
// DOM-free snapshot extracted from the live triage state:
//   draft.atoms[]         = { type, body, owner, due, target }
//                           target = real container id | 'inbox' | null
//   draft.newContainers[] = { id, type, title, goal_or_purpose, framework, folder }
//                           (containers created during THIS triage session)
// Containers created this session get bundle-local p* ids; atoms targeting them
// are rewritten to that p*. Atoms targeting a pre-existing container keep its
// real id (resolvable in state_summary), per spec §4A.
export function buildProposed(draft = {}) {
  const newContainers = draft.newContainers || [];
  const realToP = new Map();
  const containers = newContainers.map((c, i) => {
    const pid = 'p' + (i + 1);
    realToP.set(c.id, pid);
    return {
      id: pid,
      kind: c.type,
      title: c.title || '',
      goal_or_purpose: c.goal_or_purpose || '',
      framework: c.type === 'project' ? (c.framework || null) : null,
      bind_folder: c.folder || null,
      confidence: null,
      source_ref: null,
      note: 'created during this triage',
    };
  });
  const atoms = (draft.atoms || []).map((a, i) => {
    const target = a.target == null ? null : (realToP.get(a.target) || a.target);
    // suggested_target = the local model's (unconfirmed) pick, kept distinct from
    // target (the user's assignment) so Copilot sees the draft's signal even on
    // an untriaged export — probe 2 lost it entirely (all targets null).
    const suggested = a.suggested == null ? null : (realToP.get(a.suggested) || a.suggested);
    const out = { id: 'a' + (i + 1), kind: a.type, body: a.body || '', target, suggested_target: suggested, source_ref: null, confidence: null };
    if (a.type === 'action') { out.assigned_to = a.owner || null; out.due_date = a.due || null; }
    return out;
  });
  return { containers, atoms };
}

// Auto-derived open questions for the partner (spec §2 needs_clarification).
export function buildNeedsClarification(draft = {}) {
  const out = [];
  const unassigned = (draft.atoms || []).filter(a => a.target == null).length;
  if (unassigned) {
    out.push(`Where should these ${unassigned} unassigned atom(s) go — a project, a reference file, or the Inbox?`);
  }
  const news = draft.newContainers || [];
  if (news.length) {
    out.push(`Are these new container(s) the right shape (project vs reference file)? — ${news.map(c => c.title).join(', ')}`);
  }
  return out;
}

// Deterministic stable JSON (sorted keys, recursive) so the version hash is
// independent of key insertion order.
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// FNV-1a 32-bit → "tl_" + 8 hex. An integrity/staleness stamp over proposed{},
// not a security hash.
export function versionHash(obj) {
  const s = stableStringify(obj == null ? {} : obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return 'tl_' + h.toString(16).padStart(8, '0');
}

// ing_2026-06-06_1400 from an ISO timestamp (ties the eventual decision set back).
export function sessionIdFrom(nowIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(nowIso || '');
  return m ? `ing_${m[1]}-${m[2]}-${m[3]}_${m[4]}${m[5]}` : 'ing_session';
}

// Wrap the parts in the §2 envelope. version_hash is computed over proposed{}.
export function assembleBundle({
  raw_dump = '',
  file_refs = [],
  state_summary,
  proposed,
  needs_clarification = [],
  now = new Date().toISOString(),
  sessionId = null,
} = {}) {
  return {
    _artifact: BUNDLE_ARTIFACT,
    _schema: BUNDLE_SCHEMA,
    _instructions: BUNDLE_INSTRUCTIONS,
    version_hash: versionHash(proposed || {}),
    created_at: now,
    session_id: sessionId || sessionIdFrom(now),
    raw_dump,
    file_refs,
    state_summary,
    proposed,
    needs_clarification,
  };
}
