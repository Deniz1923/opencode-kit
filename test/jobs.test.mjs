import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSandbox, activePlaceholders } from '../sandbox.mjs';
import { createJobManager } from '../jobs.mjs';

function fixture(t) {
  const cache = path.join(os.homedir(), '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'oc-jobs-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace); fs.mkdirSync(home);
  return { root, workspace, cwd: workspace, home, scratchRoot: path.join(root, 'scratch') };
}

test('fast background command finishes inline within grace window without leaving a running job', async t => {
  const o = fixture(t);
  const jobs = createJobManager({ graceMs: 1000 });
  t.after(() => jobs.close());
  const r = await jobs.start({ ...o, sessionID: 'ses_a', command: 'printf fast-done' });
  assert.equal(r.background, false);
  assert.equal(r.result.exit_code, 0);
  assert.equal(r.result.content, 'fast-done');
  assert.equal(jobs.list('ses_a').length, 0);
  assert.deepEqual(activePlaceholders(o.workspace, o.scratchRoot), []);
});

test('slow background job detaches, allows concurrent commands, streams log, and finishes via wait', async t => {
  const o = fixture(t);
  const jobs = createJobManager({ graceMs: 120 });
  t.after(() => jobs.close());
  const started = await jobs.start({ ...o, sessionID: 'ses_a', command: 'printf step1\\n; sleep 0.5; printf step2\\n; touch bg-done' });
  assert.equal(started.background, true);
  assert.equal(started.status, 'running');
  assert.ok(started.job_id);
  assert.ok(fs.existsSync(started.log_path));
  assert.ok(activePlaceholders(o.workspace, o.scratchRoot).length > 0);
  const concurrent = await runSandbox({ ...o, command: 'printf alongside-ok' });
  assert.equal(concurrent.exit_code, 0, concurrent.content);
  assert.equal(concurrent.content, 'alongside-ok');
  const mid = jobs.status('ses_a', started.job_id);
  assert.equal(mid.status, 'running');
  assert.equal(mid.log_path, started.log_path);
  const done = await jobs.wait('ses_a', started.job_id, { waitMs: 5000 });
  assert.equal(done.status, 'exited');
  assert.equal(done.exit_code, 0);
  assert.ok(fs.existsSync(path.join(o.workspace, 'bg-done')));
  assert.match(fs.readFileSync(started.log_path, 'utf8'), /step1[\s\S]*step2/);
  assert.deepEqual(activePlaceholders(o.workspace, o.scratchRoot), []);
});

test('aborting during initial grace window kills job; aborting wait later leaves job running', async t => {
  const o = fixture(t);
  const jobs = createJobManager({ graceMs: 1000 });
  t.after(() => jobs.close());
  const ac1 = new AbortController();
  setTimeout(() => ac1.abort(), 120);
  const aborted = await jobs.start({ ...o, sessionID: 'ses_a', command: 'sleep 2; touch should-not-exist', signal: ac1.signal });
  assert.equal(aborted.background, false);
  assert.equal(aborted.result.exit_code, 130);
  assert.equal(jobs.list('ses_a').length, 0);
  assert.deepEqual(activePlaceholders(o.workspace, o.scratchRoot), []);
  assert.equal(fs.existsSync(path.join(o.workspace, 'should-not-exist')), false);

  const fastJobs = createJobManager({ graceMs: 100 });
  t.after(() => fastJobs.close());
  const started = await fastJobs.start({ ...o, sessionID: 'ses_a', command: 'sleep 0.6; printf survived' });
  assert.equal(started.background, true);
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort(), 80);
  const partial = await fastJobs.wait('ses_a', started.job_id, { waitMs: 5000, signal: ac2.signal });
  assert.equal(partial.status, 'running');
  const finished = await fastJobs.wait('ses_a', started.job_id, { waitMs: 5000 });
  assert.equal(finished.status, 'exited');
  assert.match(finished.content, /survived/);
});

test('cancel kills process group and releases placeholders; timeout caps background runtime', async t => {
  const o = fixture(t);
  const jobs = createJobManager({ graceMs: 80 });
  t.after(() => jobs.close());
  await assert.rejects(jobs.start({ ...o, sessionID: 'ses_a', command: 'sleep 5', timeout: 0 }), /timeout/i);
  const started = await jobs.start({ ...o, sessionID: 'ses_a', command: '(sleep 2; touch delayed-cancel) & wait' });
  assert.equal(started.background, true);
  const cancelled = await jobs.cancel('ses_a', started.job_id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.exit_code, 130);
  assert.deepEqual(activePlaceholders(o.workspace, o.scratchRoot), []);
  const timedOut = await jobs.start({ ...o, sessionID: 'ses_a', command: 'sleep 5', timeout: 250 });
  const result = timedOut.background ? await jobs.wait('ses_a', timedOut.job_id, { waitMs: 3000 }) : timedOut.result;
  assert.equal(result.exit_code, 124);
  if (timedOut.background) assert.equal(result.status, 'timed_out');
});

