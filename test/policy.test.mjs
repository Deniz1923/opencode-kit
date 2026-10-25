import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validatePolicy, loadPolicy, agentAccess, canEdit, policyPaths } from '../policy.mjs';

const policy = { schemaVersion: 1, scratchRoot: '/tmp/opencode/sandbox', agents: {
  build: { profile: 'workspace-write', shell: true, escape: 'ask' },
  plan: { profile: 'planner', shell: true, escape: 'deny' },
  'alice/reviewer': { profile: 'read-only', shell: true, escape: 'deny' },
  'strict/reviewer': { profile: 'read-only', shell: false, escape: 'deny' },
} };

test('capabilities follow declared profiles instead of special agent names', () => {
  const p = validatePolicy(policy);
  const reviewer = agentAccess(p, 'alice/reviewer');
  assert.equal(reviewer.profile, 'read-only'); assert.equal(reviewer.escape, 'deny');
  assert.equal(agentAccess(p, 'strict/reviewer').shell, false);
  const unknown = agentAccess(p, 'unregistered');
  assert.equal(unknown.profile, 'read-only'); assert.equal(unknown.shell, false); assert.equal(unknown.escape, 'deny');
});

test('planner edit access is restricted to planning roots and scratch', () => {
  const p = agentAccess(validatePolicy(policy), 'plan');
  const scope = { workspace: '/work/project', scratch: '/tmp/scratch/project' };
  assert.equal(canEdit(p, '/work/project/docs/superpowers/plans/one.md', scope), true);
  assert.equal(canEdit(p, '/work/project/docs/superpowers/specs/one.md', scope), true);
  assert.equal(canEdit(p, '/tmp/scratch/project/note.md', scope), true);
  for (const file of ['/work/project/src/main.js', '/work/project/docs/superpowers/plans-other/a', '/etc/file', '/tmp/scratch/other/a']) {
    assert.equal(canEdit(p, file, scope), false, file);
  }
  assert.equal(canEdit(agentAccess(validatePolicy(policy), 'alice/reviewer'), '/work/project/src/main.js', scope), false);
});

test('invalid or overly broad planning paths cannot grant workspace access', () => {
  for (const root of ['.', '..', '../src', '/etc', 'docs/../src', '.git/plans', '.opencode/plans', '']) {
    assert.throws(() => validatePolicy({ ...policy, agents: { plan: { profile: 'planner', planningRoots: [root] } } }), /planning/i);
  }
});

test('trusted policy must be a private owned regular file and must exist', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-policy-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'policy.json');
  assert.throws(() => loadPolicy(file), /policy.*missing|setup/i);
  fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  assert.equal(agentAccess(loadPolicy(file), 'build').profile, 'workspace-write');
  const alias = path.join(root, 'alias'); fs.symlinkSync(file, alias);
  assert.throws(() => loadPolicy(alias), /policy/i);
  fs.chmodSync(file, 0o666); assert.throws(() => loadPolicy(file), /policy/i);
});

test('paths adapt to the invoking user and XDG settings', () => {
  assert.equal(policyPaths('/home/friend', {}).policy, '/home/friend/.config/opencode-kit/policy.json');
  assert.equal(policyPaths('/home/friend', { XDG_CONFIG_HOME: '/settings' }).policy, '/settings/opencode-kit/policy.json');
});
