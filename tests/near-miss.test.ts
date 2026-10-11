import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type { MockRule } from '../shared/types';
import { createBehavior, sequenceName } from '../shared/behavior';
import { actualRequest, applyUnmatched, diagnoseUnmatched, matchesPublished, variantMatchesRequest } from '../shared/near-miss';
import { requestMapping } from '../server/behavior-mapping';
import { validateRules } from '../server/rules';
import { MockRuntime } from '../server/runtime';

function rule(patch:Partial<MockRule>={}):MockRule{
  return {id:randomUUID(),dependencyId:'bank',name:'Bank',scenario:'Success',method:'POST',path:'/pay/{id}',service:{namespace:'bank',basePath:'/v1'},status:200,headers:{'Content-Type':'application/json'},body:{ok:true},delay:0,enabled:true,query:{},requestHeaders:{},basis:'Sample',version:1,...patch};
}
function request(patch:{method?:string;url?:string;headers?:Record<string,string>;body?:unknown;query?:string}={}){
  const url=(patch.url||'/__mockingbird/bank/v1/pay/p1')+(patch.query?'?'+patch.query:'');
  return actualRequest({method:patch.method||'POST',url,headers:patch.headers||{},...(patch.body===undefined?{}:{body:typeof patch.body==='string'?patch.body:JSON.stringify(patch.body)})});
}
const text = (ruleSet:MockRule[],sample=request(),states:Record<string,string>={}) => diagnoseUnmatched(sample,ruleSet,states);

test('Diagnosis ranks by path and method, then explains the failed clause',()=>{
  const post=rule({id:'post',name:'Post',requestBody:{currency:'CNY',amount:1}});
  const get=rule({id:'get',name:'Get',method:'GET'});
  const diagnosis=text([post,get],request({body:{currency:'USD',amount:2}}));
  assert.equal(diagnosis.scope,'ranked');
  assert.equal(diagnosis.candidates[0].ruleId,'post');
  assert.match(diagnosis.candidates[0].clauses.find(clause=>clause.id==='body')!.summary,/USD/);
  assert.equal(diagnosis.candidates.find(candidate=>candidate.ruleId==='get')!.clauses.find(clause=>clause.dimension==='method')!.status,'mismatch');
});

test('Extra header and query do not fail, while a different constrained value does',()=>{
  const open=rule({query:{status:'open'},requestHeaders:{'X-Case':'declined'}});
  const extra=text([open],request({headers:{'X-Case':'declined','X-Trace':'abc'},query:'status=open&trace=1'}));
  assert.equal(extra.candidates[0].failedClauses,0);
  assert.equal(extra.candidates[0].clauses.find(clause=>clause.id==='dim:header'),undefined);
  assert.equal(extra.candidates[0].clauses.some(clause=>clause.optional&&clause.id==='optional-header:x-trace'),true);
  const missed=text([open],request({headers:{'X-Case':'approved'},query:'status=closed'}));
  assert.match(missed.candidates[0].clauses.find(clause=>clause.id==='header:rule:x-case')!.summary,/approved/);
  assert.equal(missed.candidates[0].clauses.find(clause=>clause.id==='query:rule:status')!.status,'mismatch');
});

test('Partial JSON ignores extra fields and exact JSON reports them',()=>{
  const exact=rule({name:'Exact',requestBody:{currency:'CNY'}});
  const partial=rule({name:'Partial',requestBody:{currency:'CNY'},bodyMatchMode:'partial'});
  const sample=request({body:{currency:'CNY',trace:'t'}});
  assert.equal(text([exact],sample).candidates[0].clauses.find(clause=>clause.id==='body')!.status,'mismatch');
  assert.equal(text([exact],sample).candidates[0].clauses.find(clause=>clause.id==='body-mode')!.proposal!.defaultSelected,false);
  assert.equal(text([partial],sample).candidates[0].clauses.find(clause=>clause.id==='body')!.status,'match');
  assert.equal(variantMatchesRequest(sample,partial),true);
  assert.equal(variantMatchesRequest(sample,exact),false);
  const changed=request({body:{currency:'USD',amount:1}});
  const adopted=applyUnmatched([partial],changed,{},text([partial],changed).candidates[0].id,['body'],randomUUID());
  assert.deepEqual(adopted.rule.requestBody,{currency:'USD'});
  assert.equal(adopted.created,false);
  validateRules([adopted.rule]);
});

