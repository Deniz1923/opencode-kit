import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cases} from '../evals/cases.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const solutions={
  bug:{'range.mjs':'export function sumRange(a,b){let n=0;for(let i=a;i<=b;i++)n+=i;return n;}'},
  api:{
    'money.mjs':"export const formatPrice=(n,{currency='USD'}={})=>`${currency} ${n.toFixed(2)}`;",
    'receipt.mjs':"import {formatPrice} from './money.mjs';export const receipt=(n,currency)=>'Total: '+formatPrice(n,{currency});",
    'money.test.mjs':"import {formatPrice} from './money.mjs';import assert from 'node:assert/strict';assert.equal(formatPrice(12,{currency:'EUR'}),'EUR 12.00');",
  },
  build:{'cli.mjs':"import {sum} from './math.mjs';console.log(sum(2,3));"},
  multistep:{
    'names.mjs':"export const joinNames=(names,{separator=', ',prefix=''}={})=>names.length?prefix+names.join(separator):'';",
    'cli.mjs':"import fs from 'node:fs';import {joinNames} from './names.mjs';console.log(joinNames(process.argv.slice(2),JSON.parse(fs.readFileSync(new URL('./settings.json',import.meta.url),'utf8'))));",
  },
  review:{'findings.json':JSON.stringify([
    {file:'invoice.mjs',line:2,trigger:{price:10,quantity:0,discountPercent:0},expected:0,actual:10},
    {file:'invoice.mjs',line:3,trigger:{price:100,quantity:1,discountPercent:20},expected:80,actual:-1900},
  ])},
  resume:{'slug.mjs':"export function slug(text,maxLength){if(maxLength!==undefined&&(!Number.isInteger(maxLength)||maxLength<=0))throw new RangeError();const s=text.trim().toLowerCase().replace(/\\s+/g,'-');return maxLength===undefined?s:s.slice(0,maxLength);}"},
};

test('every coding evaluation rejects its seeded defect and accepts a valid solution',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kit-evals-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const [id,task] of Object.entries(cases)){
    const broken=path.join(dir,id+'-broken'),fixed=path.join(dir,id+'-fixed');
    for(const target of [broken,fixed]){
      fs.mkdirSync(target);
      for(const [name,text] of Object.entries(task.files))fs.writeFileSync(path.join(target,name),text);
    }
    await assert.rejects(()=>task.check(broken),id+' must reject the initial fixture');
    for(const [name,text] of Object.entries(solutions[id]))fs.writeFileSync(path.join(fixed,name),text);
    await task.check(fixed);
  }
});

test('evaluation preparation refuses overwrites and supports the compaction stages',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kit-eval-cli-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const target=path.join(dir,'project');
  const run=(...args)=>spawnSync(process.execPath,['evals/run.mjs',...args],{cwd:root,encoding:'utf8'});
  assert.equal(run('prepare','resume',target).status,0);
  const marker=path.join(target,'keep');fs.writeFileSync(marker,'keep');
  assert.notEqual(run('prepare','resume',target).status,0);
  assert.equal(fs.readFileSync(marker,'utf8'),'keep');
  fs.writeFileSync(path.join(target,'slug.mjs'),solutions.resume['slug.mjs']);
  assert.equal(run('check','resume',target,'--stage1').status,0);
  assert.equal(run('check','resume',target).status,0);
  assert.match(run('followup','resume',target).stdout,/maxLength/);
  assert.notEqual(run('check','bug',target,'--stage1').status,0);
});
