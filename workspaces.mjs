import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inside } from './policy.mjs';

// Authority is persisted outside project files and model-mutable session metadata.
// Only session IDs and canonical approved directories are stored, never messages.
export function workspaceStore(directory) {
  function prepare() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let current = directory;
    while (current !== path.dirname(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe workspace approval directory');
      current = path.dirname(current);
    }
    const stat = fs.statSync(directory);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Workspace approvals must be private and owned by this user');
  }
  function file(sessionID) {
    if (typeof sessionID !== 'string' || !/^[\w-]{1,200}$/.test(sessionID)) throw new Error('Invalid workspace approval session ID');
    return path.join(directory, sessionID + '.json');
  }
  function read(sessionID) {
    prepare();
    const target = file(sessionID); let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 1024 * 1024) throw new Error('Unsafe workspace approval file');
      const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (record.schemaVersion !== 1 || record.sessionID !== sessionID || !Array.isArray(record.roots) || !record.roots.length
        || record.roots.some(root => typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || /[\0\r\n]/.test(root))) throw new Error('Invalid workspace approval record');
      return record.roots;
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function seed(sessionID, roots) {
    prepare(); const target = file(sessionID); let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, sessionID, roots }) + '\n');
      fs.fsyncSync(fd);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return read(sessionID);
  }
  function approve(sessionID, root) {
    prepare(); const target = file(sessionID), lock = target + '.lock';
    const lockFD = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const temporary = target + '.' + randomUUID();
    try {
      const roots = read(sessionID);
      if (!roots) throw new Error('Session workspace must be initialized before approval');
      if (!roots.includes(root)) roots.push(root);
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, sessionID, roots }) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true }); fs.closeSync(lockFD); fs.unlinkSync(lock);
    }
  }
  function select(roots, target) {
    return roots.filter(root => inside(target, root)).sort((a, b) => b.length - a.length)[0];
  }
  return { read, seed, approve, select };
}
