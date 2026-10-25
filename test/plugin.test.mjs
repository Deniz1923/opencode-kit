import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPlugin } from '../index.js';
import { policyPaths } from '../policy.mjs';

function host(t, { deny = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-plugin-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const tools = new Map(), hooks = new Map(); const requests = [];
  fs.mkdirSync(path.join(root, 'config'));
  const policyFile = path.join(root, 'config/policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({schemaVersion:1,scratchRoot:path.join(root,'scratch'),agents:{
    build:{profile:'workspace-write',shell:true,escape:'ask'},
    plan:{profile:'planner',shell:true,escape:'deny'},
    explore:{profile:'read-only',shell:true,escape:'deny'},
    'foreign/reviewer':{profile:'read-only',shell:true,escape:'deny'},
    'strict/reviewer':{profile:'read-only',shell:false,escape:'deny'}
  }}), {mode:0o600});
  const plugin = createPlugin({ policyFile });
  const ctx = {
    options: { scratchRoot: path.join(root, 'scratch') },
    location: { directory: workspace, project: { canonical: workspace } },
    session: { get: async () => ({ location: { directory: workspace } }) },
    permission: {
      hook: async (name, fn) => hooks.set(name, fn),
      assert: async input => { requests.push(input); if (deny) throw new Error('User rejected this request'); },
    },
    tool: { transform: async fn => fn({ add: tool => tools.set(tool.name, tool) }) },
  };
  const toolCtx = { sessionID: 'ses_test', agent: 'build', messageID: 'msg_test', id: 'call_test', signal: new AbortController().signal };
  return { root, workspace, tools, hooks, requests, ctx, toolCtx, plugin, policyFile };
}

test('sandbox tool executes quoted commands inside the trusted session workspace', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  const result = await h.tools.get('sandbox_shell').execute({ command: "printf '%s' 'a; $(touch bad)'; touch okay" }, h.toolCtx);
  assert.equal(result.metadata.exit_code, 0, result.content);
  assert.ok(result.content.includes('a; $(touch bad)'));
  assert.ok(fs.existsSync(path.join(h.workspace, 'okay')));
  assert.ok(!fs.existsSync(path.join(h.workspace, 'bad')));
  assert.equal(h.requests[0].action, 'sandbox_shell');
});

test('denied escapes never spawn and propagate the rejection reason', async t => {
  const h = host(t, { deny: true }); await h.plugin.setup(h.ctx);
  const marker = path.join(h.root, 'must-not-exist');
  await assert.rejects(h.tools.get('shell_unsandboxed').execute({ command: 'touch ' + marker }, h.toolCtx), /User rejected/);
  assert.ok(!fs.existsSync(marker));
});

test('permitted escapes run only after the permission assertion', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  const marker = path.join(h.root, 'approved');
  const r = await h.tools.get('shell_unsandboxed').execute({ command: 'touch ' + marker + '; printf approved' }, h.toolCtx);
  assert.equal(r.metadata.exit_code, 0);
  assert.ok(fs.existsSync(marker));
  assert.equal(h.requests[0].action, 'shell_unsandboxed');
  assert.equal(h.requests[0].save, undefined);
  assert.ok(r.content.includes('approved'));
});

test('escape approval and execution use the same requested working directory', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  const sub = path.join(h.workspace, 'sub'); fs.mkdirSync(sub);
  const r = await h.tools.get('shell_unsandboxed').execute({ command: 'touch relative-file; pwd', workdir: sub }, h.toolCtx);
  assert.equal(r.metadata.exit_code, 0);
  assert.ok(fs.existsSync(path.join(sub, 'relative-file')));
  assert.ok(!fs.existsSync(path.join(h.workspace, 'relative-file')));
  assert.equal(h.requests[0].metadata.cwd, sub);
});

test('escape evaluation preserves deny and forces allowed decisions to ask', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  const hook = h.hooks.get('evaluate');
  for (const [effect, wanted] of [['allow', 'ask'], ['ask', 'ask'], ['deny', 'deny']]) {
    const e = { action: 'shell_unsandboxed', effect, agent: 'build', sessionID: 'ses_test' }; await hook(e); assert.equal(e.effect, wanted);
  }
});

test('read-only agents cannot escape even when host permission rules are permissive', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  await assert.rejects(h.tools.get('shell_unsandboxed').execute({ command: 'touch forbidden' }, { ...h.toolCtx, agent: 'explore' }), /cannot.*escape/i);
  const r = await h.tools.get('sandbox_shell').execute({ command: 'touch forbidden' }, { ...h.toolCtx, agent: 'explore' });
  assert.notEqual(r.metadata.exit_code, 0);
  assert.ok(!fs.existsSync(path.join(h.workspace, 'forbidden')));
});

test('foreign agent profiles restrict shell writes and preserve explicit terminal denial', async t => {
  const h = host(t); h.ctx.options.agentPolicies = { 'foreign/reviewer': { profile: 'workspace-write' } };
  await h.plugin.setup(h.ctx);
  const reader = { ...h.toolCtx, agent: 'foreign/reviewer' };
  const r = await h.tools.get('sandbox_shell').execute({ command: 'touch forbidden' }, reader);
  assert.notEqual(r.metadata.exit_code, 0); assert.ok(!fs.existsSync(path.join(h.workspace, 'forbidden')));
  await assert.rejects(h.tools.get('shell_unsandboxed').execute({ command: 'touch forbidden' }, reader), /cannot.*escape/i);
  await assert.rejects(h.tools.get('sandbox_shell').execute({ command: 'true' }, { ...h.toolCtx, agent: 'strict/reviewer' }), /terminal|shell.*denied/i);
});

test('native edit permission guard allows plans but denies source for Planner', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  for (const [target, wanted] of [['src/main.js', 'deny'], ['docs/superpowers/plans/plan.md', 'allow']]) {
    const event = { action: 'edit', effect: 'allow', agent: 'plan', sessionID: 'ses_test', resources: [target] };
    await h.hooks.get('evaluate')(event); assert.equal(event.effect, wanted);
  }
});

test('missing policy stops execution instead of guessing agent privileges', async t => {
  const h = host(t); await h.plugin.setup(h.ctx); fs.unlinkSync(h.policyFile);
  await assert.rejects(h.tools.get('sandbox_shell').execute({ command: 'touch forbidden' }, h.toolCtx), /policy.*missing|setup/i);
  assert.ok(!fs.existsSync(path.join(h.workspace, 'forbidden')));
});
test('copied installer config in state and backups is unreadable to sandboxed shell commands', async t => {
  const h = host(t); const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(h.root, 'data');
  t.after(() => { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; });
  const state = policyPaths().state, backup = path.join(h.root, 'config/backups/one/transaction.json');
  for (const file of [state, backup]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fake-provider-secret'); }
  await h.plugin.setup(h.ctx);
  const r = await h.tools.get('sandbox_shell').execute({ command: `cat '${state}' '${backup}'` }, h.toolCtx);
  assert.ok(!r.content.includes('fake-provider-secret'), r.content);
});
