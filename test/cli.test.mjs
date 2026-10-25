import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supportedPlatform } from '../cli.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cli-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home + '/.config', XDG_DATA_HOME: home + '/.local/share', OPENCODE_CONFIG_DIR: home + '/.config/opencode' };
  return { home, env, run: (...args) => spawnSync(process.execPath, [root + '/cli.mjs', ...args], { env, encoding: 'utf8', timeout: 15000 }) };
}
test('dry-run changes no config; selected agent pack installs, lists, updates and removes', t => {
  const { home, run } = fixture(t);
  let r = run('init', '--agents', 'deniz', '--dry-run'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Preview|preview/);
  assert.equal(fs.existsSync(home + '/.config/opencode/opencode.json'), false);
  r = run('init', '--agents', 'deniz', '--apply'); assert.equal(r.status, 0, r.stderr);
  let config = JSON.parse(fs.readFileSync(home + '/.config/opencode/opencode.json'));
  assert.ok(config.agents['deniz/build']); assert.equal(config.experimental.todo, true); assert.ok(!config.plugins);
  assert.match(run('list').stdout, /agents:deniz/);
  r = run('update', '--apply'); assert.equal(r.status, 0, r.stderr);
  r = run('remove', 'agents:deniz', '--apply'); assert.equal(r.status, 0, r.stderr);
  config = JSON.parse(fs.readFileSync(home + '/.config/opencode/opencode.json')); assert.ok(!config.agents?.['deniz/build']);
});
test('noninteractive conflicts require explicit choices rather than overwriting', t => {
  const { home, run } = fixture(t); const directory = home + '/.config/opencode'; fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(directory + '/opencode.json', JSON.stringify({ default_agent: 'mine' }));
  const r = run('init', '--agents', 'deniz', '--apply'); assert.notEqual(r.status, 0); assert.match(r.stderr, /conflict/i);
  assert.equal(JSON.parse(fs.readFileSync(directory + '/opencode.json')).default_agent, 'mine');
});
test('doctor reports component scope without changing settings and platform support is explicit', t => {
  const { home, run } = fixture(t); const r = run('doctor'); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not installed|not selected/i); assert.equal(fs.existsSync(home + '/.config/opencode/opencode.json'), false);
  assert.equal(supportedPlatform('linux', 'x64'), true); assert.equal(supportedPlatform('darwin', 'x64'), false); assert.equal(supportedPlatform('linux', 'arm64'), false);
});
test('interactive menu accepts option-based component and apply choices', t => {
  const { home, env } = fixture(t);
  const r = spawnSync(process.execPath, [root + '/cli.mjs', 'init', '--interactive'], { env, encoding: 'utf8', input: '3\n1\n2\n', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Choose components/);
  assert.ok(fs.existsSync(home + '/.config/opencode/opencode.json'), r.stdout);
});
