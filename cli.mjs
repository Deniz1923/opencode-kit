#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { policyPaths } from './policy.mjs';
import { readAgentPack, fetchAgentSource } from './kit/packs.mjs';
import { planInstall, applyPlan, planRemoval, listInstalled, installedSelection, recover } from './kit/install.mjs';
import { doctor, supportedPlatform, checkCompatibility,checkUsageCompatibility } from './kit/doctor.mjs';
export { supportedPlatform };
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const help = `OpenCode kit (Linux x86-64; OpenCode 2.1.3, bwrap 0.13.1)
  opencode-kit init                         Interactive setup
  opencode-kit init --sandbox --agents deniz --workflow --apply
  opencode-kit init --usage --apply
  opencode-kit add agents PATH|github:OWNER/REPO#REF --apply
  opencode-kit list
  opencode-kit update [COMPONENT] --apply
  opencode-kit remove COMPONENT --apply
  opencode-kit doctor [--full]
  opencode-kit recover

Options:
  --sandbox          Include sandbox and mandatory protections
  --agents SOURCE    Include a data-only agent pack (repeatable)
  --namespace NAME   Namespace for an added pack
  --workflow         Include optional todo/delegation preferences
  --usage            Include the metadata-only /usage-live dashboard (OpenCode 2.2.4)
  --profile ID=ROLE  read-only, planner, or workspace-write (repeatable)
  --escape ID=VALUE  ask or deny (repeatable; explicit denials remain)
  --planning-root P  Relative folder writable by planners (repeatable)
  --scratch DIR      Private scratch root
  --resolve FILE     JSON conflict choices, keyed by preview conflict ID
  --dry-run          Preview without applying
  --apply            Apply the preview; unresolved conflicts still stop
  --restart          Restart OpenCode after a successful apply
  --interactive      Use the menu even with redirected input

Without --apply, noninteractive setup only previews. No plugins or scripts from
agent packs are executed. Existing executable plugins remain your responsibility.
`;
function parse(argv) {
  const options = { agents: [], profile: [], escape: [], planningRoot: [], positional: [] };
  const values = { '--agents': 'agents', '--namespace': 'namespace', '--profile': 'profile', '--escape': 'escape', '--planning-root': 'planningRoot', '--scratch': 'scratch', '--resolve': 'resolve' };
  const flags = { '--sandbox': 'sandbox', '--workflow': 'workflow', '--usage':'usage', '--apply': 'apply', '--dry-run': 'dryRun', '--restart': 'restart', '--interactive': 'interactive', '--full': 'full', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (values[arg]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Missing value for ' + arg);
      const key = values[arg], value = argv[++i]; if (Array.isArray(options[key])) options[key].push(value); else options[key] = value;
    } else if (flags[arg]) options[flags[arg]] = true;
    else if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
    else options.positional.push(arg);
  }
  if (options.apply && options.dryRun) throw new Error('Choose --apply or --dry-run');
  return options;
}
function promptSession() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const iterator = rl[Symbol.asyncIterator]();
  return { close: () => rl.close(), ask: async text => { process.stdout.write(text + '\n> '); const item = await iterator.next(); if (item.done) throw new Error('Setup cancelled: no answer'); return item.value.trim(); } };
}
function preview(plan) {
  console.log('\nPreview: ' + plan.components.map(c => c.id).join(', '));
  console.log(plan.securityChanges);
  for (const file of plan.files.filter(f => f.before !== f.after)) console.log(`  ${file.after === null ? 'remove' : file.before === null ? 'create' : 'update'} ${file.path}`);
  const policyFile = plan.files.find(f => f.path === plan.paths.policy);
  if (policyFile?.after) for (const [id, access] of Object.entries(JSON.parse(policyFile.after).agents)) console.log(`  ${id}: ${access.profile}; terminal ${access.shell ? 'sandboxed' : 'denied'}; escape ${access.escape}`);
  for (const warning of plan.warnings) console.log('Note: ' + warning);
  for (const c of plan.conflicts) console.log(`Conflict ${c.key}\n  current: ${JSON.stringify(c.current)}\n  proposed: ${JSON.stringify(c.proposed)} (${c.owner})`);
}
function loadPack(source, paths, namespace) {
  const fetched = source === 'deniz' ? { directory: path.join(ROOT, 'packs/deniz-agents'), source: 'deniz', revision: null } : fetchAgentSource(source, path.join(paths.kitConfig, 'cache'));
  return { ...readAgentPack(fetched.directory, { namespace: namespace ?? fetched.namespace }), source: fetched.source, revision: fetched.revision };
}
export async function main(argv = process.argv.slice(2)) {
  const o = parse(argv), [command = 'help', kind, argument] = o.positional;
  if (o.help || command === 'help') { console.log(help); return; }
  if (!supportedPlatform()) throw new Error('This installer supports Linux x86-64 only');
  const paths = policyPaths();
  if (command === 'list') { const items = listInstalled(paths); console.log(items.length ? items.map(c => `${c.id} ${c.version ?? ''} ${c.revision ?? ''}`).join('\n') : 'No kit components installed'); return; }
  if (command === 'recover') { recover(paths); console.log('Recovery complete; no pending installation'); return; }
  if (command === 'doctor') {
    const checks = await doctor(paths); checks.forEach(c => console.log(`${c.okay ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`));
    if (checks.some(c => !c.okay)) { process.exitCode = 1; return; }
    if (o.full) {
      const artifacts = fs.mkdtempSync('/var/tmp/opencode-kit-full-doctor-');
      try {
        const r = spawnSync('python3', [path.join(ROOT, 'test/opencode_integration.py')], { stdio: 'inherit', timeout: 180000, env: { ...process.env, OPENCODE_KIT_TEST_ARTIFACTS: artifacts, PYTHONDONTWRITEBYTECODE: '1' } });
        if (r.error || r.status !== 0) throw new Error('OpenCode local-model checks failed: ' + (r.error?.message ?? r.status));
      } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
    }
    return;
  }
  if (!['init', 'add', 'update', 'remove'].includes(command)) throw new Error('Unknown command: ' + command);
  const interactive = o.interactive || Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let prompts;
  try {
    const selection = { packs: [] };
    if (command === 'init' && !o.sandbox && !o.agents.length && !o.workflow && !o.usage) {
      if (!interactive) throw new Error('Select --sandbox, --agents SOURCE, --workflow or --usage; run init in a terminal for the menu');
      prompts = promptSession();
      const answer = await prompts.ask('Choose components:\n1. Sandbox + Deniz agents + workflow + usage (recommended)\n2. Sandbox only\n3. Deniz agents only\n4. Usage dashboard only\n5. Cancel');
      if (answer === '1') { o.sandbox = true; o.agents.push('deniz'); o.workflow = true; o.usage=true; }
      else if (answer === '2') o.sandbox = true;
      else if (answer === '3') o.agents.push('deniz');
      else if(answer==='4')o.usage=true;
      else { console.log('Cancelled'); return; }
    }
    if (command === 'add') {
      if (kind !== 'agents' || !argument) throw new Error('Usage: opencode-kit add agents SOURCE');
      o.agents.push(argument);
    }
    if (o.sandbox) selection.sandbox = true; if (o.workflow) selection.workflow = true; if (o.scratch) selection.scratchRoot = path.resolve(o.scratch);
    if(o.usage)selection.usage=true;
    const existing = installedSelection(paths);
    if (command === 'update') {
      if (kind && !listInstalled(paths).some(c => c.id === kind)) throw new Error('Component is not installed: ' + kind);
      o.agents.push(...existing.packs.filter(p => !kind || p.id === kind).map(p => p.source));
    }
    for (const source of o.agents) selection.packs.push(loadPack(source, paths, o.namespace));
    if (o.profile.length || o.escape.length || o.planningRoot.length) selection.profiles = structuredClone(existing.profiles ?? {});
    for (const [items, key] of [[o.profile, 'profile'], [o.escape, 'escape']]) for (const value of items) {
      const i = value.lastIndexOf('='); if (i < 1) throw new Error('Expected AGENT=VALUE');
      const id = value.slice(0, i); (selection.profiles[id] ??= {})[key] = value.slice(i + 1);
    }
    if (o.planningRoot.length) {
      const ids = new Set(['plan', ...selection.packs.flatMap(p => Object.keys(p.access).filter(id => p.access[id].profile === 'planner')),
        ...Object.keys(existing.profiles ?? {}).filter(id => existing.profiles[id].profile === 'planner')]);
      for (const id of ids) (selection.profiles[id] ??= {}).planningRoots = o.planningRoot;
    }
    if (selection.sandbox || existing.sandbox) checkCompatibility();
    if((selection.usage||existing.usage)&&!(command==='remove'&&kind==='usage'))checkUsageCompatibility();
    const resolutions = o.resolve ? JSON.parse(fs.readFileSync(o.resolve, 'utf8')) : {};
    const build = () => command === 'remove' ? planRemoval(paths, kind, resolutions) : planInstall(paths, selection, resolutions);
    let plan = build(); preview(plan);
    while (plan.conflicts.length && interactive) {
      prompts ??= promptSession(); const c = plan.conflicts[0];
      const answer = await prompts.ask(`Conflict at ${c.path.join('.')}\n1. Keep current (recommended)\n2. Replace with proposed${c.rename ? '\n3. Rename incoming agent' : ''}\n0. Cancel`);
      if (answer === '1') resolutions[c.key] = { action: 'keep' };
      else if (answer === '2') resolutions[c.key] = { action: 'replace' };
      else if (answer === '3' && c.rename) resolutions[c.key] = { action: 'rename', name: await prompts.ask('Enter new agent ID (for example friend/reviewer):') };
      else { console.log('Cancelled'); return; }
      plan = build(); preview(plan);
    }
    if (plan.conflicts.length) throw new Error('Unresolved conflicts; use the interactive menu or --resolve FILE with explicit choices');
    if (o.dryRun) { console.log('Dry-run: no configuration changed'); return; }
    let apply = o.apply;
    if (!apply && interactive) { prompts ??= promptSession(); apply = await prompts.ask('Apply this preview?\n1. Apply\n2. Cancel (recommended until reviewed)') === '1'; }
    if (!apply) { console.log('Preview only. Add --apply to apply this selection.'); return; }
    const result = applyPlan(plan); console.log(result.changed ? 'Applied. Backup: ' + result.backup : 'Already up to date');
    let restart = o.restart;
    if (!restart && interactive && result.changed) { prompts ??= promptSession(); restart = await prompts.ask('Restart OpenCode to load the changes?\n1. Restart\n2. Later') === '1'; }
    if (restart) {
      const r = spawnSync('opencode', ['service', 'restart'], { stdio: 'inherit', timeout: 30000 });
      if (r.error || r.status !== 0) throw new Error('Config applied, but OpenCode restart failed; restart manually');
    } else if (result.changed) console.log('Restart OpenCode before using the new settings.');
  } finally { prompts?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main().catch(error => { console.error('Error: ' + error.message); process.exitCode = 1; });
