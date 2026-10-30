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
    agent: { get: async () => ({ permissions: ['skill', 'subagent', 'execute', 'todo*', '*goal*'].map(action => ({ action, resource: '*', effect: 'deny' })) }) },
    session: { get: async () => ({ location: { directory: workspace } }),
      context: async () => [{ type: 'user', text: 'Explain this fully.' }],
      hook: async (name, fn) => hooks.set('session:' + name, fn) },
    permission: {
      hook: async (name, fn) => hooks.set(name, fn),
      assert: async input => { requests.push(input); if (deny) throw new Error('User rejected this request'); },
    },
    tool: { transform: async fn => fn({ add: tool => tools.set(tool.name, tool) }) },
  };
  const toolCtx = { sessionID: 'ses_test', agent: 'build', messageID: 'msg_test', id: 'call_test', signal: new AbortController().signal };
  return { root, workspace, tools, hooks, requests, ctx, toolCtx, plugin, policyFile };
}

const bootstrap = '<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n**IMPORTANT: The using-superpowers skill content is included below. It is ALREADY LOADED**\nWorkflow instructions\n**Tool Mapping for OpenCode:**\n</EXTREMELY_IMPORTANT>';
function chatContext(agent = 'chat') {
  return { agent, system: [{ type: 'text', text: 'Keep the user’s answer style.' },
    { type: 'text', text: 'OpenCode goal mode policy:\n- Manage goals only through the goal tools.\nGeneric goal instructions.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: bootstrap }, { type: 'text', text: 'Explain this fully.' }] }],
  tools: { read: {}, edit: {}, websearch: {}, sandbox_shell: {}, shell_unsandboxed: {} }, options: { maxTokens: 8192 } };
}
test('lean Chat removes only unused workflow injections and keeps practical tools and answer settings', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  const hook = h.hooks.get('session:context'); assert.equal(typeof hook, 'function');
  const event = chatContext(); const tools = structuredClone(event.tools);
  await hook(event);
  assert.deepEqual(event.messages[0].content, [{ type: 'text', text: 'Explain this fully.' }]);
  assert.deepEqual(event.system, [{ type: 'text', text: 'Keep the user’s answer style.' }]);
  assert.deepEqual(event.tools, tools); assert.deepEqual(event.options, { maxTokens: 8192 });
});
test('workflow cleanup leaves Build and unrelated agents untouched', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  const hook = h.hooks.get('session:context'); assert.equal(typeof hook, 'function');
  for (const agent of ['build', 'somebody/researcher']) {
    const event = chatContext(agent), original = structuredClone(event); await hook(event); assert.deepEqual(event, original);
  }
});
test('cleanup preserves deliberate skill access, user quotations, and available goal instructions', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  const hook = h.hooks.get('session:context'); assert.equal(typeof hook, 'function');
  const withSkills = chatContext(); withSkills.tools.skill = {};
  const getAgent = h.ctx.agent.get;
  h.ctx.agent.get = async () => ({ permissions: [{ action: 'skill', resource: '*', effect: 'allow' }] });
  const original = structuredClone(withSkills); await hook(withSkills); assert.deepEqual(withSkills, original);
  h.ctx.agent.get = getAgent;
  const quote = chatContext('deniz/chat'); quote.messages[0].content = [{ type: 'text', text: bootstrap }];
  h.ctx.session.context = async () => [{ type: 'user', text: bootstrap }];
  h.ctx.agent.get = async () => ({ permissions: ['skill', 'subagent'].map(action => ({ action, resource: '*', effect: 'deny' })) });
  quote.tools.get_goal = {}; await hook(quote);
  assert.equal(quote.messages[0].content[0].text, bootstrap);
  assert.equal(quote.system.length, 2);
});
test('Chat omits workflow tools even when the host advertises denied definitions', async t => {
  const h = host(t); const getAgent = h.ctx.agent.get;
  h.ctx.agent.get = async () => ({ location: { directory: h.workspace }, data: await getAgent() });
  await h.plugin.setup(h.ctx); const event = chatContext();
  Object.assign(event.tools, { skill: {}, subagent: {}, execute: {}, todowrite: {}, create_goal: {}, opencode_session_move: {} });
  await h.hooks.get('session:context')(event);
  assert.deepEqual(Object.keys(event.tools).sort(), ['edit','read','sandbox_shell','shell_unsandboxed','websearch']);
  assert.equal(event.messages[0].content.length, 1);
});
test('a user quotation with an attachment is preserved using stored user text', async t => {
  const h = host(t); h.ctx.session.context = async () => [{ type: 'user', text: bootstrap }];
  await h.plugin.setup(h.ctx); const event = chatContext();
  event.messages[0].content = [{ type: 'text', text: bootstrap }, { type: 'image', image: 'fixture' }];
  const original = structuredClone(event.messages);
  await h.hooks.get('session:context')(event); assert.deepEqual(event.messages, original);
});
test('bootstrap-only synthetic messages after compaction can be removed for namespaced Chat', async t => {
  const h = host(t); h.ctx.session.context = async () => [{ type: 'checkpoint', id: 'checkpoint' }];
  await h.plugin.setup(h.ctx); const event = chatContext('friend/chat');
  event.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Checkpoint' }] },
    { role: 'user', content: [{ type: 'text', text: bootstrap }] }];
  await h.hooks.get('session:context')(event);
  assert.deepEqual(event.messages, [{ role: 'assistant', content: [{ type: 'text', text: 'Checkpoint' }] }]);
});
test('an unavailable stored transcript preserves uncertain content without breaking Chat', async t => {
  const h = host(t); h.ctx.session.context = async () => { throw new Error('Unavailable'); };
  await h.plugin.setup(h.ctx); const event = chatContext(), original = structuredClone(event.messages);
  await h.hooks.get('session:context')(event); assert.deepEqual(event.messages, original);
});

