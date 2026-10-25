import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSandbox, runProcess, inside } from './sandbox.mjs';

export const READ_ONLY_AGENTS = new Set(['plan', 'explore', 'code-reviewer', 'debugger', 'test-engineer']);
const NO_ESCAPE = new Set(['plan', 'explore', 'code-reviewer', 'debugger']);
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

export default {
  id: 'opencode-workspace-sandbox',
  async setup(ctx) {
    const options = ctx.options ?? {};
    await ctx.permission.hook('evaluate', event => {
      if (event.action === 'shell_unsandboxed' && event.effect === 'allow') {
        event.effect = 'ask';
        event.message = 'Run this exact command outside the sandbox with your full user authority?';
      }
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
      return { directory, workspace };
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
          await assertPermission('sandbox_shell', input, tool);
          const { directory, workspace } = await sessionScope(tool);
          try {
            return toolResult(await runSandbox({
              workspace, cwd: input.workdir ?? directory, command: input.command,
              timeout: input.timeout, signal: tool.signal,
              readOnly: READ_ONLY_AGENTS.has(tool.agent),
              ...(options.scratchRoot ? { scratchRoot: options.scratchRoot } : {}),
              ...(options.maskedPaths ? { maskedPaths: options.maskedPaths } : {}),
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
          if (NO_ESCAPE.has(tool.agent)) throw new Error('This agent cannot request a sandbox escape');
          const { directory } = await sessionScope(tool);
          const cwd = fs.realpathSync(path.resolve(directory, input.workdir ?? directory));
          if (!fs.statSync(cwd).isDirectory() || /[\r\n\0]/.test(cwd)) throw new Error('Invalid escape working directory');
          await assertPermission('shell_unsandboxed', input, tool, cwd);
          return toolResult(await runProcess('/bin/bash', ['--noprofile', '--norc', '-c', input.command], {
            cwd, timeout: input.timeout, signal: tool.signal,
          }));
        },
      });
    });
  },
};
