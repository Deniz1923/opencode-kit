import upstream from './upstream/.opencode/plugins/superpowers.js';
import { deniedAction, workflowPermissions } from '../../workflow-policy.mjs';

// A prompt opt-in, not a permission grant. Other authors' Build agents keep
// their existing workflow unless they deliberately adopt this policy.
const proportionalWorkflow = 'Use a workflow proportional to the task.';

export function createSuperpowersAdapter(plugin) {
  return {
    ...plugin,
    async setup(ctx) {
      const session = new Proxy(ctx.session, {
        get(target, key) {
          if (key === 'hook') return (name, callback, ...options) => target.hook(name,
            name !== 'context' ? callback : async event => {
              if (event.agent?.split('/').at(-1) === 'build') {
                try {
                  const result = await ctx.agent.get({ agentID: event.agent });
                  const system = (result?.data ?? result)?.system;
                  if (typeof system === 'string' && system.split('\n').some(line => line.trim() === proportionalWorkflow)) return;
                } catch { /* Without a confirmed opt-in, retain the upstream callback. */ }
              }
              if (event.agent?.split('/').at(-1) === 'chat') {
                const rules = await workflowPermissions(ctx, event.agent);
                if (deniedAction(rules, 'skill') && deniedAction(rules, 'subagent')) return;
              }
              return callback(event);
            }, ...options);
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const adapted = new Proxy(ctx, { get: (target, key) => key === 'session' ? session : Reflect.get(target, key, target) });
      return plugin.setup(adapted);
    },
  };
}

export default createSuperpowersAdapter(upstream);
