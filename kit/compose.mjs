import * as jsonc from 'jsonc-parser';
import { isDeepStrictEqual as equal } from 'node:util';
import { migrateConfig } from '../config.mjs';
import { defaultPolicy } from '../defaults.mjs';
import { policyPaths } from '../policy.mjs';
import { validID } from './packs.mjs';

export function parseConfig(text) {
  const errors = []; const out = jsonc.parse(text || '{}', errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('Invalid JSON/JSONC config; no changes made');
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('Config must be an object');
  return out;
}
export function patchConfig(text, next) {
  let result = text || '{}\n';
  const set = (where, value, insert = false) => { result = jsonc.applyEdits(result, jsonc.modify(result, where, value, { isArrayInsertion: insert, formattingOptions: { insertSpaces: true, tabSize: 2 } })); };
  const update = (where, previous, value) => {
    if (equal(previous, value)) return;
    if (Array.isArray(previous) && Array.isArray(value)) {
      const current = [...previous]; let i = 0;
      while (i < value.length) {
        if (equal(current[i], value[i])) { i++; continue; }
        if (current.slice(i + 1).some(x => equal(x, value[i]))) { set([...where, i], undefined); current.splice(i, 1); continue; }
        if (i < current.length && value.slice(i + 1).some(x => equal(x, current[i]))) { set([...where, i], value[i], true); current.splice(i, 0, value[i]); }
        else { set([...where, i], value[i]); current[i] = value[i]; }
        i++;
      }
      while (current.length > value.length) { set([...where, current.length - 1], undefined); current.pop(); }
    } else if (previous && value && typeof previous === 'object' && typeof value === 'object' && !Array.isArray(previous) && !Array.isArray(value)) {
      for (const key of Object.keys(previous)) if (!Object.hasOwn(value, key)) set([...where, key], undefined);
      for (const [key, child] of Object.entries(value)) update([...where, key], previous[key], child);
    } else set(where, value);
  };
  update([], parseConfig(result), next); return result.endsWith('\n') ? result : result + '\n';
}
function normalAgent(raw) {
  const out = { ...raw }; if (out.prompt !== undefined && out.system === undefined) out.system = out.prompt; delete out.prompt;
  if (!out.permissions && out.permission) {
    out.permissions = Object.entries(out.permission).flatMap(([action, value]) => Object.entries(typeof value === 'string' ? { '*': value } : value).map(([resource, effect]) => ({ action: ({ bash: 'shell', task: 'subagent' })[action] ?? action, resource, effect })));
  }
  delete out.permission; return out;
}
export function compose(text, selection, resolutions = {}) {
  const previous = parseConfig(text); let config = structuredClone(previous);
  const paths = selection.paths ?? policyPaths(); const conflicts = [], overrides = {}, installed = [], warnings = [];
  const contributions = [];
  if (selection.packs?.length) { config.agents = Object.fromEntries(Object.entries(config.agents ?? config.agent ?? {}).map(([id, raw]) => [id, normalAgent(raw)])); delete config.agent; }
  function merge(where, proposed, owner, required = false) {
    const key = JSON.stringify(where); let parent = config;
    for (const part of where.slice(0, -1)) parent = parent[part] ??= {};
    const field = where.at(-1); const existing = parent[field];
    if (selection.sandbox && where[0] === 'agents' && existing) {
      const profile = defaultPolicy({ [field]: proposed }, { overrides, scratchRoot: selection.scratchRoot });
      const transformed = migrateConfig({ agents: { [field]: proposed } }, { home: paths.home, paths, pluginPath: selection.pluginPath, accessPolicy: profile }).agents[field];
      if (equal(existing, transformed)) return { used: true, name: field };
    }
    if (existing === undefined || equal(existing, proposed)) { parent[field] = structuredClone(proposed); return { used: true, name: field }; }
    const resolution = resolutions[key];
    if (!resolution) { conflicts.push({ key, path: where, owner, current: existing, proposed, required, rename: where[0] === 'agents' }); return { used: false, conflict: true }; }
    if (resolution.action === 'keep') return { used: false, omitted: required };
    if (resolution.action === 'replace') { parent[field] = structuredClone(proposed); return { used: true, name: field }; }
    if (resolution.action === 'rename' && where[0] === 'agents' && validID(resolution.name) && !Object.hasOwn(parent, resolution.name)) {
      parent[resolution.name] = structuredClone(proposed); return { used: true, name: resolution.name };
    }
    throw new Error('Invalid conflict resolution for ' + where.join('.'));
  }
  for (const pack of selection.packs ?? []) {
    if (pack.requires?.todo) {
      const todo = merge(['experimental', 'todo'], true, pack.id, true);
      if (todo.omitted) { warnings.push('Skipped ' + pack.id + ' to preserve the disabled todo setting'); continue; }
    }
    const before = structuredClone(config); const names = [], renamed = {};
    for (const [id, value] of Object.entries(pack.agents)) {
      overrides[id] = pack.access[id];
      const merged = merge(['agents', id], value, pack.id);
      if (merged.used) { overrides[merged.name] = pack.access[id]; names.push(merged.name); renamed[id] = merged.name; }
      if (merged.name !== id) delete overrides[id];
    }
    for (const [key, value] of Object.entries(pack.settings ?? {})) {
      if (key === 'experimental') for (const [child, item] of Object.entries(value)) merge(['experimental', child], item, pack.id);
      else merge([key], key === 'default_agent' ? renamed[value] ?? value : value, pack.id);
    }
    installed.push({ id: pack.id, name: pack.name, version: pack.version, source: pack.source, revision: pack.revision, hash: pack.hash, agents: names });
    contributions.push({ id: pack.id, before, after: structuredClone(config) });
  }
  if (selection.workflow) {
    const before = structuredClone(config);
    merge(['experimental', 'todo'], true, 'workflow:deniz');
    merge(['experimental', 'subagent_depth'], 1, 'workflow:deniz');
    installed.push({ id: 'workflow:deniz', name: 'Deniz workflow' }); contributions.push({ id: 'workflow:deniz', before, after: structuredClone(config) });
  }
  let policy;
  if (selection.sandbox) {
    const before = structuredClone(config);
    const agents = Object.fromEntries(Object.entries(config.agents ?? config.agent ?? {}).map(([id, raw]) => [id, normalAgent(raw)]));
    policy = defaultPolicy(agents, { overrides: { ...overrides, ...selection.profiles }, scratchRoot: selection.scratchRoot });
    config = migrateConfig(config, { home: paths.home, paths, pluginPath: selection.pluginPath, accessPolicy: policy });
    installed.unshift({ id: 'sandbox', name: 'Linux workspace sandbox' }); contributions.push({ id: 'sandbox', before, after: structuredClone(config) });
  }
  return { text: patchConfig(text, config), config, policy, conflicts, warnings, components: installed, contributions };
}