test('A disabled perfect match ranks ahead of an enabled header miss, and another service is ignored',()=>{
  const enabled=rule({id:'enabled',name:'Enabled',requestHeaders:{'X-Case':'declined'}});
  const disabled=rule({id:'disabled',name:'Disabled',enabled:false});
  const other=rule({id:'other',name:'Other',service:{namespace:'other',basePath:'/v1'}});
  const diagnosis=text([enabled,disabled,other],request({headers:{'X-Case':'approved'}}));
  assert.equal(diagnosis.candidates[0].ruleId,'disabled');
  assert.equal(diagnosis.candidates[0].clauses.find(clause=>clause.id==='enabled')!.status,'mismatch');
  assert.equal(diagnosis.candidates.some(candidate=>candidate.ruleId==='other'),false);
  assert.throws(()=>applyUnmatched([enabled,disabled],request({}),{},text([enabled,disabled],request({})).candidates.find(candidate=>candidate.ruleId==='disabled')!.id,['enabled'],randomUUID()),/冲突/);
});

test('No shared path compares only method and path, and a new rule keeps the old one',()=>{
  const original=rule({path:'/refund/{id}'});
  const diagnosis=text([original]);
  assert.equal(diagnosis.scope,'similar');
  assert.equal(diagnosis.candidates[0].clauses.find(clause=>clause.dimension==='body')!.status,'skipped');
  const adopted=applyUnmatched([original],request(),{},diagnosis.candidates[0].id,[],randomUUID());
  assert.equal(adopted.created,true);
  assert.equal(adopted.rule.method,'POST');
  assert.equal(adopted.rule.path,'/pay/p1');
  assert.equal(adopted.rule.enabled,false);
  assert.equal(adopted.rule.requestBody,undefined);
  assert.equal(original.path,'/refund/{id}');
  validateRules([original,adopted.rule]);
});

test('Unconstrained body fields stay unchecked, and secrets are not copied',()=>{
  const original=rule({requestHeaders:{Authorization:'secret-token'}});
  const sample=request({headers:{Authorization:'other-token'},body:{currency:'CNY'}});
  const diagnosis=text([original],sample);
  const header=diagnosis.candidates[0].clauses.find(clause=>clause.dimension==='header'&&!clause.optional)!;
  assert.equal(header.proposal,undefined);
  assert.doesNotMatch(header.summary,/secret-token|other-token/);
  const optional=diagnosis.candidates[0].clauses.find(clause=>clause.id==='optional-body:/currency')!;
  assert.equal(optional.proposal!.defaultSelected,false);
  const adopted=applyUnmatched([original],sample,{},diagnosis.candidates[0].id,[optional.id],randomUUID());
  assert.deepEqual(adopted.rule.requestBody,{currency:'CNY'});
  assert.equal(adopted.rule.bodyMatchMode,'partial');
  assert.equal(adopted.rule.requestHeaders.Authorization,'secret-token');
});

