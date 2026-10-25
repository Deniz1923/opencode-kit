import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planInstall, listInstalled } from './install.mjs';
import { loadPolicy } from '../policy.mjs';
import { runSandbox } from '../sandbox.mjs';

export const TESTED = { opencode: '2.1.3', bwrap: '0.13.1' };
export const supportedPlatform = (platform = process.platform, arch = process.arch) => platform === 'linux' && arch === 'x64';
function version(command) {
  const r = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) throw new Error(command + ' is unavailable');
  return (r.stdout + r.stderr).match(/\d+\.\d+\.\d+/)?.[0];
}
export function checkCompatibility() {
  if (!supportedPlatform()) throw new Error('Installer and sandbox support Linux x86-64 only');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required; tested with Node.js 26');
  const result = { opencode: version('opencode'), bwrap: version('/usr/bin/bwrap') };
  for (const key of Object.keys(TESTED)) if (result[key] !== TESTED[key]) throw new Error(`Untested ${key} version ${result[key]}; this release requires ${TESTED[key]}`);
  return result;
}
export async function doctor(paths, { execute = true } = {}) {
  const checks = []; const check = (name, okay, detail) => checks.push({ name, okay, detail });
  check('platform', supportedPlatform(), `${process.platform}/${process.arch}`);
  let installed;
  try { installed = listInstalled(paths); } catch (e) { check('state', false, e.message); return checks; }
  const sandbox = installed.some(c => c.id === 'sandbox');
  if (!sandbox) { check('sandbox', true, 'not installed: kit does not isolate agent commands'); return checks; }
  try { check('versions', true, JSON.stringify(checkCompatibility())); } catch (e) { check('versions', false, e.message); }
  let policy;
  try { policy = loadPolicy(paths.policy); check('trusted agent profiles', true, Object.entries(policy.agents).map(([id, a]) => `${id}: ${a.profile}, shell=${a.shell}, escape=${a.escape}`).join('; ')); }
  catch (e) { check('trusted agent profiles', false, e.message); }
  try {
    const plan = planInstall(paths, {});
    check('managed settings and code', !plan.conflicts.length, plan.conflicts.length ? 'Managed settings changed; review an update preview' : 'Native shell hard policy and managed settings match the installation');
  } catch (e) { check('managed settings and code', false, e.message); }
  if (execute && policy) {
    // /tmp is intentionally private/writable inside bwrap. Use a host-visible
    // parent so the outside-write check exercises a read-only host mount.
    const root = fs.mkdtempSync('/var/tmp/opencode-kit-doctor-');
    try {
      const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
      const outside = path.join(root, 'outside');
      const command = 'touch inside; if touch ../outside 2>/dev/null; then exit 91; fi; printf sandbox-ok';
      const r = await runSandbox({ workspace, cwd: workspace, command, scratchRoot: policy.scratchRoot, timeout: 10000 });
      const workspaceWrite = fs.existsSync(path.join(workspace, 'inside')), outsideWrite = fs.existsSync(outside);
      check('real bubblewrap execution', r.exit_code === 0 && workspaceWrite && !outsideWrite,
        JSON.stringify({ exitCode: r.exit_code, workspaceWrite, outsideWrite, output: r.content }));
    } catch (e) { check('real bubblewrap execution', false, e.message); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  return checks;
}
