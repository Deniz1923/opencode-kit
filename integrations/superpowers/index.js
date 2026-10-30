import upstream from './upstream/.opencode/plugins/superpowers.js';
import { deniedAction, workflowPermissions } from '../../workflow-policy.mjs';

export function createSuperpowersAdapter(plugin) {
  return {
    ...plugin,
    async setup(ctx) {
      const session = new Proxy(ctx.session, {
        get(target, key) {
          if (key === 'hook') return (name, callback, ...options) => target.hook(name,
            name !== 'context' ? callback : async event => {
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
