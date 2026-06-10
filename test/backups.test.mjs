// Backup engine (lib/backups.js): naming/path-safety, usage-relative thinning,
// dual-destination writes, and the throttled-on-change auto hook.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  sanitizeHost, backupStamp, backupFilename, BACKUP_RE, parseBackupName,
  planThinning, writeBackup, maybeAutoBackup, localBackupsDir, onedriveBackupsDir,
} from '../lib/backups.js';

// --- naming + path safety ---------------------------------------------------

test('stamp/filename round-trips and is sortable', () => {
  const d1 = new Date('2026-06-10T14:30:00.123Z');
  const d2 = new Date('2026-06-10T14:30:01.000Z');
  const f1 = backupFilename('NOAH-ORANGE', backupStamp(d1));
  const f2 = backupFilename('NOAH-ORANGE', backupStamp(d2));
  assert.ok(BACKUP_RE.test(f1));
  assert.ok(f1 < f2, 'lexicographic order matches chronological');
  const p = parseBackupName(f1);
  assert.equal(p.ts, d1.getTime());
  assert.equal(p.host, 'NOAH-ORANGE');
});

test('BACKUP_RE rejects anything that could be loaded as live state', () => {
  for (const bad of [
    'state.json', '../state.json', 'backups/../../state.json',
    'throughline-backup--x--host.bak.json',          // bad stamp
    'throughline-backup--20260610t143000123z--ho/st.bak.json', // separator
    'throughline-backup--20260610t143000123z--host.json',      // missing .bak
    '..', '.', '',
  ]) {
    assert.equal(BACKUP_RE.test(bad), false, `should reject: ${bad}`);
  }
  assert.ok(BACKUP_RE.test('throughline-backup--20260610t143000123z--NOAH_ORANGE-1.bak.json'));
});

test('sanitizeHost strips separators and never returns empty', () => {
  assert.equal(sanitizeHost('a/b\\c'), 'a-b-c');
  assert.equal(sanitizeHost(''), 'host');
  assert.equal(sanitizeHost('!!!'), 'host');
});

// --- thinning ---------------------------------------------------------------

const mkSeries = (count, stepMs, startTs) =>
  Array.from({ length: count }, (_, i) => {
    const ts = startTs + i * stepMs;
    return { file: backupFilename('h', backupStamp(new Date(ts))), ts };
  });

test('thinning keeps everything below the floor (idle-safe: in == out)', () => {
  const s = mkSeries(8, 60e3, Date.UTC(2026, 0, 1));
  const { keep, drop } = planThinning(s, { recentFloor: 10 });
  assert.equal(drop.length, 0);
  assert.equal(keep.size, 8);
});

test('thinning is anchored to the NEWEST backup, not wall-clock now', () => {
  // A dense burst long ago + a recent few. Anchor = newest. Old burst collapses
  // to daily/weekly reps but the oldest + recent floor always survive.
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const base = Date.UTC(2020, 0, 1);                 // years ago — would be purged by a wall-clock policy
  const old = mkSeries(50, HOUR, base);              // 50 hourly, way back
  const recent = mkSeries(5, HOUR, base + 40 * DAY); // 5 recent, 40d later (still all "old" vs now)
  const all = [...old, ...recent];
  const { keep, drop } = planThinning(all, { recentFloor: 10 });
  // Nothing is dropped purely for being far from "now": the recent 5 + oldest survive.
  const oldest = [...all].sort((a, b) => a.ts - b.ts)[0];
  assert.ok(keep.has(oldest.file), 'oldest is always kept');
  for (const r of recent) assert.ok(keep.has(r.file), 'recent floor kept');
  assert.ok(drop.length > 0, 'the dense old burst is thinned');
  assert.ok(keep.size >= 11, 'kept = oldest + reps + recent floor');
});

test('thinning never empties a series and always keeps oldest + recent floor', () => {
  const s = mkSeries(200, 6 * 3600e3, Date.UTC(2024, 0, 1)); // 200 every 6h ≈ 50 days
  const { keep } = planThinning(s, { recentFloor: 10 });
  const sorted = [...s].sort((a, b) => a.ts - b.ts);
  assert.ok(keep.has(sorted[0].file), 'oldest kept');
  for (const b of sorted.slice(-10)) assert.ok(keep.has(b.file), 'recent 10 kept');
  assert.ok(keep.size >= 11 && keep.size < s.length, 'thinned but non-empty');
});

