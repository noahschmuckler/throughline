// ------------------------------------------------------------------
// Copilot-assisted ingestion — the verify-and-normalize GATE (v2).
// Spec: copilot-ingestion-spec.md §3 (decision set) + §4 (gate) + §7b
// (probe-2 guardrails, all baked in here).
//
// Runtime-agnostic ESM: NO DOM, NO node:* — imported by the browser
// (public/app.js, served at /gate.js) and the tests (test/gate.test.mjs).
// Pure functions; resolveDecisions NEVER throws — every anomaly becomes a
// warning and the human decides in the review overlay (nothing auto-applies).
// ------------------------------------------------------------------

import { BUNDLE_ARTIFACT } from './ingest.js';

// Tolerant JSON extraction. Stricter inputs than shared/atomize's
// parseModelJson get the same treatment (fences/prose), but real pasted
// Copilot replies also arrive with trailing commas, smart quotes, and
// surrounding prose containing braces — the first live v2 run proved a naive
// first-{-to-last-} slice + strict JSON.parse silently fails on them. So:
// string-aware balanced-brace candidates (longest first) + a pure-code
// repair pass before giving up. The gpt-5.4 repair (§4B) stays deferred for
// what code can't fix.

// Top-level balanced {...} spans, tracking strings so braces inside values
// don't miscount. Longest first — the decision set dwarfs any prose aside.
function jsonCandidates(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

// Common LLM JSON pathologies fixable without a model. Only attempted after
// a strict parse fails, so a quote-balance edge case can't corrupt good input.
function repairJsonish(s) {
  return s
    .replace(/[\u201C\u201D\u201E]/g, '"')  // smart double quotes
    .replace(/[\u2018\u2019]/g, "'")         // smart single quotes (inside values)
    .replace(/[\u200B-\u200D\u00A0]/g, ' ') // zero-widths + nbsp
    .replace(/,\s*([}\]])/g, '$1');           // trailing commas
}

