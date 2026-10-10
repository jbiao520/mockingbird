import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type { MockRule } from '../shared/types';
import { caseRequest, createBehavior, getPointer, setPointer } from '../shared/behavior';
import { validateRules } from '../server/rules';
import { MockRuntime } from '../server/runtime';
import { BehaviorPreviewer } from '../server/behavior-preview';
import { exportMocks } from '../server/exports';
import { Workbench } from '../server/workbench';
import { declaredPaymentFlow } from './fixtures';
import { loadWorkspace } from '../server/storage';

const jar=path.resolve('runtime/wiremock-standalone-3.13.2.jar');
async function port(){const s=net.createServer();await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));const p=(s.address() as net.AddressInfo).port;await new Promise<void>(resolve=>s.close(()=>resolve()));return p;}
function rule(patch:Partial<MockRule>={}):MockRule{return{id:randomUUID(),dependencyId:'bank',name:'Bank',scenario:'Behavior',method:'POST',path:'/pay/{id}',status:200,headers:{'Content-Type':'application/json'},body:{userId:'sample',amount:0,approved:true,id:'sample',copy:'sample',trace:'sample',query:'sample',path:'sample',time:'sample',items:[],literal:'{{unknown-helper}}'},delay:0,enabled:true,query:{},requestHeaders:{},basis:'Sample',version:1,...patch};}
function dynamic(){const r=rule();r.behavior=createBehavior(r);r.behavior.sample={path:'/pay/p123?q=hello',headers:{'X-Trace':'trace123'},body:{userId:'u"\\\n测试',amount:88,items:[{ok:false,count:0}]}};r.behavior.bindings=[
  ...['userId','amount','items'].map(field=>({target:'/'+field,value:{kind:'request' as const,source:'body' as const,field:'/'+field,fallback:getPointer(r.body,'/'+field)}})),
  {target:'/trace',value:{kind:'request',source:'header',field:'X-Trace',fallback:'no-trace'}},
  {target:'/query',value:{kind:'request',source:'query',field:'q',fallback:'no-query'}},
  {target:'/path',value:{kind:'request',source:'path',field:'id',fallback:'no-path'}},
  {target:'/id',value:{kind:'uuid',variable:'transactionId'}},{target:'/copy',value:{kind:'uuid',variable:'transactionId'}},
  {target:'/time',value:{kind:'now'}},
  {target:'/approved',value:{kind:'condition',condition:{source:'body',field:'/amount',operator:'lt',value:1000},then:true,otherwise:false}}
];return r;}

test('Behavior validation preserves old rules, checks unsafe paths and prevents ambiguous targets',()=>{
  const legacy=rule();assert.equal(validateRules([legacy])[0].behavior,undefined);
  const r=dynamic();assert.equal(validateRules([r])[0].behavior?.schemaVersion,1);
  const bad=structuredClone(r);bad.behavior!.bindings[0].target='/does-not-exist';assert.throws(()=>validateRules([bad]),/字段不存在/);
  bad.behavior!.bindings[0].target='/__proto__/polluted';assert.throws(()=>validateRules([bad]));assert.equal(({} as any).polluted,undefined);
  assert.throws(()=>setPointer({a:{}},'/a/__proto__',{bad:true}));
  const overlap=structuredClone(r);overlap.behavior!.bindings.push(overlap.behavior!.bindings[0]);assert.throws(()=>validateRules([overlap]),/重复/);
  const invalid=structuredClone(r);invalid.behavior!.matchers=[{source:'header',field:'Amount',operator:'gt',value:1000}];assert.throws(()=>validateRules([invalid]),/Body 数字/);
  assert.throws(()=>validateRules([r,{...r,id:randomUUID()}]),/冲突/);
  assert.equal(validateRules([r,{...r,id:randomUUID(),priority:10}]).length,2);
  const sample=caseRequest({path:'/x',headers:{base:'a'},body:{nested:{one:1,two:2},list:[1]}},{id:'case',name:'Case',patch:{headers:{other:'b'},body:{nested:{one:9},list:[2]}},expected:{},calls:1});
  assert.deepEqual(sample.body,{nested:{one:9,two:2},list:[2]});assert.deepEqual(sample.headers,{base:'a',other:'b'});
});