test('a quota-rejected title request gets a local title without changing the provider response', async t => {
  const h = host(t), updates = [];
  h.ctx.session.update = async value => updates.push(value);
  await h.plugin.setup(h.ctx);
  const titleHook = h.hooks.get('session:title'); assert.equal(typeof titleHook, 'function');
  await titleHook({ sessionID: 'ses_test', messages: [{ role: 'user', content: [{ type: 'text', text: 'Here is the first message of the conversation:\n\n<message>\nHelp me plan a vegetable garden with tomatoes and peppers.\n</message>\n\nReply with only the title.' }] }] });
  const response = new Response(JSON.stringify({ error: { type: 'FreeUsageLimitError' } }), { status: 429 });
  const event = { sessionID: 'ses_test', kind: 'title', response };
  await h.hooks.get('session:http.response')(event);
  assert.deepEqual(updates, [{ sessionID: 'ses_test', title: 'Plan a vegetable garden with tomatoes and peppers' }]);
  assert.equal(event.response, response); assert.equal(response.bodyUsed, false);
});
test('title fallback leaves manual titles, normal replies, and successful AI titles alone', async t => {
  const h = host(t), updates = [];
  h.ctx.session.update = async value => updates.push(value);
  await h.plugin.setup(h.ctx);
  const titleHook = h.hooks.get('session:title'); assert.equal(typeof titleHook, 'function');
  const capture = () => titleHook({ sessionID: 'ses_test', messages: [{ role: 'user', content: [{ type: 'text', text: 'Here is the first message of the conversation:\n\n<message>\nInstall a compiler on Linux\n</message>\n\nReply with only the title.' }] }] });
  const respond = (kind, status) => h.hooks.get('session:http.response')({sessionID:'ses_test',kind,response:new Response(JSON.stringify({error:{type:'FreeUsageLimitError'}}),{status})});
  await capture(); await respond('primary',429); assert.equal(updates.length,0);
  await respond('title',200); assert.equal(updates.length,0);
  await capture(); h.ctx.session.get = async () => ({ title: 'My own title' });
  await respond('title',429); assert.equal(updates.length,0);
});

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
