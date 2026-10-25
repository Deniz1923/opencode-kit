import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { planningRoot } from './policy.mjs';

export const INSTALL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SPECIAL_ROOTS = new Set(['/', '/tmp', '/run', '/dev/shm', '/dev', '/proc', '/sys']);
const RESERVED = new Map([['opencode.json', 'file'], ['opencode.jsonc', 'file'],
  ['.mcp.json', 'file'], ['.opencode', 'dir'], ['.agents', 'dir'], ['.claude', 'dir'], ['.git', 'dir']]);
const queues = new Map();
export function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function unavailable(reason) { return new Error('OpenCode sandbox unavailable: ' + reason); }
function realDir(value) {
  if (!path.isAbsolute(value ?? '') || /[\r\n\0]/.test(value)) throw unavailable('invalid trusted directory');
  const real = fs.realpathSync(value);
  if (!fs.statSync(real).isDirectory()) throw unavailable('workspace is not a directory');
  return real;
}
function privateDir(dir) {
  if (!path.isAbsolute(dir)) throw unavailable('scratch directory must be absolute');
  let current = path.parse(dir).root;
  for (const part of dir.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable('symlink or non-directory in scratch path');
  }
  const stat = fs.lstatSync(dir);
  if (stat.uid !== process.getuid()) throw unavailable('scratch directory belongs to another user');
  fs.chmodSync(dir, 0o700);
}
function cleanEnvironment(source, home, scratch) {
  const out = {};
  const names = new Set(['PATH', 'USER', 'LOGNAME', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'LANG', 'TZ']);
  for (const [name, value] of Object.entries(source)) {
    if ((names.has(name) || name.startsWith('LC_')) && !/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && typeof value === 'string') out[name] = value;
  }
  return { ...out, PATH: out.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home,
    SHELL: '/bin/bash', TMPDIR: path.join(scratch, 'tmp'), XDG_RUNTIME_DIR: path.join(scratch, 'run'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), npm_config_cache: path.join(scratch, 'cache/npm'),
    PIP_CACHE_DIR: path.join(scratch, 'cache/pip'), GOCACHE: path.join(scratch, 'cache/go-build'),
    YARN_CACHE_FOLDER: path.join(scratch, 'cache/yarn'), GIT_OPTIONAL_LOCKS: '0' };
}

export function runProcess(file, args, { cwd, env = process.env, timeout = 120000, signal, extraFD, extraFDs = [] } = {}) {
  if (!Number.isSafeInteger(timeout) || timeout < 0) throw new Error('timeout must be a nonnegative integer');
  if (signal?.aborted) return Promise.resolve({ content: '[cancelled]', exit_code: 130, truncated: false });
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...(extraFD === undefined ? [] : [extraFD]), ...extraFDs] });
    const chunks = []; let size = 0; let truncated = false; let forced;
    const capture = chunk => {
      const remaining = 50 * 1024 - size;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) { const piece = chunk.subarray(0, remaining); chunks.push(piece); size += piece.length; }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const kill = code => {
      forced = code;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const abort = () => kill(130);
    const timer = timeout ? setTimeout(() => kill(124), timeout) : undefined;
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      let content = Buffer.concat(chunks).toString('utf8');
      const lines = content.split('\n');
      if (lines.length > 2000) { content = lines.slice(0, 2000).join('\n'); truncated = true; }
      if (truncated) content += '\n[truncated]';
      if (forced === 124) content += '\n[timeout: process group terminated]';
      if (forced === 130) content += '\n[cancelled]';
      resolve({ content, exit_code: forced ?? code ?? 128, truncated });
    });
  });
}

function socketFilterFD(scratchRoot) {
  // Classic seccomp BPF for the native x86-64 ABI, checked before syscall numbers.
  // Reject alternate ABIs, ptrace, io_uring (which could create sockets without
  // socket(2)), and socket(AF_UNIX). socketpair remains available for private IPC.
  if (process.platform !== 'linux' || process.arch !== 'x64') throw unavailable('only Linux x86-64 is supported');
  const deny = 0x00050001; // SECCOMP_RET_ERRNO | EPERM
  const rows = [[0x20, 0, 0, 4], [0x15, 1, 0, 0xc000003e], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x45, 0, 1, 0x40000000], [0x06, 0, 0, deny]];
  for (const nr of [101, 425, 426, 427]) rows.push([0x15, 0, 1, nr], [0x06, 0, 0, deny]);
  rows.push([0x15, 0, 3, 41], [0x20, 0, 0, 16], [0x15, 0, 1, 1], [0x06, 0, 0, deny], [0x06, 0, 0, 0x7fff0000]);
  const bytes = Buffer.alloc(rows.length * 8);
  rows.forEach(([code, jt, jf, k], i) => { bytes.writeUInt16LE(code, i * 8); bytes[i * 8 + 2] = jt; bytes[i * 8 + 3] = jf; bytes.writeUInt32LE(k, i * 8 + 4); });
  const dir = fs.mkdtempSync(path.join(scratchRoot, '.policy-'));
  const file = path.join(dir, 'seccomp.bpf');
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function gitMounts(directory, mounts) {
  // No host-side Git executable, hooks, or project-controlled executable is run.
  const meta = path.join(directory, '.git');
  if (!fs.existsSync(meta)) return;
  if (fs.lstatSync(meta).isSymbolicLink()) throw unavailable('symlinked .git is unsupported');
  mounts.add(meta);
  if (fs.statSync(meta).isFile()) {
    const match = /^gitdir: (.+)\s*$/.exec(fs.readFileSync(meta, 'utf8').trim());
    if (!match) throw unavailable('invalid worktree .git file');
    const target = fs.realpathSync(path.resolve(directory, match[1]));
    mounts.add(target);
    const common = path.join(target, 'commondir');
    if (fs.existsSync(common)) mounts.add(fs.realpathSync(path.resolve(target, fs.readFileSync(common, 'utf8').trim())));
  }
}
function gitTreeMounts(directory, mounts) {
  gitMounts(directory, mounts);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !['.git', '.opencode', '.agents', '.claude'].includes(entry.name)) gitTreeMounts(path.join(directory, entry.name), mounts);
  }
}

