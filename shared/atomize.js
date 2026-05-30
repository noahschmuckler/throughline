// ------------------------------------------------------------------
// Throughline — atomizer seam (runtime-agnostic ESM).
//
// Imported by BOTH backends: the Cloudflare Worker (src/index.js) and the
// Node server (server.js). Depends on nothing but standard JS + an optional
// injected `llmCall` — no `node:*` imports — so the Worker bundle stays clean.
//
// Today this ships a deterministic HEURISTIC STUB so the capture → triage →
// commit loop works end-to-end with zero API spend. The real LLM path is a
// one-line swap: pass an `llmCall` (see shared/llm.js) into atomizeEntry().
// Every place the model will eventually do the work is marked `TODO(AI)`.
// ------------------------------------------------------------------

// Output contract consumed by the triage modal (public/app.js):
//   { clusters: [ { id, name, suggestedId, atoms: [ {type, body, owner?, due?} ] } ] }
// where `type` ∈ {observation, decision, action} and `suggestedId` is a
// project/container id (or null when nothing matched → ambient bucket).

const AMBIENT_ID = '__ambient__';

// ---- prompt assembly (used by the real LLM path) -------------------

// TODO(AI): this is the extraction prompt the `anthropic` provider will send.
// Kept here (not in llm.js) so the Worker and Node paths share one source of
// truth for the contract. When wiring the model, instruct it to return JSON
// matching the output contract above and nothing else.
export function buildAtomizePrompt(entry, { projects = [] } = {}) {
  const projectLines = projects.length
    ? projects.map(p => `- ${p.id}: ${p.title}${p.goal_or_purpose ? ` — ${p.goal_or_purpose}` : ''}${(p.tags || []).length ? ` [${p.tags.join(', ')}]` : ''}`).join('\n')
    : '(no existing projects)';

  return [
    'You are the ingestion layer of Throughline, a project-tracking tool.',
    'Read the raw entry below and extract discrete "atoms". Each atom is exactly one of:',
    '  - observation: a fact or state of the world that was reported',
    '  - decision: a choice that was made',
    '  - action: a commitment to do something (capture owner + due date if stated)',
    '',
    'Group the atoms into clusters by topic. For each cluster, suggest which',
    'existing project it belongs to (by id) or null if none fits.',
    '',
    'Existing projects:',
    projectLines,
    '',
    '--- ENTRY ---',
    `Title: ${entry.title || '(untitled)'}`,
    entry.occurred_at ? `Date: ${entry.occurred_at}` : '',
    (entry.participants || []).length ? `Participants: ${entry.participants.join(', ')}` : '',
    '',
    entry.notes || '(no notes)',
    '--- END ENTRY ---',
    '',
    'Return ONLY JSON: {"clusters":[{"name":"…","suggestedId":"…|null",',
    '"atoms":[{"type":"observation|decision|action","body":"…","owner":"…?","due":"YYYY-MM-DD?"}]}]}',
  ].filter(Boolean).join('\n');
}

// ---- the public entry point ----------------------------------------

// atomizeEntry(entry, { projects, llmCall })
//   - if `llmCall` is provided: send the prompt, parse the JSON it returns,
//     and normalize. (TODO(AI): real path.)
//   - otherwise: run the heuristic stub. Always returns the output contract.
export async function atomizeEntry(entry, { projects = [], llmCall = null } = {}) {
  if (llmCall) {
    // TODO(AI): real model path. Kept defensive so a bad/empty model response
    // degrades to the heuristic rather than throwing into the request handler.
    try {
      const prompt = buildAtomizePrompt(entry, { projects });
      const raw = await llmCall({ prompt, tier: 'reason' });
      const parsed = parseModelJson(raw);
      if (parsed && Array.isArray(parsed.clusters)) {
        return { clusters: normalizeClusters(parsed.clusters, projects), source: 'llm' };
      }
    } catch {
      /* fall through to heuristic */
    }
  }
  return { clusters: heuristicClusters(entry, projects), source: 'heuristic' };
}

// ---- heuristic stub ------------------------------------------------

