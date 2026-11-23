import upstream from './upstream/.opencode/plugins/superpowers.js';
import { deniedAction, workflowPermissions } from '../../workflow-policy.mjs';

// A prompt opt-in, not a permission grant. Other authors' Build agents keep
// their existing workflow unless they deliberately adopt this policy.
const proportionalWorkflow = 'Use a workflow proportional to the task.';

function adaptToolMapping(event) {
  const hasTodo = !event.tools || 'todowrite' in event.tools;
  for (const message of event.messages ?? []) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text.includes('**Tool Mapping for OpenCode:**')) continue;
      let text = part.text
        .replace(
          '- Run shell commands → `shell` (`command`, `workdir`, `timeout`, `background`)',
          '- Run shell commands → `sandbox_shell` (`command`, `workdir`, `timeout`, `background`) and monitor background jobs with `sandbox_job`; use `shell_unsandboxed` only with user approval when a sandbox boundary blocks required access',
        )
        .replace('and `shell` for deletion', 'and `sandbox_shell` for deletion');
      if (hasTodo) {
        text = text.replace(
          '- Create or update todos → OpenCode v2 has no todo tool; track the plan in a markdown file (or the harness\'s plan facility) instead',
          '- Create or update todos → `todowrite` (when enabled; otherwise track the plan in a markdown file)',
        );
      }
      part.text = text;
    }
  }
}

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
              const result = await callback(event);
              adaptToolMapping(event);
              return result;
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
