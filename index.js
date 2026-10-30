import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSandbox, runProcess, inside } from './sandbox.mjs';
import { loadPolicy, agentAccess, canEdit, canonicalTarget, scratchPath, policyPaths } from './policy.mjs';
import { deniedAction, workflowPermissions } from './workflow-policy.mjs';
const inputSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The shell command to execute.' },
    workdir: { type: 'string', description: 'Directory inside the trusted workspace; defaults to the session directory.' },
    timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds; default 120000.' },
    reason: { type: 'string', description: 'Short reason when requesting unsandboxed execution.' },
  },
  required: ['command'], additionalProperties: false,
};
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
      if (event.effect === 'deny' || !['edit', 'sandbox_shell', 'shell_unsandboxed'].includes(event.action)) return;
      try {
        const policy = loadPolicy(policyFile);
        const scope = await sessionScope({ sessionID: event.sessionID });
        const access = agentAccess(policy, event.agent ?? scope.agent);
        if (event.action === 'sandbox_shell' && !access.shell) {
          event.effect = 'deny'; event.message = 'Agent terminal access is denied by kit policy';
        } else if (event.action === 'shell_unsandboxed') {
          event.effect = access.escape === 'ask' ? 'ask' : 'deny';
          event.message = access.escape === 'ask' ? 'Run this exact command outside the sandbox with your full user authority?' : 'This agent cannot request a sandbox escape';
        } else if (event.action === 'edit') {
          const scratch = scratchPath(scope.workspace, canonicalTarget(policy.scratchRoot));
          const denied = !event.resources?.length || event.resources.some(resource => {
            const target = canonicalTarget(path.resolve(scope.directory, resource));
            const paths = policyPaths();
            return inside(target, path.dirname(policyFile)) || inside(target, paths.store) || !canEdit(access, target, { workspace: scope.workspace, scratch });
          });
          if (denied) { event.effect = 'deny'; event.message = 'File write is outside this agent’s approved output locations'; }
        }
      } catch (error) { event.effect = 'deny'; event.message = error.message; }
    });
    async function sessionScope(tool) {
      const session = await ctx.session.get({ sessionID: tool.sessionID });
      const directory = fs.realpathSync(session.location.directory);
      let workspace = directory;
      const canonical = ctx.location.project?.canonical;
      if (canonical && ctx.location.directory === session.location.directory) {
        const root = fs.realpathSync(canonical);
        if (inside(directory, root) && !inside(os.homedir(), root)) workspace = root;
      }
      return { directory, workspace, agent: typeof session.agent === 'string' ? session.agent : session.agent?.id };
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
        name: 'sandbox_shell',
        description: 'Execute terminal commands in the trusted workspace using bubblewrap. Workspace and private scratch are writable; host filesystem and Git metadata are read-only. No network, host runtime sockets or GPU devices. Use this tool for terminal work; the built-in shell is denied. Retry a sandbox restriction using shell_unsandboxed with a reason; the user must approve. Commands can delete workspace files. Read-only agents receive a read-only workspace.',
        input: inputSchema, options: { codemode: false },
        execute: async (input, tool) => {
          const policy = loadPolicy(policyFile); const access = agentAccess(policy, tool.agent);
          if (!access.shell) throw new Error('Agent terminal access is denied by kit policy');
          await assertPermission('sandbox_shell', input, tool);
          const { directory, workspace } = await sessionScope(tool);
          try {
            return toolResult(await runSandbox({
              workspace, cwd: input.workdir ?? directory, command: input.command,
              timeout: input.timeout, signal: tool.signal,
              readOnly: access.profile !== 'workspace-write',
              writablePaths: access.planningRoots,
              scratchRoot: policy.scratchRoot,
              protectedPaths: [path.dirname(policyFile), policyPaths().store],
              maskedPaths: [path.dirname(policyFile), policyPaths().state],
            }));
          } catch (error) {
            return toolResult({ content: error.message, exit_code: 125, truncated: false });
          }
        },
      });
      editor.add({
        name: 'shell_unsandboxed',
        description: 'Request approval to execute an exact shell command OUTSIDE the sandbox with full host filesystem, credentials, network and device access. Use only after a sandbox restriction or an explicit user request. Every execution asks; no saved approval is requested.',
        input: inputSchema, options: { codemode: false },
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
