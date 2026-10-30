const PACKAGE = '@prevalentware/opencode-goal-plugin';
const legacy = target => typeof target === 'string' && (target === PACKAGE || target.startsWith(PACKAGE + '@'));

// Explicit migration helper: ordinary sandbox installs still preserve unrelated plugins.
export function removeLegacyGoal(input) {
  const result = structuredClone(input);
  if (Array.isArray(result.plugins)) result.plugins = result.plugins.filter(entry => !legacy(typeof entry === 'string' ? entry : entry.package));
  if (Array.isArray(result.policies)) result.policies = result.policies.filter(rule => !(rule.action === 'integration.use' && legacy(rule.resource?.replace(/^plugin:/, ''))));
  return result;
}
