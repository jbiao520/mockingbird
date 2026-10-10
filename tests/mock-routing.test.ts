import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { dependencyService, mockBaseUrl, mockRequestPath } from '../shared/mock-routing';
import { blockedInGroup, overlaps, setScenarioEnabled } from '../shared/rule-groups';
import { analyze, indexProject } from '../server/analyzer';
import { generateRules, mapping, validateRules } from '../server/rules';
import { routePreview } from '../server/routes';
import { exportMocks } from '../server/exports';
import { emptyWorkspace } from '../server/storage';
import { Workbench } from '../server/workbench';
import { declaredPaymentFlow, paymentDependencies } from './fixtures';

async function fixture(){
  const index=await indexProject('examples/payment-service');
  const wf=declaredPaymentFlow(index,analyze(index,index.project.entries[0].id));
  return{index,wf};
}

test('Routing and mappings use the same service prefix and base path, including trailing slashes',async()=>{
  const {index,wf}=await fixture(),dep=wf.dependencies[0];
  const ws=emptyWorkspace();ws.project=index.project;ws.workflows=[wf];wf.dependencies=[dep];dep.route='mock';
  for(const [base,basePath] of [
    ['https://service',''],['https://service/',''],['https://service/v1','/v1'],
    ['https://service/v1/','/v1'],['https://service/v1/internal/','/v1/internal'],
    ['https://service/api.v1+(test)','/api.v1+(test)'],['https://service/api%20v1','/api%20v1']
  ]){
    dep.originalBase=base;
    const rule=generateRules([dep],index)[0],preview=await routePreview(ws,9090);
    assert.equal(rule.path,dep.path);
    assert.equal(rule.service?.basePath,basePath);
    const expected=`/__mockingbird/config-services.user.url${basePath}/users/123`;
    const actualPath=new URL(preview.changes[0].after+dep.path.replace('{userId}','123')).pathname;
    assert.equal(actualPath,expected);
    assert.equal(mockRequestPath(rule).replace('{userId}','123'),actualPath);
    const request=mapping(rule).request;assert('urlPathPattern' in request);
    assert(new RegExp('^'+request.urlPathPattern+'$').test(actualPath));
    assert(!new RegExp('^'+request.urlPathPattern+'$').test(actualPath+'/extra'));
    assert(!new RegExp('^'+request.urlPathPattern+'$').test(actualPath.replace('services.user.url','servicesXuserXurl')));
    const literal={...rule,path:'/health'};
    const literalRequest=mapping(literal).request;assert('urlPath' in literalRequest);
    assert.equal(literalRequest.urlPath,mockRequestPath(literal));
  }
});

test('Different services can share an endpoint while calls sharing a configuration still conflict',async()=>{
  const {index,wf}=await fixture(),first=wf.dependencies[0];
  first.originalBase='https://first.example/v1';
  const second={...first,id:randomUUID(),name:'Second service',configKey:'services.other.url',originalBase:'https://second.example/v1'};
  const [a,b]=generateRules([first,second],index);
  assert.equal(validateRules([a,b]).length,2);assert.equal(overlaps(a,b),false);assert.deepEqual(blockedInGroup([a,b]),[]);
  const enabled=setScenarioEnabled([{...a,enabled:false},{...b,enabled:false}],'Success',true);
  assert.deepEqual(enabled.rules.map(rule=>rule.enabled),[true,true]);assert.deepEqual(enabled.skipped,[]);
  const alias={...first,id:randomUUID()},duplicate=generateRules([alias],index,'Error')[0];
  assert.equal(overlaps(a,duplicate),true);assert.throws(()=>validateRules([a,duplicate]),/冲突/);
  const selected=setScenarioEnabled([a,b,{...duplicate,enabled:false}],'Error',true);
  assert.deepEqual(selected.rules.map(rule=>rule.enabled),[false,true,true]);
  const forged={...duplicate,service:{namespace:'forged',basePath:'/other'}};
  assert.throws(()=>validateRules([a,forged],[first,alias]),/冲突/);
  // Rules saved before service metadata existed are bound before conflict checks.
  assert.equal(validateRules([{...a,service:undefined},{...b,service:undefined}],[first,second]).length,2);
  assert.equal(dependencyService(first)?.namespace,dependencyService(alias)?.namespace);
  const hardcodedA={...first,configKey:undefined},hardcodedB={...second,configKey:undefined};
  assert.notEqual(dependencyService(hardcodedA)?.namespace,dependencyService(hardcodedB)?.namespace);
});

