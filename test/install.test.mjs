import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { policyPaths } from '../policy.mjs';
import { parseConfig } from '../kit/compose.mjs';
import { planInstall, applyPlan, planRemoval, listInstalled, recover } from '../kit/install.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-install-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = policyPaths(home, {}); fs.mkdirSync(paths.configDir, { recursive: true });
  const config = path.join(paths.configDir, 'opencode.jsonc');
  fs.writeFileSync(config, '{\n // keep my settings\n "model":"mine/model"\n}\n');
  return { paths, config };
}
const pack = { id: 'agents:alice', name: 'Alice', version: '1', agents: { 'alice/reviewer': { mode: 'subagent', system: 'Review only.' } }, access: { 'alice/reviewer': { profile: 'read-only', shell: true, escape: 'deny' } }, settings: {}, requires: {} };
test('usage dashboard installs independently, updates idempotently and removes without changing other settings', t=>{
 const {paths,config}=fixture(t);const initial=fs.readFileSync(config,'utf8');
 const plan=planInstall(paths,{usage:true});assert.ok(plan.components.some(c=>c.id==='usage'));applyPlan(plan);
 const installed=parseConfig(fs.readFileSync(config,'utf8'));
 const entry=installed.plugins.find(p=>p.package?.endsWith('/integrations/usage'));
 assert.ok(entry);assert.ok(fs.existsSync(path.join(entry.package,'tui.tsx')));
 assert.ok(fs.existsSync(path.join(entry.package,'collector.mjs')));assert.equal(fs.existsSync(paths.policy),false);
 assert.equal(installed.model,'mine/model');assert.ok(!installed.permissions);
 assert.equal(applyPlan(planInstall(paths)).changed,false);
 applyPlan(planRemoval(paths,'usage'));assert.deepEqual(parseConfig(fs.readFileSync(config,'utf8')),parseConfig(initial));
});

