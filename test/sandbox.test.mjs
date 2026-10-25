import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { runSandbox, runProcess } from '../sandbox.mjs';

const q = s => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture(t) {
  const cache = path.join(os.homedir(), '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'oc-sandbox-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace); fs.mkdirSync(home);
  return { root, workspace, home, scratchRoot: path.join(root, 'scratch') };
}

test('workspace and scratch writes work, external and symlink writes fail', async t => {
  const o = fixture(t);
  fs.symlinkSync(o.home, path.join(o.workspace, 'outside'));
  const r = await runSandbox({ ...o, command: 'touch local; touch "$TMPDIR/probe"; ! touch outside/escape; ! touch ' + q(path.join(o.home, 'escape')) });
  assert.equal(r.exit_code, 0, r.content);
  assert.ok(fs.existsSync(path.join(o.workspace, 'local')));
  assert.ok(!fs.existsSync(path.join(o.home, 'escape')));
  assert.ok(fs.existsSync(path.join(r.scratch, 'tmp/probe')));
});

test('requested workdir cannot expand the trusted workspace', async t => {
  const o = fixture(t);
  await assert.rejects(runSandbox({ ...o, cwd: o.home, command: 'touch marker' }), /outside.*workspace/i);
  assert.ok(!fs.existsSync(path.join(o.home, 'marker')));
});

test('existing and absent configuration and Git metadata resist writes', async t => {
  const o = fixture(t);
  fs.mkdirSync(path.join(o.workspace, '.git'));
  fs.writeFileSync(path.join(o.workspace, '.git/HEAD'), 'unchanged');
  fs.writeFileSync(path.join(o.workspace, 'opencode.json'), '{"test":true}\n');
  const r = await runSandbox({ ...o, command: '! touch opencode.json; ! touch opencode.jsonc; ! mkdir .opencode; ! touch .opencode/plugin.js; ! touch .git/HEAD; ! mv .opencode moved' });
  assert.equal(r.exit_code, 0, r.content);
  assert.equal(fs.readFileSync(path.join(o.workspace, '.git/HEAD'), 'utf8'), 'unchanged');
  assert.equal(fs.readFileSync(path.join(o.workspace, 'opencode.json'), 'utf8'), '{"test":true}\n');
  assert.ok(!fs.existsSync(path.join(o.workspace, 'opencode.jsonc')));
  assert.ok(!fs.existsSync(path.join(o.workspace, '.opencode')));
});

test('credentials and secret environment values are unavailable', async t => {
  const o = fixture(t);
  fs.mkdirSync(path.join(o.home, '.ssh'));
  fs.writeFileSync(path.join(o.home, '.ssh/key'), 'DO-NOT-EXPOSE');
  const r = await runSandbox({ ...o, env: { ...process.env, API_TOKEN: 'DO-NOT-EXPOSE', BASH_ENV: '/host/evil', NODE_OPTIONS: '--bad-option' },
    command: 'env; cat "$HOME/.ssh/key" 2>/dev/null || true' });
  assert.equal(r.exit_code, 0, r.content);
  assert.ok(!r.content.includes('DO-NOT-EXPOSE'));
  assert.ok(!r.content.includes('BASH_ENV='));
  assert.ok(!r.content.includes('NODE_OPTIONS='));
});

test('host Unix sockets and localhost network are unreachable', async t => {
  const o = fixture(t);
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-host-socket-'));
  t.after(() => fs.rmSync(socketDir, { recursive: true, force: true }));
  const sock = path.join(socketDir, 'host.sock');
  const unix = net.createServer();
  const tcp = net.createServer();
  await new Promise(resolve => unix.listen(sock, resolve));
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
  t.after(() => { unix.close(); tcp.close(); });
  const script = `import socket\ntry:\n s=socket.socket(socket.AF_UNIX); s.connect(${JSON.stringify(sock)}); raise SystemExit(1)\nexcept OSError: pass\ns=socket.socket(); s.settimeout(1)\ntry: s.connect(('127.0.0.1', ${tcp.address().port})); raise SystemExit(1)\nexcept OSError: pass`;
  const r = await runSandbox({ ...o, command: 'python3 -c ' + q(script) });
  assert.equal(r.exit_code, 0, r.content);
});

