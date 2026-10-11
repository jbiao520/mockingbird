import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import assert from 'node:assert/strict';
import { Workbench } from '../server/workbench';
import { paymentDependencies } from '../tests/fixtures';
import { loadWorkspace } from '../server/storage';
import { mockRequestPath } from '../shared/mock-routing';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-regression-e2e-')),project=path.join(temp,'payment-service');
const bench=new Workbench({root:process.cwd(),dataDir:path.join(temp,'data')});
let realCalls=0;
const realDownstream=createHttpServer((_req,res)=>{realCalls++;res.setHeader('Content-Type','application/json');res.end('{"id":"u_001","name":"Real User","active":true}');});
async function waitRun(){const started=Date.now();while(bench.regression.busy){if(Date.now()-started>180000)throw new Error('Regression timed out');await new Promise(r=>setTimeout(r,200));}return bench.regression.state!;}
async function freePort(){const s=net.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
try{
  await fs.cp('examples/payment-service',project,{recursive:true,filter:s=>!s.includes('/target')&&!s.includes('/.mockingbird')});
  const configuration=path.join(project,'src/main/resources/application.properties');
  await fs.appendFile(configuration,'\nserver.servlet.context-path=/shop\n');
  await fs.writeFile(path.join(project,'src/main/resources/application-local.properties'),'server.servlet.context-path=/profile-shop\n');
  await bench.init();await bench.importProject(project);
  await bench.saveRunConfig({profiles:'local',env:'SERVER_SERVLET_CONTEXT_PATH=/environment-shop',jvm:'-Dserver.servlet.context-path=/jvm-shop',args:'--server.servlet.context-path=/argument-shop'});
  const wf=await bench.analyzeEntry(bench.workspace.project!.entries.find(e=>e.path.endsWith('/create'))!.id);
  for(const dep of paymentDependencies(bench.index!))await bench.saveDependency(wf.id,dep);
  const rules=bench.generate(),inventory=rules.find(r=>r.name==='Inventory API')!;
  const rejected={...inventory,id:crypto.randomUUID(),scenario:'库存不足',enabled:false,body:{...(inventory.body as object),available:false}};
  await bench.setRules([...rules,rejected]);
  const template=await bench.requestTemplate(wf.entry.id),request={method:template.method,path:template.path,headers:{},body:{userId:'u_001',sku:'sku_001',quantity:1,amount:128}};
  assert.equal(template.path,'/argument-shop/api/payment/create');
  const mocks=rules.map(r=>({dependencyId:r.dependencyId,ruleId:r.id,calls:1}));
  const success=await bench.saveFlowScenario({workflowId:wf.id,name:'成功支付',request,mocks,expected:{status:200,fields:{'/status':'COMPLETED'}}});
  const outOfStock=await bench.saveFlowScenario({workflowId:wf.id,name:'库存不足不调用银行',request,mocks:mocks.map(m=>({...m,ruleId:m.dependencyId===inventory.dependencyId?rejected.id:m.ruleId,calls:rules.find(r=>r.id===m.ruleId)!.name==='Bank API'||rules.find(r=>r.id===m.ruleId)!.name==='Risk API'?0:1})),expected:{status:200,fields:{'/status':'OUT_OF_STOCK'}}});
  const intentionalFailure=await bench.saveFlowScenario({workflowId:wf.id,name:'错误断言',request,mocks,expected:{status:200,fields:{'/status':'WRONG'}}});
  // Keep an ordinary debug server running to prove regression does not replace its mappings or journal.
  await bench.runtime.start(await freePort(),bench.workspace.rules);
  const user=rules.find(r=>r.name==='User API')!;
  await bench.testRequest({target:'mock',method:user.method,path:mockRequestPath(user).replace('{userId}','u_001')});
  const before=structuredClone(bench.workspace),journal=await bench.runtime.requests();
  const routesFile=path.join(project,'.mockingbird/routes.properties');await fs.writeFile(routesFile,'# current debugging configuration\n');
  bench.runRegression({workflowId:wf.id,scenarioIds:[success.id,outOfStock.id,intentionalFailure.id]});
  const report=await waitRun();assert.equal(report.status,'completed',report.error+'\n'+report.logs.join(''));
  assert.deepEqual(report.results.map(r=>r.status),['passed','passed','failed']);
  assert.equal(report.results[1].requestCount,2);assert.match(report.results[2].errors.join(' '),/WRONG/);
  assert.deepEqual(bench.workspace,before);assert.deepEqual(await bench.runtime.requests(),journal);
  assert.equal(await fs.readFile(routesFile,'utf8'),'# current debugging configuration\n');
  assert.equal((await loadWorkspace(project)).flowScenarios!.length,3);
  assert.deepEqual((await bench.regressionReport(wf.id))!.results.map(r=>r.status),['passed','passed','failed']);
  console.log('✓ Actual Spring Boot + WireMock: success, short-circuit with zero bank calls, response diff, persistence, debug isolation');
  console.log('✓ Entry templates and regression use the effective context path over profile, environment and JVM settings');
  await new Promise<void>(resolve=>realDownstream.listen(0,'127.0.0.1',resolve));
  const runConfig=structuredClone(bench.workspace.runConfig!);
  await bench.saveRunConfig({...runConfig,args:runConfig.args+' --services.user.url=http://127.0.0.1:'+(realDownstream.address() as net.AddressInfo).port});
  bench.runRegression({workflowId:wf.id,scenarioIds:[success.id]});
  const shadowed=await waitRun();assert.equal(shadowed.status,'failed');assert.equal(shadowed.results[0].status,'blocked');
  assert.match(shadowed.error!,/services.user.url.*覆盖/);assert.equal(realCalls,0);
  await bench.saveRunConfig(runConfig);
  console.log('✓ Conflicting downstream startup arguments block regression before contacting the real service');
  bench.runRegression({workflowId:wf.id,scenarioIds:[success.id]});bench.regression.cancel();
  assert.equal((await waitRun()).status,'cancelled');assert.equal(bench.runtime.state.status,'running');
  console.log('✓ Cancellation during preparation leaves the ordinary debug server running');
  const slow=structuredClone(bench.workspace.rules);slow.find(r=>r.id===user.id)!.delay=15000;await bench.setRules(slow);
  await bench.saveFlowScenario({...success,mocks,request});
  bench.runRegression({workflowId:wf.id,scenarioIds:[success.id]});
  const started=Date.now();while(bench.regression.state!.results[0].status!=='running'){
    if(!bench.regression.busy||Date.now()-started>120000)throw new Error('Regression did not reach request execution');await new Promise(r=>setTimeout(r,100));
  }
  await new Promise(r=>setTimeout(r,500));bench.regression.cancel();
  const cancelled=await waitRun();assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.results[0].status,'cancelled');
  assert.equal(bench.runtime.state.status,'running');
  const configUrl=/--spring.config.additional-location=(file:\/\/\/\S+) --server.port=/.exec(cancelled.logs.join(''))?.[1];
  assert(configUrl);await assert.rejects(()=>fs.stat(new URL(configUrl)),/ENOENT/);
  console.log('✓ In-flight cancellation stops Java / WireMock and removes the temporary route configuration');
  await fs.writeFile(path.join(project,'mvnw'),'#!/bin/sh\necho intentional-startup-failure\nexit 1\n',{mode:0o755});
  bench.runRegression({workflowId:wf.id,scenarioIds:[success.id]});
  const failed=await waitRun();assert.equal(failed.status,'failed');assert.equal(failed.results[0].status,'blocked');assert(failed.logs.join('').includes('intentional-startup-failure'));
  assert.equal(bench.runtime.state.status,'running');console.log('✓ Build failure is reported as blocked and cleans up the isolated runtime');
}finally{await bench.close();await new Promise<void>(resolve=>{realDownstream.close(()=>resolve());realDownstream.closeAllConnections();});await fs.rm(temp,{recursive:true,force:true});}
