import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PLANNING_ROOTS = ['docs/superpowers/specs', 'docs/superpowers/plans'];
const modes = new Set(['read-only', 'planner', 'workspace-write']);
const reserved = new Set(['.git', '.opencode', '.agents', '.claude', '.mcp.json', 'opencode.json', 'opencode.jsonc']);
export function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel));
}
export function planningRoot(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /[\0\r\n\\]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..' || reserved.has(p))) {
    throw new Error('Invalid or unsafe planning root');
  }
  return value;
}
export function validatePolicy(input) {
  if (input?.schemaVersion !== 1 || !input.agents || Array.isArray(input.agents)) throw new Error('Invalid kit policy schema');
  const scratchRoot = input.scratchRoot ?? '/tmp/opencode/sandbox';
  if (!path.isAbsolute(scratchRoot) || /[\0\r\n]/.test(scratchRoot) || ['/', os.homedir(), '/tmp', '/run'].includes(path.resolve(scratchRoot))) throw new Error('Invalid policy scratch root');
  const agents = Object.create(null);
  for (const [id, raw] of Object.entries(input.agents)) {
    if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(id) || !modes.has(raw?.profile)) throw new Error('Invalid agent policy: ' + id);
    if (raw.escape !== undefined && !['ask', 'deny'].includes(raw.escape)) throw new Error('Invalid escape policy');
    if (raw.shell !== undefined && typeof raw.shell !== 'boolean') throw new Error('Invalid shell policy');
    const roots = raw.profile === 'planner' ? (raw.planningRoots ?? PLANNING_ROOTS) : [];
    if (!Array.isArray(roots)) throw new Error('Invalid planning roots');
    agents[id] = { profile: raw.profile, shell: raw.shell ?? true, escape: raw.escape ?? 'deny', planningRoots: roots.map(planningRoot) };
  }
  return { schemaVersion: 1, scratchRoot: path.resolve(scratchRoot), agents };
}
export function agentAccess(policy, id) {
  return Object.hasOwn(policy.agents, id) ? policy.agents[id] : { profile: 'read-only', shell: false, escape: 'deny', planningRoots: [] };
}
export function policyPaths(home = os.homedir(), env = process.env) {
  const configRoot = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const dataRoot = env.XDG_DATA_HOME || path.join(home, '.local/share');
  return { home, configDir: env.OPENCODE_CONFIG_DIR || path.join(configRoot, 'opencode'),
    kitConfig: path.join(configRoot, 'opencode-kit'), policy: path.join(configRoot, 'opencode-kit/policy.json'),
    store: path.join(dataRoot, 'opencode-kit'), state: path.join(dataRoot, 'opencode-kit/state.json'),
    dataDir: path.join(dataRoot, 'opencode'), stateDir: path.join(env.XDG_STATE_HOME || path.join(home, '.local/state'), 'opencode'),
    cacheDir: path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'opencode') };
}
// One path inventory for native file guards, shell mounts, and installation rules.
// Do not inspect these files to discover whether they contain private data.
export function privatePaths(home = os.homedir(), env = process.env) {
  const p = policyPaths(home, env);
  const configRoot = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [...new Set([
    ...['.ssh', '.aws', '.gnupg', '.config/gh', '.docker', '.kube', '.azure', '.config/gcloud',
      '.git-credentials', '.netrc', '.npmrc', '.pypirc', '.codex', '.claude', '.claude.json',
      '.config/opencode', '.local/share/opencode', '.local/state/opencode'].map(n => path.join(home, n)),
    path.join(configRoot, 'gh'), path.join(configRoot, 'gcloud'),
    p.configDir, p.dataDir, p.stateDir, p.kitConfig, p.state,
  ])];
}
export function loadPolicy(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o022)) throw new Error('policy must be an owned, non-writable-by-others regular file');
    return validatePolicy(JSON.parse(fs.readFileSync(fd, 'utf8')));
  } catch (error) { throw new Error('Kit policy missing or invalid; run setup: ' + error.message); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function scratchPath(workspace, root) {
  return path.join(root, createHash('sha256').update(workspace).digest('hex').slice(0, 16));
}
export function canonicalTarget(file) {
  let pending = path.resolve(file).split(path.sep).filter(Boolean), current = '/', links = 0;
  while (pending.length) {
    const part = pending.shift();
    if (part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    const next = path.join(current, part);
    let st;
    try { st = fs.lstatSync(next); }
    catch (error) { if (error.code !== 'ENOENT') throw error; current = next; continue; }
    if (st.isSymbolicLink()) {
      if (++links > 40) throw new Error('Too many symlinks resolving file target');
      const target = fs.readlinkSync(next);
      if (path.isAbsolute(target)) current = '/';
      pending = [...target.split(path.sep).filter(Boolean), ...pending];
    } else current = next;
  }
  return current;
}
export function canEdit(access, target, { workspace, scratch }) {
  if (inside(target, scratch)) return true;
  if (!inside(target, workspace)) return false;
  if (path.relative(workspace, target).split(path.sep).some(p => reserved.has(p))) return false;
  if (access.profile === 'workspace-write') return true;
  return access.profile === 'planner' && access.planningRoots.some(root => inside(target, path.join(workspace, root)));
}
