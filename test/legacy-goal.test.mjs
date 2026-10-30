import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeLegacyGoal } from '../kit/legacy-goal.mjs';

test('removes only the legacy goal package and its integration rules', () => {
  const original = {
    plugins: ['@prevalentware/opencode-goal-plugin', {package:'@prevalentware/opencode-goal-plugin@0.1.68',options:{}}, 'superpowers', {package:'/managed/sandbox'}],
    policies: [
      {action:'integration.use',resource:'plugin:@prevalentware/opencode-goal-plugin',effect:'allow'},
      {action:'integration.use',resource:'plugin:opencode.goal',effect:'allow'},
      {action:'integration.use',resource:'plugin:*',effect:'deny'},
    ],
    agents: {chat:{system:'Unchanged',permissions:[{action:'*goal*',resource:'*',effect:'deny'}]}},
    model: 'my/model', experimental: {todo:true},
  };
  const before = structuredClone(original), result = removeLegacyGoal(original);
  assert.deepEqual(original,before);
  assert.deepEqual(result.plugins,['superpowers',{package:'/managed/sandbox'}]);
  assert.deepEqual(result.policies,original.policies.slice(1));
  assert.deepEqual(result.agents,original.agents);assert.equal(result.model,'my/model');
  assert.deepEqual(removeLegacyGoal(result),result);
});
test('unrelated configurations are unchanged',()=>{
  assert.deepEqual(removeLegacyGoal({experimental:{todo:true}}),{experimental:{todo:true}});
});
