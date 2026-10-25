import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import { parse as parseJSONC } from 'jsonc-parser';
import { defaultPolicy } from '../defaults.mjs';
import { inside } from '../policy.mjs';

const fields = new Set(['description', 'mode', 'system', 'prompt', 'model', 'permissions', 'permission', 'color', 'hidden', 'steps']);
export function validID(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-][\w.-]*(?:\/[A-Za-z0-9_-][\w.-]*)*$/.test(id) && !id.split('/').some(x => ['__proto__', 'constructor', 'prototype'].includes(x));
}
function json(text) {
  const errors = []; const value = parseJSONC(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('Invalid JSON/JSONC in agent pack'); return value;
}
function safeFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '..' || p === '.')) throw new Error('Unsafe pack path');
  const full = path.join(root, relative); let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Agent pack symlinks are unsupported');
  }
  const st = fs.statSync(full);
  if (!inside(fs.realpathSync(full), root) || !st.isFile() || st.size > 256 * 1024) throw new Error('Agent file outside pack, not regular, or too large');
  return full;
}
function permissionRules(raw) {
  if (Array.isArray(raw)) return raw.map(rule => {
    if (!rule || typeof rule.action !== 'string' || typeof rule.resource !== 'string' || !['allow', 'ask', 'deny'].includes(rule.effect)) throw new Error('Invalid agent permission');
    return { ...rule, action: ({ bash: 'shell', task: 'subagent' })[rule.action] ?? rule.action };
  });
  const out = [];
  for (const [name, value] of Object.entries(raw ?? {})) {
    const action = ({ bash: 'shell', task: 'subagent' })[name] ?? name;
    for (const [resource, effect] of Object.entries(typeof value === 'string' ? { '*': value } : value)) out.push({ action, resource, effect });
  }
  return permissionRules(out);
}
function agent(raw, body) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Agent definition must be an object');
  for (const field of Object.keys(raw)) if (!fields.has(field)) throw new Error('Unsupported agent field (executable/config fields are not imported): ' + field);
  const out = { ...raw, system: body ?? raw.system ?? raw.prompt ?? '', permissions: permissionRules(raw.permissions ?? raw.permission) };
  delete out.prompt; delete out.permission;
  if (typeof out.system !== 'string' || /\{(?:file|env):/i.test(JSON.stringify(out))) throw new Error('Agent config interpolation is not imported; use literal agent data');
  if (out.mode !== undefined && !['primary', 'subagent', 'all'].includes(out.mode)) throw new Error('Invalid agent mode');
  if (out.model !== undefined && typeof out.model !== 'string') throw new Error('Agent model must be a provider/model string');
  if (out.steps !== undefined && (!Number.isSafeInteger(out.steps) || out.steps < 1)) throw new Error('Agent steps must be a positive integer');
  return out;
}
function walk(root, relative, out) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Agent pack symlinks are unsupported');
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) { if (name.split('/').length > 12) throw new Error('Agent pack nesting limit exceeded'); walk(root, name, out); }
    else if (/\.(md|json|jsonc)$/i.test(entry.name)) out.push({ file: name });
    if (out.length > 100) throw new Error('Agent pack exceeds 100 agents');
  }
}
export function readAgentPack(source, { namespace } = {}) {
  const root = fs.realpathSync(source); const manifestPath = path.join(root, 'opencode-kit.json');
  const manifest = fs.existsSync(manifestPath) ? json(fs.readFileSync(safeFile(root, 'opencode-kit.json'), 'utf8')) : {};
  if (/\{(?:file|env):/i.test(JSON.stringify(manifest))) throw new Error('Manifest config interpolation is not imported');
  if (manifest.formatVersion !== undefined && manifest.formatVersion !== 1) throw new Error('Unsupported agent pack format');
  namespace = namespace ?? manifest.namespace ?? path.basename(root);
  if (!validID(namespace)) throw new Error('Invalid pack namespace');
  const entries = manifest.agents ? manifest.agents.map(e => typeof e === 'string' ? { file: e } : e) : [];
  if (!manifest.agents) {
    const directory = ['agents', '.opencode/agents'].find(p => fs.existsSync(path.join(root, p)));
    if (!directory) throw new Error('No agents/ or .opencode/agents/ directory found');
    walk(root, directory, entries);
  }
  if (!entries.length || entries.length > 100) throw new Error('Agent pack must contain between 1 and 100 agents');
  const agents = {}, access = {}; const hash = createHash('sha256');
  for (const entry of entries) {
    const file = safeFile(root, entry.file); const text = fs.readFileSync(file, 'utf8'); hash.update(entry.file).update(text);
    let definitions;
    if (file.endsWith('.md')) {
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''));
      const doc = parseDocument(match?.[1] ?? '{}', { uniqueKeys: true });
      if (doc.errors.length || doc.warnings.length) throw new Error('Invalid or unsupported agent frontmatter');
      definitions = { [entry.id ?? path.basename(file, '.md')]: agent(doc.toJS({ maxAliasCount: 0 }), (match ? text.slice(match[0].length) : text).trim()) };
    } else {
      const value = json(text);
      definitions = value.agents ? Object.fromEntries(Object.entries(value.agents).map(([id, v]) => [id, agent(v)])) : { [entry.id ?? path.basename(file).replace(/\.jsonc?$/, '')]: agent(value) };
    }
    for (const [id, value] of Object.entries(definitions)) {
      if (!validID(id)) throw new Error('Invalid agent ID');
      const full = namespace + '/' + id;
      if (agents[full]) throw new Error('Duplicate agent ID: ' + full);
      agents[full] = value;
      access[full] = defaultPolicy({ [full]: value }, { overrides: { [full]: entry.access ?? {} } }).agents[full];
    }
  }
  const settings = manifest.settings ?? {};
  for (const key of Object.keys(settings)) if (!['model', 'default_agent', 'share', 'experimental'].includes(key)) throw new Error('Unsupported pack setting: ' + key);
  if (settings.experimental) for (const key of Object.keys(settings.experimental)) if (!['todo', 'subagent_depth'].includes(key)) throw new Error('Unsupported experimental pack setting');
  if (/\{(?:file|env):/i.test(JSON.stringify(settings))) throw new Error('Config interpolation is not imported');
  if (settings.default_agent && agents[namespace + '/' + settings.default_agent]) settings.default_agent = namespace + '/' + settings.default_agent;
  return { id: 'agents:' + namespace, name: manifest.name ?? namespace, namespace, version: manifest.version ?? 'unversioned',
    source: root, hash: hash.update(JSON.stringify(manifest)).digest('hex'), agents, access, settings, requires: manifest.requires ?? {} };
}
export function parseGithubSource(source) {
  const match = /^github:([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)(?:#([A-Za-z0-9][\w./-]*))?$/.exec(source);
  if (!match || match[1].includes('..') || match[2].includes('..') || match[3]?.includes('..')) throw new Error('Expected a GitHub source github:owner/repository#reference');
  return { owner: match[1], repo: match[2], ref: match[3] ?? 'HEAD' };
}
export function fetchAgentSource(source, cacheRoot) {
  if (!source.startsWith('github:')) return { directory: fs.realpathSync(source), source, revision: null };
  const spec = parseGithubSource(source);
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(cacheRoot, 'source-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const git = args => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args], { cwd: directory, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error('GitHub agent fetch failed: ' + (r.error?.message ?? r.stderr.trim()));
    return r.stdout.trim();
  };
  try {
    git(['init', '--quiet']); git(['fetch', '--quiet', '--depth', '1', '--', `https://github.com/${spec.owner}/${spec.repo}.git`, spec.ref]);
    const revision = git(['rev-parse', '--verify', 'FETCH_HEAD']); git(['checkout', '--quiet', '--detach', revision]);
    return { directory, source, revision, namespace: spec.owner + '-' + spec.repo };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