test('jobs are isolated per session, enforce workspace cap, and clean up on session deletion or close', async t => {
  const o = fixture(t);
  const jobs = createJobManager({ graceMs: 60, maxPerWorkspace: 2, maxGlobal: 4 });
  t.after(() => jobs.close());
  const j1 = await jobs.start({ ...o, sessionID: 'ses_a', command: 'sleep 5' });
  const j2 = await jobs.start({ ...o, sessionID: 'ses_a', command: 'sleep 5' });
  assert.equal(j1.background, true);
  assert.equal(j2.background, true);
  await assert.rejects(jobs.start({ ...o, sessionID: 'ses_a', command: 'sleep 5' }), /active background jobs/i);
  assert.deepEqual(jobs.list('ses_b'), []);
  assert.throws(() => jobs.status('ses_b', j1.job_id), /not found/i);
  await assert.rejects(jobs.wait('ses_b', j1.job_id), /not found/i);
  await assert.rejects(jobs.cancel('ses_b', j1.job_id), /not found/i);
  await jobs.cleanupSession('ses_a');
  assert.equal(jobs.status('ses_a', j1.job_id).status, 'cancelled');
  assert.equal(jobs.status('ses_a', j2.job_id).status, 'cancelled');
  assert.deepEqual(activePlaceholders(o.workspace, o.scratchRoot), []);
  const j3 = await jobs.start({ ...o, sessionID: 'ses_b', command: 'sleep 5' });
  assert.equal(j3.background, true);
  await jobs.close();
  assert.deepEqual(activePlaceholders(o.workspace, o.scratchRoot), []);
});

test('cleanupSession and close abort in-flight start calls during graceMs without leaking jobs or placeholders', async t => {
  const o = fixture(t);
  const jobs = createJobManager({ graceMs: 1000 });
  t.after(() => jobs.close());
  const pending1 = jobs.start({ ...o, sessionID: 'ses_a', command: 'sleep 5; touch leaked-a' });
  await new Promise(resolve => setTimeout(resolve, 150));
  await jobs.cleanupSession('ses_a');
  const r1 = await pending1;
  assert.equal(r1.background, false);
  assert.equal(r1.result.exit_code, 130);
  assert.equal(jobs.list('ses_a').length, 0);
  assert.deepEqual(activePlaceholders(o.workspace, o.scratchRoot), []);

  const pending2 = jobs.start({ ...o, sessionID: 'ses_b', command: 'sleep 5; touch leaked-b' });
  await new Promise(resolve => setTimeout(resolve, 150));
  await jobs.close();
  const r2 = await pending2;
  assert.equal(r2.background, false);
  assert.equal(r2.result.exit_code, 130);
  assert.equal(jobs.list('ses_b').length, 0);
  assert.deepEqual(activePlaceholders(o.workspace, o.scratchRoot), []);
});

test('maxPerWorkspace cap holds across staggered starts within the graceMs window', async t => {
  const o = fixture(t);
  const jobs = createJobManager({ graceMs: 600, maxPerWorkspace: 2, maxGlobal: 4 });
  t.after(() => jobs.close());
  const p1 = jobs.start({ ...o, sessionID: 'ses_a', command: 'sleep 5' });
  const p2 = jobs.start({ ...o, sessionID: 'ses_a', command: 'sleep 5' });
  await new Promise(resolve => setTimeout(resolve, 120));
  await assert.rejects(jobs.start({ ...o, sessionID: 'ses_a', command: 'sleep 5' }), /active background jobs/i);
  await Promise.all([p1, p2]);
  await jobs.close();
});

test('truncated non-zero sandbox commands surface key failure lines from omitted middle while exit 0 stays clean', async t => {
  const o = fixture(t);
  const lineFail = await runSandbox({
    ...o,
    command: 'for i in $(seq 1 2600); do if [ "$i" -eq 600 ]; then echo "FAIL src/auth.test.js: AssertionError expected 200"; else echo "ok line $i"; fi; done; exit 1',
  });
  assert.equal(lineFail.exit_code, 1);
  assert.equal(lineFail.truncated, true);
  assert.match(lineFail.content, /\[truncated — key failure lines from omitted middle:\]/);
  assert.match(lineFail.content, /FAIL src\/auth\.test\.js: AssertionError expected 200/);
  assert.ok(lineFail.log_path && fs.existsSync(lineFail.log_path));

  const byteFail = await runSandbox({
    ...o,
    command: 'node -e \'const pad = "x".repeat(120); for (let i = 1; i <= 900; i++) console.log(i === 300 ? "error TS2345: Argument of type string is not assignable" : `line ${i} ${pad}`); process.exit(2);\'',
  });
  assert.equal(byteFail.exit_code, 2);
  assert.equal(byteFail.truncated, true);
  assert.match(byteFail.content, /error TS2345: Argument of type string is not assignable/);

  const okTrunc = await runSandbox({
    ...o,
    command: 'for i in $(seq 1 2600); do if [ "$i" -eq 600 ]; then echo "ERROR ignored on exit 0"; else echo "ok line $i"; fi; done',
  });
  assert.equal(okTrunc.exit_code, 0);
  assert.equal(okTrunc.truncated, true);
  assert.doesNotMatch(okTrunc.content, /key failure lines from omitted middle/);
});
