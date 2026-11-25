import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { planningRoot, privatePaths, policyPaths } from './policy.mjs';

export const INSTALL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SPECIAL_ROOTS = new Set(['/', '/tmp', '/run', '/dev/shm', '/dev', '/proc', '/sys']);
const RESERVED = new Map([['opencode.json', 'file'], ['opencode.jsonc', 'file'],
  ['.mcp.json', 'file'], ['.opencode', 'dir'], ['.agents', 'dir'], ['.claude', 'dir'], ['.git', 'dir']]);
const HEAD_BYTES = 10 * 1024;
const TAIL_BYTES = 40 * 1024;
const MAX_INLINE_LINES = 2000;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const RECENT_TAIL_BYTES = 4 * 1024;
const SAFE_ENV = new Set([
  'PATH', 'USER', 'LOGNAME', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'LANG', 'TZ',
  'VIRTUAL_ENV', 'RUSTUP_HOME', 'CARGO_HOME', 'GOPATH', 'NVM_DIR', 'FNM_DIR',
  'PYENV_ROOT', 'BUN_INSTALL', 'DENO_DIR', 'JAVA_HOME', 'DOTNET_ROOT',
]);

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
export function workspaceHash(workspace) {
  return createHash('sha256').update(realDir(workspace)).digest('hex').slice(0, 16);
}
function isSafeOwnedDir(dir) {
  if (!dir || !path.isAbsolute(dir) || /[\r\n\0]/.test(dir)) return false;
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o022));
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
  for (const [name, value] of Object.entries(source)) {
    if ((SAFE_ENV.has(name) || name.startsWith('LC_')) && !/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && typeof value === 'string') out[name] = value;
  }
  return { ...out, PATH: out.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home,
    SHELL: '/bin/bash', TMPDIR: path.join(scratch, 'tmp'), XDG_RUNTIME_DIR: path.join(scratch, 'run'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), npm_config_cache: path.join(scratch, 'cache/npm'),
    PIP_CACHE_DIR: path.join(scratch, 'cache/pip'), GOCACHE: path.join(scratch, 'cache/go-build'),
    YARN_CACHE_FOLDER: path.join(scratch, 'cache/yarn'),
    PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: path.join(scratch, 'cache/pycache'),
    RUFF_CACHE_DIR: path.join(scratch, 'cache/ruff'), MYPY_CACHE_DIR: path.join(scratch, 'cache/mypy'),
    GIT_OPTIONAL_LOCKS: '0' };
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}
function readPrivateJson(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return undefined; return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readLeases(leasesFile) {
  const data = readPrivateJson(leasesFile);
  if (!data || data.schemaVersion !== 1 || !data.leases || typeof data.leases !== 'object') return {};
  return data.leases;
}
function writeLeases(leasesFile, leases) {
  if (!Object.keys(leases).length) { fs.rmSync(leasesFile, { force: true }); return; }
  const tmp = leasesFile + '.tmp-' + randomUUID();
  try {
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, leases }) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, leasesFile);
  } finally { fs.rmSync(tmp, { force: true }); }
}
function removePlaceholderIfUnchanged({ file, kind, ino, dev }) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.ino !== ino || stat.dev !== dev) return;
    if (kind === 'dir') fs.rmdirSync(file);
    else if (stat.isFile() && fs.readFileSync(file, 'utf8') === '{}\n') fs.unlinkSync(file);
  } catch { /* Preserve anything changed or replaced by another host process. */ }
}
function pruneDeadLeases(leases) {
  const aliveFiles = new Set();
  const deadPlaceholders = [];
  for (const [id, entry] of Object.entries(leases)) {
    if (pidAlive(entry?.pid)) {
      for (const p of entry.placeholders ?? []) aliveFiles.add(p.file);
    } else {
      for (const p of entry?.placeholders ?? []) deadPlaceholders.push(p);
      delete leases[id];
    }
  }
  for (const p of deadPlaceholders.reverse()) {
    if (!aliveFiles.has(p.file)) removePlaceholderIfUnchanged(p);
  }
}
async function withCoordLock(scratchRoot, hash, fn) {
  const lock = path.join(scratchRoot, hash + '.coord.lock');
  const deadline = Date.now() + 5000;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + '\n'); }
      finally { fs.closeSync(fd); }
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw unavailable('cannot acquire workspace coordination lock: ' + error.message);
      let recovered = false;
      try {
        const stat = fs.lstatSync(lock);
        if (stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077)) {
          const parsed = readPrivateJson(lock);
          if (parsed === undefined) { recovered = true; }
          else if (parsed && !pidAlive(parsed.pid)) { fs.unlinkSync(lock); recovered = true; }
          else if (parsed === null && Date.now() - stat.mtimeMs > 250) { fs.unlinkSync(lock); recovered = true; }
        }
      } catch { /* Another process may have already released it. */ }
      if (recovered) continue;
      if (Date.now() >= deadline) throw unavailable('workspace coordination lock busy: ' + lock);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await fn(); }
  finally { try { fs.unlinkSync(lock); } catch { /* ignore */ } }
}

