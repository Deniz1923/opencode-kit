import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAgentPack, parseGithubSource } from '../kit/packs.mjs';

function packDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'agents')); return root;
}
test('native Markdown agents import as data with namespaced IDs and restrictive permissions', t => {
  const root = packDir(t);
  fs.writeFileSync(path.join(root, 'agents/reviewer.md'), '---\ndescription: Review code\nmode: subagent\npermissions:\n  - action: edit\n    resource: "*"\n    effect: deny\n  - action: shell\n    resource: "*"\n    effect: deny\n---\nRead and review only.\n');
  const pack = readAgentPack(root, { namespace: 'alice' });
  assert.equal(pack.agents['alice/reviewer'].system, 'Read and review only.');
  assert.equal(pack.access['alice/reviewer'].shell, false);
  assert.equal(pack.access['alice/reviewer'].escape, 'deny');
  assert.equal(pack.access['alice/reviewer'].profile, 'read-only');
});
test('manifest can declare an optional writer/planner pack without importing scripts', t => {
  const root = packDir(t);
  fs.writeFileSync(path.join(root, 'agents/planner.json'), JSON.stringify({ mode: 'primary', system: 'Plan.' }));
  fs.writeFileSync(path.join(root, 'opencode-kit.json'), JSON.stringify({ formatVersion: 1, name: 'writers', namespace: 'team', version: '1.0.0', agents: [{ file: 'agents/planner.json', id: 'planner', access: { profile: 'planner' } }], requires: { todo: true } }));
  fs.writeFileSync(path.join(root, 'install.js'), 'throw new Error("must never run")');
  const p = readAgentPack(root);
  assert.equal(p.access['team/planner'].profile, 'planner'); assert.equal(p.requires.todo, true);
  assert.deepEqual(Object.keys(p.agents), ['team/planner']);
});
test('pack paths, symlinks and executable configuration fields are rejected', t => {
  const root = packDir(t);
  fs.symlinkSync('/etc/passwd', path.join(root, 'agents/alias.md'));
  assert.throws(() => readAgentPack(root), /symlink|outside/i);
  fs.unlinkSync(path.join(root, 'agents/alias.md'));
  fs.writeFileSync(path.join(root, 'agents/unsafe.json'), '{"system":"x","command":"curl something"}');
  assert.throws(() => readAgentPack(root), /unsupported.*field|executable/i);
  fs.writeFileSync(path.join(root, 'agents/unsafe.json'), '{"system":"{file:/home/user/secret}"}');
  assert.throws(() => readAgentPack(root), /interpolation/i);
});
test('GitHub source parsing accepts pinned references and rejects arbitrary transports', () => {
  assert.deepEqual(parseGithubSource('github:alice/agents#v1.0.0'), { owner: 'alice', repo: 'agents', ref: 'v1.0.0' });
  for (const source of ['git+ssh://host/repo', 'github:alice/../evil', 'github:alice/repo#--exec=x']) assert.throws(() => parseGithubSource(source), /GitHub|reference/i);
});
