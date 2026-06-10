// ------------------------------------------------------------------
// Throughline — circle federation (M3) + per-circle merge routing (M1).
//
// GET  : load every circle's state.json, tag each object with its origin
//        `_circle`, and union into one federated doc the front-end renders.
// PUT  : split the incoming federated doc back by `_circle`, 3-way merge each
//        circle against disk (base = a machine-local snapshot), write only the
//        circles that changed, and return the re-federated merged doc + conflicts.
//
// The `_circle` tag is a runtime federation marker only — stripped before each
// file is written, so the on-disk state.json files stay clean + portable.
// ------------------------------------------------------------------

import { discoverCircles, circleById } from './circles.js';
import { readStateAt, writeStateAt, emptyState } from './store.js';
import { readSnapshot, writeSnapshot } from './snapshots.js';
import { mergeStates } from '../shared/merge.js';

const TAG = '_circle';

const tagArr = (arr, id) => (Array.isArray(arr) ? arr : []).map(o => ({ ...o, [TAG]: id }));
const strip = (o) => { const { [TAG]: _drop, ...rest } = o; return rest; };

// Deterministic content compare (id-sorted) so we only write circles that changed.
// Exported so the backup engine (lib/backups.js) keys its throttle on the SAME
// notion of "did this circle's content change".
export function contentKey(s) {
  const ids = (a) => [...(a || [])].map(o => ({ ...o })).sort((x, y) => String(x.id).localeCompare(String(y.id)));
  return JSON.stringify({ c: ids(s.containers), e: ids(s.entries), a: ids(s.atoms), p: s.people_meta || {} });
}

// Assemble a federated doc from [{ circle, state }] pairs (primary's people_meta
// wins; programs/containers tagged by origin).
function federate(pairs, registry) {
  const primary = registry.find(c => c.primary) || registry[0];
  const containers = [], entries = [], atoms = [];
  let people_meta = {};
  // Non-primary first, primary last → primary's overlay wins on key collision.
  const ordered = [...pairs].sort((a, b) => (a.circle.primary === b.circle.primary ? 0 : a.circle.primary ? 1 : -1));
  for (const { circle, state } of ordered) {
    containers.push(...tagArr(state.containers, circle.id));
    entries.push(...tagArr(state.entries, circle.id));
    atoms.push(...tagArr(state.atoms, circle.id));
    people_meta = { ...people_meta, ...(state.people_meta || {}) };
  }
  return {
    schema_version: 3,
    containers, entries, atoms, people_meta,
    workspace: primary ? { id: primary.id, name: primary.name } : { id: null, name: '' },
    circles: registry.map(c => ({ id: c.id, name: c.name, primary: !!c.primary })),
  };
}

// GET — load + tag + union.
export async function loadFederated() {
  const registry = await discoverCircles();
  const pairs = [];
  for (const c of registry) {
    let state;
    try { state = await readStateAt(c.statePath); }
    catch (e) { console.warn(`[federation] circle "${c.name}" unreadable, showing empty: ${e.message}`); state = emptyState(); }
    pairs.push({ circle: c, state });
  }
  return federate(pairs, registry);
}

// PUT — split by _circle, 3-way merge each circle, write the changed ones,
// refresh snapshots, return the re-federated merged doc + conflicts.
export async function saveFederated(incoming, { onCircleWritten } = {}) {
  const registry = await discoverCircles();
  const primary = registry.find(c => c.primary) || registry[0];

  // Group the incoming objects back to their origin circle (untagged → primary).
  const groups = new Map(registry.map(c => [c.id, { containers: [], entries: [], atoms: [] }]));
  const route = (field, o) => {
    const target = (circleById(registry, o[TAG]) || primary)?.id;
    if (!groups.has(target)) groups.set(target, { containers: [], entries: [], atoms: [] });
    groups.get(target)[field].push(strip(o));
  };
  for (const o of incoming.containers || []) route('containers', o);
  for (const o of incoming.entries || []) route('entries', o);
  for (const o of incoming.atoms || []) route('atoms', o);

  const conflicts = [];
  const pairs = [];
  for (const c of registry) {
    const slice = groups.get(c.id) || { containers: [], entries: [], atoms: [] };
    let theirs;
    try { theirs = await readStateAt(c.statePath); }
    catch (e) {
      // A malformed (non-empty) file: never merge-and-overwrite it — that would
      // destroy data. Skip the circle entirely; show it empty.
      console.warn(`[federation] circle "${c.name}" unreadable, NOT writing it: ${e.message}`);
      pairs.push({ circle: c, state: emptyState() });
      continue;
    }
    const base = (await readSnapshot(c.id)) || theirs;       // first save: base=disk → safe 2-way
    const ours = {
      schema_version: 3,
      containers: slice.containers,
      entries: slice.entries,
      atoms: slice.atoms,
      // people_meta is edited only via the primary circle (MVP); others stay as base
      // (== "no change" → merge keeps disk).
      people_meta: c.id === (primary && primary.id) ? (incoming.people_meta || {}) : (base.people_meta || {}),
      // Carry the registry's (minted) id so a fresh circle's identity persists.
      workspace: { id: c.id, name: (theirs.workspace && theirs.workspace.name) || c.name },
    };
    const { merged, conflicts: cc } = mergeStates(base, ours, theirs);
    conflicts.push(...cc);
    // Write only if the circle's content actually changed (avoid OneDrive churn
    // on the other operator's box when we edited a different circle).
    const changed = contentKey(merged) !== contentKey(theirs);
    if (changed) await writeStateAt(merged, c.statePath);
    await writeSnapshot(c.id, merged);
    // Post-write hook (the backup engine). A malformed circle never reaches here
    // (it `continue`d above), so we never back up an emptyState() placeholder.
    // Try/caught HARD: a backup failure (e.g. OneDrive offline) must never break
    // the save — disk + snapshot are already consistent at this point.
    if (onCircleWritten) {
      try { await onCircleWritten({ circle: c, merged, changed }); }
      catch (e) { console.warn(`[federation] backup hook failed for "${c.name}": ${e.message}`); }
    }
    pairs.push({ circle: c, state: merged });
  }

  const state = federate(pairs, registry);
  return { state, conflicts };
}