test('usage dashboard remains allowed with sandbox policy and survives sandbox removal',t=>{
 const {paths,config}=fixture(t);applyPlan(planInstall(paths,{sandbox:true,usage:true}));
 let c=parseConfig(fs.readFileSync(config,'utf8'));
 const usage=c.plugins.find(p=>p.package?.endsWith('/integrations/usage'));assert.ok(usage);
 assert.ok(c.policies.some(p=>p.resource==='plugin:'+usage.package&&p.effect==='allow'));
 applyPlan(planRemoval(paths,'sandbox'));c=parseConfig(fs.readFileSync(config,'utf8'));
 assert.ok(c.plugins.some(p=>p.package?.endsWith('/integrations/usage')));assert.equal(fs.existsSync(paths.policy),false);
 applyPlan(planRemoval(paths,'usage'));assert.ok(!parseConfig(fs.readFileSync(config,'utf8')).plugins);
});
test('managed Superpowers launchers remain directly executable after installation', t => {
  const { paths } = fixture(t); const plan = planInstall(paths, { sandbox: true }); applyPlan(plan);
  const entry = parseConfig(plan.files.find(f => f.path === plan.configFile).after).plugins.at(-1).package;
  const script = path.join(entry, 'integrations/superpowers/upstream/skills/executing-plans/scripts/task-start');
  const result = spawnSync(script, [], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /usage: task-start/);
});
test('sandbox removal restores the original Superpowers entry', t => {
  const { paths, config } = fixture(t);
  const plugins = ['other-plugin', 'superpowers@git+https://github.com/obra/superpowers.git'];
  fs.writeFileSync(config, JSON.stringify({ plugins }));
  applyPlan(planInstall(paths, { sandbox: true }));
  const installed = parseConfig(fs.readFileSync(config, 'utf8'));
  assert.ok(installed.plugins.some(p => typeof p === 'object' && p.package.endsWith('/integrations/superpowers')));
  applyPlan(planRemoval(paths, 'sandbox'));
  assert.deepEqual(parseConfig(fs.readFileSync(config, 'utf8')).plugins, plugins);
});
test('agent-only install, repeated install and removal preserve unrelated JSONC settings', t => {
  const { paths, config } = fixture(t);
  applyPlan(planInstall(paths, { packs: [pack] }));
  assert.equal(listInstalled(paths).length, 1); assert.ok(!parseConfig(fs.readFileSync(config, 'utf8')).plugins);
  const first = fs.readFileSync(config, 'utf8'); applyPlan(planInstall(paths, { packs: [pack] })); assert.equal(fs.readFileSync(config, 'utf8'), first);
  const text = fs.readFileSync(config, 'utf8').replace('mine/model', 'my/new-model'); fs.writeFileSync(config, text);
  applyPlan(planRemoval(paths, pack.id));
  assert.match(fs.readFileSync(config, 'utf8'), /keep my settings/); assert.match(fs.readFileSync(config, 'utf8'), /my\/new-model/);
  assert.equal(listInstalled(paths).length, 0); assert.ok(!fs.readFileSync(config, 'utf8').includes('Review only'));
});
test('sandbox lives in a managed versioned store and new agents update the same trusted policy', t => {
  const { paths, config } = fixture(t);
  const initial = planInstall(paths, { sandbox: true }); applyPlan(initial);
  const c = parseConfig(fs.readFileSync(config, 'utf8'));
  const target = c.plugins.at(-1).package; assert.ok(target.startsWith(paths.store + '/versions/'));
  assert.ok(fs.existsSync(path.join(target, 'index.js'))); assert.ok(fs.existsSync(paths.policy));
  applyPlan(planInstall(paths, { packs: [pack] }));
  assert.equal(JSON.parse(fs.readFileSync(paths.policy)).agents['alice/reviewer'].profile, 'read-only');
  applyPlan(planRemoval(paths, 'sandbox'));
  assert.equal(fs.existsSync(paths.policy), false); assert.ok(fs.readFileSync(config, 'utf8').includes('Review only'));
});
test('apply refuses stale previews and symlink config paths without changing anything', t => {
  const { paths, config } = fixture(t); const p = planInstall(paths, { packs: [pack] });
  fs.appendFileSync(config, '\n// edited after preview\n');
  assert.throws(() => applyPlan(p), /changed|stale/i); assert.equal(listInstalled(paths).length, 0);
  fs.renameSync(config, config + '.real'); fs.symlinkSync(config + '.real', config);
  assert.throws(() => planInstall(paths, { packs: [pack] }), /symlink/i);
});
test('modified owned entries require conflict choices on removal', t => {
  const { paths, config } = fixture(t); applyPlan(planInstall(paths, { packs: [pack] }));
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('Review only.', 'My customized review.'));
  const removal = planRemoval(paths, pack.id); assert.ok(removal.conflicts.length);
  assert.throws(() => applyPlan(removal), /conflict/i);
  const resolutions = Object.fromEntries(removal.conflicts.map(c => [c.key, { action: 'keep' }]));
  applyPlan(planRemoval(paths, pack.id, resolutions));
  assert.match(fs.readFileSync(config, 'utf8'), /My customized review/);
});
test('failed transaction restores files, and interrupted transaction recovery restores its backups', t => {
  const { paths, config } = fixture(t); const original = fs.readFileSync(config, 'utf8');
  assert.throws(() => applyPlan(planInstall(paths, { sandbox: true }), { faultAfter: 1 }), /injected/i);
  assert.equal(fs.readFileSync(config, 'utf8'), original); assert.equal(fs.existsSync(paths.policy), false);
  const p = planInstall(paths, { packs: [pack] });
  assert.throws(() => applyPlan(p, { interruptAfter: 1 }), /interrupted/i);
  assert.throws(() => planInstall(paths, {}), /recover/i);
  recover(paths); assert.equal(fs.readFileSync(config, 'utf8'), original); assert.equal(listInstalled(paths).length, 0);
});
test('manual policy changes require a choice and versioned code cannot be silently repaired', t => {
  const { paths } = fixture(t); applyPlan(planInstall(paths, { sandbox: true }));
  const policy = JSON.parse(fs.readFileSync(paths.policy)); policy.agents.build.escape = 'deny'; fs.writeFileSync(paths.policy, JSON.stringify(policy));
  const plan = planInstall(paths, {}); assert.ok(plan.conflicts.some(c => c.key === 'owned:policy'));
  const kept = planInstall(paths, {}, { 'owned:policy': { action: 'keep' } }); applyPlan(kept);
  assert.equal(JSON.parse(fs.readFileSync(paths.policy)).agents.build.escape, 'deny');
  const plugin = plan.files.find(f => f.path.endsWith('/index.js')).path; fs.appendFileSync(plugin, '\n// modified\n');
  assert.throws(() => planInstall(paths, {}), /managed code.*changed|integrity/i);
});