test('Actual WireMock renders typed request values, reused IDs, defaults, branches, partial JSON and exceptions',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mb-behavior-runtime-')),runtime=new MockRuntime(jar,dir,()=>{}),p=await port();
  try{
    const r=dynamic();r.service={namespace:'bank',basePath:'/v1'};
    r.behavior!.sample.path='/pay/p123?q=hello';
    r.behavior!.exceptions=[{id:'forced',name:'指定拒绝',conditions:[{source:'header',field:'X-Mock-Case',operator:'eq',value:'declined'}],overrides:{'/approved':false}}];
    const partial=rule({path:'/partial',requestBody:{currency:'CNY'},bodyMatchMode:'partial',body:{ok:true}});
    const numeric=rule({path:'/numeric',body:{ok:true}});numeric.behavior=createBehavior(numeric);numeric.behavior.matchers=[{source:'body',field:'/amount',operator:'gte',value:1000}];
    await runtime.start(p,[r,partial,numeric]);
    const base=`http://127.0.0.1:${p}`,endpoint=base+'/__mockingbird/bank/v1/pay/p123?q=hello';
    const post=(url:string,body:unknown,headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    const input=r.behavior!.sample.body;
    const response=await post(endpoint,input,{'x-trace':'trace123'});assert.equal(response.status,200);const a=await response.json();
    assert.equal(a.userId,(input as any).userId);assert.equal(a.amount,88);assert.deepEqual(a.items,[{ok:false,count:0}]);assert.equal(a.approved,true);assert.equal(a.id,a.copy);assert.match(a.id,/^[\da-f-]{36}$/);assert.equal(a.trace,'trace123');assert.equal(a.query,'hello');assert.equal(a.path,'p123');assert.equal(a.literal,'{{unknown-helper}}');assert(Number.isFinite(Date.parse(a.time)));
    const b=await (await post(endpoint,{amount:1000,userId:'u2'})).json();assert.equal(b.approved,false);assert.notEqual(a.id,b.id);assert.equal(b.trace,'no-trace');assert.deepEqual(b.items,[]);
    const edge=rule({path:'/edge',body:{exists:false,boolean:true,nil:null,items:[]}});edge.behavior=createBehavior(edge);edge.behavior.bindings=[{target:'/exists',value:{kind:'condition',condition:{source:'body',field:'/foo',operator:'exists'},then:true,otherwise:false}},...['boolean','nil','items'].map(field=>({target:'/'+field,value:{kind:'request' as const,source:'body' as const,field:'/'+field,fallback:getPointer(edge.body,'/'+field)}}))];
    await runtime.publish([r,partial,numeric,edge]);
    assert.deepEqual(await (await post(base+'/edge',{})).json(),{exists:false,boolean:true,nil:null,items:[]});
    assert.deepEqual(await (await post(base+'/edge',{foo:false,boolean:false,nil:null,items:[]})).json(),{exists:true,boolean:false,nil:null,items:[]});
    const forced=await (await post(endpoint,input,{'X-Mock-Case':'declined'})).json();assert.equal(forced.approved,false);assert.equal(forced.amount,88);
    assert.equal((await post(base+'/partial',{currency:'CNY',extra:true})).status,200);assert.equal((await post(base+'/partial',{currency:'USD'})).status,404);
    assert.equal((await post(base+'/numeric',{amount:1000})).status,200);assert.equal((await post(base+'/numeric',{amount:999})).status,404);
    const logs=await runtime.requests();assert(logs.some(log=>log.ruleId===r.id&&log.rule?.includes('指定拒绝')));
    const exported=JSON.parse(exportMocks([r],'wiremock').content);assert.equal(exported.mappings.length,2);await runtime.admin('mappings/import','POST',{...exported,importOptions:{deleteAllNotInImport:true}});assert.equal((await post(endpoint,input)).status,200);
    const postman=JSON.parse(exportMocks([r],'postman').content);assert.match(postman.item[0].request.description,/基础响应样本/);assert.equal(JSON.parse(postman.item[0].request.body.raw).amount,88);
  }finally{await runtime.stop();await fs.rm(dir,{recursive:true,force:true});}
});