// --- dual-destination writes ------------------------------------------------

async function withCircle(run) {
  const root = await mkdtemp(join(tmpdir(), 'tl-bk-'));
  const saved = process.env.THROUGHLINE_BACKUPS;
  try {
    const statePath = join(root, 'circle', 'Throughline', 'state.json');
    await mkdir(dirname(statePath), { recursive: true });
    process.env.THROUGHLINE_BACKUPS = join(root, '_local');
    const circle = { id: 'circle-1', name: 'Test Circle', statePath, root: join(root, 'circle') };
    await run({ root, circle, statePath });
  } finally {
    if (saved === undefined) delete process.env.THROUGHLINE_BACKUPS; else process.env.THROUGHLINE_BACKUPS = saved;
    await rm(root, { recursive: true, force: true });
  }
}

const sampleState = (extra = {}) => ({
  schema_version: 3, containers: [{ id: 'p1', title: 'P' }], entries: [], atoms: [], people_meta: {},
  workspace: { id: 'circle-1', name: 'Test Circle' }, ...extra,
});

test('writeBackup writes both destinations, embeds + strips _backup_meta', async () => {
  await withCircle(async ({ circle }) => {
    const now = new Date('2026-06-10T10:00:00.000Z');
    // A state that already carries a stale _backup_meta — must be replaced, not nested.
    const res = await writeBackup(circle, sampleState({ _backup_meta: { reason: 'STALE' } }), 'manual', { host: 'BOX1', now });
    assert.deepEqual(res.locations.sort(), ['local', 'onedrive']);

    const localFile = join(localBackupsDir('circle-1'), res.file);
    const odFile = join(onedriveBackupsDir(circle, 'BOX1'), res.file);
    const local = JSON.parse(await readFile(localFile, 'utf8'));
    const od = JSON.parse(await readFile(odFile, 'utf8'));
    assert.equal(local._backup_meta.reason, 'manual');
    assert.equal(local._backup_meta.host, 'BOX1');
    assert.equal(local._backup_meta.circle_id, 'circle-1');
    assert.equal(typeof local._backup_meta.STALE, 'undefined'); // not nested
    assert.deepEqual(local.containers, od.containers);
  });
});

test('writeBackup tolerates an unwritable OneDrive dir (local still lands)', async () => {
  await withCircle(async ({ circle, statePath }) => {
    // Make the OneDrive backups path collide with a FILE so mkdir fails.
    await writeFile(join(dirname(statePath), 'backups'), 'x', 'utf8');
    const res = await writeBackup(circle, sampleState(), 'auto', { host: 'BOX1', now: new Date('2026-06-10T11:00:00Z') });
    assert.deepEqual(res.locations, ['local'], 'onedrive skipped, local kept');
    const files = await readdir(localBackupsDir('circle-1'));
    assert.equal(files.length, 1);
  });
});

// --- throttled-on-change auto hook ------------------------------------------

test('maybeAutoBackup: skips no-change, throttles, then backs up after the window', async () => {
  await withCircle(async ({ circle }) => {
    const t0 = new Date('2026-06-10T12:00:00Z');
    // changed=false → never backs up.
    assert.equal(await maybeAutoBackup({ circle, merged: sampleState(), changed: false }, { now: t0 }), null);

    // First changed save → backs up.
    const r1 = await maybeAutoBackup({ circle, merged: sampleState(), changed: true }, { now: t0 });
    assert.ok(r1 && r1.file);

    // Same content again → identical contentKey → skip.
    const r2 = await maybeAutoBackup({ circle, merged: sampleState(), changed: true }, { now: new Date(t0.getTime() + 60e3) });
    assert.equal(r2, null);

    // Different content but within the throttle window → skip.
    const changed = sampleState({ atoms: [{ id: 'a1' }] });
    const r3 = await maybeAutoBackup({ circle, merged: changed, changed: true }, { now: new Date(t0.getTime() + 5 * 60e3) });
    assert.equal(r3, null);

    // Different content AFTER the 15-min window → backs up.
    const r4 = await maybeAutoBackup({ circle, merged: changed, changed: true }, { now: new Date(t0.getTime() + 20 * 60e3) });
    assert.ok(r4 && r4.file);

    const files = (await readdir(localBackupsDir('circle-1'))).filter(f => BACKUP_RE.test(f));
    assert.equal(files.length, 2, 'exactly two auto backups landed');
  });
});
