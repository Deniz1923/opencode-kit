import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {policyPaths} from '../policy.mjs';
import {planInstall,planRemoval,applyPlan,listInstalled} from '../kit/install.mjs';
import {parseConfig} from '../kit/compose.mjs';

const source=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t,initial){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kit-ponytail-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const paths=policyPaths(home,{});fs.mkdirSync(paths.configDir,{recursive:true});
  const config=path.join(paths.configDir,'opencode.json');fs.writeFileSync(config,JSON.stringify(initial));
  return {paths,config,read:()=>parseConfig(fs.readFileSync(config,'utf8'))};
}
test('Ponytail installs independently, preserves other skills and agents, and removes cleanly',t=>{
  const initial={model:'mine/model',skills:['/my/team-skills','/other/skills','/my/team-skills'],agents:{'friend/build':{system:'My prompt'},chat:{permissions:[{action:'skill',resource:'*',effect:'deny'}]}}};
  const f=fixture(t,initial);applyPlan(planInstall(f.paths,{ponytail:true}));
  let c=f.read();assert.equal(c.skills.length,4);assert.deepEqual(c.skills.slice(0,-1),initial.skills);
  assert.deepEqual(c.agents,initial.agents);assert.equal(c.model,initial.model);assert.ok(!c.plugins);assert.ok(!c.permissions);
  assert.ok(listInstalled(f.paths).some(x=>x.id==='ponytail'&&x.version==='5.3.3'));
  const base=c.skills.at(-1);assert.ok(fs.existsSync(path.join(base,'ponytail/SKILL.md')));
  assert.ok(fs.readFileSync(path.join(base,'../LICENSE'),'utf8').includes('DietrichGebert'));
  assert.equal(applyPlan(planInstall(f.paths)).changed,false);
  applyPlan(planRemoval(f.paths,'ponytail'));assert.deepEqual(f.read(),initial);
});
test('Ponytail coexists with sandbox and usage and survives removing those components',t=>{
  const f=fixture(t,{});applyPlan(planInstall(f.paths,{sandbox:true,usage:true,ponytail:true}));
  let c=f.read();assert.equal(c.skills.length,1);assert.ok(c.plugins.length>=2);
  applyPlan(planRemoval(f.paths,'sandbox'));assert.equal(f.read().skills.length,1);
  applyPlan(planRemoval(f.paths,'usage'));assert.equal(f.read().skills.length,1);
  applyPlan(planRemoval(f.paths,'ponytail'));assert.deepEqual(f.read(),{});
});
test('removing Ponytail preserves skills added after installation and rejects invalid legacy sources',t=>{
  const f=fixture(t,{});applyPlan(planInstall(f.paths,{ponytail:true}));
  const c=f.read();c.skills.push('/later/team-skills');fs.writeFileSync(f.config,JSON.stringify(c));
  applyPlan(planRemoval(f.paths,'ponytail'));assert.deepEqual(f.read().skills,['/later/team-skills']);
  const bad=fixture(t,{skills:{paths:['/legacy']}});
  assert.throws(()=>planInstall(bad.paths,{ponytail:true}),/V2 skills array/);
  assert.deepEqual(bad.read(),{skills:{paths:['/legacy']}});
});
test('bundled Ponytail contains only three self-contained skills and keeps main mode explicit',()=>{
  const dir=path.join(source,'integrations/ponytail');
  assert.deepEqual(fs.readdirSync(path.join(dir,'skills')).sort(),['ponytail','ponytail-audit','ponytail-review']);
  for(const id of ['ponytail','ponytail-review','ponytail-audit']){
    const text=fs.readFileSync(path.join(dir,'skills',id,'SKILL.md'),'utf8');
    const meta=parse(/^---\n([\s\S]*?)\n---/.exec(text)[1]);assert.equal(meta.name,id);assert.ok(meta.description);
    assert.equal(meta.metadata?.['opencode/autoinvoke'],id==='ponytail'?false:undefined);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'PROVENANCE.json'))).version,'5.3.3');
  assert.ok(!fs.existsSync(path.join(dir,'index.js')));
});
