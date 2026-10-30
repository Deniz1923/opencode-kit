import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { compose, parseConfig, patchConfig } from './compose.mjs';
import { inside, loadPolicy } from '../policy.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CODE = ['index.js', 'sandbox.mjs', 'policy.mjs', 'defaults.mjs', 'workflow-policy.mjs', 'workspaces.mjs'];
const digest = text => text === null ? null : createHash('sha256').update(text).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function checkPath(file) {
  if (!path.isAbsolute(file)) throw new Error('Installation paths must be absolute');
  let current = path.parse(file).root;
  for (const part of file.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Refusing symlink installation path: ' + current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function read(file, privateFile = false) {
  checkPath(file);
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.uid !== process.getuid() || (privateFile && (st.mode & 0o022))) throw new Error('Unsafe file ownership/type/mode: ' + file);
    if (st.size > 16 * 1024 * 1024) throw new Error('Installation file too large: ' + file);
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function stateAt(paths) {
  const text = read(paths.state, true); if (text === null) return null;
  const state = JSON.parse(text);
  if (state.schemaVersion !== 1 || !state.selection || !state.installed || !state.baseline || !Array.isArray(state.components)) throw new Error('Unsupported or damaged kit state');
  return state;
}
const journalPath = paths => path.join(paths.kitConfig, 'transaction.json');
function assertReady(paths) {
  for (const p of [paths.configDir, paths.kitConfig, paths.store, paths.policy, paths.state]) checkPath(p);
  if (read(journalPath(paths), true) !== null) throw new Error('Interrupted installation; run opencode-kit recover first');
}
function configFile(paths, state) {
  const files = ['opencode.json', 'opencode.jsonc'].map(p => path.join(paths.configDir, p));
  const present = files.filter(p => read(p) !== null);
  if (present.length > 1) throw new Error('Both opencode.json and opencode.jsonc exist; select one before setup');
  const file = state?.configFile ?? present[0] ?? files[0];
  if (!files.includes(file) || (present[0] && present[0] !== file)) throw new Error('Config location changed since installation');
  return file;
}
function itemKey(value) {
  if (value && typeof value === 'object' && value.action && value.resource) return JSON.stringify([value.action, value.resource]);
  if (value && typeof value === 'object' && value.package) return 'plugin:' + value.package;
  return JSON.stringify(value);
}
// Undo only changes owned by this kit, merging any later user edits.
function unapply(current, before, after, where, conflicts, resolutions) {
  if (equal(before, after)) return current;
  if (equal(current, after)) return structuredClone(before);
  if ((object(before) || before === undefined) && object(after) && object(current)) {
    const out = structuredClone(current);
    for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after)])) {
      const v = unapply(current[key], before?.[key], after[key], [...where, key], conflicts, resolutions);
      if (v === undefined) delete out[key]; else out[key] = v;
    }
    return before === undefined && !Object.keys(out).length ? undefined : out;
  }
  if (Array.isArray(current) && Array.isArray(after) && (Array.isArray(before) || before === undefined)) {
    const out = [...current], original = before ?? [];
    const keys = new Set([...original.map(itemKey), ...after.map(itemKey)]);
    for (const key of keys) {
      const b = original.find(v => itemKey(v) === key), a = after.find(v => itemKey(v) === key);
      if (equal(b, a)) continue;
      const index = out.findIndex(v => itemKey(v) === key);
      const v = unapply(out[index], b, a, [...where, key], conflicts, resolutions);
      if (v === undefined && index >= 0) out.splice(index, 1);
      else if (v !== undefined && index >= 0) out[index] = v;
      else if (v !== undefined) out.push(v);
    }
    return before === undefined && !out.length ? undefined : out;
  }
  const key = 'owned:' + JSON.stringify(where), choice = resolutions[key];
  if (choice?.action === 'keep') return current;
  if (choice?.action === 'replace') return structuredClone(before);
  conflicts.push({ key, path: where, owner: 'previous kit installation', current, proposed: before, rename: false });
  return current;
}
function codeFiles(paths) {
  const content = CODE.map(name => [name, fs.readFileSync(path.join(ROOT, name), 'utf8'), 0o600]);
  function include(directory) {
    for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Managed integration symlinks are unsupported');
      if (entry.isDirectory()) include(relative);
      else if (entry.isFile()) content.push([relative, fs.readFileSync(path.join(ROOT, relative), 'utf8'), fs.statSync(path.join(ROOT, relative)).mode & 0o111 ? 0o700 : 0o600]);
    }
  }
  include('integrations/superpowers');
  content.push(['package.json', json({ name: 'opencode-workspace-sandbox', type: 'module', version: '0.2.0', private: true }), 0o600]);
  const hash = digest(json(content)); const directory = path.join(paths.store, 'versions', hash.slice(0, 20));
  return { directory, hash, files: content.map(([name, after, mode]) => ({ path: path.join(directory, name), after, mode })) };
}
export function planInstall(paths, requested = {}, resolutions = {}, { remove } = {}) {
  assertReady(paths); const stateText = read(paths.state, true), state = stateAt(paths);
  const file = configFile(paths, state); const configText = read(file) ?? '{}\n'; const current = parseConfig(configText);
  const conflicts = [];
  const baseline = state ? unapply(current, state.baseline, state.installed, [], conflicts, resolutions) : current;
  const previous = state?.selection ?? { packs: [], sandbox: false, workflow: false };
  const packs = new Map(previous.packs.map(pack => [pack.id, pack]));
  for (const pack of requested.packs ?? []) packs.set(pack.id, pack);
  let selection = { ...previous, ...requested, packs: [...packs.values()], paths };
  if (remove) {
    if (!state?.components.some(c => c.id === remove)) throw new Error('Component is not installed: ' + remove);
    if (remove === 'sandbox') selection.sandbox = false;
    else if (remove === 'workflow:deniz') selection.workflow = false;
    else selection.packs = selection.packs.filter(pack => pack.id !== remove);
  }
  let retainPolicy;
  if (state?.policy) {
    const raw = read(paths.policy, true);
    const currentPolicy = raw === null ? null : JSON.parse(raw);
    if (!equal(currentPolicy, state.policy)) {
      const choice = resolutions['owned:policy'];
      if (choice?.action === 'keep') {
        if (selection.sandbox) {
          if (raw === null) throw new Error('Sandbox requires a policy; replace the missing policy or remove sandbox');
          const valid = loadPolicy(paths.policy);
          selection.profiles = { ...selection.profiles, ...valid.agents, ...requested.profiles }; selection.scratchRoot = valid.scratchRoot;
        } else retainPolicy = raw;
      } else if (choice?.action !== 'replace') conflicts.push({ key: 'owned:policy', path: ['trusted policy'], owner: 'sandbox', current: currentPolicy, proposed: state.policy, rename: false });
    }
  }
  const code = codeFiles(paths); selection.pluginPath = code.directory;
  const composed = compose(patchConfig(configText, baseline), selection, { ...state?.resolutions, ...resolutions });
  conflicts.push(...composed.conflicts);
  const storedSelection = { ...selection }; delete storedSelection.paths; delete storedSelection.pluginPath;
  const nextState = { schemaVersion: 1, configFile: file, baseline, installed: composed.config, selection: storedSelection,
    components: composed.components, resolutions: { ...state?.resolutions, ...resolutions }, policy: composed.policy ?? null, codeHash: selection.sandbox ? code.hash : null };
  const finalText = patchConfig(configText, composed.config);
  const files = [{ path: file, after: finalText }, { path: paths.policy, after: composed.policy ? json(composed.policy) : retainPolicy ?? null }, { path: paths.state, after: json(nextState) }];
  if (!selection.sandbox && !state?.selection.sandbox) files.splice(1, 1);
  if (selection.sandbox) files.unshift(...code.files);
  for (const f of files) {
    f.before = read(f.path, f.path !== file);
    if (inside(f.path, path.join(paths.store, 'versions')) && f.before !== null && f.before !== f.after) throw new Error('Managed code integrity changed: ' + f.path);
    f.expected = digest(f.before);
    if (f.path === paths.policy && !state && f.before !== null) throw new Error('Unmanaged policy already exists; preserve it before setup');
  }
  return { schemaVersion: 1, paths, configFile: file, files, conflicts, warnings: composed.warnings, components: composed.components,
    stateExpected: digest(stateText), securityChanges: selection.sandbox ? 'Native agent shell is blocked; commands use sandbox_shell and trusted per-agent profiles. Host escapes always ask.' : 'Sandbox component is not selected.' };
}
export function planRemoval(paths, id, resolutions = {}) { return planInstall(paths, {}, resolutions, { remove: id }); }
export function listInstalled(paths) { return stateAt(paths)?.components ?? []; }
export function installedSelection(paths) { return stateAt(paths)?.selection ?? { packs: [], sandbox: false, workflow: false }; }
function ensureParent(file) { checkPath(file); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); checkPath(file); }
function atomic(file, text, mode = 0o600) {
  ensureParent(file);
  if (text === null) { fs.rmSync(file, { force: true }); return; }
  const temp = file + '.tmp-' + randomUUID();
  try {
    const fd = fs.openSync(temp, 'wx', mode);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { fs.rmSync(temp, { force: true }); }
}
function takeLock(paths, recovering = false) {
  const file = path.join(paths.kitConfig, 'install.lock'); ensureParent(file);
  try {
    const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(read(file, true)); let alive = true;
    try { if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(); process.kill(pid, 0); } catch (e) { alive = e.code !== 'ESRCH' && e.code !== undefined; }
    if (alive || !recovering) throw new Error('Installer is locked; stop other setup processes, then run recover');
    fs.unlinkSync(file); return takeLock(paths, false);
  }
  return () => fs.unlinkSync(file);
}
function allowedFile(paths, file, config) {
  return file === config || file === paths.policy || file === paths.state || (inside(file, path.join(paths.store, 'versions')) && file !== path.join(paths.store, 'versions'));
}
function rollback(paths, journal) {
  if (journal.schemaVersion !== 1 || !Array.isArray(journal.files) || !['opencode.json', 'opencode.jsonc'].some(n => journal.configFile === path.join(paths.configDir, n))) throw new Error('Invalid recovery journal');
  // Inspect every file before changing any; preserve edits made after interruption.
  for (const file of journal.files) {
    if (!allowedFile(paths, file.path, journal.configFile)) throw new Error('Recovery journal contains an unsafe path');
    const current = digest(read(file.path));
    if (current !== digest(file.before) && current !== digest(file.after)) throw new Error('Recovery conflict: file changed after interruption: ' + file.path);
  }
  for (const file of [...journal.files].reverse()) if (digest(read(file.path)) !== digest(file.before)) atomic(file.path, file.before);
  fs.unlinkSync(journalPath(paths));
}
export function recover(paths) {
  const release = takeLock(paths, true);
  try { const raw = read(journalPath(paths), true); if (raw !== null) rollback(paths, JSON.parse(raw)); }
  finally { release(); }
}
export function applyPlan(plan, { faultAfter, interruptAfter } = {}) {
  if (plan.conflicts.length) throw new Error('Resolve installation conflicts before applying');
  assertReady(plan.paths); const release = takeLock(plan.paths); let journal;
  try {
    if (digest(read(plan.paths.state, true)) !== plan.stateExpected) throw new Error('State changed since preview; generate a fresh plan');
    for (const f of plan.files) if (digest(read(f.path)) !== f.expected) throw new Error('File changed since preview; generate a fresh plan: ' + f.path);
    const files = plan.files.filter(f => f.before !== f.after);
    if (!files.length) return { changed: false, components: plan.components };
    const backup = path.join(plan.paths.kitConfig, 'backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    journal = { schemaVersion: 1, configFile: plan.configFile, files: files.map(f => ({ path: f.path, before: f.before, after: f.after })) };
    atomic(path.join(backup, 'transaction.json'), json(journal));
    atomic(journalPath(plan.paths), json(journal));
    for (const [index, file] of files.entries()) {
      atomic(file.path, file.after, file.mode);
      if (interruptAfter === index + 1) { const e = new Error('Installation interrupted (test simulation); run recover'); e.interrupted = true; throw e; }
      if (faultAfter === index + 1) throw new Error('Injected installation failure');
    }
    if (plan.components.some(c => c.id === 'sandbox')) loadPolicy(plan.paths.policy);
    fs.unlinkSync(journalPath(plan.paths));
    return { changed: true, backup, components: plan.components };
  } catch (error) {
    if (journal && !error.interrupted) {
      try { rollback(plan.paths, journal); } catch (failure) { throw new Error(error.message + '; recovery required: ' + failure.message); }
    }
    throw error;
  } finally { release(); }
}