test('WireMock and Postman exports retain the full routed path',async()=>{
  const {index,wf}=await fixture(),dep=wf.dependencies[0];dep.originalBase='https://service/v1';
  const rule=generateRules([dep],index)[0],legacy={...rule,service:undefined};
  const wire=JSON.parse(exportMocks([legacy],'wiremock','Users',9090,false,[dep]).content);
  assert.deepEqual(wire.mappings[0],mapping(rule));
  const postman=JSON.parse(exportMocks([legacy],'postman','Users',9090,false,[dep]).content);
  assert.equal(postman.item[0].request.url.raw,'{{baseUrl}}/__mockingbird/config-services.user.url/v1/users/:userId');
  assert.deepEqual(postman.item[0].request.url.path,['__mockingbird','config-services.user.url','v1','users',':userId']);
});

test('Routing rejects inconsistent bases under a shared configuration key',async()=>{
  const {index,wf}=await fixture(),dep=wf.dependencies[0];
  const ws=emptyWorkspace();ws.project=index.project;ws.workflows=[wf];
  wf.dependencies=[{...dep,route:'mock'},{...dep,id:randomUUID(),route:'mock',originalBase:dep.originalBase+'/v2'}];
  await assert.rejects(()=>routePreview(ws,9090),/基础地址不一致/);
});

test('Real WireMock isolates identical endpoints and survives rule edits, legacy reload',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-routing-')),project=path.join(root,'project');
  await fs.cp('examples/payment-service',project,{recursive:true,filter:file=>!file.split(path.sep).some(part=>['target','.mockingbird'].includes(part))});
  await fs.appendFile(path.join(project,'src/main/resources/application.properties'),'\nservices.user.url=https://first.example/v1\nservices.other.url=https://second.example/v1\nservices.alias.url=https://first.example/v2\n');
  const bench=new Workbench({root:process.cwd(),dataDir:path.join(root,'data')});
  const socket=net.createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=(socket.address() as net.AddressInfo).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
  try{
    await bench.importProject(project);
    const wf=await bench.analyzeEntry(bench.workspace.project!.entries.find(entry=>entry.path.endsWith('/create'))!.id);
    const draft=paymentDependencies(bench.index!)[0];
    const first=await bench.saveDependency(wf.id,draft);
    const second=await bench.saveDependency(wf.id,{...draft,name:'Other User API',configKey:'services.other.url'});
    const rules=bench.generate();rules[0].body={id:'123',name:'First',active:true};rules[1].body={id:'123',name:'Second',active:false};
    await bench.setRules(rules);await bench.runtime.start(port,bench.workspace.rules);
    const routes={[first.id]:'mock' as const,[second.id]:'mock' as const};
    const preview=await bench.applyRoutes(routes);
    const firstUrl=preview.changes.find(c=>c.key===first.configKey)!.after+'/users/123';
    const secondUrl=preview.changes.find(c=>c.key===second.configKey)!.after+'/users/123';
    assert.deepEqual(await (await fetch(firstUrl)).json(),rules[0].body);
    assert.deepEqual(await (await fetch(secondUrl)).json(),rules[1].body);
    assert.equal((await fetch(firstUrl.replace('/v1/','/'))).status,404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/users/123`)).status,404);
    const edited=structuredClone(bench.workspace.rules);edited[0].path='/accounts/{id}';
    await bench.setRules(edited);
    assert.equal((await fetch(firstUrl)).status,404);
    assert.equal((await fetch(firstUrl.replace('/users/','/accounts/'))).status,200);
    assert.deepEqual(await (await fetch(secondUrl)).json(),rules[1].body);
    await bench.setRules(rules);assert.deepEqual(await (await fetch(firstUrl)).json(),rules[0].body);
    const journal=await bench.runtime.requests();assert(journal.some(r=>r.url===new URL(firstUrl).pathname&&r.matched));assert(journal.some(r=>r.url===new URL(secondUrl).pathname&&r.matched));
    // Simulate a pre-upgrade workspace with rules lacking service data.
    const legacy=structuredClone(bench.workspace);for(const rule of legacy.rules)delete rule.service;
    await fs.writeFile(path.join(project,'.mockingbird/workspace.json'),JSON.stringify(legacy));
    await bench.importProject(project);
    assert.deepEqual(bench.workspace.rules.map(r=>r.service),rules.map(r=>r.service));
    await bench.runtime.start(port,bench.workspace.rules);await bench.setRules(rules);
    assert.deepEqual(await (await fetch(firstUrl)).json(),rules[0].body);
    assert.deepEqual(await (await fetch(secondUrl)).json(),rules[1].body);
    // Changing a Real dependency's base must also update its published rules.
    await bench.applyRoutes({[first.id]:'real'});
    const changed=await bench.saveDependency(wf.id,{...draft,configKey:'services.alias.url'},first.id);
    const newUrl=mockBaseUrl(changed,port)+'/users/123';
    assert.equal((await fetch(firstUrl)).status,404);
    assert.deepEqual(await (await fetch(newUrl)).json(),rules[0].body);
    assert.deepEqual(await (await fetch(secondUrl)).json(),rules[1].body);
  }finally{await bench.close();await fs.rm(root,{recursive:true,force:true});}
});
