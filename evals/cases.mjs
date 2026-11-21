import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const load = (root, file) => import(pathToFileURL(path.join(root, file)).href);
const run = (root, ...args) => {
  const env={...process.env}; delete env.NODE_TEST_CONTEXT;
  return execFileSync(process.execPath, args, {cwd: root, env, stdio: 'pipe', encoding: 'utf8', timeout: 10000}).trim();
};
export const cases = {
  bug: {
    prompt: 'Fix sumRange so it sums both endpoints, including negative ranges. An inverted range returns 0. Preserve the exported API and run the existing tests.',
    files: {
      'range.mjs': 'export function sumRange(start, end) { let total = 0; for (let n = start; n < end; n++) total += n; return total; }\n',
      'range.test.mjs': "import {sumRange} from './range.mjs'; import assert from 'node:assert/strict'; assert.equal(sumRange(1,3),6); assert.equal(sumRange(2,2),2);\n",
    },
    async check(root) {
      const {sumRange} = await load(root, 'range.mjs');
      for (const [a,b,expected] of [[1,3,6],[2,2,2],[-3,-1,-6],[3,1,0],[0,0,0]]) assert.equal(sumRange(a,b),expected);
      run(root, '--test', 'range.test.mjs');
    },
  },
  api: {
    prompt: 'Change formatPrice to accept an options object as its second argument: {currency}, default USD. Update receipt and all existing callers/tests. Keep receipt(amount, currency) working. EUR 12 must render EUR 12.00; no currency means USD. Verify the result.',
    files: {
      'money.mjs': "export const formatPrice = (amount, currency = 'USD') => `${currency} ${amount.toFixed(2)}`;\n",
      'receipt.mjs': "import {formatPrice} from './money.mjs'; export const receipt = (amount, currency) => 'Total: ' + formatPrice(amount, currency);\n",
      'money.test.mjs': "import {formatPrice} from './money.mjs'; import assert from 'node:assert/strict'; assert.equal(formatPrice(12,'EUR'),'EUR 12.00');\n",
    },
    async check(root) {
      const {formatPrice} = await load(root,'money.mjs'), {receipt} = await load(root,'receipt.mjs');
      assert.equal(formatPrice(12,{currency:'EUR'}),'EUR 12.00');
      assert.equal(formatPrice(0),'USD 0.00');
      assert.equal(receipt(12,'EUR'),'Total: EUR 12.00');
      assert.equal(receipt(0),'Total: USD 0.00');
      run(root,'--test','money.test.mjs');
    },
  },
  build: {
    prompt: 'npm run build fails. Diagnose and fix it so npm start prints 5. Preserve the public exports in math.mjs. Run both commands and report the cause and outcomes.',
    files: {
      'package.json': JSON.stringify({private:true,scripts:{build:'node cli.mjs',start:'node cli.mjs'}})+'\n',
      'math.mjs': 'export const sum = (a,b) => a+b;\n',
      'cli.mjs': "import {add} from './math.mjs'; console.log(add(2,3));\n",
    },
    async check(root) {
      assert.equal(run(root,'cli.mjs'),'5');
      assert.equal(fs.readFileSync(path.join(root,'math.mjs'),'utf8'),cases.build.files['math.mjs']);
    },
  },
  multistep: {
    prompt: 'Implement joinNames(names, {separator, prefix}) with defaults separator=", " and prefix="". Empty names produces "". Update the CLI to read options from settings.json, accept names as arguments, and print the result. Keep the library usable without CLI side effects. Run relevant verification; finish the implementation rather than only describing steps.',
    files: {
      'names.mjs': 'export const joinNames = names => names.join(", ");\n',
      'cli.mjs': "import {joinNames} from './names.mjs'; console.log(joinNames(process.argv.slice(2)));\n",
      'settings.json': '{"separator":" / ","prefix":"Team: "}\n',
    },
    async check(root) {
      const {joinNames} = await load(root,'names.mjs');
      assert.equal(joinNames(['Ada','Lin']),'Ada, Lin');
      assert.equal(joinNames(['Ada','Lin'],{separator:' & ',prefix:'Hi '}),'Hi Ada & Lin');
      assert.equal(joinNames([],{prefix:'Hi '}),'');
      assert.equal(run(root,'cli.mjs','Ada','Lin'),'Team: Ada / Lin');
      const settings = fs.readFileSync(path.join(root,'settings.json'),'utf8');
      fs.writeFileSync(path.join(root,'settings.json'),'{"separator":"+","prefix":""}\n');
      try { assert.equal(run(root,'cli.mjs','A','B'),'A+B'); }
      finally { fs.writeFileSync(path.join(root,'settings.json'),settings); }
    },
  },
  review: {
    prompt: 'Review invoice.mjs without modifying it. Identify concrete calculation bugs. Write findings.json as an array with one entry per bug: {file, line, trigger, expected, actual}. trigger must contain numeric price, quantity, discountPercent. Give a brief explanation in your final answer. Report only bugs you can demonstrate.',
    files: {
      'invoice.mjs': 'export function invoice(price, quantity, discountPercent) {\n  const total = price * (quantity || 1);\n  return total * (1 - discountPercent);\n}\n',
    },
    async check(root) {
      assert.equal(fs.readFileSync(path.join(root,'invoice.mjs'),'utf8'),cases.review.files['invoice.mjs']);
      const findings=JSON.parse(fs.readFileSync(path.join(root,'findings.json'),'utf8'));
      assert.ok(Array.isArray(findings) && findings.length===2,'Report both bugs, without extra false positives');
      const {invoice}=await load(root,'invoice.mjs');
      for(const f of findings){
        assert.equal(f.file,'invoice.mjs'); assert.ok([2,3].includes(f.line));
        const t=f.trigger; for(const v of [t.price,t.quantity,t.discountPercent,f.expected,f.actual]) assert.ok(Number.isFinite(v));
        assert.equal(f.actual,invoice(t.price,t.quantity,t.discountPercent));
        assert.equal(f.expected,t.price*t.quantity*(1-t.discountPercent/100));
        assert.notEqual(f.expected,f.actual);
      }
      assert.deepEqual(findings.map(f=>f.line).sort(),[2,3]);
    },
  },
  resume: {
    prompt: 'Implement slug(text): trim, lowercase, replace runs of whitespace with a hyphen, and preserve underscores. Add tests and verify. Do not change any other behavior without a request.',
    followup: 'Now add optional maxLength as the second argument to slug. It must be a positive integer when provided; otherwise throw RangeError. Truncate the normalized slug to that length. Keep the original behavior when omitted, including preserving underscores. Add verification and complete the change.',
    files: {'slug.mjs':'export const slug = text => text;\n'},
    async check(root,stage1=false) {
      const {slug}=await load(root,'slug.mjs');
      assert.equal(slug('  A_B   C  '),'a_b-c'); assert.equal(slug(''),'');
      if(!stage1){
        assert.equal(slug('HELLO WORLD',5),'hello');
        for(const n of [0,-1,1.5,NaN])assert.throws(()=>slug('abc',n),RangeError);
      }
    },
  },
};