const DECISION_RE = /\b(decid|agree|approv|chose|choose|settle|will go with|going with|target(ed)? for|deferred)\b/i;
const ACTION_RE   = /\b(will|to |need to|should|follow up|send|schedule|draft|export|complete|review|confirm|coordinate|set up|email|call|update|by (mon|tue|wed|thu|fri|next|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|by \d)\b/i;

function classify(text) {
  if (DECISION_RE.test(text)) return 'decision';
  if (ACTION_RE.test(text)) return 'action';
  return 'observation';
}

// "@Name" or "Name to <verb>" → owner. Best-effort only.
function extractOwner(text) {
  const at = text.match(/@([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)?)/);
  if (at) return at[1];
  const to = text.match(/\b([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)?)\s+to\s+[a-z]/);
  if (to) return to[1];
  return undefined;
}

// "by June 3" / "by 2026-06-03" → a YYYY-MM-DD due date when unambiguous.
function extractDue(text) {
  const iso = text.match(/\bby\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (iso) return iso[1];
  return undefined; // TODO(AI): natural-language date resolution is the model's job.
}

// Split notes into candidate atom bodies: bullet lines first, else sentences.
function segment(notes) {
  const text = String(notes || '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).map(l => l.replace(/^\s*[-*•\d.)\]]+\s*/, '').trim()).filter(Boolean);
  const bulletish = text.split(/\r?\n/).some(l => /^\s*[-*•]/.test(l));
  if (bulletish && lines.length > 1) return lines;
  // Fall back to sentence-ish splitting.
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map(s => s.trim()).filter(Boolean);
}

// Score a body against a project by shared significant words with its
// title / tags / goal. Cheap bag-of-words overlap — the model replaces this.
const STOP = new Set('the a an and or of to for in on at by with is are was were be this that from into our we their it its as has have will would about'.split(' '));
function words(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
}
function projectScore(body, project) {
  const pw = words(`${project.title} ${(project.tags || []).join(' ')} ${project.goal_or_purpose || ''}`);
  const bw = words(body);
  let hits = 0;
  for (const w of bw) if (pw.has(w)) hits++;
  return hits;
}

function heuristicClusters(entry, projects) {
  const segments = segment(entry.notes);
  const atomsByProject = new Map(); // projectId|AMBIENT_ID -> atoms[]

  for (const body of segments) {
    const type = classify(body);
    const atom = { type, body };
    if (type === 'action') {
      const owner = extractOwner(body);
      const due = extractDue(body);
      if (owner) atom.owner = owner;
      if (due) atom.due = due;
    }
    // TODO(AI): project assignment is keyword overlap today; the model will
    // reason over project goals + history instead.
    let best = AMBIENT_ID, bestScore = 0;
    for (const p of projects) {
      const s = projectScore(body, p);
      if (s > bestScore) { bestScore = s; best = p.id; }
    }
    const key = bestScore > 0 ? best : AMBIENT_ID;
    if (!atomsByProject.has(key)) atomsByProject.set(key, []);
    atomsByProject.get(key).push(atom);
  }

  const projectsById = Object.fromEntries(projects.map(p => [p.id, p]));
  const clusters = [];
  for (const [key, atoms] of atomsByProject) {
    if (key === AMBIENT_ID) continue; // emit ambient last
    const p = projectsById[key];
    clusters.push({
      id: key,
      name: p ? p.title : key,
      suggestedId: key,
      atoms,
    });
  }
  if (atomsByProject.has(AMBIENT_ID)) {
    clusters.push({
      id: AMBIENT_ID,
      name: 'Ambient / uncategorized',
      suggestedId: null,
      atoms: atomsByProject.get(AMBIENT_ID),
    });
  }
  // If nothing parsed (empty notes), surface one empty ambient cluster so the
  // modal can explain there was nothing to extract.
  if (!clusters.length) {
    clusters.push({ id: AMBIENT_ID, name: 'Ambient / uncategorized', suggestedId: null, atoms: [] });
  }
  return clusters;
}

// ---- model-response normalization ----------------------------------

function parseModelJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  const text = String(raw);
  // Tolerate ```json fences or surrounding prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

const VALID_TYPES = new Set(['observation', 'decision', 'action']);
function normalizeClusters(clusters, projects) {
  const ids = new Set(projects.map(p => p.id));
  const out = [];
  for (const c of clusters) {
    const atoms = (Array.isArray(c.atoms) ? c.atoms : [])
      .filter(a => a && a.body)
      .map(a => {
        const type = VALID_TYPES.has(a.type) ? a.type : 'observation';
        const atom = { type, body: String(a.body) };
        if (type === 'action') {
          if (a.owner) atom.owner = String(a.owner);
          if (a.due) atom.due = String(a.due);
        }
        return atom;
      });
    const suggestedId = c.suggestedId && ids.has(c.suggestedId) ? c.suggestedId : null;
    out.push({
      id: suggestedId || `cl_${out.length}`,
      name: c.name || 'Cluster',
      suggestedId,
      atoms,
    });
  }
  return out;
}
