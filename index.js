import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSandbox, runProcess, inside, activePlaceholders } from './sandbox.mjs';
import { createJobManager } from './jobs.mjs';
import { loadPolicy, agentAccess, canEdit, isProjectConfigEdit, canonicalTarget, scratchPath, policyPaths, privatePaths } from './policy.mjs';
import { deniedAction, workflowPermissions } from './workflow-policy.mjs';
import { workspaceStore } from './workspaces.mjs';

const baseShellSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The shell command to execute.' },
    workdir: { type: 'string', description: 'Directory inside an approved workspace; defaults to the session directory.' },
    timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds; default 120000 (600000 for background jobs, max 1800000).' },
  },
  required: ['command'], additionalProperties: false,
};
const sandboxShellSchema = {
  ...baseShellSchema,
  properties: {
    ...baseShellSchema.properties,
    background: { type: 'boolean', description: 'Run a long build, test suite, or server in the background and return a job handle (default false).' },
  },
};
const escapeSchema = {
  ...baseShellSchema,
  properties: {
    ...baseShellSchema.properties,
    reason: { type: 'string', description: 'Explain the required host access so the user can decide whether to approve.' },
  },
};
const jobSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'status', 'wait', 'cancel'], description: 'Background job operation.' },
    job_id: { type: 'string', description: 'Job ID for status, wait, or cancel.' },
    wait_ms: { type: 'integer', minimum: 0, maximum: 60000, description: 'Max milliseconds to wait for completion (default 10000).' },
  },
  required: ['action'], additionalProperties: false,
};

const GIT_RESTRICTION = /(?:\.git\/|cannot lock ref|index\.lock)[\s\S]{0,160}(?:read-only file system|EROFS|permission denied|EACCES|operation not permitted)|(?:read-only file system|EROFS|permission denied|EACCES|operation not permitted)[\s\S]{0,160}(?:\.git\/|index\.lock)/i;
const NET_RESTRICTION = /(?:could not resolve host|temporary failure in name resolution|name or service not known|failed to lookup address information|getaddrinfo|EAI_AGAIN|ENOTFOUND|ENETUNREACH|ECONNREFUSED|network is unreachable|network is down|connection refused|no route to host|address family not supported|EAFNOSUPPORT)/i;
const FS_RESTRICTION = /(?:read-only file system|EROFS|operation not permitted|EPERM|permission denied|EACCES|sandbox unavailable)/i;

function restrictionHint(result, access) {
  if (result.exit_code === 0 || result.exit_code === 130) return result;
  const text = result.content ?? '';
  let boundary;
  if (GIT_RESTRICTION.test(text)) boundary = 'Git metadata is read-only inside sandbox_shell.';
  else if (NET_RESTRICTION.test(text)) boundary = 'Network is disabled inside sandbox_shell.';
  else if (FS_RESTRICTION.test(text)) boundary = 'network is disabled, host and protected paths are read-only.';
  else return result;
  const next = access.escape === 'ask'
    ? 'If this access is necessary for the user’s task, call shell_unsandboxed with the exact command and a short reason to request approval. Do not repeat blocked probes or conclude that network/host access is impossible. Respect rejection; never bypass it.'
    : 'This agent cannot request host execution. Continue within its allowed locations or explain the required access to the user.';
  return { ...result, content: text + '\n[Sandbox boundary: ' + boundary + ' ' + next + ']' };
}

function toolResult(result) {
  const { content, ...metadata } = result;
  let body = content || '(no output)';
  if (result.truncated && result.log_path) {
    body += `\n[full output saved to ${result.log_path}; inspect with read/grep instead of re-running]`;
  }
  const status = Number.isInteger(result.exit_code) ? '\n[exit_code: ' + result.exit_code + ']' : '';
  return { content: body + status, metadata };
}

