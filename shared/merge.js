// ------------------------------------------------------------------
// Throughline — M1 concurrent-edit 3-way merge (runtime-agnostic, pure).
//
// Two people sharing one circle (one OneDrive state.json) edit concurrently;
// OneDrive's last-write-wins would silently drop one side's work. This merges
// keyed by object id so disjoint additions/edits/deletions combine with ZERO
// loss — the common case — and only same-object/same-field edits are true
// conflicts (auto-resolved to the newer updated_at, and RECORDED so nothing
// vanishes silently; surfacing them is M2).
//
//   mergeStates(base, ours, theirs) -> { merged, conflicts }
//     base   = last-synced snapshot (the common ancestor)
//     ours   = our in-memory version
//     theirs = what's currently on disk
//
// `merged` is a normal state doc; `conflicts` is [{ kind, id, field, kept, dropped }].
// ------------------------------------------------------------------

const ID_ARRAYS = ['containers', 'entries', 'atoms'];
const TIME_FIELD = 'updated_at';

// Stable deep-equality (order-independent for object keys).
function eq(a, b) {
  return stable(a) === stable(b);
}
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

function byId(arr) {
  const m = new Map();
  for (const o of (Array.isArray(arr) ? arr : [])) if (o && o.id != null) m.set(o.id, o);
  return m;
}

// Which side is "newer" for conflict tie-break (lexicographic ISO compare).
function oursIsNewer(ours, theirs) {
  return String(ours?.[TIME_FIELD] || '') >= String(theirs?.[TIME_FIELD] || '');
}

// Field-level 3-way merge of one object present (and changed) on both sides.
// Disjoint field edits both survive; same-field edits conflict → newer wins.
function mergeObject(base, ours, theirs, idForConflict, conflicts) {
  const out = {};
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(ours || {}), ...Object.keys(theirs || {})]);
  const preferOurs = oursIsNewer(ours, theirs);
  for (const k of keys) {
    const b = base ? base[k] : undefined;
    const o = ours ? ours[k] : undefined;
    const t = theirs ? theirs[k] : undefined;
    const oChanged = !eq(o, b);
    const tChanged = !eq(t, b);
    if (oChanged && tChanged) {
      if (eq(o, t)) { out[k] = o; continue; }          // both made the same change
      // True conflict on this field.
      const kept = preferOurs ? o : t;
      const dropped = preferOurs ? t : o;
      out[k] = kept;
      if (k !== TIME_FIELD) conflicts.push({ kind: 'field', id: idForConflict, field: k, kept, dropped });
    } else if (oChanged) {
      out[k] = o;
    } else if (tChanged) {
      out[k] = t;
    } else {
      out[k] = b;                                       // unchanged on both
    }
  }
  // The merged object reflects the latest touch.
  if (out[TIME_FIELD] !== undefined) out[TIME_FIELD] = maxTime(ours?.[TIME_FIELD], theirs?.[TIME_FIELD]);
  return out;
}

function maxTime(a, b) {
  const sa = String(a || ''), sb = String(b || '');
  return sa >= sb ? (a ?? b) : (b ?? a);
}

// 3-way merge of one id-keyed array.
function mergeIdArray(baseArr, oursArr, theirsArr, conflicts) {
  const base = byId(baseArr), ours = byId(oursArr), theirs = byId(theirsArr);
  const ids = new Set([...ours.keys(), ...theirs.keys(), ...base.keys()]);
  const out = [];
  for (const id of ids) {
    const b = base.get(id), o = ours.get(id), t = theirs.get(id);
    const inBase = base.has(id), inOurs = ours.has(id), inTheirs = theirs.has(id);

    if (!inBase) {                                       // an addition on one/both sides
      if (inOurs && inTheirs) out.push(eq(o, t) ? o : mergeObject({}, o, t, id, conflicts));
      else out.push(inOurs ? o : t);
      continue;
    }
    // Present in base.
    const delOurs = !inOurs, delTheirs = !inTheirs;
    if (delOurs && delTheirs) continue;                  // both deleted → gone
    if (delOurs || delTheirs) {
      const surviving = delOurs ? t : o;                 // the side that kept it
      const survChanged = !eq(surviving, b);
      if (!survChanged) continue;                        // delete vs untouched → honor delete
      // delete vs edit → keep the edit (don't lose work); record it.
      conflicts.push({ kind: 'delete-edit', id, field: null, kept: surviving, dropped: null });
      out.push(surviving);
      continue;
    }
    // Present on both → field-level merge (fast path if identical/one side static).
    if (eq(o, b)) out.push(t);                           // only theirs changed
    else if (eq(t, b)) out.push(o);                      // only ours changed
    else if (eq(o, t)) out.push(o);                      // both same change
    else out.push(mergeObject(b, o, t, id, conflicts));  // real 3-way
  }
  return out;
}

// people_meta is a name-keyed object (no per-record timestamps) — merge per key
// at unit granularity: one-sided change wins; both-changed → ours + conflict.
function mergePeopleMeta(base = {}, ours = {}, theirs = {}, conflicts) {
  const out = {};
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)]);
  for (const k of keys) {
    const inB = k in base, inO = k in ours, inT = k in theirs;
    const b = base[k], o = ours[k], t = theirs[k];
    if (!inB) { if (inO && inT) { out[k] = eq(o, t) ? o : (conflicts.push({ kind: 'people_meta', id: k, field: null, kept: o, dropped: t }), o); } else out[k] = inO ? o : t; continue; }
    const delO = !inO, delT = !inT;
    if (delO && delT) continue;
    if (delO || delT) { const surv = delO ? t : o; if (eq(surv, b)) continue; out[k] = surv; continue; }
    if (eq(o, b)) out[k] = t;
    else if (eq(t, b)) out[k] = o;
    else if (eq(o, t)) out[k] = o;
    else { out[k] = o; conflicts.push({ kind: 'people_meta', id: k, field: null, kept: o, dropped: t }); }
  }
  return out;
}

export function mergeStates(base, ours, theirs) {
  const b = base || {}, o = ours || {}, t = theirs || {};
  const conflicts = [];
  // Circle identity: prefer the side that actually has an id (disk wins when both
  // do — it's the source of truth — but a fresh file's just-minted id isn't lost).
  const wsT = t.workspace, wsO = o.workspace;
  const workspace = (wsT && wsT.id) ? wsT : (wsO && wsO.id) ? wsO : (wsT || wsO || { id: null, name: '' });
  const merged = {
    ...o,                                                // preserve unknown top-level keys (ours)
    schema_version: 3,
    workspace,
    people_meta: mergePeopleMeta(b.people_meta, o.people_meta, t.people_meta, conflicts),
  };
  for (const field of ID_ARRAYS) {
    merged[field] = mergeIdArray(b[field], o[field], t[field], conflicts);
  }
  return { merged, conflicts };
}
