import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateConfig } from '../config.mjs';
import { defaultPolicy } from '../defaults.mjs';

const source = {
  model: 'provider/model', default_agent: 'build', share: 'manual', instructions: [],
  subagent_depth: 2, experimental: { todo: true }, extra_setting: { preserve: true },
  plugins: ['@prevalentware/opencode-goal-plugin', 'superpowers@git+https://github.com/obra/superpowers.git'],
  permission: { edit: 'allow', bash: { '*': 'ask', 'pwd': 'allow' }, read: { '*.env': 'deny' } },
  agent: { build: { mode: 'primary', prompt: 'MY EXACT PROMPT' },
    explore: { mode: 'subagent', prompt: 'EXPLORE', permission: { edit: 'deny' } } },
};
const opts = { home: '/home/test', pluginPath: '/home/test/addons/sandbox' };
test('configured Superpowers uses the managed producer adapter across code upgrades', () => {
  const once = migrateConfig(source, opts);
  assert.ok(once.plugins.some(p => p.package === '/home/test/addons/sandbox/integrations/superpowers'));
  assert.ok(!once.plugins.some(p => typeof p === 'string' && p.startsWith('superpowers@')));
  const twice = migrateConfig(once, { ...opts, pluginPath: '/new/sandbox' });
  assert.equal(twice.plugins.filter(p => typeof p === 'object' && p.package.endsWith('/integrations/superpowers')).length, 1);
  assert.ok(twice.plugins.some(p => p.package === '/new/sandbox/integrations/superpowers'));
});

test('migration preserves unrelated settings, prompts, plugins and original input', () => {
  const before = structuredClone(source); const c = migrateConfig(source, opts);
  assert.deepEqual(source, before);
  assert.equal(c.model, 'provider/model');
  assert.deepEqual(c.extra_setting, { preserve: true });
  assert.deepEqual(c.experimental, { todo: true, subagent_depth: 2 });
  assert.equal(c.agents.build.system, 'MY EXACT PROMPT');
  assert.equal(c.agents.explore.system, 'EXPLORE');
  assert.equal(c.plugins[0], source.plugins[0]);
  assert.deepEqual(c.plugins[1], {package:'/home/test/addons/sandbox/integrations/superpowers'});
  assert.ok(!('permission' in c)); assert.ok(!('agent' in c));
  assert.ok(!('subagent_depth' in c));
});

test('migration enforces native shell denial and permits only sandboxed ordinary commands', () => {
  const c = migrateConfig(source, opts);
  assert.ok(c.permissions.some(r => r.action === 'shell' && r.effect === 'deny' && r.resource === '*'));
  assert.ok(c.policies.some(r => r.action === 'tool.use' && r.resource === 'shell:*' && r.effect === 'deny'));
  assert.ok(c.permissions.some(r => r.action === 'sandbox_shell' && r.effect === 'allow'));
  assert.ok(c.permissions.some(r => r.action === 'shell_unsandboxed' && r.effect === 'ask'));
  assert.ok(c.policies.some(r => r.action === 'integration.use' && r.resource === 'plugin:*' && r.effect === 'deny'));
  assert.ok(c.policies.some(r => r.resource === 'plugin:/home/test/addons/sandbox' && r.effect === 'allow'));
});

test('global config and implementation denials override project configuration asks', () => {
  const c = migrateConfig(source, opts);
  const ask = c.permissions.findIndex(r => r.action === 'edit' && r.resource === '**/opencode.json');
  const deny = c.permissions.findIndex(r => r.action === 'edit' && r.resource === '/home/test/.config/opencode/**');
  assert.ok(deny > ask);
  assert.ok(c.policies.some(r => r.resource === 'edit:/home/test/addons/sandbox/**' && r.effect === 'deny'));
  assert.ok(c.agents.explore.permissions.some(r => r.action === 'shell_unsandboxed' && r.effect === 'deny'));
  for (const resource of ['**/.agents/**', '**/.claude/**']) {
    assert.ok(c.permissions.some(r => r.action === 'edit' && r.resource === resource && r.effect === 'ask'));
  }
});

test('migration is idempotent and preserves custom V2 settings and policies', () => {
  const once = migrateConfig({ ...source, policies: [{ action: 'provider.use', resource: 'blocked', effect: 'deny' }] }, opts);
  assert.deepEqual(migrateConfig(once, opts), once);
  assert.ok(once.policies.some(r => r.resource === 'blocked'));
});

test('planner and imported reviewer rules agree with selected access profiles', () => {
  const c = migrateConfig({ agents: {
    plan: { mode: 'primary' },
    'other/reviewer': { mode: 'subagent', permissions: [{ action: 'edit', resource: '*', effect: 'deny' }, { action: 'shell', resource: '*', effect: 'deny' }] },
  } }, opts);
  const p = defaultPolicy(c.agents);
  assert.equal(p.agents.plan.profile, 'planner');
  assert.ok(c.agents.plan.permissions.some(r => r.action === 'edit' && r.resource === '*' && r.effect === 'deny'));
  assert.ok(c.agents.plan.permissions.some(r => r.action === 'edit' && r.resource === 'docs/superpowers/plans/**' && r.effect === 'allow'));
  assert.ok(c.agents['other/reviewer'].permissions.some(r => r.action === 'sandbox_shell' && r.effect === 'deny'));
  assert.ok(c.agents['other/reviewer'].permissions.some(r => r.action === 'shell_unsandboxed' && r.effect === 'deny'));
});
test('replaces a prior local sandbox implementation while preserving other plugins', t => {
  const previous = fs.mkdtempSync(path.join(os.tmpdir(), 'old-sandbox-'));
  t.after(() => fs.rmSync(previous, { recursive: true, force: true }));
  fs.writeFileSync(path.join(previous, 'package.json'), JSON.stringify({ name: 'opencode-workspace-sandbox' }));
  const c = migrateConfig({ plugins: [previous, 'other-plugin'] }, { pluginPath: '/new/sandbox' });
  assert.deepEqual(c.plugins, ['other-plugin', { package: '/new/sandbox' }]);
});
test('installer state and backups have native-read hard denials', () => {
  const c = migrateConfig({}, { home: '/home/friend', pluginPath: '/store/plugin' });
  for (const resource of ['/home/friend/.config/opencode-kit/**', '/home/friend/.local/share/opencode-kit/state.json']) {
    assert.ok(c.permissions.some(r => r.action === 'read' && r.resource === resource && r.effect === 'deny'));
    assert.ok(c.policies.some(r => r.action === 'tool.use' && r.resource === 'read:' + resource && r.effect === 'deny'));
  }
});
