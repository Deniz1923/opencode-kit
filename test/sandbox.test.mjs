import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { runSandbox, runProcess, spawnSandbox, activePlaceholders, inspectScratchHealth, workspaceHash } from '../sandbox.mjs';

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

test('workspace protection scans each directory once asynchronously without redundant lstat calls', async t => {
  const o = fixture(t);
  const nested = path.join(o.workspace, 'node_modules/pkg');
  const plain = path.join(o.workspace, 'node_modules/plain');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(nested, 'opencode.json'), '{}');
  fs.writeFileSync(path.join(plain, 'index.js'), 'export default 1;\n');
  const originalReaddir = fs.promises.readdir, counts = new Map();
  const originalLstat = fs.lstatSync, originalAsyncLstat = fs.promises.lstat;
  let plainLstats = 0;
  fs.promises.readdir = async function(file, ...args) {
    if (String(file).startsWith(o.workspace)) counts.set(String(file), (counts.get(String(file)) ?? 0) + 1);
    return originalReaddir.call(this, file, ...args);
  };
  fs.lstatSync = function(file, ...args) {
    if (String(file).startsWith(plain + path.sep)) plainLstats++;
    return originalLstat.call(this, file, ...args);
  };
  fs.promises.lstat = async function(file, ...args) {
    if (String(file).startsWith(plain + path.sep)) plainLstats++;
    return originalAsyncLstat.call(this, file, ...args);
  };
  let result;
  try { result = await runSandbox({ ...o, command: '! touch node_modules/pkg/opencode.jsonc; printf done' }); }
  finally { fs.promises.readdir = originalReaddir; fs.lstatSync = originalLstat; fs.promises.lstat = originalAsyncLstat; }
  assert.equal(result.exit_code, 0, result.content);
  assert.equal(counts.get(nested), 1);
  assert.equal(counts.get(plain), 1);
  assert.ok([...counts.values()].every(n => n === 1), JSON.stringify([...counts]));
  assert.equal(plainLstats, 0, 'Non-reserved directory must not incur redundant lstat syscalls');
  assert.ok(!fs.existsSync(path.join(nested, 'opencode.jsonc')));
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

test('shell output keeps the opening and final diagnostic at both output limits', async () => {
  for (const noise of ["head -c 200000 /dev/zero | tr '\\0' x", 'yes x | head -n 5000']) {
    const r = await runProcess('/bin/bash', ['-c',
      "printf 'BUILD STARTED\\n'; " + noise + "; printf '\\nFINAL FAILURE\\n' >&2; exit 7"]);
    assert.equal(r.exit_code, 7);
    assert.equal(r.truncated, true);
    assert.match(r.content, /^BUILD STARTED\n[\s\S]*\[truncated\][\s\S]*FINAL FAILURE\n$/);
    assert.ok(Buffer.byteLength(r.content) < 52000);
    assert.ok(r.content.split('\n').length <= 2000);
  }
  const small = await runProcess('/bin/bash', ['-c', 'printf hello']);
  assert.deepEqual(small, {content: 'hello', exit_code: 0, truncated: false});
});

test('timed-out commands cannot create delayed files', async t => {
  const o = fixture(t);
  const killed = await runSandbox({ ...o, timeout: 150, command: '(sleep 1; touch delayed) & wait' });
  assert.equal(killed.exit_code, 124);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok(!fs.existsSync(path.join(o.workspace, 'delayed')));
});

test('truncated foreground output spills complete log outside writable scratch and rotates old logs', async t => {
  const o = fixture(t);
  const small = await runSandbox({ ...o, command: 'printf small-ok' });
  assert.equal(small.log_path, undefined);
  for (const [label, cmd, needle] of [
    ['lines', 'seq 1 2500', '\n1234\n'],
    ['bytes', "printf 'START\\n'; head -c 35000 /dev/zero | tr '\\0' a; printf '\\nMID_SENTINEL\\n'; head -c 35000 /dev/zero | tr '\\0' b; printf '\\nEND\\n'", 'MID_SENTINEL'],
  ]) {
    const r = await runSandbox({ ...o, command: cmd });
    assert.equal(r.exit_code, 0, label + ': ' + r.content);
    assert.equal(r.truncated, true, label);
    assert.ok(r.log_path, label + ' must return log_path');
    assert.ok(r.log_path.startsWith(o.scratchRoot + path.sep), r.log_path);
    assert.ok(!r.log_path.startsWith(r.scratch + path.sep), 'log must live outside writable scratch mount');
    const st = fs.statSync(r.log_path);
    assert.equal(st.mode & 0o077, 0);
    const full = fs.readFileSync(r.log_path, 'utf8');
    assert.ok(full.includes(needle), label + ' full log missed middle bytes');
  }
  const logDir = path.join(o.scratchRoot, workspaceHash(o.workspace) + '.logs');
  for (let i = 0; i < 36; i++) fs.writeFileSync(path.join(logDir, `old-${String(i).padStart(2, '0')}.log`), 'x', { mode: 0o600 });
  await runSandbox({ ...o, command: 'seq 1 2500' });
  assert.ok(fs.readdirSync(logDir).length <= 32);
});

test('read-only commands run concurrently with active writable commands and concurrent writers share ref-counted placeholders', async t => {
  const o = fixture(t);
  execFileSync('git', ['init', '--quiet', o.workspace]);
  const start = Date.now();
  const writer = runSandbox({ ...o, command: 'sleep 0.6; touch from-writer' });
  await new Promise(resolve => setTimeout(resolve, 120));
  const readerStart = Date.now();
  const reader = await runSandbox({ ...o, readOnly: true, command: 'git status --porcelain; printf reader-ok' });
  const readerElapsed = Date.now() - readerStart;
  assert.equal(reader.exit_code, 0, reader.content);
  assert.equal(reader.content, 'reader-ok');
  assert.ok(readerElapsed < 400, `read-only command waited ${readerElapsed}ms behind writer`);
  const writer2 = runSandbox({ ...o, command: '! touch opencode.json; touch from-writer-2' });
  const [r1, r2] = await Promise.all([writer, writer2]);
  assert.equal(r1.exit_code, 0, r1.content);
  assert.equal(r2.exit_code, 0, r2.content);
  assert.ok(Date.now() - start < 2500);
  assert.ok(fs.existsSync(path.join(o.workspace, 'from-writer')));
  assert.ok(fs.existsSync(path.join(o.workspace, 'from-writer-2')));
  assert.equal(fs.existsSync(path.join(o.workspace, 'opencode.json')), false);
  assert.equal(fs.existsSync(path.join(o.workspace, '.opencode')), false);
  assert.deepEqual(activePlaceholders(o.workspace, o.scratchRoot), []);
});

test('dead-PID coord lock and leases self-recover while preserving user-modified files', async t => {
  const o = fixture(t);
  fs.mkdirSync(o.scratchRoot, { recursive: true, mode: 0o700 });
  const hash = workspaceHash(o.workspace);
  const deadPid = 99999999;
  const stalePlaceholder = path.join(o.workspace, 'opencode.jsonc');
  fs.writeFileSync(stalePlaceholder, '{}\n', { mode: 0o444 });
  const stPlaceholder = fs.lstatSync(stalePlaceholder);
  const userModified = path.join(o.workspace, 'opencode.json');
  fs.writeFileSync(userModified, '{"user":true}\n', { mode: 0o600 });
  const stUser = fs.lstatSync(userModified);
  fs.writeFileSync(path.join(o.scratchRoot, hash + '.coord.lock'), JSON.stringify({ pid: deadPid, createdAt: 1 }), { mode: 0o600 });
  fs.writeFileSync(path.join(o.scratchRoot, hash + '.lock'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(o.scratchRoot, hash + '.leases.json'), JSON.stringify({
    schemaVersion: 1,
    leases: {
      dead1: {
        pid: deadPid, createdAt: 1,
        placeholders: [
          { file: stalePlaceholder, kind: 'file', ino: stPlaceholder.ino, dev: stPlaceholder.dev },
          { file: userModified, kind: 'file', ino: stUser.ino, dev: stUser.dev },
        ],
      },
    },
  }), { mode: 0o600 });
  const beforeHealth = inspectScratchHealth(o.scratchRoot);
  assert.equal(beforeHealth.ok, true);
  assert.ok(beforeHealth.staleLocks >= 1 && beforeHealth.staleLeases >= 1, JSON.stringify(beforeHealth));
  const r = await runSandbox({ ...o, command: 'printf recovered' });
  assert.equal(r.exit_code, 0, r.content);
  assert.equal(r.content, 'recovered');
  assert.equal(fs.existsSync(stalePlaceholder), false, 'unchanged dead-PID placeholder should be removed');
  assert.equal(fs.readFileSync(userModified, 'utf8'), '{"user":true}\n', 'user-modified file must be preserved');
  assert.equal(fs.existsSync(path.join(o.scratchRoot, hash + '.lock')), false);
});

test('safe nativeTempRoot bridges files into sandbox while masking scratchRoot, leases, logs, and host /tmp sockets', async t => {
  const o = fixture(t);
  const nativeTempRoot = path.join(o.root, 'opencode-temp');
  const scratchRoot = path.join(nativeTempRoot, 'sandbox');
  fs.mkdirSync(nativeTempRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(nativeTempRoot, 'shared.txt'), 'FROM_NATIVE');
  const siblingScratch = path.join(scratchRoot, 'deadbeef01234567');
  fs.mkdirSync(siblingScratch, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(siblingScratch, 'secret'), 'OTHER_WORKSPACE_SECRET');
  const hash = workspaceHash(o.workspace);
  const logDir = path.join(scratchRoot, hash + '.logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(logDir, 'prior.log'), 'HOST_LOG_SENTINEL', { mode: 0o600 });
  const r = await runSandbox({
    ...o, scratchRoot, nativeTempRoot,
    command: `cat ${q(path.join(nativeTempRoot, 'shared.txt'))}; printf ':'; `
      + `printf FROM_SHELL > ${q(path.join(nativeTempRoot, 'reply.txt'))}; `
      + `! cat ${q(path.join(siblingScratch, 'secret'))} 2>/dev/null; `
      + `! cat ${q(path.join(logDir, 'prior.log'))} 2>/dev/null; `
      + `! cat ${q(path.join(scratchRoot, hash + '.leases.json'))} 2>/dev/null`,
  });
  assert.equal(r.exit_code, 0, r.content);
  assert.equal(r.content, 'FROM_NATIVE:');
  assert.equal(fs.readFileSync(path.join(nativeTempRoot, 'reply.txt'), 'utf8'), 'FROM_SHELL');
  // Read-only agent sees nativeTempRoot read-only.
  const ro = await runSandbox({ ...o, scratchRoot, nativeTempRoot, readOnly: true, command: `! touch ${q(path.join(nativeTempRoot, 'ro-blocked'))}` });
  assert.equal(ro.exit_code, 0, ro.content);
  assert.equal(fs.existsSync(path.join(nativeTempRoot, 'ro-blocked')), false);
});

test('cleanEnvironment configures scratch cache dirs and preserves safe toolchain locators while stripping secrets', async t => {
  const o = fixture(t);
  const r = await runSandbox({
    ...o,
    env: { ...process.env, VIRTUAL_ENV: '/opt/venv', CARGO_HOME: '/opt/cargo', GOPATH: '/opt/go', VIRTUAL_ENV_SECRET: 'DO-NOT-EXPOSE' },
    command: 'printf "%s|%s|%s|%s|%s|%s|%s" "$PYTHONDONTWRITEBYTECODE" "$PYTHONPYCACHEPREFIX" "$RUFF_CACHE_DIR" "$MYPY_CACHE_DIR" "$VIRTUAL_ENV" "$CARGO_HOME" "$VIRTUAL_ENV_SECRET"',
  });
  assert.equal(r.exit_code, 0, r.content);
  const [noPyc, pycache, ruff, mypy, venv, cargo, secret] = r.content.split('|');
  assert.equal(noPyc, '1');
  assert.ok(pycache.startsWith(r.scratch + '/cache/'));
  assert.ok(ruff.startsWith(r.scratch + '/cache/'));
  assert.ok(mypy.startsWith(r.scratch + '/cache/'));
  assert.equal(venv, '/opt/venv');
  assert.equal(cargo, '/opt/cargo');
  assert.equal(secret, '');
});

test('spawnSandbox exposes a running process handle with active lease until release', async t => {
  const o = fixture(t);
  const handle = await spawnSandbox({ ...o, command: 'sleep 0.3; printf spawned-ok' });
  try {
    assert.ok(activePlaceholders(o.workspace, o.scratchRoot).length > 0);
    const result = await handle.done;
    assert.equal(result.exit_code, 0, result.content);
    assert.equal(result.content, 'spawned-ok');
  } finally {
    await handle.release();
  }
  assert.deepEqual(activePlaceholders(o.workspace, o.scratchRoot), []);
});
