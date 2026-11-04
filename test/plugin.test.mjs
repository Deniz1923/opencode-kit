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
test('Chat cleanup preserves messages without retrieving stored session text', async t => {
  const h = host(t); let reads = 0;
  h.ctx.session.context = async () => { reads++; throw new Error('History retrieval forbidden'); };
  await h.plugin.setup(h.ctx); const event = chatContext(), messages = structuredClone(event.messages);
  await h.hooks.get('session:context')(event);
  assert.equal(reads, 0); assert.deepEqual(event.messages, messages);
});
function chatContext(agent = 'chat') {
  return { agent, system: [{ type: 'text', text: 'Keep the user’s answer style.' },
    { type: 'text', text: 'OpenCode goal mode policy:\n- Manage goals only through the goal tools.\nGeneric goal instructions.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: bootstrap }, { type: 'text', text: 'Explain this fully.' }] }],
  tools: { read: {}, edit: {}, websearch: {}, sandbox_shell: {}, shell_unsandboxed: {} }, options: { maxTokens: 8192 } };
}
test('Chat tool cleanup preserves all user and system instructions', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  const hook = h.hooks.get('session:context'); assert.equal(typeof hook, 'function');
  const event = chatContext(); const tools = structuredClone(event.tools), messages = structuredClone(event.messages), system = structuredClone(event.system);
  await hook(event);
  assert.deepEqual(event.messages, messages);
  assert.deepEqual(event.system, system);
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
  assert.equal(event.messages[0].content.length, 2);
});
test('a user quotation with an attachment is preserved using stored user text', async t => {
  const h = host(t); h.ctx.session.context = async () => [{ type: 'user', text: bootstrap }];
  await h.plugin.setup(h.ctx); const event = chatContext();
  event.messages[0].content = [{ type: 'text', text: bootstrap }, { type: 'image', image: 'fixture' }];
  const original = structuredClone(event.messages);
  await h.hooks.get('session:context')(event); assert.deepEqual(event.messages, original);
});
test('cleanup does not remove quoted instructions beside a compaction checkpoint', async t => {
  const h = host(t); h.ctx.session.context = async () => [{ type: 'checkpoint', id: 'checkpoint' }];
  await h.plugin.setup(h.ctx); const event = chatContext('friend/chat');
  event.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Checkpoint' }] },
    { role: 'user', content: [{ type: 'text', text: bootstrap }] }];
  const original = structuredClone(event.messages);
  await h.hooks.get('session:context')(event);
  assert.deepEqual(event.messages, original);
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

test('moving a session cannot expand native or sandbox write access without directory approval', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  await h.hooks.get('session:context')({ sessionID: 'ses_test', agent: 'build', tools: {} });
  const second = path.join(h.root, 'second'); fs.mkdirSync(second);
  h.ctx.session.get = async () => ({ location: { directory: second } });
  const edit = { action: 'edit', effect: 'allow', agent: 'build', sessionID: 'ses_test', resources: ['blocked'] };
  await h.hooks.get('evaluate')(edit); assert.equal(edit.effect, 'deny');
  assert.match(edit.message, /workspace_approve/);
  const result = await h.tools.get('sandbox_shell').execute({ command: 'touch blocked' }, h.toolCtx);
  assert.equal(result.metadata.exit_code, 125); assert.equal(fs.existsSync(path.join(second, 'blocked')), false);
});

test('approved directories survive plugin reloads while rejected requests grant no access', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  await h.hooks.get('session:context')({ sessionID: 'ses_test', agent: 'build', tools: {} });
  const second = path.join(h.root, 'second'); fs.mkdirSync(second);
  h.ctx.session.get = async () => ({ location: { directory: second } });
  const originalAssert = h.ctx.permission.assert;
  h.ctx.permission.assert = async input => { if (input.action === 'workspace_approve') throw new Error('Rejected directory'); return originalAssert(input); };
  await assert.rejects(h.tools.get('workspace_approve').execute({ directory: second }, h.toolCtx), /Rejected directory/);
  let result = await h.tools.get('sandbox_shell').execute({ command: 'touch rejected' }, h.toolCtx);
  assert.equal(result.metadata.exit_code, 125); assert.equal(fs.existsSync(path.join(second, 'rejected')), false);
  h.ctx.permission.assert = originalAssert;
  await h.tools.get('workspace_approve').execute({ directory: second }, h.toolCtx);
  const request = h.requests.find(r => r.action === 'workspace_approve');
  assert.deepEqual(request.resources, [second]); assert.equal(request.metadata.sessionID, 'ses_test');
  // A fresh location/plugin instance must load the same approved session roots.
  h.ctx.location = { directory: second, project: { canonical: second } };
  await createPlugin({ policyFile: h.policyFile }).setup(h.ctx);
  result = await h.tools.get('sandbox_shell').execute({ command: 'touch approved' }, h.toolCtx);
  assert.equal(result.metadata.exit_code, 0, result.content); assert.ok(fs.existsSync(path.join(second, 'approved')));
  const outside = path.join(h.root, 'unapproved'); fs.mkdirSync(outside);
  result = await h.tools.get('sandbox_shell').execute({ command: 'touch blocked', workdir: outside }, h.toolCtx);
  assert.equal(result.metadata.exit_code, 125); assert.equal(fs.existsSync(path.join(outside, 'blocked')), false);
  h.ctx.session.get = async () => ({ location: { directory: h.workspace } });
  result = await h.tools.get('sandbox_shell').execute({ command: 'touch approved-workdir', workdir: second }, h.toolCtx);
  assert.equal(result.metadata.exit_code, 0, result.content); assert.ok(fs.existsSync(path.join(second, 'approved-workdir')));
  result = await h.tools.get('sandbox_shell').execute({ command: 'touch original-still-approved' }, h.toolCtx);
  assert.equal(result.metadata.exit_code, 0, result.content);
});

