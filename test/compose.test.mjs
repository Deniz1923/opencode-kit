import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose, parseConfig } from '../kit/compose.mjs';
const paths = { home: '/home/friend', configDir: '/home/friend/.config/opencode', kitConfig: '/home/friend/.config/opencode-kit', policy: '/home/friend/.config/opencode-kit/policy.json', store: '/home/friend/.local/share/opencode-kit' };
const pack = { id: 'agents:alice', name: 'alice', version: '1', agents: { 'alice/reviewer': { mode: 'subagent', system: 'New review prompt' } }, access: { 'alice/reviewer': { profile: 'read-only', shell: true, escape: 'deny' } }, settings: {}, requires: {} };

test('components are independent and sandbox is not forced onto an agent-only install', () => {
  const r = compose('{}', { packs: [pack], paths });
  assert.equal(r.config.agents['alice/reviewer'].system, 'New review prompt');
  assert.ok(!r.config.plugins); assert.equal(r.policy, undefined);
  const s = compose('{}', { sandbox: true, paths, pluginPath: '/store/sandbox' });
  assert.ok(s.config.policies.some(r => r.resource === 'shell:*' && r.effect === 'deny'));
  assert.ok(!s.config.agents?.['deniz/build']);
});
test('preserves JSONC comments, existing model and plugins while adding a pack', () => {
  const source = '{\n // My model choice\n "model":"mine/model",\n "plugins":[\n  "existing-plugin", // keep this plugin comment\n ],\n}\n';
  const r = compose(source, { packs: [pack], paths });
  assert.ok(r.text.includes('// My model choice')); assert.ok(r.text.includes('// keep this plugin comment'));
  assert.equal(parseConfig(r.text).model, 'mine/model'); assert.deepEqual(r.config.plugins, ['existing-plugin']);
});
test('conflicts require explicit keep/replace/rename decisions', () => {
  const source = JSON.stringify({ agents: { 'alice/reviewer': { mode: 'subagent', system: 'My old prompt' } } });
  const r = compose(source, { packs: [pack], paths });
  assert.equal(r.conflicts.length, 1); const key = r.conflicts[0].key;
  assert.equal(r.config.agents['alice/reviewer'].system, 'My old prompt');
  const kept = compose(source, { packs: [pack], paths }, { [key]: { action: 'keep' } });
  assert.equal(kept.config.agents['alice/reviewer'].system, 'My old prompt'); assert.equal(kept.conflicts.length, 0);
  const replaced = compose(source, { packs: [pack], paths }, { [key]: { action: 'replace' } });
  assert.equal(replaced.config.agents['alice/reviewer'].system, 'New review prompt');
  const renamed = compose(source, { packs: [pack], paths }, { [key]: { action: 'rename', name: 'alice/reviewer-v2' } });
  assert.equal(renamed.config.agents['alice/reviewer-v2'].system, 'New review prompt');
  assert.equal(renamed.config.agents['alice/reviewer'].system, 'My old prompt');
});
test('composition with sandbox preserves source denials for imported or renamed agents', () => {
  const strict = { ...pack, agents: { 'alice/reviewer': { ...pack.agents['alice/reviewer'], permissions: [{ action: 'shell', resource: '*', effect: 'deny' }] } } };
  const r = compose('{}', { sandbox: true, packs: [strict], paths, pluginPath: '/store/sandbox' });
  assert.equal(r.policy.agents['alice/reviewer'].shell, false);
  assert.equal(r.policy.agents['alice/reviewer'].escape, 'deny');
  assert.ok(r.config.agents['alice/reviewer'].permissions.some(x => x.action === 'sandbox_shell' && x.effect === 'deny'));
});
test('invalid config cannot be silently replaced by an empty object', () => {
  assert.throws(() => compose('{broken', { paths }), /config|JSON/i);
  assert.throws(() => compose('[]', { paths }), /object/i);
});
test('renaming an incoming agent updates its default-agent reference and capability', () => {
  const source = JSON.stringify({ agents: { 'alice/reviewer': { system: 'old' } } });
  const p = { ...pack, settings: { default_agent: 'alice/reviewer' } };
  const r = compose(source, { sandbox: true, packs: [p], paths, pluginPath: '/store/sandbox' }, { '["agents","alice/reviewer"]': { action: 'rename', name: 'alice/other' } });
  assert.equal(r.config.default_agent, 'alice/other');
  assert.equal(r.policy.agents['alice/other'].profile, 'read-only');
});
test('composing identical components twice does not duplicate settings or rules', () => {
  const selection = { sandbox: true, packs: [pack], paths, pluginPath: '/store/sandbox' };
  const first = compose('{}', selection);
  const second = compose(first.text, selection);
  assert.deepEqual(second.config, first.config);
  assert.equal(second.conflicts.length, 0);
});
