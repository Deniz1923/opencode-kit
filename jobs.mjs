import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSandbox, pruneWorkspaceLogs } from './sandbox.mjs';

const DEFAULT_BG_TIMEOUT = 600000;
const MAX_BG_TIMEOUT = 1800000;
const MAX_WAIT_MS = 60000;

function commandPreview(command) {
  const clean = String(command ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? clean.slice(0, 117) + '...' : clean;
}

export function createJobManager({
  maxPerWorkspace = 8,
  maxGlobal = 16,
  maxCompletedPerSession = 32,
  graceMs = 1000,
  defaultBackgroundTimeout = DEFAULT_BG_TIMEOUT,
  maxBackgroundTimeout = MAX_BG_TIMEOUT,
} = {}) {
  const jobs = new Map();
  const inFlight = new Set();
  let startingGlobal = 0;
  const startingByWorkspace = new Map();
  let closed = false;

  const activeJobs = () => [...jobs.values()].filter(j => j.status === 'running');
  const activeLogPaths = logDir => {
    const set = new Set();
    for (const j of activeJobs()) if (j.logDir === logDir && j.logPath) set.add(j.logPath);
    for (const f of inFlight) if (f.logDir === logDir && f.logPath) set.add(f.logPath);
    return set;
  };

  function requireOwned(sessionID, jobID) {
    const job = jobs.get(jobID);
    if (!job || job.sessionID !== sessionID) throw new Error('Sandbox job not found: ' + jobID);
    return job;
  }

  function pruneCompleted(sessionID) {
    const completed = [...jobs.values()]
      .filter(j => j.sessionID === sessionID && j.status !== 'running')
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    while (completed.length > maxCompletedPerSession) {
      const oldest = completed.shift();
      jobs.delete(oldest.id);
    }
  }

  function snapshot(job, { includeFull = false } = {}) {
    const end = job.endedAt ?? Date.now();
    const base = {
      job_id: job.id,
      status: job.status,
      command: job.command,
      workspace: job.workspace,
      cwd: job.cwd,
      elapsed_ms: Math.max(0, end - job.startedAt),
      log_path: job.logPath,
      log_bytes: job.handle.logBytes(),
    };
    if (job.status === 'running') {
      return { ...base, tail: job.handle.tail() };
    }
    return {
      ...base,
      exit_code: job.result?.exit_code ?? (job.status === 'cancelled' ? 130 : 128),
      truncated: Boolean(job.result?.truncated),
      content: includeFull ? (job.result?.content ?? '') : undefined,
      tail: job.handle.tail(),
    };
  }

  async function start(options) {
    if (closed) throw new Error('Sandbox job manager is closed');
    const { sessionID, timeout, signal } = options;
    if (typeof sessionID !== 'string' || !sessionID) throw new Error('sessionID is required for background jobs');
    const effectiveTimeout = timeout === undefined ? defaultBackgroundTimeout : timeout;
    if (!Number.isSafeInteger(effectiveTimeout) || effectiveTimeout <= 0 || effectiveTimeout > maxBackgroundTimeout) {
      throw new Error(`Background job timeout must be an integer between 1 and ${maxBackgroundTimeout} ms`);
    }
    const workspaceKey = fs.realpathSync(options.workspace);
    const active = activeJobs();
    if (active.length + startingGlobal >= maxGlobal) {
      throw new Error(`Too many active background jobs (limit ${maxGlobal}); wait for or cancel an existing job first.`);
    }
    const wsActive = active.filter(j => j.workspace === workspaceKey).length + (startingByWorkspace.get(workspaceKey) ?? 0);
    if (wsActive >= maxPerWorkspace) {
      throw new Error(`Too many active background jobs in this workspace (limit ${maxPerWorkspace}); wait for or cancel an existing job first.`);
    }

    startingGlobal++;
    startingByWorkspace.set(workspaceKey, (startingByWorkspace.get(workspaceKey) ?? 0) + 1);
    const flightController = new AbortController();
    let resolveFlight;
    const flight = {
      sessionID,
      logDir: null,
      logPath: null,
      abort: () => flightController.abort(),
      done: new Promise(resolve => { resolveFlight = resolve; }),
    };
    inFlight.add(flight);

    const releaseReservation = () => {
      startingGlobal--;
      const next = (startingByWorkspace.get(workspaceKey) ?? 1) - 1;
      if (next <= 0) startingByWorkspace.delete(workspaceKey); else startingByWorkspace.set(workspaceKey, next);
      inFlight.delete(flight);
      resolveFlight();
    };

    try {
      if (closed || flightController.signal.aborted || signal?.aborted) {
        return { background: false, result: { content: '[cancelled]', exit_code: 130, truncated: false } };
      }
      const handle = await spawnSandbox({
        ...options,
        timeout: effectiveTimeout,
        signal: undefined,
        eagerLog: true,
        pruneLogs: false,
      });
      flight.logDir = handle.logDir;
      flight.logPath = handle.logPath();

      const startedAt = Date.now();
      const id = 'job_' + randomUUID().slice(0, 8);
      let finishedResult = null;
      let finishedError = null;
      let abortedDuringGrace = false;
      let registeredJob = null;

      const settled = handle.done.then(
        async result => {
          finishedResult = result;
          await handle.release().catch(() => {});
          if (registeredJob) {
            registeredJob.endedAt = Date.now();
            registeredJob.result = result;
            registeredJob.status = registeredJob.cancelled
              ? 'cancelled'
              : result.exit_code === 124
                ? 'timed_out'
                : 'exited';
            pruneWorkspaceLogs(handle.logDir, activeLogPaths(handle.logDir), 32, result.log_path);
            pruneCompleted(sessionID);
          }
          return result;
        },
        async error => {
          finishedError = error;
          await handle.release().catch(() => {});
          if (registeredJob) {
            registeredJob.endedAt = Date.now();
            registeredJob.status = registeredJob.cancelled ? 'cancelled' : 'exited';
            registeredJob.result = { content: error.message, exit_code: 125, truncated: false, log_path: handle.logPath() };
            pruneCompleted(sessionID);
          }
          return null;
        },
      );

      const onGraceAbort = () => {
        abortedDuringGrace = true;
        handle.kill(130);
      };
      if (closed || flightController.signal.aborted || signal?.aborted) {
        onGraceAbort();
      }
      signal?.addEventListener('abort', onGraceAbort, { once: true });
      flightController.signal.addEventListener('abort', onGraceAbort, { once: true });
      let graceTimer;
      const gracePromise = new Promise(resolve => { graceTimer = setTimeout(() => resolve('grace'), graceMs); });
      const winner = abortedDuringGrace ? 'abort' : await Promise.race([settled.then(() => 'done'), gracePromise]);
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onGraceAbort);
      flightController.signal.removeEventListener('abort', onGraceAbort);

      if (winner === 'done' || abortedDuringGrace || closed || flightController.signal.aborted || signal?.aborted) {
        if (winner !== 'done') {
          handle.kill(130);
          await settled;
        }
        if (finishedError) throw finishedError;
        const result = { ...finishedResult };
        if (!result.truncated && result.log_path) {
          try { fs.unlinkSync(result.log_path); } catch { /* ignore */ }
          delete result.log_path;
        } else if (result.log_path) {
          pruneWorkspaceLogs(handle.logDir, activeLogPaths(handle.logDir), 32, result.log_path);
        }
        return { background: false, result };
      }

      const job = {
        id,
        sessionID,
        command: commandPreview(options.command),
        workspace: handle.workspace,
        cwd: handle.cwd,
        logDir: handle.logDir,
        logPath: handle.logPath(),
        startedAt,
        endedAt: null,
        status: 'running',
        cancelled: false,
        reported: false,
        access: options.access,
        result: null,
        handle,
        settled,
      };
      registeredJob = job;
      jobs.set(id, job);

      if (finishedResult || finishedError) {
        await settled;
        if (!job.endedAt) {
          job.endedAt = Date.now();
          job.result = finishedResult ?? { content: finishedError.message, exit_code: 125, truncated: false, log_path: job.logPath };
          job.status = job.result.exit_code === 124 ? 'timed_out' : 'exited';
        }
        pruneWorkspaceLogs(handle.logDir, activeLogPaths(handle.logDir), 32, job.logPath);
        pruneCompleted(sessionID);
      }

      return {
        background: true,
        job_id: id,
        status: job.status,
        log_path: job.logPath,
        workspace: job.workspace,
        cwd: job.cwd,
        command: job.command,
      };
    } finally {
      releaseReservation();
    }
  }

  function list(sessionID) {
    return [...jobs.values()]
      .filter(j => j.sessionID === sessionID)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(j => ({
        job_id: j.id,
        status: j.status,
        exit_code: j.status === 'running' ? undefined : j.result?.exit_code,
        elapsed_ms: Math.max(0, (j.endedAt ?? Date.now()) - j.startedAt),
        log_path: j.logPath,
        command: j.command,
      }));
  }

  function pendingForContext(sessionID, limit = 6) {
    return [...jobs.values()]
      .filter(j => j.sessionID === sessionID && (j.status === 'running' || !j.reported))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(j => ({
        job_id: j.id,
        status: j.status,
        exit_code: j.status === 'running' ? undefined : j.result?.exit_code,
        elapsed_ms: Math.max(0, (j.endedAt ?? Date.now()) - j.startedAt),
        log_path: j.logPath,
        command: j.command,
      }));
  }

  function status(sessionID, jobID) {
    const job = requireOwned(sessionID, jobID);
    if (job.status !== 'running') job.reported = true;
    return snapshot(job, { includeFull: false });
  }

  async function wait(sessionID, jobID, { waitMs = 10000, signal } = {}) {
    const job = requireOwned(sessionID, jobID);
    if (job.status !== 'running') {
      job.reported = true;
      return snapshot(job, { includeFull: true });
    }
    const duration = Math.max(0, Math.min(Number.isSafeInteger(waitMs) ? waitMs : 10000, MAX_WAIT_MS));
    if (duration > 0 && !signal?.aborted) {
      let timer;
      const waiters = [
        job.settled,
        new Promise(resolve => { timer = setTimeout(resolve, duration); }),
      ];
      let onAbort;
      if (signal) {
        waiters.push(new Promise(resolve => {
          onAbort = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        }));
      }
      await Promise.race(waiters);
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
    if (job.status !== 'running') job.reported = true;
    return snapshot(job, { includeFull: job.status !== 'running' });
  }

  async function cancelJob(job) {
    if (job.status === 'running') {
      job.cancelled = true;
      job.handle.kill(130);
      await job.settled;
    }
    job.reported = true;
    return snapshot(job, { includeFull: false });
  }

  async function cancel(sessionID, jobID) {
    return cancelJob(requireOwned(sessionID, jobID));
  }

  async function cleanupSession(sessionID) {
    const pending = [...inFlight].filter(f => f.sessionID === sessionID);
    for (const f of pending) f.abort();
    const targets = [...jobs.values()].filter(j => j.sessionID === sessionID && j.status === 'running');
    await Promise.all([...pending.map(f => f.done), ...targets.map(cancelJob)]);
  }

  async function close() {
    closed = true;
    const pending = [...inFlight];
    for (const f of pending) f.abort();
    const targets = activeJobs();
    await Promise.all([...pending.map(f => f.done), ...targets.map(cancelJob)]);
  }

  return { start, list, pendingForContext, status, wait, cancel, cleanupSession, close, activeLogPaths };
}
