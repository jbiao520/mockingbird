import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexProject, analyze } from '../server/analyzer';
import { emptyWorkspace, loadWorkspace, saveWorkspace } from '../server/storage';
import { declaredPaymentFlow } from './fixtures';
import { generateRules } from '../server/rules';
import { generateRequestTemplate } from '../server/request-shape';
import { makeScenario, assertRunnableScenario, assertRegressionResponse, RegressionRunner, readRegressionReport, MAX_REGRESSION_REQUESTS } from '../server/regression';
import { scenarioStaleReason } from '../shared/regression';
import type { RequestLog } from '../shared/types';
import { Workbench } from '../server/workbench';

async function fixture(){
  const index=await indexProject('examples/payment-service'),workspace=emptyWorkspace();
  const workflow=declaredPaymentFlow(index,analyze(index,index.project.entries.find(e=>e.path.endsWith('/create'))!.id));
  workspace.project=index.project;workspace.workflows=[workflow];workspace.rules=generateRules(workflow.dependencies,index);
  const template=generateRequestTemplate(index,workflow.entry.id);
  const input={workflowId:workflow.id,name:'成功支付',request:{method:template.method,path:template.path,headers:template.headers,body:{userId:'u_001',sku:'sku_001',quantity:1,amount:128}},mocks:workspace.rules.map(rule=>({dependencyId:rule.dependencyId,ruleId:rule.id,calls:1})),expected:{status:200,fields:{'/status':'COMPLETED'}}};
  return{index,workspace,workflow,input};
}
test('Flow scenarios require one valid Mock per dependency and a valid entry request',async()=>{
  const {index,workspace,workflow,input}=await fixture(),scenario=makeScenario(input,workspace,index);
  assert.equal(assertRunnableScenario(scenario,workspace,index).length,4);
  assert.throws(()=>makeScenario({...input,mocks:input.mocks.slice(1)},workspace,index),/遗漏/);
  assert.throws(()=>makeScenario({...input,mocks:[input.mocks[0],input.mocks[0],...input.mocks.slice(2)]},workspace,index),/重复/);
  assert.throws(()=>makeScenario({...input,request:{...input.request,path:'//evil.example/api/payment/create'}},workspace,index),/非法/);
  assert.throws(()=>makeScenario({...input,request:{...input.request,path:'/other'}},workspace,index),/偏离入口/);
  assert.throws(()=>makeScenario({...input,request:{...input.request,body:{...input.request.body,amount:'wrong'}}},workspace,index),/数字/);
  assert.throws(()=>makeScenario({...input,request:{...input.request,headers:{Host:'evil.example'}}},workspace,index),/覆盖/);
  assert.throws(()=>makeScenario({...input,expected:{status:200,fields:{'/__proto__/key':true}}},workspace,index),/字段路径/);
  workflow.dependencies[0].configKey=undefined;
  const noRoute=makeScenario(input,workspace,index);
  assert.throws(()=>assertRunnableScenario(noRoute,workspace,index),/无法接管/);
});
test('Scenario bindings detect deleted or changed mocks and dependencies, but allow enable switches',async()=>{
  const {index,workspace,workflow,input}=await fixture(),scenario=makeScenario(input,workspace,index);
  workspace.rules[0].enabled=false;workspace.rules[0].version++;
  assert.equal(scenarioStaleReason(scenario,workflow,workspace.rules,index.project.revision),'');
  workflow.dependencies[0].route='mock';
  assert.equal(scenarioStaleReason(scenario,workflow,workspace.rules,index.project.revision),'');
  workspace.rules[0].delay++;
  assert.match(scenarioStaleReason(scenario,workflow,workspace.rules,index.project.revision),/Mock 内容/);
  const updated=makeScenario(input,workspace,index);workspace.rules.shift();
  assert.match(scenarioStaleReason(updated,workflow,workspace.rules,index.project.revision),/已删除/);
  workflow.dependencies[0].responseType='Other';
  assert.match(scenarioStaleReason(updated,workflow,workspace.rules,index.project.revision),/依赖/);
  assert.match(scenarioStaleReason(updated,workflow,workspace.rules,'changed'),/源码版本/);
});
test('Regression assertions compare JSON values, escaped pointers, zero calls and unmatched downstreams',async()=>{
  const {index,workspace,input}=await fixture(),scenario=makeScenario(input,workspace,index);
  scenario.expected.fields={'/data':{a:1,b:2},'/a~1b':false};scenario.mocks.forEach(m=>m.calls=0);
  assert.deepEqual(assertRegressionResponse(scenario,200,'{"data":{"b":2,"a":1},"a/b":false}',[]),[]);
  const log:RequestLog={id:'x',method:'POST',url:'/bank/charge',status:200,matched:true,ruleId:scenario.mocks[0].ruleId,at:new Date().toISOString()};
  assert.match(assertRegressionResponse(scenario,201,'{}',[log]).join('；'),/期望调用 0 次，实际 1 次/);
  assert.match(assertRegressionResponse(scenario,200,'not json',[]).join('；'),/不是合法 JSON/);
  assert.match(assertRegressionResponse(scenario,200,'{}',[{...log,matched:false}]).join('；'),/未命中/);
  assert.match(assertRegressionResponse(scenario,200,'{}',Array(MAX_REGRESSION_REQUESTS+1).fill(log)).join('；'),/超过 5000/);
});

