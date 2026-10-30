export function deniedAction(rules, action) {
  let effect;
  for (const rule of rules ?? []) {
    const pattern = rule.action.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (rule.resource === '*' && new RegExp('^' + pattern + '$').test(action)) effect = rule.effect;
  }
  return effect === 'deny';
}

export async function workflowPermissions(ctx, agentID) {
  const result = await ctx.agent.get({ agentID });
  return (result.data ?? result).permissions ?? [];
}