test('directory approval preserves explicit denial and agent write profiles', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  for (const effect of ['allow', 'ask', 'deny']) {
    const e = { action: 'workspace_approve', effect, agent: 'build', sessionID: 'ses_test' };
    await h.hooks.get('evaluate')(e); assert.equal(e.effect, effect === 'deny' ? 'deny' : 'ask');
  }
  const second = path.join(h.root, 'second'); fs.mkdirSync(second);
  await h.hooks.get('session:context')({ sessionID: 'ses_test', agent: 'build', tools: {} });
  h.ctx.session.get = async () => ({ location: { directory: second } });
  await h.tools.get('workspace_approve').execute({ directory: second }, h.toolCtx);
  const result = await h.tools.get('sandbox_shell').execute({ command: 'touch forbidden' }, { ...h.toolCtx, agent: 'explore' });
  assert.notEqual(result.metadata.exit_code, 0); assert.equal(fs.existsSync(path.join(second, 'forbidden')), false);
  const edit = { action: 'edit', effect: 'allow', agent: 'plan', sessionID: 'ses_test', resources: ['src/main.js'] };
  await h.hooks.get('evaluate')(edit); assert.equal(edit.effect, 'deny');
  const planEdit = { ...edit, effect: 'allow', resources: ['docs/superpowers/plans/allowed.md'] };
  await h.hooks.get('evaluate')(planEdit); assert.equal(planEdit.effect, 'allow');
});

test('subagents inherit approved roots instead of trusting a different session location', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  await h.hooks.get('session:context')({ sessionID: 'ses_test', agent: 'build', tools: {} });
  const outside = path.join(h.root, 'outside'); fs.mkdirSync(outside);
  h.ctx.session.get = async () => ({ parentID: 'ses_test', location: { directory: outside } });
  await h.hooks.get('session:context')({ sessionID: 'ses_child', agent: 'build', tools: {} });
  const r = await h.tools.get('sandbox_shell').execute({ command: 'touch blocked' }, { ...h.toolCtx, sessionID: 'ses_child' });
  assert.equal(r.metadata.exit_code, 125); assert.equal(fs.existsSync(path.join(outside, 'blocked')), false);
});