export function parseDecisionSet(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  const text = String(raw).replace(/^\uFEFF/, '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const scopes = fenced ? [fenced[1], text] : [text];
  for (const scope of scopes) {
    for (const candidate of jsonCandidates(scope)) {
      try { return JSON.parse(candidate); } catch { /* try repaired */ }
      try { return JSON.parse(repairJsonish(candidate)); } catch { /* next candidate */ }
    }
  }
  return null;
}

// "Was this paste ATTEMPTING to be JSON?" — used by the intake router so a
// malformed decision set errors visibly instead of becoming a freetext entry
// (the first live v2 run turned a truncated paste into an entry titled "{").
export function looksLikeJson(text) {
  const t = String(text || '').replace(/^\uFEFF/, '').trim();
  return t.startsWith('{') || /```(?:json)?\s*\{/i.test(t) || /"[a-z]\d*\w*"\s*:\s*\{/i.test(t);
}

export function isBundle(obj) {
  return !!obj && typeof obj === 'object' && obj._artifact === BUNDLE_ARTIFACT;
}

// A decision set is an object keyed by item ids whose values look like
// verdicts. Verbs blur in practice (§7b#1), so `verb` is NOT required —
// any verdict-ish field counts.
export function isDecisionSet(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || isBundle(obj)) return false;
  return Object.entries(obj).some(([k, v]) =>
    k !== '_meta' && v && typeof v === 'object' && !Array.isArray(v) &&
    ('verb' in v || 'kind' in v || 'body' in v || 'title' in v || 'target' in v));
}

const ATOM_KINDS = new Set(['observation', 'decision', 'action']);
const NARRATOR_ALIASES = new Set(['narrator', 'me', 'i', 'user', 'myself', 'the user']);
// Treat '' / null / undefined as "field not provided" (§7b#6 empty-string noise).
const given = (v) => v !== undefined && v !== null && v !== '';

// resolveDecisions(bundle, decisions, { state, userName, pRealIds })
//   bundle    — the chat_about_this export this decision set answers.
//   decisions — parsed §3 decision set (any shape; garbage tolerated).
//   state     — live state doc (preferred over state_summary for container
//               existence + program children, so post-export drift is seen).
//   userName  — for narrator aliasing ('' → warn instead).
//   pRealIds  — real container ids for the bundle's p1..pN (those containers
//               were created during the original triage and already live in
//               state; the bundle only knows their p* alias — the stash
//               carries the mapping). pRealIds[0] ↔ 'p1'.
// Returns a ResolvedPlan:
//   { atoms:[{key,type,body,owner,due,target,source_ref,confidence,_badge,_srcId}],
//     containerCreates:[{pid,kind,title,goal_or_purpose,framework}],
//     warnings:[{code,msg,ids}], dropped:[{id,body,note}], unaddressed:[{id,body}],
//     info:{sessionId,versionHash,versionStale,metaPresent,coverageMissingPct,userNameMissing} }
export function resolveDecisions(bundle, decisions, { state = null, userName = '', pRealIds = [] } = {}) {
  const warnings = [];
  const warn = (code, msg, ids = []) => warnings.push({ code, msg, ids });
  bundle = bundle && typeof bundle === 'object' ? bundle : {};

  const proposed = bundle.proposed || {};
  const propAtoms = new Map((proposed.atoms || []).map(a => [a.id, a]));
  const propContainers = (proposed.containers || []);
  const bundleP = new Map(propContainers.map((c, i) => [c.id, pRealIds[i] || null]));
  const summary = (bundle.state_summary && bundle.state_summary.containers) || [];
  const summaryById = new Map(summary.map(c => [c.id, c]));
  const liveContainers = state && Array.isArray(state.containers) ? state.containers : null;
  const liveById = liveContainers ? new Map(liveContainers.map(c => [c.id, c])) : null;

  const containerInfo = (id) => (liveById && liveById.get(id)) || summaryById.get(id) || null;
  const childProjectsOfProgram = (pid) =>
    (liveContainers || summary).filter(c => c.program_id === pid && c.type === 'project' && c.status !== 'archived');

  // ---- _meta echo / staleness (§4D — warn, never hard-fail) ----------
  const meta = decisions && typeof decisions === 'object' ? decisions._meta : null;
  const metaPresent = !!meta;
  let versionStale = false;
  if (!metaPresent) {
    warn('no_meta_echo', 'Copilot did not echo _meta — cannot confirm it answered against this draft.');
  } else if (given(meta.version_hash) && given(bundle.version_hash) && meta.version_hash !== bundle.version_hash) {
    versionStale = true;
    warn('version_stale', `Decision set echoes ${meta.version_hash} but this bundle is ${bundle.version_hash} — it may answer an older draft.`);
  }

  // ---- classify keys → verdict records (field-driven; verb = intent) --
  const entries = decisions && typeof decisions === 'object' && !Array.isArray(decisions)
    ? Object.entries(decisions).filter(([k]) => k !== '_meta') : [];

  const res = new Map();          // atom id → {action:'keep'|'drop'|'merge', v, isNew}
  const containerCreates = [];    // new p* containers proposed by this decision set
  const newPids = new Set();
  const dropped = [];

  for (const [id, v] of entries) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { warn('bad_verdict', `Verdict for "${id}" is not an object — skipped.`, [id]); continue; }
    const verb = String(v.verb || '').toLowerCase();

    if (propAtoms.has(id)) {
      if (verb === 'drop') { res.set(id, { action: 'drop', v }); continue; }
      if (verb === 'merge_into') { res.set(id, { action: 'merge', v }); continue; }
      res.set(id, { action: 'keep', v }); // accept / edit / recategorize / blurred
      continue;
    }

    if (bundleP.has(id)) {
      // Bundle p* = a container ALREADY created during the original triage.
      // Edits to committed state are out of scope until E3.5 — surface, skip.
      if (verb !== 'accept') warn('container_edit_deferred', `Verdict "${verb || 'edit'}" on existing container ${id} — editing committed containers is deferred; apply it by hand.`, [id]);
      continue;
    }

    if (/^p/i.test(id)) {
      // New container minted by Copilot (any unused p* key — §7b#2: it
      // assumed p2 with no p1; never expect a sequence).
      let kind = String(v.kind || '').toLowerCase();
      if (kind !== 'project' && kind !== 'reference_file') {
        warn('container_kind_coerced', `New container ${id} has kind "${v.kind || '?'}" — coerced to reference_file (program creation is E3.4).`, [id]);
        kind = 'reference_file';
      }
      containerCreates.push({
        pid: id, kind,
        title: String(v.title || v.body || id),
        goal_or_purpose: String(v.goal_or_purpose || v.note || ''),
        framework: kind === 'project' && given(v.framework) ? String(v.framework) : null,
      });
      newPids.add(id);
      continue;
    }

    if (/^n/i.test(id)) { // new atom
      if (verb === 'drop') continue; // dropping its own creation — ignore
      res.set(id, { action: 'keep', v, isNew: true });
      continue;
    }

    warn('unknown_id', `Verdict for unknown id "${id}" — skipped (not in the bundle, not n*/p*).`, [id]);
  }

  // ---- merge-chain resolution (§7b: survivor's text wins; merged bodies
  // are discarded; cycles keep everyone standalone) --------------------
  for (const [id, r] of res) {
    if (r.action !== 'merge') continue;
    const seen = new Set([id]);
    let cur = given(r.v.target) ? r.v.target : null;
    let ok = false, cycled = false;
    while (cur) {
      if (seen.has(cur)) {
        // Cycle: every member becomes standalone (plan rule — no content loss).
        cycled = true;
        warn('merge_cycle', `merge_into cycle involving ${[...seen].join(' → ')} — all kept standalone.`, [...seen]);
        for (const sid of seen) { const rr = res.get(sid); if (rr && rr.action === 'merge') rr.action = 'keep'; }
        break;
      }
      seen.add(cur);
      const t = res.get(cur);
      if (!t) { // survivor has no verdict: fine if it's a bundle atom (implicit accept)
        ok = propAtoms.has(cur);
        if (ok) res.set(cur, { action: 'keep', v: {} });
        break;
      }
      if (t.action === 'drop') break;          // merging into a dropped atom
      if (t.action === 'merge') { cur = given(t.v.target) ? t.v.target : null; continue; }
      ok = true; break;                         // survivor is kept (or already merged_away's survivor)
    }
    if (cycled) continue;
    if (ok) {
      r.action = 'merged_away'; // excluded from output, body discarded by design
    } else {
      warn('merge_orphan', `${id} merges into ${r.v.target || '?'} which is dropped/unknown — kept standalone.`, [id]);
      r.action = 'keep';
    }
  }

  // ---- build final atoms ----------------------------------------------
  // Order: bundle a* atoms in proposed order, then n* creates in verdict order.
  const orderedIds = [
    ...(proposed.atoms || []).map(a => a.id).filter(id => res.has(id)),
    ...[...res.keys()].filter(id => res.get(id).isNew),
  ];

  const atoms = [];
  let userNameMissing = false;
  const aliasOwner = (owner, id) => {
    if (!given(owner) || !NARRATOR_ALIASES.has(String(owner).trim().toLowerCase())) return owner ?? null;
    if (userName) return userName;
    userNameMissing = true;
    return owner; // left as-is; review shows it + the warning
  };

  for (const id of orderedIds) {
    const r = res.get(id);
    if (r.action === 'drop') {
      const base = propAtoms.get(id) || {};
      dropped.push({ id, body: base.body || '', note: r.v.note || '' });
      continue;
    }
    if (r.action !== 'keep') continue; // merged_away

    const base = propAtoms.get(id) || {};
    const v = r.v || {};

    let type = given(v.kind) ? String(v.kind).toLowerCase() : (base.kind || 'observation');
    if (!ATOM_KINDS.has(type)) {
      warn('kind_coerced', `Atom ${id} kind "${type}" isn't ingestible here — coerced to observation.`, [id]);
      type = 'observation';
    }

    let badge = r.isNew ? 'created' : null;
    // Target chain: Copilot's verdict → the user's assignment at export →
    // the local draft's suggestion (suggested_target, the v1.x fix) → null.
    let target = given(v.target) ? v.target : (given(base.target) ? base.target : null);
    if (target == null && given(base.suggested_target)) { target = base.suggested_target; badge = badge || 'suggested'; }

    // Resolve + validate target.
    if (target != null && target !== 'inbox') {
      if (bundleP.has(target)) {
        const real = bundleP.get(target);
        if (real && (!liveById || liveById.has(real))) target = real;
        else { warn('container_deleted', `${id} targets ${target}, whose container no longer exists — pick one in review.`, [id]); target = null; badge = 'unresolved_target'; }
      } else if (newPids.has(target)) {
        // stays as the pending p* id — the overlay materializes it at commit
      } else {
        const info = containerInfo(target);
        if (!info) {
          warn('unresolved_target', `${id} targets unknown container "${target}" — pick one in review.`, [id]);
          target = null; badge = 'unresolved_target';
        } else if (liveById && !liveById.has(target)) {
          warn('container_deleted', `${id} targets "${target}", deleted since export — pick one in review.`, [id]);
          target = null; badge = 'unresolved_target';
        } else if (info.type === 'program') {
          // Programs cannot hold atoms (their page renders the OKR dashboard,
          // not entries). One child project → remap; else the human picks.
          const kids = childProjectsOfProgram(target);
          if (kids.length === 1) {
            warn('program_remap', `${id} targeted program "${info.title || target}" — filed into its only project "${kids[0].title || kids[0].id}".`, [id]);
            target = kids[0].id; badge = 'remapped';
          } else {
            warn('program_no_target', `${id} targeted program "${info.title || target}" (${kids.length} child projects) — pick a project in review.`, [id]);
            target = null; badge = 'unresolved_target';
          }
        } else if (info.type === 'inbox') {
          target = 'inbox';
        }
      }
    }

    const owner = type === 'action'
      ? aliasOwner(given(v.assigned_to) ? v.assigned_to : (base.assigned_to ?? null), id)
      : null;
    const due = type === 'action'
      ? (given(v.due_date) ? v.due_date : (base.due_date ?? null))
      : null;
    const body = given(v.body) ? String(v.body) : String(base.body || '');
    const source_ref = given(v.source_ref) ? v.source_ref : (base.source_ref ?? null);
    if (!source_ref && given(v.body) && !badge) badge = 'ungrounded'; // informational; bounds-check is v2-deferred

    atoms.push({
      key: 'd' + atoms.length, type, body,
      owner: owner ?? null, due: due ?? null, target,
      source_ref, confidence: given(v.confidence) ? v.confidence : (base.confidence ?? null),
      _badge: badge, _srcId: id,
    });
  }
  if (userNameMissing) warn('no_user_name', 'Some owners are "narrator"-style placeholders and no user name is set — fix the owners after commit, or set your name.');

  // ---- coverage (§4D softened: warn, never abort — the human decides) --
  const allA = (proposed.atoms || []).map(a => a.id);
  const unaddressed = allA.filter(id => !res.has(id)).map(id => {
    const a = propAtoms.get(id);
    return { id, body: (a && a.body) || '' };
  });
  const coverageMissingPct = allA.length ? unaddressed.length / allA.length : 0;
  if (unaddressed.length) {
    warn(coverageMissingPct > 0.4 ? 'coverage_low' : 'coverage_gap',
      `${unaddressed.length} of ${allA.length} draft atoms got no verdict — they are NOT imported (the raw dump keeps them in the entry notes).`,
      unaddressed.map(u => u.id));
  }

  return {
    atoms, containerCreates, warnings, dropped, unaddressed,
    info: {
      sessionId: bundle.session_id || null,
      versionHash: bundle.version_hash || null,
      versionStale, metaPresent, coverageMissingPct, userNameMissing,
    },
  };
}