test('missing bwrap never executes the submitted command', async t => {
  const o = fixture(t);
  await assert.rejects(runSandbox({ ...o, bwrap: path.join(o.root, 'missing'), command: 'touch marker' }), /sandbox unavailable/i);
  assert.ok(!fs.existsSync(path.join(o.workspace, 'marker')));
});

test('protection placeholders do not appear as untracked Git changes', async t => {
  const o = fixture(t);
  execFileSync('git', ['init', '--quiet', o.workspace]);
  const r = await runSandbox({ ...o, command: 'git status --porcelain' });
  assert.equal(r.exit_code, 0, r.content);
  assert.equal(r.content, '');
});

test('ordinary Node and npm tests run inside the actual sandbox', async t => {
  const o = fixture(t);
  fs.writeFileSync(path.join(o.workspace, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  fs.writeFileSync(path.join(o.workspace, 'example.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('arithmetic',()=>assert.equal(2+2,4));\n");
  const r = await runSandbox({ ...o, command: 'npm test', timeout: 10000 });
  assert.equal(r.exit_code, 0, r.content);
  assert.match(r.content, /pass 1/);
});

test('linked worktree Git reads work and metadata writes remain blocked', async t => {
  const o = fixture(t);
  execFileSync('git', ['init', '--quiet', o.workspace]);
  execFileSync('git', ['-C', o.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '-m', 'initial']);
  const linked = path.join(o.root, 'linked');
  execFileSync('git', ['-C', o.workspace, 'worktree', 'add', '--quiet', '--detach', linked]);
  const read = await runSandbox({ ...o, workspace: linked, command: 'git status --porcelain' });
  assert.equal(read.exit_code, 0, read.content); assert.equal(read.content, '');
  const write = await runSandbox({ ...o, workspace: linked, command: 'git update-ref refs/heads/must-not-exist HEAD' });
  assert.notEqual(write.exit_code, 0, write.content);
  assert.ok(!fs.existsSync(path.join(o.workspace, '.git/refs/heads/must-not-exist')));
});

test('filesystem Unix sockets under HOME cannot reach host processes', async t => {
  const o = fixture(t);
  const sock = path.join(o.home, 'service.sock');
  const server = net.createServer();
  await new Promise(resolve => server.listen(sock, resolve));
  t.after(() => server.close());
  const r = await runSandbox({ ...o, command: 'python3 -c ' + q(`import socket; s=socket.socket(socket.AF_UNIX); s.connect(${JSON.stringify(sock)})`) });
  assert.notEqual(r.exit_code, 0, 'Sandbox reached a host socket outside standard runtime directories');
});

test('read-only mode and home guard withhold workspace writes', async t => {
  const o = fixture(t);
  for (const extra of [{ readOnly: true }, { home: o.workspace }]) {
    const r = await runSandbox({ ...o, ...extra, command: 'touch forbidden' });
    assert.notEqual(r.exit_code, 0, r.content);
    assert.ok(!fs.existsSync(path.join(o.workspace, 'forbidden')));
  }
});

test('output is bounded and timed-out commands cannot create delayed files', async t => {
  const o = fixture(t);
  const r = await runProcess('/bin/bash', ['-c', 'yes x | head -c 200000'], { cwd: o.workspace, timeout: 2000 });
  assert.ok(Buffer.byteLength(r.content) < 52000);
  assert.equal(r.truncated, true);
  const killed = await runSandbox({ ...o, timeout: 150, command: '(sleep 1; touch delayed) & wait' });
  assert.equal(killed.exit_code, 124);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok(!fs.existsSync(path.join(o.workspace, 'delayed')));
});