test('An exception can rank ahead of the base variant, and path or numeric conditions can be adopted',()=>{
  const base=rule({requestBody:{currency:'CNY'}});
  base.behavior=createBehavior(base);
  base.behavior.exceptions=[{id:'forced',name:'指定拒绝',conditions:[{source:'header',field:'X-Case',operator:'eq',value:'declined'}],overrides:{}}];
  const closer=text([base],request({headers:{'X-Case':'declined'},body:{currency:'USD'}}));
  assert.equal(closer.candidates[0].variantLabel,'例外 · 指定拒绝');
  const approved=request({headers:{'X-Case':'approved'},body:{currency:'CNY'}});
  const exception=text([base],approved).candidates.find(candidate=>candidate.variantLabel==='例外 · 指定拒绝')!;
  const header=exception.clauses.find(clause=>clause.dimension==='header'&&clause.status==='mismatch')!;
  const exceptionAdopted=applyUnmatched([base],approved,{},exception.id,[header.id],randomUUID());
  assert.equal(exceptionAdopted.rule.behavior!.exceptions[0].conditions[0].value,'approved');
  assert.equal(exceptionAdopted.rule.requestHeaders['X-Case'],undefined);
  validateRules([exceptionAdopted.rule]);
  const templated=rule({name:'Templated'});
  templated.behavior=createBehavior(templated);
  templated.behavior.matchers=[{source:'path',field:'id',operator:'eq',value:'u_001'}];
  const pathDiagnosis=text([templated],request({url:'/__mockingbird/bank/v1/pay/u_002'}));
  assert.equal(pathDiagnosis.candidates[0].pathMatched,true);
  const pathClause=pathDiagnosis.candidates[0].clauses.find(clause=>clause.dimension==='path'&&clause.status==='mismatch')!;
  assert.match(pathClause.summary,/u_002/);
  const pathAdopted=applyUnmatched([templated],request({url:'/__mockingbird/bank/v1/pay/u_002'}),{},pathDiagnosis.candidates[0].id,[pathClause.id],randomUUID());
  assert.equal(pathAdopted.rule.behavior!.matchers[0].value,'u_002');
  const numeric=rule({name:'Numeric',path:'/numeric'});
  numeric.behavior=createBehavior(numeric);
  numeric.behavior.matchers=[{source:'body',field:'/amount',operator:'gte',value:1000}];
  const numericDiagnosis=text([numeric],request({url:'/__mockingbird/bank/v1/numeric',body:{amount:999}}));
  const amount=numericDiagnosis.candidates[0].clauses.find(clause=>clause.summary.includes('999'))!;
  const numericAdopted=applyUnmatched([numeric],request({url:'/__mockingbird/bank/v1/numeric',body:{amount:999}}),{},numericDiagnosis.candidates[0].id,[amount.id],randomUUID());
  assert.equal(numericAdopted.rule.behavior!.matchers[0].operator,'gte');
  assert.equal(numericAdopted.rule.behavior!.matchers[0].value,999);
  validateRules([pathAdopted.rule,numericAdopted.rule]);
});

test('Finished sequence is reported separately from body, and ties stay side by side',()=>{
  const sequenced=rule({name:'Retry',method:'GET',path:'/retry'});
  sequenced.behavior=createBehavior(sequenced);
  sequenced.behavior.sequence={steps:[{name:'Down',status:503,overrides:{}},{name:'Up',status:200,overrides:{}}],end:'stop'};
  const sample=request({method:'GET',url:'/__mockingbird/bank/v1/retry'});
  const stopped=text([sequenced],sample,{[sequenceName(sequenced)]:'Finished'});
  assert.equal(stopped.candidates[0].failedClauses,0);
  assert.equal(stopped.candidates[0].clauses.find(clause=>clause.id==='sequence')!.status,'mismatch');
  assert.equal(stopped.candidates[0].clauses.find(clause=>clause.dimension==='body')!.status,'unconstrained');
  assert.equal(matchesPublished(sample,[sequenced],{[sequenceName(sequenced)]:'Finished'}),false);
  assert.equal(matchesPublished(sample,[sequenced],{[sequenceName(sequenced)]:'Started'}),true);
  const alpha=rule({id:'alpha',name:'Alpha',requestHeaders:{'X-A':'1'}});
  const beta=rule({id:'beta',name:'Beta',requestHeaders:{'X-B':'1'}});
  const tied=text([beta,alpha],request({headers:{'X-A':'2','X-B':'2'}}));
  assert.deepEqual(tied.candidates.map(candidate=>candidate.ruleId),['alpha','beta']);
  assert.equal(text([],request()).scope,'empty');
  assert.equal(text([rule({service:{namespace:'other',basePath:''}})],request()).scope,'outside');
});