test('a directory alias changed during approval grants no access', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  const second = path.join(h.root, 'second'), third = path.join(h.root, 'third'), alias = path.join(h.root, 'alias');
  fs.mkdirSync(second); fs.mkdirSync(third); fs.symlinkSync(second, alias);
  h.ctx.permission.assert = async () => { fs.unlinkSync(alias); fs.symlinkSync(third, alias); };
  await assert.rejects(h.tools.get('workspace_approve').execute({ directory: alias }, h.toolCtx), /changed during approval/);
  const r = await h.tools.get('sandbox_shell').execute({ command: 'touch blocked', workdir: second }, h.toolCtx);
  assert.equal(r.metadata.exit_code, 125); assert.equal(fs.existsSync(path.join(second, 'blocked')), false);
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

test('native reads and searches cannot expose protected data through relative paths or aliases', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  fs.writeFileSync(path.join(h.root, 'config/fake-history'), 'SYNTHETIC-PRIVATE');
  fs.symlinkSync(path.join(h.root, 'config'), path.join(h.workspace, 'alias'));
  for (const [action, resources, metadata] of [
    ['read', ['alias/fake-history'], {}],
    ['grep', ['SYNTHETIC'], {path:'alias'}],
    ['grep', ['SYNTHETIC'], {path:h.root}],
  ]) {
    const e = {action, resources, metadata, effect:'allow', agent:'build', sessionID:'ses_test'};
    await h.hooks.get('evaluate')(e); assert.equal(e.effect, 'deny', action);
  }
  const e = {action:'grep', resources:['source'], metadata:{path:h.workspace}, effect:'allow', agent:'build', sessionID:'ses_test'};
  await h.hooks.get('evaluate')(e); assert.equal(e.effect, 'allow');
});

test('canonical read checks tolerate absent permission metadata and source',async t=>{
 const h=host(t);fs.writeFileSync(path.join(h.workspace,'normal.txt'),'NORMAL-READ');
 h.ctx.permission.assert=async input=>{
  if(input.metadata===null || input.source===null)throw new Error('Expected object at metadata/source');
  h.requests.push(input);
 };
 await h.plugin.setup(h.ctx);
 const e={action:'read',effect:'allow',agent:'build',sessionID:'ses_test',resources:['normal.txt'],metadata:null,source:null};
 await h.hooks.get('evaluate')(e);
 assert.equal(e.effect,'allow',e.message);
 assert.equal(h.requests.length,1);assert.equal(h.requests[0].resources[0],path.join(h.workspace,'normal.txt'));
});

test('session-approved directory boundaries stop asking without overriding denials', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  const second = path.join(h.root, 'second'); fs.mkdirSync(second);
  await h.tools.get('workspace_approve').execute({directory:second}, h.toolCtx);
  for (const initial of ['ask', 'deny']) {
    const e = {action:'external_directory', resources:[second+'/*'], effect:initial, agent:'build', sessionID:'ses_test'};
    await h.hooks.get('evaluate')(e); assert.equal(e.effect, initial === 'deny' ? 'deny' : 'allow');
  }
  const e = {action:'external_directory', resources:[h.root+'/*'], effect:'ask', agent:'build', sessionID:'ses_test'};
  await h.hooks.get('evaluate')(e); assert.equal(e.effect, 'ask');
});

test('ordinary shell has no approval reason field and restriction failures explain the approval route', async t => {
  const h = host(t); await h.plugin.setup(h.ctx);
  assert.equal(h.tools.get('sandbox_shell').input.properties.reason, undefined);
  const r = await h.tools.get('sandbox_shell').execute({command:'curl -I --max-time 2 https://example.com'}, h.toolCtx);
  assert.notEqual(r.metadata.exit_code, 0); assert.match(r.content, /shell_unsandboxed/);
  assert.ok(!h.requests.some(r=>r.action==='shell_unsandboxed'));
  const normal = await h.tools.get('sandbox_shell').execute({command:'printf "test assertion failed"; exit 1'}, h.toolCtx);
  assert.doesNotMatch(normal.content, /shell_unsandboxed/);
});
