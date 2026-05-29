#!/usr/bin/env node
// One-off seed script for Throughline.
//
// Fetches GET /api/state, refuses to run if demo_* containers already
// exist (unless --force is passed), then merges the demo containers /
// entries / atoms onto whatever is already there and PUTs the result.
//
// Usage:
//   node scripts/seed.mjs                     # local (http://127.0.0.1:8787)
//   node scripts/seed.mjs --target local
//   node scripts/seed.mjs --target prod --url https://throughline.<acct>.workers.dev
//   node scripts/seed.mjs --force             # strip & re-add demo_* data

import { buildDemoData } from './seed-data.mjs';

const TARGETS = {
  local: 'http://127.0.0.1:8787',
};

function parseArgs(argv) {
  const args = { target: 'local', url: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Throughline demo seeder

Usage:
  node scripts/seed.mjs [--target local|prod] [--url <base>] [--force]

Flags:
  --target local|prod    Pick a base URL (default: local).
  --url <base>           Override base URL (required for --target prod).
  --force                Strip existing demo_* containers/entries/atoms,
                         then re-add. Without --force, the script refuses
                         to run if demo_* data already exists.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.url || TARGETS[args.target];
  if (!base) {
    console.error(`No URL for target "${args.target}". Pass --url <base>.`);
    process.exit(2);
  }
  const stateUrl = `${base.replace(/\/$/, '')}/api/state`;
  console.log(`-> ${stateUrl}`);

  // 1. Fetch current state.
  let current;
  try {
    const res = await fetch(stateUrl, { headers: { 'cache-control': 'no-store' } });
    if (!res.ok) throw new Error(`GET ${res.status} ${res.statusText}`);
    current = await res.json();
  } catch (err) {
    console.error(`Failed to read current state: ${err.message}`);
    console.error(`(Is the worker running? For local: \`npm run dev\` in another shell.)`);
    process.exit(1);
  }

  const currContainers = Array.isArray(current.containers) ? current.containers : [];
  const currEntries    = Array.isArray(current.entries)    ? current.entries    : [];
  const currAtoms      = Array.isArray(current.atoms)      ? current.atoms      : [];

  // 2. Collision check on demo_* containers.
  const existingDemoIds = currContainers.filter(c => c.id?.startsWith('demo_')).map(c => c.id);
  if (existingDemoIds.length > 0 && !args.force) {
    console.error(
      `Demo data already present (${existingDemoIds.length} demo_* container(s): ${existingDemoIds.join(', ')}).`
    );
    console.error(`Pass --force to strip and reseed.`);
    process.exit(1);
  }

  // 3. Build fresh demo from fixture.
  const demo = buildDemoData(new Date());

  // 4. If --force, strip prior demo_* data so we don't double up.
  let baseContainers = currContainers;
  let baseEntries    = currEntries;
  let baseAtoms      = currAtoms;
  if (args.force && existingDemoIds.length > 0) {
    const demoCidSet = new Set(existingDemoIds);
    const strippedEntryIds = new Set(
      currEntries.filter(e => demoCidSet.has(e.container_id)).map(e => e.id)
    );
    baseContainers = currContainers.filter(c => !demoCidSet.has(c.id));
    baseEntries    = currEntries.filter(e => !demoCidSet.has(e.container_id));
    baseAtoms      = currAtoms.filter(a => !strippedEntryIds.has(a.entry_id));
    console.log(
      `--force: stripped ${existingDemoIds.length} demo container(s) + ` +
      `${currEntries.length - baseEntries.length} entries + ` +
      `${currAtoms.length - baseAtoms.length} atoms.`
    );
  }

  // 5. Merge.
  const next = {
    schema_version: 1,
    containers: [...baseContainers, ...demo.containers],
    entries:    [...baseEntries,    ...demo.entries],
    atoms:      [...baseAtoms,      ...demo.atoms],
  };

  // 6. PUT.
  const putRes = await fetch(stateUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(next),
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => '');
    console.error(`PUT failed: ${putRes.status} ${putRes.statusText} ${text}`);
    process.exit(1);
  }

  // 7. Summary.
  const openActions = countOpenActions(demo);
  const overdueActions = countOverdueActions(demo, new Date());
  console.log(`OK.`);
  console.log(`  added:     ${demo.containers.length} containers, ${demo.entries.length} entries, ${demo.atoms.length} atoms`);
  console.log(`  preserved: ${baseContainers.length} containers, ${baseEntries.length} entries, ${baseAtoms.length} atoms`);
  console.log(`  demo open actions: ${openActions} (overdue: ${overdueActions})`);
}

function countOpenActions(demo) {
  const closed = new Set(
    demo.atoms.filter(a => a.kind === 'outcome' && a.parent_atom_id).map(a => a.parent_atom_id)
  );
  return demo.atoms.filter(a => a.kind === 'action' && !closed.has(a.id)).length;
}

function countOverdueActions(demo, now) {
  const today = now.toISOString().slice(0, 10);
  const closed = new Set(
    demo.atoms.filter(a => a.kind === 'outcome' && a.parent_atom_id).map(a => a.parent_atom_id)
  );
  return demo.atoms.filter(
    a => a.kind === 'action' && !closed.has(a.id) && a.due_date && a.due_date < today
  ).length;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
