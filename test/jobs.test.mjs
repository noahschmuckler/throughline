// Tests for lib/jobs.js (T16/T26): the machine-local job store, the FIFO
// runner state machine, boot recovery, and consult sessions. Runners are
// injected fakes — no model, no server.
// Run: node --test test/

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  jobsPath, emptyJobsDoc, normalizeJobsDoc, pruneDoc,
  createJob, getJob, listJobs, dismissJob,
  createSession, getSession, updateSession, appendSessionTurn,
  configureRunner, sweepOnBoot,
} from '../lib/jobs.js';

let dir;
beforeEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(join(tmpdir(), 'tl-jobs-'));
  process.env.THROUGHLINE_JOBS = join(dir, 'jobs.json');
  configureRunner({ runners: {}, concurrency: 3 });
});

const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ---- store ------------------------------------------------------------

test('normalizeJobsDoc: tolerant, preserves unknown keys', () => {
  assert.deepEqual(normalizeJobsDoc(null), { jobs: [], sessions: [] });
  const d = normalizeJobsDoc({ jobs: 'nope', sessions: [{ id: 's1' }], extra: 1 });
  assert.deepEqual(d.jobs, []);
  assert.equal(d.sessions.length, 1);
  assert.equal(d.extra, 1);
});

test('pruneDoc: terminal jobs cap; committed/abandoned + stale sessions drop', () => {
  const doc = emptyJobsDoc();
  for (let i = 0; i < 60; i++) doc.jobs.push({ id: `j${i}`, status: 'done', updated_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` });
  doc.jobs.push({ id: 'running', status: 'running', updated_at: '2025-01-01T00:00:00Z' });
  doc.sessions.push(
    { id: 'live', status: 'active', updated_at: new Date().toISOString() },
    { id: 'done', status: 'committed', updated_at: new Date().toISOString() },
    { id: 'old', status: 'active', updated_at: '2026-01-01T00:00:00Z' },
  );
  pruneDoc(doc, Date.parse('2026-06-07T00:00:00Z'));
  assert.equal(doc.jobs.filter(j => j.status === 'done').length, 50);
  assert.ok(doc.jobs.some(j => j.id === 'running'), 'running never prunes');
  assert.deepEqual(doc.sessions.map(s => s.id), ['live']);
});

// ---- lifecycle ----------------------------------------------------------

test('createJob → runner runs it → done with result; listJobs/since filters', async () => {
  configureRunner({ runners: { atomize: async (job) => ({ ok: true, echo: job.input.x }) }, concurrency: 3 });
  const job = await createJob({ kind: 'atomize', title: 'T', input: { x: 42 } });
  assert.equal(job.status, 'queued');
  await settle();
  const done = await getJob(job.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { ok: true, echo: 42 });
  assert.ok(done.started_at && done.finished_at);

  const all = await listJobs();
  assert.equal(all.length, 1);
  const none = await listJobs({ since: done.updated_at });
  assert.equal(none.length, 0);
});

test('runner throwing → error status with the message; unknown kind errors too', async () => {
  configureRunner({ runners: { atomize: async () => { throw new Error('model exploded'); } }, concurrency: 3 });
  const j1 = await createJob({ kind: 'atomize', input: {} });
  const j2 = await createJob({ kind: 'consult_turn', input: {} }); // no runner registered
  await settle();
  assert.equal((await getJob(j1.id)).status, 'error');
  assert.match((await getJob(j1.id)).error, /model exploded/);
  assert.equal((await getJob(j2.id)).status, 'error');
  assert.match((await getJob(j2.id)).error, /no runner/);
});

test('concurrency cap: at most N running at once, FIFO order', async () => {
  let active = 0, peak = 0;
  const order = [];
  configureRunner({
    concurrency: 2,
    runners: {
      atomize: async (job) => {
        active++; peak = Math.max(peak, active);
        order.push(job.input.n);
        await settle(40);
        active--;
        return {};
      },
    },
  });
  const jobs = [];
  for (let n = 0; n < 5; n++) jobs.push(await createJob({ kind: 'atomize', input: { n } }));
  await settle(250);
  assert.equal(peak, 2, `peak concurrency was ${peak}`);
  assert.deepEqual(order, [0, 1, 2, 3, 4], 'FIFO pickup');
  for (const j of jobs) assert.equal((await getJob(j.id)).status, 'done');
});

test('dismissJob: soft flag, job survives', async () => {
  configureRunner({ runners: { atomize: async () => ({}) }, concurrency: 3 });
  const j = await createJob({ kind: 'atomize', input: {} });
  await settle();
  const d = await dismissJob(j.id);
  assert.equal(d.dismissed, true);
  assert.equal((await getJob(j.id)).status, 'done');
});

test('sweepOnBoot: running → error, queued re-schedules', async () => {
  // Simulate a crash: cap 1 + a hanging runner → the FIRST job sticks in
  // `running` forever; the other two stay `queued`.
  configureRunner({ runners: { atomize: () => new Promise(() => {}) }, concurrency: 1 });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await createJob({ kind: 'atomize', input: { i } })).id);
  await settle();
  const hung = (await listJobs({ status: 'running' }))[0];
  assert.ok(hung, 'one job is running (hung)');
  assert.equal((await listJobs({ status: 'queued' })).length, 2);

  // "Restart": fresh runner config (also frees the leaked slot); sweep marks
  // the running job dead and re-schedules the queued ones.
  configureRunner({ runners: { atomize: async () => ({ ok: 1 }) }, concurrency: 2 });
  await sweepOnBoot();
  await settle(80);
  assert.equal((await getJob(hung.id)).status, 'error');
  assert.match((await getJob(hung.id)).error, /restarted/);
  for (const id of ids.filter(x => x !== hung.id)) {
    assert.equal((await getJob(id)).status, 'done');
  }
});

// ---- sessions (T26) ------------------------------------------------------

test('sessions: create → consult_turn job appends user turn atomically; runner appends assistant', async () => {
  configureRunner({
    concurrency: 1,
    runners: {
      consult_turn: async (job, { getSession: getS, appendSessionTurn: appendS }) => {
        const s = await getS(job.input.session_id);
        const reply = `echo: ${s.messages[s.messages.length - 1].content}`;
        await appendS(s.id, 'assistant', reply);
        return { reply };
      },
    },
  });
  const s = await createSession({ entry_id: 'e1', new_container_ids: ['c1'], bundle: { session_id: 'ing_x' } });
  const job = await createJob({ kind: 'consult_turn', input: { session_id: s.id, content: 'hello model', awaiting_decision_set: true } });
  assert.equal(job.input.turn_index, 0);
  assert.equal(job.input.awaiting_decision_set, true);
  await settle();
  const after = await getSession(s.id);
  assert.equal(after.messages.length, 2);
  assert.deepEqual(after.messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(after.messages[1].content, 'echo: hello model');
  assert.equal((await getJob(job.id)).result.reply, 'echo: hello model');
});

test('consult_turn against a missing session → job errors at create time', async () => {
  configureRunner({ runners: {}, concurrency: 1 });
  await assert.rejects(
    () => createJob({ kind: 'consult_turn', input: { session_id: 'nope', content: 'hi' } }),
    /session nope not found/);
});

test('updateSession: status transitions, message append, decision-set storage', async () => {
  const s = await createSession({ bundle: {} });
  await updateSession(s.id, { message: '[from review] moved X from A to B', status: 'active' });
  await updateSession(s.id, { status: 'reviewing', last_decision_set: { a1: { verb: 'accept' } } });
  const after = await getSession(s.id);
  assert.equal(after.messages.length, 1);
  assert.match(after.messages[0].content, /from review/);
  assert.equal(after.status, 'reviewing');
  assert.deepEqual(after.last_decision_set, { a1: { verb: 'accept' } });
  await updateSession(s.id, { status: 'bogus' }); // invalid → ignored
  assert.equal((await getSession(s.id)).status, 'reviewing');
});