async function executeSandbox({ workspace, cwd, command, home = os.homedir(), scratchRoot = '/tmp/opencode/sandbox',
  bwrap = '/usr/bin/bwrap', env = process.env, readOnly = false, writablePaths = [], protectedPaths: extraProtected = [], maskedPaths = [], timeout, signal }) {
  if (typeof command !== 'string' || command.includes('\0')) throw unavailable('invalid command');
  workspace = realDir(workspace); home = realDir(home);
  cwd = cwd ? realDir(path.resolve(workspace, cwd)) : workspace;
  if (!inside(cwd, workspace)) throw unavailable('requested workdir is outside the trusted workspace');
  try { fs.accessSync(bwrap, fs.constants.X_OK); } catch { throw unavailable('bwrap is missing or not executable'); }
  if (!path.isAbsolute(bwrap)) throw unavailable('bwrap path must be absolute');
  const writable = !readOnly && !SPECIAL_ROOTS.has(workspace) && !inside(home, workspace);
  if (!Array.isArray(writablePaths)) throw unavailable('invalid planning roots');
  const requestedRoots = writablePaths.map(planningRoot);
  const narrow = readOnly && !SPECIAL_ROOTS.has(workspace) && !inside(home, workspace) && !inside(INSTALL_DIR, workspace) ? requestedRoots : [];
  const checkRoot = relative => {
    let current = workspace;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) throw unavailable('symlink in planning root'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if ([INSTALL_DIR, ...extraProtected].some(p => inside(current, p) || inside(p, current))) throw unavailable('planning root overlaps a protected path');
    return current;
  };
  const narrowTargets = narrow.map(checkRoot);
  // Never make the sandbox's own implementation writable.
  if (writable && inside(INSTALL_DIR, workspace)) throw unavailable('workspace contains the sandbox implementation');
  privateDir(scratchRoot);
  const hash = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
  const scratch = path.join(scratchRoot, hash);
  for (const dir of [scratch, ...['tmp', 'run', 'cache'].map(n => path.join(scratch, n))]) privateDir(dir);
  const lock = path.join(scratchRoot, hash + '.lock');
  let lockFD;
  try { lockFD = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
  catch { throw unavailable('workspace is busy or has a stale lock: ' + lock); }
  const placeholders = [];
  let filterFD;
  const narrowFDs = [];
  try {
    if (writable) {
      for (const [name, kind] of RESERVED) {
        const file = path.join(workspace, name);
        try {
          if (kind === 'dir') fs.mkdirSync(file, { mode: 0o555 });
          else fs.writeFileSync(file, '{}\n', { flag: 'wx', mode: 0o444 });
          const stat = fs.lstatSync(file);
          placeholders.push({ file, kind, ino: stat.ino, dev: stat.dev });
        } catch (e) { if (e.code !== 'EEXIST') throw e; }
        if (fs.lstatSync(file).isSymbolicLink()) throw unavailable('symlinked reserved configuration path: ' + name);
      }
    }
    const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/run', '--tmpfs', '/tmp', '--tmpfs', '/dev/shm'];
    if (!SPECIAL_ROOTS.has(workspace)) args.push(writable ? '--bind' : '--ro-bind', workspace, workspace);
    args.push('--bind', scratch, scratch);
    const narrowPosition = args.length;
    const protectedPaths = new Set();
    if (writable) {
      for (const name of RESERVED.keys()) protectedPaths.add(path.join(workspace, name));
      // Existing nested repositories must not expose writable Git metadata.
      gitTreeMounts(workspace, protectedPaths);
    }
    for (const value of [INSTALL_DIR, path.join(home, '.config/opencode'), path.join(home, '.cache/opencode')]) {
      if (fs.existsSync(value)) protectedPaths.add(value);
    }
    for (const value of extraProtected) if (fs.existsSync(value)) protectedPaths.add(fs.realpathSync(value));
    for (const value of protectedPaths) args.push('--ro-bind', value, value);
    const secrets = ['.ssh', '.aws', '.gnupg', '.config/gh', '.docker', '.kube', '.azure', '.config/gcloud',
      '.git-credentials', '.netrc', '.npmrc', '.pypirc', '.config/opencode/service.json',
      '.local/share/opencode', '.local/state/opencode', '.codex/auth.json', '.claude/.credentials.json', '.claude.json'];
    for (const value of [...secrets.map(n => path.join(home, n)), ...maskedPaths]) {
      if (!path.isAbsolute(value)) throw unavailable('mask path must be absolute');
      if (!fs.existsSync(value)) continue;
      const real = fs.realpathSync(value);
      if (fs.statSync(real).isDirectory()) args.push('--tmpfs', real, '--remount-ro', real);
      else args.push('--ro-bind', '/dev/null', real);
    }
    const childEnv = cleanEnvironment(env, home, scratch);
    if (narrowTargets.length) {
      // Create only validated output roots, inside a separate confined namespace.
      // No privileged host mkdir follows a project-controlled path.
      const preparation = [...args];
      const binding = preparation.findIndex((arg, i) => arg === '--ro-bind' && preparation[i + 1] === workspace);
      if (binding < 0) throw unavailable('planning workspace mount is unavailable');
      preparation[binding] = '--bind';
      const prepareFD = socketFilterFD(scratchRoot);
      try {
        const prepared = await runProcess(bwrap, [...preparation, '--seccomp', '3', '--chdir', workspace, '--', '/usr/bin/mkdir', '-p', '--', ...narrowTargets],
          { cwd: '/', env: childEnv, timeout: 10000, signal, extraFD: prepareFD });
        if (prepared.exit_code !== 0) throw unavailable('planning directory preparation failed: ' + prepared.content);
      } finally { fs.closeSync(prepareFD); }
      const mounts = [];
      for (let i = 0; i < narrowTargets.length; i++) {
        checkRoot(narrow[i]);
        const target = narrowTargets[i];
        const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        narrowFDs.push(fd);
        if (fs.realpathSync('/proc/self/fd/' + fd) !== target) throw unavailable('planning root changed during setup');
        mounts.push('--bind-fd', String(4 + i), target);
        const metadata = new Set(); gitTreeMounts(target, metadata);
        for (const meta of metadata) args.push('--ro-bind', meta, meta);
      }
      // Protected/credential mounts remain later and therefore authoritative.
      args.splice(narrowPosition, 0, ...mounts);
    }
    // Hide only our transient placeholders from Git's untracked-file listing.
    // The existing excludes file is read inside bwrap, never by a host process.
    // These scratch writes also occur inside bwrap, so symlinks cannot turn them
    // into privileged host-side writes.
    const bootstrap = `
original=$(git config --path --get core.excludesFile 2>/dev/null || :)
if [[ -z "$original" ]]; then original="$HOME/.config/git/ignore"; fi
if [[ -f "$original" ]]; then cat -- "$original" > "$OPENCODE_GIT_EXCLUDES"; else : > "$OPENCODE_GIT_EXCLUDES"; fi
printf '\\n%s\\n' "$OPENCODE_PLACEHOLDER_IGNORE" >> "$OPENCODE_GIT_EXCLUDES"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.excludesFile GIT_CONFIG_VALUE_0="$OPENCODE_GIT_EXCLUDES"
exec /bin/bash --noprofile --norc -c "$1"
`;
    childEnv.OPENCODE_GIT_EXCLUDES = path.join(scratch, 'run/git-excludes');
    childEnv.OPENCODE_PLACEHOLDER_IGNORE = placeholders.map(p => '/' + path.basename(p.file)).join('\n');
    filterFD = socketFilterFD(scratchRoot);
    args.push('--seccomp', '3', '--chdir', cwd, '--', '/bin/bash', '--noprofile', '--norc', '-c', bootstrap, 'opencode-sandbox', command);
    const result = await runProcess(bwrap, args, { cwd: '/', env: childEnv, timeout, signal, extraFD: filterFD, extraFDs: narrowFDs });
    return { ...result, scratch };
  } finally {
    if (filterFD !== undefined) fs.closeSync(filterFD);
    for (const fd of narrowFDs) fs.closeSync(fd);
    for (const { file, kind, ino, dev } of placeholders.reverse()) {
      try {
        const stat = fs.lstatSync(file);
        if (stat.ino !== ino || stat.dev !== dev) continue;
        if (kind === 'dir') fs.rmdirSync(file);
        else if (stat.isFile() && fs.readFileSync(file, 'utf8') === '{}\n') fs.unlinkSync(file);
      } catch { /* Preserve anything changed or replaced by another host process. */ }
    }
    fs.closeSync(lockFD); fs.unlinkSync(lock);
  }
}

export async function runSandbox(options) {
  const key = realDir(options.workspace);
  const previous = queues.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => executeSandbox(options));
  queues.set(key, pending);
  try { return await pending; }
  finally { if (queues.get(key) === pending) queues.delete(key); }
}
