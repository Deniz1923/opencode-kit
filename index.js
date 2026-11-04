import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSandbox, runProcess, inside } from './sandbox.mjs';
import { loadPolicy, agentAccess, canEdit, canonicalTarget, scratchPath, policyPaths, privatePaths } from './policy.mjs';
import { deniedAction, workflowPermissions } from './workflow-policy.mjs';
import { workspaceStore } from './workspaces.mjs';
const inputSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The shell command to execute.' },
    workdir: { type: 'string', description: 'Directory inside an approved workspace; defaults to the session directory.' },
    timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds; default 120000.' },
  },
  required: ['command'], additionalProperties: false,
};
const escapeSchema = { ...inputSchema, properties: { ...inputSchema.properties,
  reason: {type:'string', description:'Explain the required host access so the user can decide whether to approve.'} } };
function restrictionHint(result, access) {
  if (result.exit_code === 0 || !/(?:could not resolve host|network is unreachable|network is down|connection refused|read-only file system|operation not permitted|permission denied|sandbox unavailable)/i.test(result.content)) return result;
  const next = access.escape === 'ask'
    ? 'If this access is necessary for the user’s task, call shell_unsandboxed with the exact command and a short reason to request approval. Do not repeat blocked probes or conclude that network/host access is impossible. Respect rejection; never bypass it.'
    : 'This agent cannot request host execution. Continue within its allowed locations or explain the required access to the user.';
  return {...result, content:result.content+'\n[Sandbox boundary: network is disabled, host and protected paths are read-only. '+next+']'};
}
function toolResult(result) {
  const { content, ...metadata } = result;
  return { content: content || '(no output)', metadata };
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

export function createPlugin({ policyFile = policyPaths().policy } = {}) { return {
  id: 'opencode-workspace-sandbox',
  async setup(ctx) {
    const approvals = workspaceStore(path.join(path.dirname(policyFile), 'workspaces'));
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
      if (event.agent?.split('/').at(-1) !== 'chat') return;
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
      if (event.effect === 'deny' || !['read', 'grep', 'glob', 'external_directory', 'edit', 'sandbox_shell', 'shell_unsandboxed'].includes(event.action)) return;
      try {
        const policy = loadPolicy(policyFile);
        const scope = await sessionScope({ sessionID: event.sessionID });
        const access = agentAccess(policy, event.agent ?? scope.agent);
        const sensitive = [...privatePaths(), path.dirname(policyFile)].map(canonicalTarget);
        if (event.action === 'external_directory') {
          const targets = (event.resources ?? []).map(r => canonicalTarget(r.endsWith('/*') ? r.slice(0,-2) : r));
          if (targets.length && targets.every(target => !sensitive.some(p=>inside(target,p)) && scope.roots.some(root=>inside(target,root)))) event.effect = 'allow';
        } else if (['read', 'grep', 'glob'].includes(event.action)) {
          const search = event.action !== 'read';
          const targets = search ? [canonicalTarget(path.resolve(scope.directory, event.metadata?.path ?? '.'))]
            : (event.resources ?? []).map(r => canonicalTarget(path.resolve(scope.directory,r)));
          if (!targets.length || targets.some(target=>sensitive.some(p=>inside(target,p) || (search && inside(p,target))))) {
            event.effect='deny'; event.message='Private credentials, configuration and conversation history are protected. Narrow the search to project source, or use sandbox_shell with its private-data masks.';
          } else if (!search) {
            // Native reads normalize internal paths to relative resources. Check
            // canonical absolute rules too, without recursing on absolute checks.
            const absolute = targets.filter((target,i)=>event.resources[i] !== target);
            if (absolute.length) await ctx.permission.assert({sessionID:event.sessionID, agent:event.agent, action:'read', resources:absolute,
              metadata:event.metadata ?? {}, ...(event.source ? {source:event.source} : {})});
          }
        } else if (event.action === 'sandbox_shell' && !access.shell) {
          event.effect = 'deny'; event.message = 'Agent terminal access is denied by kit policy';
        } else if (event.action === 'shell_unsandboxed') {
          event.effect = access.escape === 'ask' ? 'ask' : 'deny';
          event.message = access.escape === 'ask' ? 'Run this exact command outside the sandbox with your full user authority?' : 'This agent cannot request a sandbox escape';
        } else if (event.action === 'edit') {
          const roots = scope.roots;
          let needsDirectory = false;
          const denied = !event.resources?.length || event.resources.some(resource => {
            const target = canonicalTarget(path.resolve(scope.directory, resource));
            const paths = policyPaths();
            if (!sensitive.some(p=>inside(target,p)) && !inside(target,paths.store) && !roots.some(root=>inside(target,root))) needsDirectory = true;
            return sensitive.some(p=>inside(target,p)) || inside(target, paths.store) || !roots.some(workspace =>
              canEdit(access, target, { workspace, scratch: scratchPath(workspace, canonicalTarget(policy.scratchRoot)) }));
          });
          if (denied) {
            event.effect = 'deny';
            event.message = needsDirectory && access.profile === 'workspace-write'
              ? 'This directory is not approved for this session. Request workspace_approve for the exact directory, then retry the native file tool. A full shell_unsandboxed escape is unnecessary for ordinary additional-workspace files.'
              : 'File write is outside this agent’s approved output locations or targets a protected path';
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
            await ctx.permission.assert({ sessionID: tool.sessionID, agent: tool.agent, action: 'workspace_approve', resources: [target],
              metadata: { sessionID: tool.sessionID, reason: input.reason ?? '', approvedDirectories: roots }, source: source(tool) });
            if (fs.realpathSync(requested) !== target) throw new Error('Requested directory changed during approval');
            approvals.approve(tool.sessionID, target);
          }
          return toolResult({ content: 'Approved workspace directory: ' + target, directories: approvals.read(tool.sessionID) });
        },
      });
      editor.add({
        name: 'sandbox_shell',
        description: 'Execute terminal commands in the trusted workspace using bubblewrap. Workspace and private scratch are writable; host filesystem and Git metadata are read-only. No network, host runtime sockets or GPU devices. Use this tool for terminal work; the built-in shell is denied. Retry a sandbox restriction using shell_unsandboxed with a reason; the user must approve. Commands can delete workspace files. Read-only agents receive a read-only workspace.',
        input: inputSchema, options: { codemode: false },
        execute: async (input, tool) => {
          const policy = loadPolicy(policyFile); const access = agentAccess(policy, tool.agent);
          if (!access.shell) throw new Error('Agent terminal access is denied by kit policy');
          await assertPermission('sandbox_shell', input, tool);
          const { directory } = await sessionScope(tool);
          try {
            const cwd = fs.realpathSync(path.resolve(directory, input.workdir ?? directory));
            const workspace = approvals.select(approvals.read(tool.sessionID), cwd);
            if (!workspace) throw new Error('Directory is outside this session’s approved workspaces. Request workspace_approve for the exact directory before continuing.');
            return toolResult(restrictionHint(await runSandbox({
              workspace, cwd, command: input.command,
              timeout: input.timeout, signal: tool.signal,
              readOnly: access.profile !== 'workspace-write',
              writablePaths: access.planningRoots,
              scratchRoot: policy.scratchRoot,
              protectedPaths: [path.dirname(policyFile), policyPaths().store],
              maskedPaths: [path.dirname(policyFile), policyPaths().state],
            }), access));
          } catch (error) {
            return toolResult({ content: error.message, exit_code: 125, truncated: false });
          }
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
  },
}; }

export default createPlugin();
