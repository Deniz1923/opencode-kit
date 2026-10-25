import { validatePolicy } from './policy.mjs';

// Setup defaults, not runtime authority. Runtime reads the user's trusted policy.
const defaults = {
  build: ['workspace-write', 'ask'], general: ['workspace-write', 'ask'], chat: ['workspace-write', 'ask'],
  plan: ['planner', 'deny'], explore: ['read-only', 'deny'],
  'code-reviewer': ['read-only', 'deny'], debugger: ['read-only', 'deny'], 'test-engineer': ['read-only', 'ask'],
};
export function explicitlyDenied(rules, action) {
  let effect;
  for (const rule of rules ?? []) if (['*', action].includes(rule.action) && rule.resource === '*') effect = rule.effect;
  return effect === 'deny';
}
export function defaultPolicy(agents = {}, { scratchRoot = '/tmp/opencode/sandbox', overrides = {} } = {}) {
  const names = new Set(['build', 'general', 'plan', 'explore', ...Object.keys(agents)]);
  const mapping = Object.fromEntries([...names].map(id => {
    const permissions = agents[id]?.permissions ?? [];
    const known = defaults[id] ?? ['read-only', 'deny'];
    const raw = { profile: id !== 'plan' && explicitlyDenied(permissions, 'edit') ? 'read-only' : known[0],
      shell: !explicitlyDenied(permissions, 'shell'), escape: known[1], ...overrides[id] };
    // Never adapt an explicit source denial into an implicit grant.
    if (explicitlyDenied(permissions, 'shell')) { raw.shell = false; raw.escape = 'deny'; }
    if (explicitlyDenied(permissions, 'shell_unsandboxed')) raw.escape = 'deny';
    return [id, raw];
  }));
  return validatePolicy({ schemaVersion: 1, scratchRoot, agents: mapping });
}