export function activePlaceholders(workspace, scratchRoot = '/tmp/opencode/sandbox') {
  try {
    const hash = workspaceHash(workspace);
    const leases = readLeases(path.join(scratchRoot, hash + '.leases.json'));
    const out = new Set();
    for (const entry of Object.values(leases)) {
      if (!pidAlive(entry?.pid)) continue;
      for (const p of entry.placeholders ?? []) out.add(p.file);
    }
    return [...out];
  } catch { return []; }
}

export function inspectScratchHealth(scratchRoot = '/tmp/opencode/sandbox') {
  const stat = fs.lstatSync(scratchRoot, { throwIfNoEntry: false });
  if (!stat) {
    return { ok: true, staleLocks: 0, staleLeases: 0, activeLeases: 0, detail: 'scratch directory not yet created' };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    return { ok: false, staleLocks: 0, staleLeases: 0, activeLeases: 0, detail: 'unsafe scratch directory ownership, mode, or symlink: ' + scratchRoot };
  }
  let staleLocks = 0, staleLeases = 0, activeLeases = 0;
  for (const entry of fs.readdirSync(scratchRoot, { withFileTypes: true })) {
    const full = path.join(scratchRoot, entry.name);
    if (entry.name.endsWith('.coord.lock')) {
      const data = readPrivateJson(full);
      if (!data || !pidAlive(data.pid)) staleLocks++;
    } else if (entry.name.endsWith('.lock')) {
      staleLocks++;
    } else if (entry.name.endsWith('.leases.json')) {
      for (const lease of Object.values(readLeases(full))) {
        if (pidAlive(lease?.pid)) activeLeases++; else staleLeases++;
      }
    }
  }
  const parts = [];
  if (activeLeases) parts.push(`${activeLeases} active lease(s)`);
  if (staleLocks) parts.push(`${staleLocks} stale lock(s)`);
  if (staleLeases) parts.push(`${staleLeases} stale lease(s)`);
  const detail = parts.length
    ? parts.join(', ') + (staleLocks || staleLeases ? ' (will self-recover on next sandbox_shell)' : '')
    : 'clean';
  return { ok: true, staleLocks, staleLeases, activeLeases, detail };
}