function formatJobSummary(info, access) {
  const parts = [`Job ${info.job_id}: ${info.status} (${info.elapsed_ms}ms)`];
  if (Number.isInteger(info.exit_code)) parts[0] += ` [exit_code: ${info.exit_code}]`;
  parts.push(`Log: ${info.log_path} (${info.log_bytes} bytes)`);
  if (info.status !== 'running' && info.content !== undefined) {
    let body = info.content || '(no output)';
    if (info.truncated && info.log_path) {
      body += `\n[full output saved to ${info.log_path}; inspect with read/grep instead of re-running]`;
    }
    const hinted = access ? restrictionHint({ content: body, exit_code: info.exit_code }, access).content : body;
    parts.push('', hinted);
  } else if (info.tail) {
    const hinted = info.status !== 'running' && access
      ? restrictionHint({ content: info.tail, exit_code: info.exit_code }, access).content
      : info.tail;
    parts.push('', hinted);
  }
  const { content: _c, tail: _t, ...metadata } = info;
  return { content: parts.join('\n'), metadata };
}

function source(tool) {
  return { type: 'tool', messageID: tool.messageID, id: tool.id };
}

function localTitle(messages) {
  const prefix = 'Here is the first message of the conversation:\n\n<message>\n';
  const suffix = '\n</message>\n\nReply with only the title.';
  const text = messages?.flatMap(message => message.role === 'user' ? message.content ?? [] : [])
    .find(part => part.type === 'text' && part.text.startsWith(prefix) && part.text.endsWith(suffix))?.text;
  if (!text) return;
  let title = text.slice(prefix.length, -suffix.length).slice(0, 4000).split('\n')
    .map(line => line.trim().replace(/^#+\s*/, '')).find(line => line && !line.startsWith('```'));
  if (!title) return;
  title = title.replace(/^(?:please\s+)?(?:can you\s+|could you\s+)?(?:help me\s+)?/i, '')
    .split(/[.!?](?:\s|$)/u)[0].replace(/\s+/g, ' ').trim();
  title = [...title].slice(0, 80).join('').split(/\s+/).slice(0, 12).join(' ').replace(/[.!?]+$/, '');
  return title ? title[0].toLocaleUpperCase() + title.slice(1) : undefined;
}

export function createPlugin({ policyFile = policyPaths().policy, nativeTempRoot = '/tmp/opencode' } = {}) { return {
  id: 'opencode-workspace-sandbox',
  async setup(ctx) {
    const approvals = workspaceStore(path.join(path.dirname(policyFile), 'workspaces'));
    const jobs = createJobManager();
    let closed = false;
    let eventIterator;
    if (typeof ctx.event?.subscribe === 'function') {
      try {
        eventIterator = ctx.event.subscribe({ types: ['session.deleted'] })[Symbol.asyncIterator]();
        const pump = async () => {
          while (!closed) {
            const item = await eventIterator.next();
            if (item.done || closed) break;
            const deletedID = item.value?.data?.sessionID;
            if (typeof deletedID === 'string') await jobs.cleanupSession(deletedID);
          }
        };
        void pump().catch(() => {});
      } catch { /* Event subscription unavailable in minimal test hosts. */ }
    }
    function isNativeTemp(target) {
      if (!inside(target, nativeTempRoot)) return false;
      const stat = fs.lstatSync(nativeTempRoot, { throwIfNoEntry: false });
      return stat?.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o022);
    }
    const initialDirectory = fs.realpathSync(ctx.location.directory);
    let initialWorkspace = initialDirectory;
    if (ctx.location.project?.canonical) {
      const root = fs.realpathSync(ctx.location.project.canonical);
      if (inside(initialDirectory, root) && !inside(os.homedir(), root)) initialWorkspace = root;
    }
    async function approvedRoots(sessionID, session) {
      const existing = approvals.read(sessionID);
      if (existing) return existing;
      const inherited = session.parentID ? approvals.read(session.parentID) : undefined;
      if (session.parentID && !inherited) throw new Error('Parent session workspace approval is unavailable; open the parent session first.');
      return approvals.seed(sessionID, inherited ?? [initialWorkspace]);
    }
    // Store only a bounded candidate from the current outgoing title request.
    // No transcript reads, historical backfill, model retries, or response rewriting.
    const pendingTitles = new Map();
    await ctx.session.hook('title', event => {
      const title = event.result === undefined && localTitle(event.messages);
      if (!title) return;
      pendingTitles.delete(event.sessionID); pendingTitles.set(event.sessionID, title);
      if (pendingTitles.size > 128) pendingTitles.delete(pendingTitles.keys().next().value);
    });
    await ctx.session.hook('http.response', async event => {
      if (event.kind !== 'title') return;
      const title = pendingTitles.get(event.sessionID); pendingTitles.delete(event.sessionID);
      if (!title || event.response.status !== 429) return;
      try {
        const body = await event.response.clone().json();
        if (body?.error?.type !== 'FreeUsageLimitError') return;
        const current = await ctx.session.get({ sessionID: event.sessionID });
        if (!current.title) await ctx.session.update({ sessionID: event.sessionID, title });
      } catch { /* Keep the original provider response and normal chat behavior. */ }
    });
    // Presentation only: permission rules select tools; this hook never grants
    // capabilities or changes user content, answer style, or model settings.
    await ctx.session.hook('context', async event => {
      // This runs before the model can call a session-moving host utility.
      if (event.sessionID) await approvedRoots(event.sessionID, await ctx.session.get({ sessionID: event.sessionID }));
      const role = event.agent?.split('/').at(-1);
      if (role === 'build') {
        // Only handle newly delivered OpenCode notices. A user or tool can quote the markup.
        const messages = event.messages ?? [];
        const newest = messages.slice(messages.findLastIndex(message => message.role === 'assistant') + 1);
        const reports = newest.filter(message => message.metadata?.source === 'subagent');
        const guidance = [];
        if (reports.some(message => ['error', 'cancelled'].includes(message.metadata.state))) {
          guidance.push('A subagent failed or was cancelled. Keep useful evidence already delivered and complete the missing work yourself if the parent task is still authorized. Do not relaunch a cancelled child. After a model failure, retry once only if the user explicitly approved a fallback model for this work. Do not retry a permission denial.');
        }
        if (reports.some(message => message.metadata.state === 'completed')) {
          guidance.push('A subagent report arrived. Resume the original task from its current state, use the findings, and complete pending implementation and verification. If the report lists work still running, keep that work pending.');
        }
        if (guidance.length) event.system.push({ type: 'text', text: 'Subagent handoff: ' + guidance.join(' ') });
      }
      if (role !== 'chat') return;
      const rules = await workflowPermissions(ctx, event.agent);
      const denied = action => deniedAction(rules, action);
      // Newer hosts may advertise a denied tool. Keep authority in permission
      // rules and independently omit unavailable workflows from model context.
      for (const name of Object.keys(event.tools ?? {})) {
        const workflow = ['skill', 'subagent', 'execute'].includes(name) || name.startsWith('todo') || name.includes('goal');
        if (workflow && denied(name)) delete event.tools[name];
        if (/^opencode[_.]/.test(name) && denied('execute')) delete event.tools[name];
      }
    });
    // Authority comes from an owned user policy file, never a project's plugin options.
    await ctx.permission.hook('evaluate', async event => {
      if (event.action === 'workspace_approve') {
        if (event.effect !== 'deny') {
          event.effect = 'ask';
          event.message = 'Allow this exact directory for this session? Existing agent write restrictions still apply.';
        }
        return;
      }
      if (event.effect === 'deny' || !['read', 'grep', 'glob', 'external_directory', 'edit', 'sandbox_shell', 'sandbox_job', 'shell_unsandboxed'].includes(event.action)) return;
      try {
        const policy = loadPolicy(policyFile);
        const scope = await sessionScope({ sessionID: event.sessionID });
        const access = agentAccess(policy, event.agent ?? scope.agent);
        const sensitive = [...privatePaths(), path.dirname(policyFile)].map(canonicalTarget);
        if (event.action === 'external_directory') {
          const targets = (event.resources ?? []).map(r => canonicalTarget(path.resolve(scope.directory, r.endsWith('/*') ? r.slice(0, -2) : r)));
          if (targets.length && targets.every(target => !sensitive.some(p => inside(target, p))
            && (inside(target, '/tmp') || scope.roots.some(root => inside(target, root))))) event.effect = 'allow';
        } else if (['read', 'grep', 'glob'].includes(event.action)) {
          const search = event.action !== 'read';
          const targets = search ? [canonicalTarget(path.resolve(scope.directory, event.metadata?.path ?? '.'))]
            : (event.resources ?? []).map(r => canonicalTarget(path.resolve(scope.directory, r)));
          if (!targets.length || targets.some(target => sensitive.some(p => inside(target, p) || (search && inside(p, target))))) {
            event.effect = 'deny'; event.message = 'Private credentials, configuration and conversation history are protected. Narrow the search to project source, or use sandbox_shell with its private-data masks.';
          } else if (!search) {
            // Native reads normalize internal paths to relative resources. Check
            // canonical absolute rules too, without recursing on absolute checks.
            const absolute = targets.filter((target, i) => event.resources[i] !== target);
            if (absolute.length) await ctx.permission.assert({
              sessionID: event.sessionID, agent: event.agent, action: 'read', resources: absolute,
              metadata: event.metadata ?? {}, ...(event.source ? { source: event.source } : {}),
            });
          }
        } else if (['sandbox_shell', 'sandbox_job'].includes(event.action) && !access.shell) {
          event.effect = 'deny'; event.message = 'Agent terminal access is denied by kit policy';
        } else if (event.action === 'shell_unsandboxed') {
          event.effect = access.escape === 'ask' ? 'ask' : 'deny';
          event.message = access.escape === 'ask' ? 'Run this exact command outside the sandbox with your full user authority?' : 'This agent cannot request a sandbox escape';
        } else if (event.action === 'edit') {
          const roots = scope.roots;
          const scratchRoot = canonicalTarget(policy.scratchRoot);
          let needsDirectory = false;
          let needsConfigAsk = false;
          let blockedByPlaceholder = false;
          const denied = !event.resources?.length || event.resources.some(resource => {
            const target = canonicalTarget(path.resolve(scope.directory, resource));
            const paths = policyPaths();
            if (sensitive.some(p => inside(target, p)) || inside(target, paths.store)) return true;
            if (access.profile === 'workspace-write' && isNativeTemp(target) && target !== nativeTempRoot
              && !inside(target, scratchRoot) && !inside(scratchRoot, target)
              && canEdit(access, target, { workspace: nativeTempRoot, scratch: scratchRoot })) return false;
            if (roots.some(workspace => canEdit(access, target, { workspace, scratch: scratchPath(workspace, scratchRoot) }))) return false;
            if (access.profile === 'workspace-write') {
              const configRoot = roots.find(workspace => isProjectConfigEdit(target, workspace));
              if (configRoot) {
                const placeholders = activePlaceholders(configRoot, scratchRoot);
                if (placeholders.some(p => inside(target, p) || inside(p, target))) {
                  blockedByPlaceholder = true;
                  return true;
                }
                needsConfigAsk = true;
                return false;
              }
              if (!roots.some(root => inside(target, root))) needsDirectory = true;
            }
            return true;
          });
          if (denied) {
            event.effect = 'deny';
            event.message = blockedByPlaceholder
              ? 'Cannot edit this project config path while an active background sandbox job holds its protection placeholder; wait for or cancel the job via sandbox_job first.'
              : needsDirectory && access.profile === 'workspace-write'
                ? 'This directory is not approved for this session. Request workspace_approve for the exact directory, then retry the native file tool. A full shell_unsandboxed escape is unnecessary for ordinary additional-workspace files.'
                : 'File write is outside this agent’s approved output locations or targets a protected path';
          } else if (needsConfigAsk) {
            event.effect = 'ask';
            event.message = 'Approve editing this project configuration or agent file?';
          }
        }
      } catch (error) { event.effect = 'deny'; event.message = error.message; }
    });
    async function sessionScope(tool) {
      const session = await ctx.session.get({ sessionID: tool.sessionID });
      const directory = fs.realpathSync(session.location.directory);
      const roots = await approvedRoots(tool.sessionID, session);
      return { directory, roots, agent: typeof session.agent === 'string' ? session.agent : session.agent?.id };
    }
    async function assertPermission(action, input, tool, cwd) {
      await ctx.permission.assert({
        sessionID: tool.sessionID, agent: tool.agent, action, resources: [input.command],
        metadata: { reason: input.reason ?? '', outsideSandbox: action === 'shell_unsandboxed', ...(cwd ? { cwd } : {}) },
        source: source(tool),
      });
    }
    await ctx.tool.transform(editor => {
      editor.add({
        name: 'workspace_approve',
        description: 'Request user approval for an exact additional workspace directory in this session. Moving the session grants no write access. Existing Plan/read-only restrictions remain in force. Approval persists for this session across restarts; no command is executed.',
        input: { type: 'object', properties: { directory: { type: 'string', description: 'Exact additional directory, absolute or relative to the current session directory.' }, reason: { type: 'string' } }, required: ['directory'], additionalProperties: false },
        options: { codemode: false },
        execute: async (input, tool) => {
          loadPolicy(policyFile);
          const { directory } = await sessionScope(tool);
          const requested = path.resolve(directory, input.directory);
          const target = fs.realpathSync(requested);
          const roots = approvals.read(tool.sessionID);
          if (!fs.statSync(target).isDirectory() || /[\0\r\n]/.test(target) || inside(os.homedir(), target)
            || ['/', '/tmp', '/run', '/dev', '/dev/shm', '/proc', '/sys'].includes(target)
            || inside(path.dirname(policyFile), target) || inside(target, path.dirname(policyFile))
            || inside(policyPaths().store, target) || inside(target, policyPaths().store)) throw new Error('Unsafe additional workspace directory');
          if (!approvals.select(roots, target)) {
            await ctx.permission.assert({
              sessionID: tool.sessionID, agent: tool.agent, action: 'workspace_approve', resources: [target],
              metadata: { sessionID: tool.sessionID, reason: input.reason ?? '', approvedDirectories: roots }, source: source(tool),
            });
            if (fs.realpathSync(requested) !== target) throw new Error('Requested directory changed during approval');
            approvals.approve(tool.sessionID, target);
          }
          return toolResult({ content: 'Approved workspace directory: ' + target, directories: approvals.read(tool.sessionID) });
        },
      });
      editor.add({
        name: 'sandbox_shell',
        description: 'Execute terminal commands in the trusted workspace using bubblewrap. Workspace and private scratch are writable; host filesystem and Git metadata are read-only. No network, host runtime sockets or GPU devices. Use background: true for long builds, test suites, or dev servers, then monitor with sandbox_job. Truncated output saves the full log in scratch for read/grep. Retry a sandbox restriction using shell_unsandboxed with a reason; the user must approve.',
        input: sandboxShellSchema, options: { codemode: false },
        execute: async (input, tool) => {
          const policy = loadPolicy(policyFile); const access = agentAccess(policy, tool.agent);
          if (!access.shell) throw new Error('Agent terminal access is denied by kit policy');
          await assertPermission('sandbox_shell', input, tool);
          const { directory } = await sessionScope(tool);
          try {
            const cwd = fs.realpathSync(path.resolve(directory, input.workdir ?? directory));
            const workspace = approvals.select(approvals.read(tool.sessionID), cwd);
            if (!workspace) throw new Error('Directory is outside this session’s approved workspaces. Request workspace_approve for the exact directory before continuing.');
            const common = {
              workspace, cwd, command: input.command,
              timeout: input.timeout, signal: tool.signal,
              readOnly: access.profile !== 'workspace-write',
              writablePaths: access.planningRoots,
              scratchRoot: policy.scratchRoot,
              nativeTempRoot,
              protectedPaths: [path.dirname(policyFile), policyPaths().store],
              maskedPaths: [path.dirname(policyFile), policyPaths().state],
            };
            if (input.background) {
              const started = await jobs.start({ ...common, sessionID: tool.sessionID, access });
              if (!started.background) return toolResult(restrictionHint(started.result, access));
              const { background: _bg, ...metadata } = started;
              return {
                content: `Job ${started.job_id} started in background.\nLog: ${started.log_path}\nUse sandbox_job (status/wait/cancel) or inspect the log with read/grep.`,
                metadata,
              };
            }
            return toolResult(restrictionHint(await runSandbox(common), access));
          } catch (error) {
            return toolResult({ content: error.message, exit_code: 125, truncated: false });
          }
        },
      });
      editor.add({
        name: 'sandbox_job',
        description: 'Inspect, wait for, list, or cancel background sandbox_shell jobs started in this session.',
        input: jobSchema, options: { codemode: false },
        execute: async (input, tool) => {
          const policy = loadPolicy(policyFile); const access = agentAccess(policy, tool.agent);
          if (!access.shell) throw new Error('Agent terminal access is denied by kit policy');
          await ctx.permission.assert({
            sessionID: tool.sessionID, agent: tool.agent, action: 'sandbox_job',
            resources: [input.job_id ?? input.action], metadata: { action: input.action }, source: source(tool),
          });
          if (input.action === 'list') {
            const items = jobs.list(tool.sessionID);
            const content = items.length
              ? items.map(j => `${j.job_id}  ${j.status}${Number.isInteger(j.exit_code) ? ' (exit ' + j.exit_code + ')' : ''}  ${j.elapsed_ms}ms  ${j.log_path}  ${j.command}`).join('\n')
              : 'No background sandbox jobs in this session.';
            return { content, metadata: { jobs: items } };
          }
          if (!input.job_id) throw new Error('job_id is required for ' + input.action);
          if (input.action === 'status') return formatJobSummary(jobs.status(tool.sessionID, input.job_id), access);
          if (input.action === 'wait') return formatJobSummary(await jobs.wait(tool.sessionID, input.job_id, { waitMs: input.wait_ms, signal: tool.signal }), access);
          if (input.action === 'cancel') return formatJobSummary(await jobs.cancel(tool.sessionID, input.job_id), access);
          throw new Error('Unknown sandbox_job action: ' + input.action);
        },
      });
      editor.add({
        name: 'shell_unsandboxed',
        description: 'Request approval to execute an exact shell command OUTSIDE the sandbox with full host filesystem, credentials, network and device access. Use only after a sandbox restriction or an explicit user request. For ordinary files in another project directory, prefer workspace_approve and native file tools. Every execution asks; no saved approval is requested.',
        input: escapeSchema, options: { codemode: false },
        execute: async (input, tool) => {
          if (agentAccess(loadPolicy(policyFile), tool.agent).escape !== 'ask') throw new Error('This agent cannot request a sandbox escape');
          const { directory } = await sessionScope(tool);
          const cwd = fs.realpathSync(path.resolve(directory, input.workdir ?? directory));
          if (!fs.statSync(cwd).isDirectory() || /[\r\n\0]/.test(cwd)) throw new Error('Invalid escape working directory');
          await assertPermission('shell_unsandboxed', input, tool, cwd);
          if (agentAccess(loadPolicy(policyFile), tool.agent).escape !== 'ask') throw new Error('This agent cannot request a sandbox escape');
          return toolResult(await runProcess('/bin/bash', ['--noprofile', '--norc', '-c', input.command], {
            cwd, timeout: input.timeout, signal: tool.signal,
          }));
        },
      });
    });
    return async () => {
      closed = true;
      try { await eventIterator?.return?.(); } catch { /* ignore */ }
      await jobs.close();
    };
  },
}; }

export default createPlugin();
