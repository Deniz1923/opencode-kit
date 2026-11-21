import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cases } from './cases.mjs';

const [action,id,directory,stage] = process.argv.slice(2);
if (process.argv.length>6 || !['prepare','check','followup'].includes(action) || !Object.hasOwn(cases,id) || !directory || (stage && !(action==='check' && id==='resume' && stage==='--stage1'))) {
  console.error('Usage: node evals/run.mjs prepare|check|followup CASE NEW_DIRECTORY [--stage1]\nCases: '+Object.keys(cases).join(', '));
  process.exit(2);
}
const task=cases[id], root=path.resolve(directory);
if(action==='prepare'){
  // Never overwrite an existing checkout or an earlier model's results.
  fs.mkdirSync(root);
  try{
    for(const [name,text] of Object.entries(task.files))fs.writeFileSync(path.join(root,name),text,{flag:'wx'});
    const result=spawnSync('git',['init','--quiet',root],{encoding:'utf8'});
    if(result.error || result.status!==0)throw new Error(result.error?.message || result.stderr);
    console.log(task.prompt);
    console.log('\nWorkspace: '+root);
  }catch(error){console.error('Preparation failed; inspect '+root+' before removing it.');throw error;}
}else if(action==='followup'){
  if(!task.followup)throw new Error('This case has no follow-up');
  console.log(task.followup);
}else{
  if(!fs.statSync(root).isDirectory())throw new Error('Workspace must be a directory');
  await task.check(root,stage==='--stage1');
  console.log('PASS '+id+(stage?' stage 1':''));
}
