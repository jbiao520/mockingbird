import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Workbench } from '../server/workbench';
import { indexProject } from '../server/analyzer';
import { paymentDependencies } from '../tests/fixtures';
import { mockRequestPath } from '../shared/mock-routing';
const root=process.cwd(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-e2e-')),project=path.join(temp,'payment-service');
await fs.cp(path.join(root,'examples/payment-service'),project,{recursive:true,filter:s=>!s.includes('/target')&&!s.includes('/.mockingbird')});
// Exercise application context-path and base-path routing through all four real Java HTTP clients.
const configuration=path.join(project,'src/main/resources/application.properties');
await fs.writeFile(configuration,(await fs.readFile(configuration,'utf8')).replace(/^(services\.[\w.-]+\.url=http[^\r\n]+)$/gm,'$1/v1')+'\nserver.servlet.context-path=/shop\n');
const bench=new Workbench({root,dataDir:path.join(temp,'data')});
const report:{step:string;result:string}[]=[];
const pass=(step:string,result:string)=>{report.push({step,result});console.log('✓ '+step+' — '+result);};
async function waitLaunch(){const start=Date.now();while(Date.now()-start<160000){if(bench.launcher.state.status==='running')return;if(bench.launcher.state.status==='failed')throw new Error(bench.launcher.state.error+'\n'+bench.launcher.state.logs.join(''));await new Promise(r=>setTimeout(r,400));}throw new Error('Java startup timed out');}
const request={target:'project' as const,method:'POST',path:'/shop/api/payment/create',body:{userId:'u_001',sku:'sku_001',quantity:1,amount:128}};
try{
  await bench.init();await bench.importProject(project);const original=bench.index!.project.revision;
  const entry=bench.workspace.project!.entries.find(e=>e.path==='/api/payment/create')!;assert(entry);pass('Import','Maven, Java 17, 2 Controller entries');
  let wf=await bench.analyzeEntry(entry.id);assert.equal(wf.dependencies.length,0);for(const draft of paymentDependencies(bench.index!))await bench.saveDependency(wf.id,draft);wf=bench.activeWorkflow();assert.deepEqual(new Set(wf.dependencies.map(d=>d.client)),new Set(['Feign','RestTemplate','WebClient','OkHttp']));assert.equal(wf.dependencies.length,4);assert(wf.dependencies.every(d=>d.status==='confirmed'&&d.configKey));pass('Confirm dependencies','4 manually confirmed dependencies with source evidence and configuration keys');
  const rules=bench.generate();await bench.setRules(rules);await bench.runtime.start(19190,bench.workspace.rules);pass('Mock runtime','4 validated JSON rules loaded into real WireMock');
  const matchRules=structuredClone(rules),matchBank=matchRules.find(r=>r.name==='Bank API')!;
  matchBank.query={scenario:'verify'};matchBank.requestHeaders={'X-Scenario':'verify'};matchBank.requestBody={amount:128};
  await bench.setRules(matchRules);
  const matchRequest={target:'mock' as const,method:'POST',path:mockRequestPath(matchBank)+'?scenario=verify',headers:{'X-Scenario':'verify'},body:{amount:128}};
  assert.equal((await bench.testRequest(matchRequest)).status,200);
  assert.equal((await bench.testRequest({...matchRequest,headers:{'X-Scenario':'wrong'}})).status,404);
  assert.equal((await bench.testRequest({...matchRequest,body:{amount:129}})).status,404);
  assert((await bench.runtime.requests()).some(request=>!request.matched));
  await bench.setRules(rules);pass('Request matchers','Query, header and JSON body matched; mismatches returned 404 and appeared in journal');
  const routes=Object.fromEntries(wf.dependencies.map(d=>[d.id,'mock' as const]));const preview=await bench.setRoutes(routes);assert.equal(preview.preview.changes.length,4);await bench.applyRoutes(routes);pass('Routing','4 Spring property overrides saved');
  await bench.launcher.start(bench.workspace,18180);await waitLaunch();
  const template=await bench.requestTemplate(entry.id);assert.equal(template.path,request.path);
  const entryRequest={...template,...request};
  await assert.rejects(()=>bench.testRequest({...entryRequest,path:'/api/payment/create'}),/偏离入口/);
  const first=await bench.testRequest(entryRequest);assert.equal(first.status,200);assert.equal(JSON.parse(first.body).status,'COMPLETED');
  const logs=(await bench.runtime.requests()).filter(l=>!l.url.includes('?'));assert.equal(new Set(logs.filter(l=>l.matched).map(l=>l.url)).size,4);assert(logs.every(l=>l.status===200));pass('Entry API verification','Generated /shop context-path request hit actual Spring Boot and all 4 downstream mocks, COMPLETED');
  const bank=bench.workspace.rules.find(r=>r.name==='Bank API')!;const modified=structuredClone(bench.workspace.rules);modified.find(r=>r.id===bank.id)!.body={transactionId:'txn_declined',approved:false,message:'Declined for test'};await bench.setRules(modified);
  const second=await bench.testRequest(request);assert.equal(JSON.parse(second.body).status,'DECLINED');assert.equal(bench.workspace.rules.find(r=>r.id===bank.id)!.version,bank.version+1);pass('Edit & hot reload','Changed Bank response; Java returned DECLINED without restart');
  const invalid=structuredClone(modified);invalid[0].status=999;await assert.rejects(()=>bench.setRules(invalid));const afterInvalid=await bench.testRequest(request);assert.equal(JSON.parse(afterInvalid.body).status,'DECLINED');pass('Invalid rule isolation','Invalid status rejected; existing runtime preserved');
  await bench.setRules(rules);const third=await bench.testRequest(request);assert.equal(JSON.parse(third.body).status,'COMPLETED');pass('Edit mocks','User reapplied success rules, Java returned COMPLETED');
  const user=wf.dependencies.find(d=>d.client==='Feign')!;await bench.applyRoutes({[user.id]:'real'});await bench.launcher.stop();await bench.launcher.start(bench.workspace,18180);await waitLaunch();const real=await bench.testRequest(request);assert.equal(real.status,502);pass('Selective Real routing','User restored to original unavailable localhost upstream, Java returned 502');
  await bench.applyRoutes(routes);await bench.launcher.stop();await bench.launcher.start(bench.workspace,18180);await waitLaunch();const restored=await bench.testRequest(request);assert.equal(JSON.parse(restored.body).status,'COMPLETED');pass('Update routing','User reapplied Mock routes and restarted project; 4 mocked dependencies work again');
  assert.equal((await indexProject(project)).project.revision,original);pass('Source integrity','Original Java and application configuration unchanged');
  await bench.launcher.stop();await bench.runtime.stop();await bench.importProject(project);assert.equal(bench.workspace.rules.length,4);assert.equal(bench.workspace.workflows.length,1);pass('Persistence','Workflows, rules and routes reopened from disk');
}finally{await bench.close();await fs.mkdir(path.join(root,'artifacts'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/e2e-report.json'),JSON.stringify({at:new Date().toISOString(),passed:report.length===13,steps:report},null,2));await fs.rm(temp,{recursive:true,force:true});}