test('Preview uses isolated state; sequences hold, reset, preserve on publish, loop and stop',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mb-sequence-runtime-')),runtime=new MockRuntime(jar,dir,()=>{}),p=await port();
  const previewer=new BehaviorPreviewer(jar);
  try{
    const r=rule({method:'GET',path:'/retry',body:{ok:true}});r.behavior=createBehavior(r);r.behavior.sequence={steps:[{name:'Unavailable',status:503,overrides:{}},{name:'Recovered',status:200,overrides:{}}],end:'hold'};
    await runtime.start(p,[r]);const url=`http://127.0.0.1:${p}/retry`;
    assert.equal((await fetch(url)).status,503);
    const reports=await previewer.run([r],r.id,[{id:'retry',name:'Retry',patch:{},expected:{matched:true,status:200},calls:2}]);assert.equal(reports[0].passed,true);assert.deepEqual(reports[0].calls.map(c=>c.status),[503,200]);
    const disabled={...r,id:randomUUID(),enabled:false,scenario:'Draft'};
    const draftReports=await previewer.run([r,disabled],disabled.id);assert.equal(draftReports[0].passed,true);assert.deepEqual(draftReports[0].calls.map(c=>c.status),[503,200]);
    // Preview must not reset the already-progressed live runtime.
    assert.equal((await fetch(url)).status,200);await runtime.publish([r]);assert.equal((await fetch(url)).status,200);
    await runtime.resetSequence(r);assert.equal((await fetch(url)).status,503);
    r.behavior.sequence.end='loop';await runtime.publish([r]);assert.deepEqual(await Promise.all([fetch(url).then(r=>r.status)]),[503]);assert.equal((await fetch(url)).status,200);assert.equal((await fetch(url)).status,503);
    r.behavior.sequence.end='stop';await runtime.publish([r]);assert.equal((await fetch(url)).status,503);assert.equal((await fetch(url)).status,200);assert.equal((await fetch(url)).status,404);
    const fault=rule({path:'/fault',method:'GET',body:{}});fault.behavior=createBehavior(fault);fault.behavior.fault='EMPTY_RESPONSE';await runtime.publish([fault]);await assert.rejects(fetch(`http://127.0.0.1:${p}/fault`));const journal=await runtime.requests();assert.equal(journal[0].status,0);assert.equal(journal[0].fault,'EMPTY_RESPONSE');
  }finally{await previewer.close();await runtime.stop();await fs.rm(dir,{recursive:true,force:true});}
});

test('Saving behavior validates rendered DTO and cases before publishing, and persists the complete behavior',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mb-behavior-save-')),project=path.join(dir,'project');
  const bench=new Workbench({root:process.cwd(),dataDir:path.join(dir,'data')});
  try{
    await fs.cp('examples/payment-service',project,{recursive:true,filter:f=>!f.includes('/target')&&!f.includes('/.mockingbird')});await bench.init();await bench.importProject(project);
    const wf=declaredPaymentFlow(bench.index!,await bench.analyzeEntry(bench.workspace.project!.entries[0].id));
    const rules=bench.generate(wf.dependencies.map(d=>d.id),'Success');const bank=rules.find(r=>r.name.includes('Bank'))!;bank.behavior=createBehavior(bank);bank.behavior.sample={path:bank.path,headers:{},body:{approved:true}};
    bank.behavior.bindings=[{target:'/approved',value:{kind:'request',source:'body',field:'/approved',fallback:true}}];
    bank.behavior.cases=[{id:'accepted',name:'Approved',patch:{},expected:{matched:true,status:200,fields:{'/approved':true}},calls:1}];
    await bench.setRules(rules);const loaded=await loadWorkspace(project);assert.deepEqual(loaded.rules.find(r=>r.id===bank.id)?.behavior,bank.behavior);
    const broken=structuredClone(bench.workspace.rules);const bad=broken.find(r=>r.id===bank.id)!;bad.behavior!.sample.body={approved:'wrong-type'};
    await assert.rejects(()=>bench.setRules(broken),/行为验证未通过/);assert.equal((bench.workspace.rules.find(r=>r.id===bank.id)!.behavior!.sample.body as any).approved,true);
    const mismatch=structuredClone(bench.workspace.rules);mismatch.find(r=>r.id===bank.id)!.behavior!.cases[0].expected.fields={'/approved':false};await assert.rejects(()=>bench.setRules(mismatch),/期望不同/);
  }finally{await bench.close();await fs.rm(dir,{recursive:true,force:true});}
});