test('Path decisions agree with the WireMock mapping',()=>{
  const plain=rule({path:'/orders'});
  const templated=rule();
  templated.behavior=createBehavior(templated);
  templated.behavior.matchers=[{source:'path',field:'id',operator:'eq',value:'u_001'}];
  const cases=[[plain,'/__mockingbird/bank/v1/orders',true],[rule(),'/__mockingbird/bank/v1/pay/p1',true],[rule(),'/__mockingbird/bank/v1/pay/p1/extra',false],[templated,'/__mockingbird/bank/v1/pay/u_002',false],[templated,'/__mockingbird/bank/v1/pay/u_001',true]] as const;
  for(const [candidate,pathname,expected] of cases){
    const mapping=requestMapping(candidate,candidate.behavior?.matchers||[]) as {urlPath?:string;urlPathPattern?:string};
    const wire=mapping.urlPath?mapping.urlPath===pathname:new RegExp('^'+mapping.urlPathPattern+'$').test(pathname);
    assert.equal(wire,expected,pathname);
    assert.equal(variantMatchesRequest(actualRequest({method:'POST',url:pathname}),candidate),expected,pathname);
  }
});

test('A real WireMock journal explains the same miss the server returned',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mb-near-miss-'));
  const runtime=new MockRuntime(path.resolve('runtime/wiremock-standalone-3.13.2.jar'),dir,()=>{});
  const socket=net.createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=(socket.address() as net.AddressInfo).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
  try{
    const partial=rule({name:'Partial',path:'/partial',requestBody:{currency:'CNY'},bodyMatchMode:'partial'});
    const headed=rule({name:'Headed',path:'/headed',requestHeaders:{'X-Case':'declined'}});
    const queried=rule({name:'Queried',path:'/queried',query:{status:'open'}});
    const sequenced=rule({name:'Retry',method:'GET',path:'/retry'});
    sequenced.behavior=createBehavior(sequenced);
    sequenced.behavior.sequence={steps:[{name:'Down',status:503,overrides:{}},{name:'Up',status:200,overrides:{}}],end:'stop'};
    await runtime.start(port,[partial,headed,queried,sequenced]);
    const base=`http://127.0.0.1:${port}/__mockingbird/bank/v1`;
    const post=(url:string,body:unknown,headers:Record<string,string>={})=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal((await post('/partial',{currency:'CNY',extra:true})).status,200);
    assert.equal((await post('/partial',{currency:'USD'})).status,404);
    assert.equal((await post('/headed',{},{'X-Case':'approved'})).status,404);
    assert.equal((await post('/queried?status=closed',{})).status,404);
    assert.equal((await fetch(base+'/retry')).status,503);
    assert.equal((await fetch(base+'/retry')).status,200);
    assert.equal((await fetch(base+'/retry')).status,404);
    const rules=[partial,headed,queried,sequenced];
    const states=await runtime.scenarioStates();
    const journal=await runtime.admin('requests') as {requests:Array<{wasMatched?:boolean;request:Parameters<typeof actualRequest>[0]&{url?:string}}>};
    for(const entry of journal.requests){
      if(String(entry.request.url||'').includes('/retry'))continue;
      const sample=actualRequest(entry.request);
      assert.equal(matchesPublished(sample,rules,states),Boolean(entry.wasMatched),JSON.stringify(entry.request));
    }
    const missed=journal.requests.filter(entry=>!entry.wasMatched).map(entry=>actualRequest(entry.request));
    const currency=missed.find(item=>item.pathname.endsWith('/partial'))!;
    assert.match(diagnoseUnmatched(currency,rules,states).candidates[0].clauses.find(clause=>clause.id==='body')!.summary,/USD/);
    const header=missed.find(item=>item.pathname.endsWith('/headed'))!;
    assert.match(diagnoseUnmatched(header,rules,states).candidates[0].clauses.find(clause=>clause.dimension==='header')!.summary,/approved/);
    const query=missed.find(item=>item.pathname.endsWith('/queried'))!;
    assert.match(diagnoseUnmatched(query,rules,states).candidates[0].clauses.find(clause=>clause.dimension==='query')!.summary,/closed/);
    const stopped=missed.find(item=>item.pathname.endsWith('/retry'))!;
    const sequence=diagnoseUnmatched(stopped,rules,states).candidates[0];
    assert.equal(sequence.clauses.find(clause=>clause.id==='sequence')!.status,'mismatch');
    assert.notEqual(sequence.clauses.find(clause=>clause.dimension==='body')!.status,'mismatch');
  }finally{await runtime.stop();await fs.rm(dir,{recursive:true,force:true});}
});
