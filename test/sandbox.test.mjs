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

test('history and XDG credential locations are masked, including aliases', async t => {
  const o = fixture(t), data = path.join(o.home, 'custom-data'), config = path.join(o.home, 'custom-config');
  const files = [path.join(o.home, '.codex/sessions/fake'), path.join(o.home, '.claude/projects/fake'),
    path.join(data, 'opencode/history/fake'), path.join(config, 'opencode/service.json'),
    path.join(config, 'gh/hosts.yml'), path.join(config, 'gcloud/fake-credentials')];
  for (const file of files) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, 'SYNTHETIC-PRIVATE-SENTINEL'); }
  fs.symlinkSync(path.join(o.home, '.codex'), path.join(o.workspace, 'alias'));
  const r = await runSandbox({...o, env:{...process.env, XDG_DATA_HOME:data, XDG_CONFIG_HOME:config},
    command: 'cat ' + [...files, path.join(o.workspace, 'alias/sessions/fake')].map(q).join(' ') + ' 2>/dev/null || true'});
  assert.equal(r.exit_code, 0, r.content);
  assert.ok(!r.content.includes('SYNTHETIC-PRIVATE-SENTINEL'), r.content);
});

test('existing nested configuration is read-only and absent nested configuration cannot be created', async t => {
  const o = fixture(t); fs.mkdirSync(path.join(o.workspace, 'sub/.opencode'), {recursive:true});
  fs.writeFileSync(path.join(o.workspace, 'sub/opencode.json'), '{}');
  const r = await runSandbox({...o, command: '! touch sub/opencode.json; ! touch sub/opencode.jsonc; ! touch sub/.opencode/plugin.js; printf ok > sub/source.txt'});
  assert.equal(r.exit_code, 0, r.content);
  assert.equal(fs.readFileSync(path.join(o.workspace, 'sub/opencode.json'), 'utf8'), '{}');
  assert.ok(!fs.existsSync(path.join(o.workspace, 'sub/opencode.jsonc')));
  assert.ok(!fs.existsSync(path.join(o.workspace, 'sub/.opencode/plugin.js')));
});

test('non-stream Unix socketpair creation is denied while private stream IPC works', async t => {
  const o = fixture(t);
  const script = `import socket\na,b=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)\na.send(b'ok'); assert b.recv(2)==b'ok'\nfor kind in [socket.SOCK_DGRAM,socket.SOCK_SEQPACKET]:\n try: socket.socketpair(socket.AF_UNIX,kind)\n except OSError: continue\n raise SystemExit('non-stream socketpair permitted')`;
  const r = await runSandbox({...o, command:'python3 -c '+q(script)});
  assert.equal(r.exit_code, 0, r.content);
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

test('Planner can create planning documents and scratch while application source stays read-only', async t => {
  const o = fixture(t);
  fs.mkdirSync(path.join(o.workspace, 'src')); fs.writeFileSync(path.join(o.workspace, 'src/main.js'), 'original');
  const r = await runSandbox({ ...o, readOnly: true, writablePaths: ['docs/superpowers/plans', 'docs/superpowers/specs'],
    command: 'printf plan > docs/superpowers/plans/one.md; printf design > docs/superpowers/specs/one.md; touch "$TMPDIR/note"; ! touch src/main.js' });
  assert.equal(r.exit_code, 0, r.content);
  assert.equal(fs.readFileSync(path.join(o.workspace, 'docs/superpowers/plans/one.md'), 'utf8'), 'plan');
  assert.equal(fs.readFileSync(path.join(o.workspace, 'src/main.js'), 'utf8'), 'original');
});

test('Planner roots reject traversal and symlink aliases before creating outside files', async t => {
  const o = fixture(t);
  fs.symlinkSync(o.home, path.join(o.workspace, 'docs'));
  for (const writablePaths of [['../home'], ['.'], ['docs/plans']]) {
    await assert.rejects(runSandbox({ ...o, readOnly: true, writablePaths, command: 'touch forbidden' }), /planning|symlink/i);
  }
  assert.deepEqual(fs.readdirSync(o.home), []);
});

test('nested Git metadata stays read-only inside writable planning roots', async t => {
  const o = fixture(t);
  const metadata = path.join(o.workspace, 'docs/superpowers/plans/example/.git');
  fs.mkdirSync(metadata, { recursive: true }); fs.writeFileSync(path.join(metadata, 'HEAD'), 'original');
  const r = await runSandbox({ ...o, readOnly: true, writablePaths: ['docs/superpowers/plans'], command: 'touch docs/superpowers/plans/example/.git/HEAD' });
  assert.notEqual(r.exit_code, 0, r.content);
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
