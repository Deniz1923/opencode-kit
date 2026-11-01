import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../integrations/superpowers/index.js';

function context() {
  const hooks = new Map(), skills = [];
  let historyReads = 0;
  const ctx = {
    agent: { get: async () => ({ data: { permissions: ['skill', 'subagent'].map(action => ({ action, resource: '*', effect: 'deny' })) } }) },
    skill: { transform: async fn => fn({ add: value => skills.push(value) }) },
    session: {
      hook: async (name, fn) => { hooks.set(name, fn); return { dispose() {} }; },
      get: async () => ({ id: 'ses_fixture' }),
      context: async () => { historyReads++; throw new Error('Stored history is forbidden'); },
    },
  };
  return { ctx, hooks, skills, reads: () => historyReads };
}
test('upstream producer leaves Chat content and compaction checkpoints untouched without history reads', async () => {
  const h = context(); await adapter.setup(h.ctx);
  for (const agent of ['chat', 'friend/chat']) for (const content of ['Hello', '<EXTREMELY_IMPORTANT>\nYou have superpowers.\nA deliberate quotation']) {
    const e = { sessionID: 'ses_fixture', agent, messages: [{role:'user',content:[{type:'text',text:content},{type:'image',image:'fixture'}]}] };
    const original = structuredClone(e); await h.hooks.get('context')(e); assert.deepEqual(e, original);
  }
  const e = { sessionID:'ses_fixture',agent:'chat',messages:[{role:'assistant',content:[{type:'text',text:'Checkpoint'}]}] };
  const original = structuredClone(e); await h.hooks.get('context')(e); assert.deepEqual(e,original);
  assert.equal(h.reads(),0);
  assert.ok(h.skills.some(s=>s.id==='brainstorming'));
});
test('Build and Plan still receive the original Superpowers bootstrap', async () => {
  const h=context(); await adapter.setup(h.ctx);
  for (const agent of ['build','plan']) {
    const e={sessionID:'ses_fixture',agent,messages:[{role:'user',content:[{type:'text',text:'Original request'}]}]};
    await h.hooks.get('context')(e);
    assert.match(e.messages[0].content[0].text,/You have superpowers/);
    assert.equal(e.messages[0].content.at(-1).text,'Original request');
  }
  assert.equal(h.reads(),0);
});

test('Build opting into proportional workflow keeps skills without the automatic dispatcher', async () => {
  const h = context();
  h.ctx.agent.get = async () => ({ data: { system: 'Use a workflow proportional to the task.', permissions: [] } });
  await adapter.setup(h.ctx);
  for (const agent of ['build', 'team/build']) {
    for (const messages of [
      [{ role: 'user', content: [{ type: 'text', text: 'Fix the typo.' }, { type: 'image', image: 'fixture' }] }],
      [{ role: 'assistant', content: [{ type: 'text', text: 'Opaque checkpoint' }] }],
    ]) {
      const event = { sessionID: 'ses_fixture', agent, messages };
      const original = structuredClone(event);
      await h.hooks.get('context')(event);
      assert.deepEqual(event, original);
    }
  }
  assert.ok(h.skills.some(s => s.id === 'using-superpowers'));
  assert.ok(h.skills.some(s => s.id === 'brainstorming'));
  assert.ok(h.skills.some(s => s.id === 'writing-plans'));
  assert.ok(h.skills.some(s => s.id === 'systematic-debugging'));
  assert.equal(h.reads(), 0);
});

test('the Build workflow opt-in does not suppress Plan or another role', async () => {
  const h = context();
  h.ctx.agent.get = async () => ({ system: 'Use a workflow proportional to the task.', permissions: [] });
  await adapter.setup(h.ctx);
  for (const agent of ['plan', 'team/architect']) {
    const event = { sessionID: 'ses_fixture', agent, messages: [{ role: 'user', content: [{ type: 'text', text: 'Design this change.' }] }] };
    await h.hooks.get('context')(event);
    assert.match(event.messages[0].content[0].text, /You have superpowers/);
  }
});

test('unavailable Build metadata preserves the original callback instead of breaking a turn', async () => {
  for (const lookup of [async () => { throw new Error('Agent lookup unavailable'); }, async () => undefined]) {
    const h = context(); h.ctx.agent.get = lookup; await adapter.setup(h.ctx);
    const event = { sessionID: 'ses_fixture', agent: 'build', messages: [{ role: 'user', content: [{ type: 'text', text: 'Original request' }] }] };
    await assert.doesNotReject(h.hooks.get('context')(event));
    assert.match(event.messages[0].content[0].text, /You have superpowers/);
  }
});
test('explicitly restoring Chat workflow access restores upstream behavior', async () => {
  const h=context(); h.ctx.agent.get=async()=>({permissions:[{action:'skill',resource:'*',effect:'allow'}]});
  await adapter.setup(h.ctx);
  const e={sessionID:'ses_fixture',agent:'chat',messages:[{role:'user',content:[{type:'text',text:'Original request'}]}]};
  await h.hooks.get('context')(e); assert.match(e.messages[0].content[0].text,/You have superpowers/);
});
