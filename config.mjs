import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { INSTALL_DIR } from './sandbox.mjs';

const DROP = new Set(['list', 'todowrite', 'lsp', 'doom_loop']);
function rules(value) {
  if (Array.isArray(value)) return value.map(r => ({ ...r }));
  const out = [];
  for (let [action, resources] of Object.entries(value ?? {})) {
    if (DROP.has(action)) continue;
    action = ({ bash: 'shell', task: 'subagent' })[action] ?? action;
    if (typeof resources === 'string') resources = { '*': resources };
    for (const [resource, effect] of Object.entries(resources)) out.push({ action, resource, effect });
  }
  return out;
}
const key = r => JSON.stringify([r.action, r.resource]);
function enforce(existing, additions) {
  const keys = new Set(additions.map(key));
  return [...existing.filter(r => !keys.has(key(r))), ...additions];
}
function pluginTarget(entry) {
  const spec = typeof entry === 'string' ? entry : entry.package;
  if (spec.startsWith('/') || spec.startsWith('file:')) return spec.replace(/^file:\/\//, '');
  return spec.replace(/(?<!^)@.*$/, '');
}

export function migrateConfig(input, { home = os.homedir(), pluginPath = INSTALL_DIR } = {}) {
  if (!path.isAbsolute(home) || !path.isAbsolute(pluginPath)) throw new Error('home and pluginPath must be absolute');
  const out = structuredClone(input);
  out.experimental = { ...out.experimental };
  if (out.subagent_depth !== undefined) out.experimental.subagent_depth = out.subagent_depth;
  delete out.subagent_depth;
  out.agents = Object.fromEntries(Object.entries(out.agents ?? out.agent ?? {}).map(([name, raw]) => {
    const agent = { ...raw, system: raw.system ?? raw.prompt };
    delete agent.prompt;
    agent.permissions = rules(raw.permissions ?? raw.permission);
    delete agent.permission;
    if (['plan', 'explore', 'code-reviewer', 'debugger'].includes(name)) {
      agent.permissions = enforce(agent.permissions, [{ action: 'shell_unsandboxed', resource: '*', effect: 'deny' }]);
    }
    return [name, agent];
  }));
  delete out.agent;
  const additions = [
    { action: 'shell', resource: '*', effect: 'deny' },
    { action: 'sandbox_shell', resource: '*', effect: 'allow' },
    { action: 'shell_unsandboxed', resource: '*', effect: 'ask' },
    { action: 'external_directory', resource: '*', effect: 'ask' },
    { action: 'external_directory', resource: '/tmp/opencode/sandbox/*', effect: 'allow' },
    { action: 'webfetch', resource: '*', effect: 'ask' },
    { action: 'websearch', resource: '*', effect: 'ask' },
    { action: 'read', resource: '*.env', effect: 'deny' },
    { action: 'read', resource: '*.env.*', effect: 'deny' },
    { action: 'read', resource: '*.env.example', effect: 'allow' },
    ...['**/opencode.json', '**/opencode.jsonc', '**/.opencode/**', '**/.agents/**', '**/.claude/**', '**/.mcp.json'].map(resource => ({ action: 'edit', resource, effect: 'ask' })),
  ];
  const sensitive = ['.ssh', '.aws', '.gnupg', '.config/gh', '.docker', '.kube', '.azure', '.config/gcloud',
    '.local/share/opencode', '.local/state/opencode', '.codex', '.claude'];
  for (const name of sensitive) for (const action of ['read', 'edit']) {
    additions.push({ action, resource: path.join(home, name, '**'), effect: 'deny' });
  }
  for (const name of ['.git-credentials', '.netrc', '.npmrc', '.pypirc', '.claude.json', '.config/opencode/service.json']) {
    for (const action of ['read', 'edit']) additions.push({ action, resource: path.join(home, name), effect: 'deny' });
  }
  const immutable = [path.join(home, '.config/opencode'), path.join(home, '.cache/opencode'), pluginPath];
  for (const name of immutable) additions.push({ action: 'edit', resource: name + '/**', effect: 'deny' });
  out.permissions = enforce(rules(out.permissions ?? out.permission), additions);
  delete out.permission;
  out.plugins = [...(out.plugins ?? [])].filter(entry => (typeof entry === 'string' ? entry : entry.package) !== pluginPath);
  out.plugins.push({ package: pluginPath });
  const policies = [
    { action: 'tool.use', resource: 'shell:*', effect: 'deny' },
    { action: 'integration.use', resource: 'plugin:*', effect: 'deny' },
    ...out.plugins.map(entry => ({ action: 'integration.use', resource: 'plugin:' + pluginTarget(entry), effect: 'allow' })),
    ...immutable.map(name => ({ action: 'tool.use', resource: 'edit:' + name + '/**', effect: 'deny' })),
  ];
  out.policies = enforce(out.policies ?? [], policies);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const option = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const input = option('--input');
  if (!input) throw new Error('Usage: node config.mjs --input FILE [--output FILE] [--plugin DIR]');
  const output = option('--output');
  if (output && path.resolve(output) === path.resolve(input)) throw new Error('Refusing to overwrite the input config; generate and review a separate file');
  const result = migrateConfig(JSON.parse(fs.readFileSync(input, 'utf8')), { pluginPath: option('--plugin') ?? INSTALL_DIR });
  const text = JSON.stringify(result, null, 2) + '\n';
  if (output) fs.writeFileSync(output, text, { mode: 0o600 });
  else process.stdout.write(text);
}