test('Regression refuses startup arguments that override any declared downstream before launching Java or WireMock',async()=>{
  const {index,workspace,input}=await fixture(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-regression-route-'));
  const runner=new RegressionRunner('/must-not-start.jar',()=>{});
  try{
    await fs.writeFile(path.join(temp,'pom.xml'),'<project/>');
    await fs.writeFile(path.join(temp,'mvnw'),'#!/bin/sh\ntouch java-started\n',{mode:0o755});
    workspace.project={...workspace.project!,path:temp};index.project=workspace.project;
    workspace.flowScenarios=[makeScenario(input,workspace,index)];
    workspace.runConfig!.args='--services.user.url=http://real.example';
    runner.start(workspace,index,input.workflowId,[workspace.flowScenarios[0].id],new AbortController().signal,()=>{});
    while(runner.busy)await new Promise(r=>setTimeout(r,10));
    assert.equal(runner.state!.status,'failed');assert.match(runner.state!.error!,/services.user.url.*覆盖/);
    assert.equal(runner.state!.results[0].status,'blocked');
    await assert.rejects(()=>fs.stat(path.join(temp,'java-started')),/ENOENT/);
  }finally{await runner.close();await fs.rm(temp,{recursive:true,force:true});}
});
test('Saved scenarios reopen and blocked regressions persist reports without starting services',async()=>{
  const {index,workspace,input}=await fixture(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-regression-test-'));
  const runner=new RegressionRunner('/not-installed.jar',()=>{});
  try{
    workspace.project={...workspace.project!,path:temp};index.project=workspace.project;
    workspace.flowScenarios=[makeScenario(input,workspace,index)];await saveWorkspace(workspace);
    const reopened=await loadWorkspace(temp);assert.deepEqual(reopened.flowScenarios,workspace.flowScenarios);
    workspace.rules[0].delay++;runner.start(workspace,index,input.workflowId,[workspace.flowScenarios[0].id],new AbortController().signal,()=>{});
    assert.throws(()=>runner.start(workspace,index,input.workflowId,[],new AbortController().signal,()=>{}),/正在执行/);
    // close waits for report persistence; the preflight has already marked this case blocked.
    while(runner.busy)await new Promise(r=>setTimeout(r,10));
    assert.equal(runner.state!.results[0].status,'blocked');assert.equal(runner.state!.status,'completed');
    const report=await readRegressionReport(temp,input.workflowId);assert.equal(report!.results[0].status,'blocked');assert(report!.endedAt);
    assert.throws(()=>runner.start(workspace,index,input.workflowId,['missing'],new AbortController().signal,()=>{}),/不存在/);
  }finally{await runner.close();await fs.rm(temp,{recursive:true,force:true});}
});
test('Workbench rejects scenario IDs from another Flow and saves updates atomically',async()=>{
  const {index,workspace,input}=await fixture(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-scenario-save-'));
  const bench=new Workbench({root:process.cwd(),dataDir:path.join(temp,'data')});
  try{
    workspace.project={...workspace.project!,path:temp};index.project=workspace.project;bench.index=index;bench.workspace=workspace;
    const first=await bench.saveFlowScenario(input);
    await assert.rejects(()=>bench.saveFlowScenario({...input,id:'missing'}),/不存在/);
    await bench.saveFlowScenario({...input,id:first.id,name:'更新'});
    assert.equal(bench.workspace.flowScenarios!.length,1);assert.equal(bench.workspace.flowScenarios![0].name,'更新');
    await bench.removeFlowScenario(first.id);assert.equal((await loadWorkspace(temp)).flowScenarios!.length,0);
  }finally{await bench.close();await fs.rm(temp,{recursive:true,force:true});}
});