export function pruneWorkspaceLogs(logDir, activePaths = new Set(), limit = 32, keepPath = null) {
  try {
    const files = fs.readdirSync(logDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.log'))
      .map(e => { const full = path.join(logDir, e.name); return { full, mtime: fs.lstatSync(full).mtimeMs }; });
    const removable = files
      .filter(item => !activePaths.has(item.full) && item.full !== keepPath)
      .sort((a, b) => a.mtime - b.mtime || a.full.localeCompare(b.full));
    const maxRemovable = Math.max(0, limit - (keepPath && files.some(f => f.full === keepPath) ? 1 : 0));
    while (removable.length > maxRemovable) {
      const oldest = removable.shift();
      try { fs.unlinkSync(oldest.full); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function countNewlines(buf) {
  let count = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
  return count;
}

const FAILURE_LINE = /(?:^|[\s:[({])(?:FAIL(?:ED|URE)?|ERROR|FATAL|PANIC|AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|Exception|Traceback \(most recent call last\)|error\[E\d+\]|error TS\d+|npm ERR!|✖|✗|not ok \d+)/i;
const MAX_FAILURE_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_FAILURE_LINES = 25;
const MAX_FAILURE_BYTES = 3500;

function extractFailureLines(candidateLines, inlineLines) {
  const inlineSet = new Set(inlineLines.map(line => line.trim()).filter(Boolean));
  const seen = new Set();
  const picked = [];
  let bytes = 0;
  for (const raw of candidateLines) {
    const trimmed = raw.trim();
    if (!trimmed || inlineSet.has(trimmed) || seen.has(trimmed)) continue;
    if (!FAILURE_LINE.test(trimmed)) continue;
    seen.add(trimmed);
    const clipped = trimmed.length > 240 ? trimmed.slice(0, 237) + '...' : trimmed;
    const cost = Buffer.byteLength(clipped, 'utf8') + 1;
    if (bytes + cost > MAX_FAILURE_BYTES) break;
    picked.push(clipped);
    bytes += cost;
    if (picked.length >= MAX_FAILURE_LINES) break;
  }
  return picked;
}

function readMiddleLogLines(logPath, headBytes, tailBytes, totalBytes) {
  if (!logPath || totalBytes <= headBytes + tailBytes) return [];
  const start = headBytes;
  const available = Math.max(0, totalBytes - headBytes - tailBytes);
  const length = Math.min(available, MAX_FAILURE_SCAN_BYTES);
  if (length <= 0) return [];
  let fd;
  try {
    fd = fs.openSync(logPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString('utf8').split('\n');
  } catch { return []; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

export function spawnProcess(file, args, {
  cwd, env = process.env, timeout = 120000, signal, extraFD, extraFDs = [],
  logFile, spillLog, maxLogBytes = MAX_LOG_BYTES,
} = {}) {
  if (!Number.isSafeInteger(timeout) || timeout < 0) throw new Error('timeout must be a nonnegative integer');
  let activeLogPath = logFile;
  let logFD;
  let logBytes = 0;
  let logCapped = false;
  const openLog = target => {
    logFD = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    activeLogPath = target;
  };
  const writeLog = buf => {
    if (logFD === undefined || !buf.length || logCapped) return;
    const remaining = maxLogBytes - logBytes;
    if (remaining <= 0) {
      logCapped = true;
      const notice = Buffer.from('\n[log truncated at 10 MiB]\n');
      try { fs.writeSync(logFD, notice); } catch { /* ignore */ }
      return;
    }
    const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
    try { fs.writeSync(logFD, slice); } catch { /* ignore */ }
    logBytes += slice.length;
    if (buf.length > remaining) {
      logCapped = true;
      const notice = Buffer.from('\n[log truncated at 10 MiB]\n');
      try { fs.writeSync(logFD, notice); } catch { /* ignore */ }
    }
  };
  if (activeLogPath) openLog(activeLogPath);
  if (signal?.aborted) {
    if (logFD !== undefined) { fs.closeSync(logFD); logFD = undefined; }
    return {
      child: null,
      kill: () => {},
      tail: () => '',
      logPath: () => activeLogPath,
      logBytes: () => logBytes,
      done: Promise.resolve({ content: '[cancelled]', exit_code: 130, truncated: false, ...(activeLogPath ? { log_path: activeLogPath } : {}) }),
    };
  }
  const child = spawn(file, args, {
    cwd, env, detached: true,
    stdio: ['ignore', 'pipe', 'pipe', ...(extraFD === undefined ? [] : [extraFD]), ...extraFDs],
  });
  const head = Buffer.allocUnsafe(HEAD_BYTES);
  const tail = Buffer.allocUnsafe(TAIL_BYTES);
  const recent = Buffer.allocUnsafe(RECENT_TAIL_BYTES);
  let headSize = 0, tailSize = 0, tailOffset = 0, recentSize = 0, recentOffset = 0;
  let lineCount = 1, byteTruncated = false, forced;
  const appendRecent = chunk => {
    if (chunk.length >= recent.length) {
      chunk.copy(recent, 0, chunk.length - recent.length);
      recentSize = recent.length; recentOffset = 0;
    } else {
      const copied = chunk.copy(recent, recentOffset);
      if (copied < chunk.length) chunk.copy(recent, 0, copied);
      recentOffset = (recentOffset + chunk.length) % recent.length;
      recentSize = Math.min(recentSize + chunk.length, recent.length);
    }
  };
  const capture = chunk => {
    appendRecent(chunk);
    const nextLines = lineCount + countNewlines(chunk);
    const willByteTruncate = byteTruncated || (headSize + tailSize + chunk.length > HEAD_BYTES + TAIL_BYTES);
    if (logFD === undefined && spillLog && (willByteTruncate || nextLines > MAX_INLINE_LINES)) {
      try {
        openLog(spillLog());
        if (headSize > 0) writeLog(head.subarray(0, headSize));
        if (tailSize > 0) writeLog(tail.subarray(0, tailSize));
      } catch { /* Best effort; inline truncation still applies. */ }
    }
    if (logFD !== undefined) writeLog(chunk);
    lineCount = nextLines;
    const opening = chunk.copy(head, headSize);
    headSize += opening;
    const rest = chunk.subarray(opening);
    if (rest.length === 0) return;
    byteTruncated ||= tailSize + rest.length > tail.length;
    tailSize = Math.min(tailSize + rest.length, tail.length);
    if (rest.length >= tail.length) {
      rest.copy(tail, 0, rest.length - tail.length);
      tailOffset = 0;
    } else {
      const copied = rest.copy(tail, tailOffset);
      if (copied < rest.length) rest.copy(tail, 0, copied);
      tailOffset = (tailOffset + rest.length) % tail.length;
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const kill = code => {
    if (forced === undefined) forced = code;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  };
  const abort = () => kill(130);
  const timer = timeout ? setTimeout(() => kill(124), timeout) : undefined;
  signal?.addEventListener('abort', abort, { once: true });
  const closeLog = () => { if (logFD !== undefined) { try { fs.closeSync(logFD); } catch { /* ignore */ } logFD = undefined; } };
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); closeLog(); };
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      const opening = head.subarray(0, headSize);
      const ending = byteTruncated
        ? Buffer.concat([tail.subarray(tailOffset), tail.subarray(0, tailOffset)])
        : tail.subarray(0, tailSize);
      const lines = byteTruncated ? null : Buffer.concat([opening, ending]).toString('utf8').split('\n');
      const truncated = byteTruncated || lines.length > MAX_INLINE_LINES;
      const exitCode = forced ?? code ?? 128;
      let content;
      if (truncated) {
        const headLines = (lines ?? opening.toString('utf8').split('\n')).slice(0, 400);
        const tailLines = (lines ?? ending.toString('utf8').split('\n')).slice(-1599);
        let marker = '[truncated]';
        if (exitCode !== 0 && exitCode !== 130) {
          const middleLines = lines
            ? lines.slice(400, -1599)
            : readMiddleLogLines(activeLogPath, headSize, tailSize, logBytes);
          const failures = extractFailureLines(middleLines, [...headLines, ...tailLines]);
          if (failures.length) {
            marker = ['[truncated — key failure lines from omitted middle:]', ...failures, '[end key failure lines]'].join('\n');
          }
        }
        content = [...headLines, marker, ...tailLines].join('\n');
      } else {
        content = lines.join('\n');
      }
      if (forced === 124) content += '\n[timeout: process group terminated]';
      if (forced === 130) content += '\n[cancelled]';
      resolve({ content, exit_code: exitCode, truncated, ...(activeLogPath ? { log_path: activeLogPath } : {}) });
    });
  });
  const readRecentTail = () => {
    if (recentSize === 0) return '';
    const buf = recentSize < recent.length
      ? recent.subarray(0, recentSize)
      : Buffer.concat([recent.subarray(recentOffset), recent.subarray(0, recentOffset)]);
    return buf.toString('utf8');
  };
  return { child, kill, tail: readRecentTail, logPath: () => activeLogPath, logBytes: () => logBytes, done };
}

export function runProcess(file, args, options = {}) {
  return spawnProcess(file, args, options).done;
}

function socketFilterFD(scratchRoot) {
  // Classic seccomp BPF for the native x86-64 ABI, checked before syscall numbers.
  // Reject alternate ABIs, ptrace, io_uring (which could create sockets without
  // socket(2)), and socket(AF_UNIX). Only private stream socketpairs remain;
  // datagram/seqpacket endpoints can address unrelated filesystem sockets.
  if (process.platform !== 'linux' || process.arch !== 'x64') throw unavailable('only Linux x86-64 is supported');
  const deny = 0x00050001; // SECCOMP_RET_ERRNO | EPERM
  const rows = [[0x20, 0, 0, 4], [0x15, 1, 0, 0xc000003e], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x45, 0, 1, 0x40000000], [0x06, 0, 0, deny]];
  for (const nr of [101, 425, 426, 427]) rows.push([0x15, 0, 1, nr], [0x06, 0, 0, deny]);
  rows.push([0x15, 0, 3, 41], [0x20, 0, 0, 16], [0x15, 0, 1, 1], [0x06, 0, 0, deny]);
  // Reload nr after inspecting socket's domain. Mask SOCK_CLOEXEC/NONBLOCK.
  rows.push([0x20, 0, 0, 0], [0x15, 0, 4, 53], [0x20, 0, 0, 24], [0x54, 0, 0, 0xf],
    [0x15, 1, 0, 1], [0x06, 0, 0, deny], [0x06, 0, 0, 0x7fff0000]);
  const bytes = Buffer.alloc(rows.length * 8);
  rows.forEach(([code, jt, jf, k], i) => { bytes.writeUInt16LE(code, i * 8); bytes[i * 8 + 2] = jt; bytes[i * 8 + 3] = jf; bytes.writeUInt32LE(k, i * 8 + 4); });
  const dir = fs.mkdtempSync(path.join(scratchRoot, '.policy-'));
  const file = path.join(dir, 'seccomp.bpf');
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function addGitWorktreeMounts(directory, meta, mounts) {
  // No host-side Git executable, hooks, or project-controlled executable is run.
  if (fs.statSync(meta).isFile()) {
    const match = /^gitdir: (.+)\s*$/.exec(fs.readFileSync(meta, 'utf8').trim());
    if (!match) throw unavailable('invalid worktree .git file');
    const target = fs.realpathSync(path.resolve(directory, match[1]));
    mounts.add(target);
    const common = path.join(target, 'commondir');
    if (fs.existsSync(common)) mounts.add(fs.realpathSync(path.resolve(target, fs.readFileSync(common, 'utf8').trim())));
  }
}

async function scanTree(rootDir, mounts, placeholderDirs, workspace, cwd, concurrency = 16) {
  const queue = [rootDir];
  let active = 0;
  let failure = null;
  await new Promise((resolve, reject) => {
    const finish = err => {
      if (err && !failure) { failure = err; reject(err); }
      else if (!failure && active === 0 && queue.length === 0) resolve();
    };
    const pump = () => {
      while (!failure && active < concurrency && queue.length > 0) {
        const directory = queue.shift();
        active++;
        (async () => {
          let entries;
          try {
            entries = await fs.promises.readdir(directory, { withFileTypes: true });
          } catch (err) {
            if (directory !== rootDir && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return;
            throw err;
          }
          let hasReserved = false;
          for (const entry of entries) {
            if (RESERVED.has(entry.name)) {
              hasReserved = true;
              const file = path.join(directory, entry.name);
              let isLink = entry.isSymbolicLink();
              if (!isLink && !entry.isFile() && !entry.isDirectory()) {
                try { isLink = (await fs.promises.lstat(file)).isSymbolicLink(); }
                catch (err) { if (err.code === 'ENOENT') continue; throw err; }
              }
              if (isLink) {
                throw unavailable(entry.name === '.git' ? 'symlinked .git is unsupported' : 'symlinked reserved configuration path: ' + file);
              }
              mounts.add(file);
              if (entry.name === '.git') addGitWorktreeMounts(directory, file, mounts);
            } else if (entry.isDirectory()) {
              queue.push(path.join(directory, entry.name));
            }
          }
          if (placeholderDirs && (directory === workspace || directory === cwd || hasReserved)) {
            placeholderDirs.add(directory);
          }
        })().then(
          () => { active--; pump(); finish(); },
          err => { active--; finish(err); },
        );
      }
    };
    pump();
  });
}

export async function spawnSandbox({
  workspace, cwd, command, home = os.homedir(), scratchRoot = '/tmp/opencode/sandbox', nativeTempRoot,
  bwrap = '/usr/bin/bwrap', env = process.env, readOnly = false, writablePaths = [],
  protectedPaths: extraProtected = [], maskedPaths = [], timeout = 120000, signal,
  logFile, eagerLog = false, pruneLogs = true, activeLogPaths,
}) {
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
  const realScratchRoot = fs.realpathSync(scratchRoot);
  if (inside(workspace, realScratchRoot)) throw unavailable('workspace cannot be inside scratchRoot');
  const hash = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
  const scratch = path.join(realScratchRoot, hash);
  const logDir = path.join(realScratchRoot, hash + '.logs');
  const leasesFile = path.join(realScratchRoot, hash + '.leases.json');
  for (const dir of [scratch, logDir, ...['tmp', 'run', 'cache'].map(n => path.join(scratch, n))]) privateDir(dir);

  const leaseId = randomUUID();
  let leaseAcquired = false;
  let filterFD;
  const narrowFDs = [];
  let placeholderPaths = [];

  const releaseLease = async () => {
    if (!leaseAcquired) return;
    leaseAcquired = false;
    await withCoordLock(realScratchRoot, hash, async () => {
      const leases = readLeases(leasesFile);
      const mine = leases[leaseId]?.placeholders ?? [];
      delete leases[leaseId];
      pruneDeadLeases(leases);
      const stillReferenced = new Set();
      for (const entry of Object.values(leases)) {
        for (const p of entry.placeholders ?? []) stillReferenced.add(p.file);
      }
      for (const p of [...mine].reverse()) {
        if (!stillReferenced.has(p.file)) removePlaceholderIfUnchanged(p);
      }
      writeLeases(leasesFile, leases);
    });
  };
  const closeSetupFDs = () => {
    if (filterFD !== undefined) { try { fs.closeSync(filterFD); } catch { /* ignore */ } filterFD = undefined; }
    while (narrowFDs.length) { try { fs.closeSync(narrowFDs.pop()); } catch { /* ignore */ } }
  };

  try {
    const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/run', '--tmpfs', '/tmp', '--tmpfs', '/dev/shm'];
    if (!SPECIAL_ROOTS.has(workspace)) args.push(writable ? '--bind' : '--ro-bind', workspace, workspace);

    // Optional safe /tmp/opencode bridge (host /tmp remains isolated via --tmpfs /tmp).
    if (nativeTempRoot && isSafeOwnedDir(nativeTempRoot)) {
      const realTemp = fs.realpathSync(nativeTempRoot);
      if (realTemp !== realScratchRoot && !inside(workspace, realTemp)) {
        args.push(writable ? '--bind' : '--ro-bind', realTemp, realTemp);
      }
    }
    // Mask host-trusted coordination state (locks, leases, logs, sibling scratches),
    // while exposing only this workspace's private scratch directory.
    args.push('--tmpfs', realScratchRoot, '--bind', scratch, scratch, '--remount-ro', realScratchRoot);

    const narrowPosition = args.length;
    const protectedPaths = new Set();

    if (writable) {
      const placeholderDirs = new Set([workspace, cwd]);
      await scanTree(workspace, protectedPaths, placeholderDirs, workspace, cwd);
      await withCoordLock(realScratchRoot, hash, async () => {
        const legacyLock = path.join(realScratchRoot, hash + '.lock');
        try {
          const st = fs.lstatSync(legacyLock);
          if (st.isFile() && st.uid === process.getuid() && st.size === 0) fs.unlinkSync(legacyLock);
        } catch { /* ignore */ }
        const leases = readLeases(leasesFile);
        pruneDeadLeases(leases);
        const livePlaceholders = new Map();
        for (const entry of Object.values(leases)) {
          for (const p of entry.placeholders ?? []) livePlaceholders.set(p.file, p);
        }
        const mine = [];
        for (const directory of placeholderDirs) {
          for (const [name, kind] of RESERVED) {
            if (name === '.git' && directory !== workspace) continue;
            const file = path.join(directory, name);
            const tracked = livePlaceholders.get(file);
            if (tracked) {
              const st = fs.lstatSync(file, { throwIfNoEntry: false });
              if (st && st.ino === tracked.ino && st.dev === tracked.dev) {
                mine.push(tracked);
                protectedPaths.add(file);
                continue;
              }
            }
            try {
              if (kind === 'dir') fs.mkdirSync(file, { mode: 0o555 });
              else fs.writeFileSync(file, '{}\n', { flag: 'wx', mode: 0o444 });
              const st = fs.lstatSync(file);
              const record = { file, kind, ino: st.ino, dev: st.dev };
              mine.push(record);
              livePlaceholders.set(file, record);
              protectedPaths.add(file);
            } catch (e) {
              if (e.code !== 'EEXIST') throw e;
              if (fs.lstatSync(file).isSymbolicLink()) throw unavailable('symlinked reserved configuration path: ' + file);
              protectedPaths.add(file);
            }
          }
        }
        leases[leaseId] = { pid: process.pid, createdAt: Date.now(), placeholders: mine };
        writeLeases(leasesFile, leases);
        leaseAcquired = true;
        placeholderPaths = mine.map(p => p.file);
      });
    } else {
      // Read-only / planner invocations do not block on writers; still ignore
      // any live writer placeholders in git status.
      placeholderPaths = activePlaceholders(workspace, realScratchRoot);
    }

    for (const value of [INSTALL_DIR, policyPaths(home, env).cacheDir, path.join(home, '.config/opencode'), path.join(home, '.cache/opencode')]) {
      if (fs.existsSync(value)) protectedPaths.add(value);
    }
    for (const value of extraProtected) if (fs.existsSync(value)) protectedPaths.add(fs.realpathSync(value));
    for (const value of protectedPaths) args.push('--ro-bind', value, value);
    for (const value of [...new Set([...privatePaths(home, env), ...maskedPaths])].sort((a, b) => a.length - b.length)) {
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
      const prepareFD = socketFilterFD(realScratchRoot);
      try {
        const prepared = await runProcess(bwrap, [...preparation, '--seccomp', '3', '--chdir', workspace, '--', '/usr/bin/mkdir', '-p', '--', ...narrowTargets],
          { cwd: '/', env: childEnv, timeout: 10000, signal, extraFD: prepareFD });
        if (prepared.exit_code !== 0) throw unavailable('planning directory preparation failed: ' + prepared.content);
      } finally { fs.closeSync(prepareFD); }
      const mounts = [];
      const plannerMeta = new Set();
      for (let i = 0; i < narrowTargets.length; i++) {
        checkRoot(narrow[i]);
        const target = narrowTargets[i];
        const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        narrowFDs.push(fd);
        if (fs.realpathSync('/proc/self/fd/' + fd) !== target) throw unavailable('planning root changed during setup');
        mounts.push('--bind-fd', String(4 + i), target);
        await scanTree(target, plannerMeta, null, workspace, cwd);
      }
      if (plannerMeta.size) {
        await withCoordLock(realScratchRoot, hash, async () => {
          const leases = readLeases(leasesFile);
          pruneDeadLeases(leases);
          const livePlaceholders = new Map();
          for (const entry of Object.values(leases)) {
            for (const p of entry.placeholders ?? []) livePlaceholders.set(p.file, p);
          }
          const shared = [];
          for (const meta of plannerMeta) {
            const st = fs.lstatSync(meta, { throwIfNoEntry: false });
            if (!st) continue;
            const tracked = livePlaceholders.get(meta);
            if (tracked && st.ino === tracked.ino && st.dev === tracked.dev) shared.push(tracked);
            args.push('--ro-bind', meta, meta);
          }
          if (shared.length) {
            leases[leaseId] = { pid: process.pid, createdAt: Date.now(), placeholders: shared };
            writeLeases(leasesFile, leases);
            leaseAcquired = true;
          }
        });
      }
      // Protected/credential mounts remain later and therefore authoritative.
      args.splice(narrowPosition, 0, ...mounts);
    }

    // Hide transient placeholders from Git's untracked-file listing inside each
    // invocation's private ephemeral /tmp so concurrent runs never collide.
    const bootstrap = `
original=$(git config --path --get core.excludesFile 2>/dev/null || :)
if [[ -z "$original" ]]; then original="$HOME/.config/git/ignore"; fi
if [[ -f "$original" ]]; then cat -- "$original" > "$OPENCODE_GIT_EXCLUDES"; else : > "$OPENCODE_GIT_EXCLUDES"; fi
if [[ -n "$OPENCODE_PLACEHOLDER_IGNORE" ]]; then printf '\\n%s\\n' "$OPENCODE_PLACEHOLDER_IGNORE" >> "$OPENCODE_GIT_EXCLUDES"; fi
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.excludesFile GIT_CONFIG_VALUE_0="$OPENCODE_GIT_EXCLUDES"
exec /bin/bash --noprofile --norc -c "$1"
`;
    childEnv.OPENCODE_GIT_EXCLUDES = '/tmp/.opencode-git-excludes';
    childEnv.OPENCODE_PLACEHOLDER_IGNORE = placeholderPaths
      .filter(file => inside(file, workspace))
      .map(file => '/' + path.relative(workspace, file).split(path.sep).join('/'))
      .join('\n');

    filterFD = socketFilterFD(realScratchRoot);
    args.push('--seccomp', '3', '--chdir', cwd, '--', '/bin/bash', '--noprofile', '--norc', '-c', bootstrap, 'opencode-sandbox', command);

    const makeLogPath = () => path.join(logDir, `${Date.now()}-${leaseId.slice(0, 8)}.log`);
    const resolvedLogFile = logFile ?? (eagerLog ? makeLogPath() : undefined);
    const proc = spawnProcess(bwrap, args, {
      cwd: '/', env: childEnv, timeout, signal, extraFD: filterFD, extraFDs: narrowFDs,
      logFile: resolvedLogFile,
      spillLog: resolvedLogFile ? undefined : makeLogPath,
    });
    // Child process has inherited filterFD and narrowFDs; close parent copies now.
    closeSetupFDs();

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await releaseLease();
    };
    const done = proc.done.then(
      async result => {
        if (pruneLogs && result.log_path) {
          const active = typeof activeLogPaths === 'function' ? activeLogPaths(logDir) : (activeLogPaths ?? new Set());
          pruneWorkspaceLogs(logDir, active, 32, result.log_path);
        }
        return { ...result, scratch };
      },
      async error => {
        await release();
        throw error;
      },
    );
    return {
      child: proc.child,
      kill: proc.kill,
      tail: proc.tail,
      logPath: proc.logPath,
      logBytes: proc.logBytes,
      scratch,
      logDir,
      workspace,
      cwd,
      done,
      release,
    };
  } catch (error) {
    closeSetupFDs();
    await releaseLease();
    throw error;
  }
}

export async function runSandbox(options) {
  const handle = await spawnSandbox(options);
  try { return await handle.done; }
  finally { await handle.release(); }
}
