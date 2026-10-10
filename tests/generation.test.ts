import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../server/workbench';
import { validateResponseShape } from '../server/response-shape';
import { validateResponseContracts, generateRules } from '../server/rules';
import { indexProject } from '../server/analyzer';
import type { Index } from '../server/analyzer';
import type { Dependency, MockRule, Task } from '../shared/types';
import { paymentDependencies } from './fixtures';

const bundleSource=`package dev.mockingbird.payment;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.util.List;
import java.util.Map;
enum Decision { ALLOW, DENY }
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class LineItem { private String skuName; private int quantity; }
public class Bundle {
  @JsonProperty("txn_id") private String transactionId;
  private List<LineItem> lines;
  private Decision decision;
  private Map<String, Object> extra;
  private JsonNode raw;
  @JsonIgnore private String secret;
}
`;
function synthetic(sources:Record<string,string>):Index{return{project:{revision:'shape'} as Index['project'],methods:[],sources:new Map(Object.entries(sources)),properties:{},classHeaders:new Map(),contracts:{}};}
const validBundle={txn_id:'txn_1',lines:[{sku_name:'sku_001',quantity:1}],decision:'ALLOW',extra:{note:'later'},raw:{}};

test('Response validation covers nested DTOs, aliases, enums and leaves unknown shapes unverified',()=>{
  const index=synthetic({'src/Bundle.java':bundleSource});
  assert.deepEqual(validateResponseShape(validBundle,'Bundle',index).unresolved.join('\n').includes('extra'),true);
  assert.match(validateResponseShape(validBundle,'Bundle',index).unresolved.join('\n'),/raw/);
  assert.throws(()=>validateResponseShape({transactionId:'txn_1',lines:[],decision:'ALLOW',extra:{},raw:{}},'Bundle',index),/txn_id/);
  assert.throws(()=>validateResponseShape({...validBundle,lines:[{sku_name:'sku_001'}]},'Bundle',index),/quantity/);
  assert.throws(()=>validateResponseShape({...validBundle,lines:[{sku_name:'sku_001',quantity:'1'}]},'Bundle',index),/quantity/);
  assert.throws(()=>validateResponseShape({...validBundle,decision:'MAYBE'},'Bundle',index),/ALLOW/);
  assert.doesNotThrow(()=>validateResponseShape({...validBundle,secret:'hidden'},'Bundle',index));
  const outer='public record Outer(Inner child, java.util.List<String> tags) {} public record Inner(boolean ok) {}';
  const nested=synthetic({'src/Outer.java':outer});
  assert.throws(()=>validateResponseShape({child:{ok:1},tags:[]},'Outer',nested),/ok/);
  validateResponseShape({child:{ok:true},tags:['a']},'Outer',nested);
});

async function setup(){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-generation-')),project=path.join(temp,'project');
  await fs.cp('examples/payment-service',project,{recursive:true,filter:file=>!file.split(path.sep).some(part=>['target','.mockingbird'].includes(part))});
  const bench=new Workbench({root:process.cwd(),dataDir:path.join(temp,'data')});
  await bench.importProject(project);
  const wf=await bench.analyzeEntry(bench.workspace.project!.entries.find(entry=>entry.path.endsWith('/create'))!.id);
  const deps:Dependency[]=[];
  for(const draft of paymentDependencies(bench.index!))deps.push(await bench.saveDependency(wf.id,draft));
  const executable=path.join(temp,'fake-grok.cjs');
  await fs.writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
assert.equal(value('--reasoning-effort'),'medium');assert.equal(value('--sandbox'),'read-only');assert.equal(value('--tools'),'read_file,grep,list_dir');assert(args.includes('--no-subagents'));assert(args.includes('--disable-web-search'));
const prompt=fs.readFileSync(value('--prompt-file'),'utf8');
fs.writeFileSync(process.argv[1]+'.prompt',prompt);
if(prompt.includes('cancel-test')){setInterval(()=>{},1000);return;}
if(prompt.includes('error-test')){console.log(JSON.stringify({type:'error',message:'cli exploded'}));process.exit(1);}
if(!prompt.includes('源码感知')){process.stdout.write(JSON.stringify({text:JSON.stringify({summary:'旧的发现结果',dependencies:[],rules:[]}),stopReason:'end_turn'}));return;}
assert.equal(value('--model'),prompt.includes('custom-model')?'grok-4.1-custom':'grok-4.7');
assert(fs.existsSync('project/src/main/java/dev/mockingbird/payment/PaymentService.java'));
const result=JSON.parse(fs.readFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]),'result.json'),'utf8'));
process.stdout.write(JSON.stringify({text:JSON.stringify(result),stopReason:'end_turn'}));
`,{mode:0o755});
  const writeResult=(result:unknown)=>fs.writeFile(path.join(temp,'result.json'),JSON.stringify(result));
  const wait=async(task:Task)=>{for(let i=0;i<150&&task.status==='running';i++)await new Promise(resolve=>setTimeout(resolve,20));assert.notEqual(task.status,'running');};
  bench.agents=[{id:'grok',installed:true,path:executable,version:'fake'}];
  return{temp,project,bench,wf,deps,executable,writeResult,wait,close:async()=>{await bench.close();await fs.rm(temp,{recursive:true,force:true});}};
}
function evidenceFor(dep:Dependency){return[{file:dep.evidence.file,line:dep.evidence.line,reason:`${dep.name} 的调用约束响应字段`}];}
function generated(deps:Dependency[],bodies:unknown[],summary='按调用分支生成'){return{summary,rules:deps.map((dep,index)=>({dependencyId:dep.id,status:200,body:JSON.stringify(bodies[index]),basis:`${dep.name} 满足请求的分支`,evidence:evidenceFor(dep),assumptions:['示例标识符来自调用参数命名，不是运行结果'],unresolved:[]}))};}

test('Scoped source generation covers exactly the selected dependencies and keeps the current workflow',async()=>{
  const ctx=await setup();
  try{
    const status=await ctx.bench.analyzeEntry(ctx.bench.workspace.project!.entries.find(entry=>entry.path.endsWith('/status'))!.id);
    await ctx.bench.selectWorkflow(status.id);
    const [user,inventory,risk,bank]=ctx.deps;
    await assert.rejects(()=>ctx.bench.generateWithAgent({workflowId:status.id,dependencyIds:[user.id],scenario:'success',agent:'grok'}),/不在当前 Flow/);
    assert.equal(ctx.bench.workspace.activeWorkflowId,status.id);
    await assert.rejects(()=>ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id,user.id],scenario:'success',agent:'grok'}),/重复/);
    ctx.bench.agents=[{id:'grok',installed:false,error:'missing'}];
    await assert.rejects(()=>ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id],scenario:'success',agent:'grok'}),/不会改用本地模板/);
    assert.equal(ctx.bench.workspace.rules.length,0);assert.equal(ctx.bench.agentManager.tasks.length,0);
    ctx.bench.agents=[{id:'grok',installed:true,path:ctx.executable}];
    await ctx.writeResult(generated([user,bank],[{id:'u_001',name:'Alex',active:true},{transactionId:'txn_001',approved:true,message:'ok'}]));
    const task=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id,bank.id],scenario:'success',instructions:'沿 PaymentService 成功分支',agent:'grok',model:'grok-4.7'});
    await ctx.wait(task);
    assert.equal(task.status,'completed',task.error);
    assert.equal(ctx.bench.workspace.activeWorkflowId,status.id);
    assert.equal(task.workflowId,ctx.wf.id);assert.equal(task.kind,'generate');
    assert.deepEqual(task.proposal?.map(rule=>rule.dependencyId),[user.id,bank.id]);
    assert.equal(ctx.bench.workspace.rules.length,0);
    assert.match(task.proposal![0].basis,/未经运行或调用验证/);
    assert.equal(task.proposal![0].evidence?.[0].file,user.evidence.file);
    assert.match(task.proposal![0].assumptions?.join('')||'',/不是运行结果/);
    const prompt=await fs.readFile(ctx.executable+'.prompt','utf8');
    assert.match(prompt,/成功路径/);assert.match(prompt,new RegExp('必须覆盖且仅覆盖以下 dependencyId：'+user.id+','+bank.id));
    assert.doesNotMatch(prompt,/业务拒绝或下游错误/);assert.doesNotMatch(prompt,new RegExp(inventory.id));assert.doesNotMatch(prompt,/"dependencies":/);
    assert.match(prompt,/UserClient\.java/);
    const reviewed=ctx.bench.reviewTask(task.id);assert.equal(reviewed.rules.length,2);
    const local=ctx.bench.generate(undefined,'Success',ctx.wf.id);assert.equal(local.length,4);assert.match(local[0].basis,/样本|模板/);
    await ctx.bench.setRules(local);
    await ctx.bench.approveTask(task.id);
    assert.equal(ctx.bench.workspace.rules.length,6);
    for(const dep of [inventory,risk]){const kept=ctx.bench.workspace.rules.find(rule=>rule.dependencyId===dep.id);assert.equal(kept?.enabled,true);assert.equal(JSON.stringify(kept?.body),JSON.stringify(local.find(rule=>rule.dependencyId===dep.id)?.body));}
    assert.equal(ctx.bench.workspace.rules.filter(rule=>rule.dependencyId===user.id&&rule.enabled).length,1);
    assert.equal(ctx.bench.workspace.rules.find(rule=>rule.id===task.proposal![0].id)?.scenario,'Success');
    const chat=await ctx.bench.chat('grok','只做依赖发现',undefined,ctx.wf.id);await ctx.wait(chat);
    assert.equal(chat.status,'completed',chat.error);assert.deepEqual(chat.dependencyProposal,[]);assert.equal(chat.kind,'chat');
  }finally{await ctx.close();}
});

test('Branch prompts differ and invalid shapes, evidence, CLI failures or stale tasks never publish',async()=>{
  const ctx=await setup();
  try{
    const [user,inventory]=ctx.deps;
    await ctx.writeResult(generated([user],[{id:'u_001',name:'Alex',active:false}]));
    const rejection=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id],scenario:'rejection',instructions:'用户未激活',agent:'grok'});
    await ctx.wait(rejection);assert.equal(rejection.status,'completed',rejection.error);assert.equal(rejection.proposal?.[0].scenario,'Business rejection');
    const rejectionPrompt=await fs.readFile(ctx.executable+'.prompt','utf8');
    assert.match(rejectionPrompt,/业务拒绝/);assert.match(rejectionPrompt,/active/);assert.match(rejectionPrompt,/用户未激活/);
    await ctx.writeResult(generated([user],[{id:'u_001',name:'Alex'}]));
    const missing=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id],scenario:'success',agent:'grok'});
    await ctx.wait(missing);assert.equal(missing.status,'failed');assert.match(missing.error||'',/active/);assert.equal(missing.proposal,undefined);
    await ctx.writeResult(generated([user],[{success:true}]));
    const dumped=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id],scenario:'success',agent:'grok'});
    await ctx.wait(dumped);assert.equal(dumped.status,'failed');assert.match(dumped.error||'',/缺少字段/);
    await ctx.writeResult({summary:'多了一条',rules:[...generated([user],[{id:'u',name:'n',active:true}]).rules,{dependencyId:inventory.id,status:200,body:'{}',basis:'x',evidence:evidenceFor(inventory),assumptions:[],unresolved:[]}]});
    const extra=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id],scenario:'success',agent:'grok'});
    await ctx.wait(extra);assert.equal(extra.status,'failed');assert.match(extra.error||'',/恰好覆盖/);
    await ctx.writeResult(generated([user,user],[{id:'u',name:'n',active:true},{id:'u',name:'n',active:true}]));
    const duplicate=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id,inventory.id],scenario:'success',agent:'grok'});
    await ctx.wait(duplicate);assert.equal(duplicate.status,'failed');assert.match(duplicate.error||'',/重复|恰好覆盖/);
    const badEvidence=generated([user],[{id:'u_001',name:'Alex',active:true}]);badEvidence.rules[0].evidence=[{file:'src/missing.java',line:1,reason:'不存在'}];
    await ctx.writeResult(badEvidence);
    const invalidEvidence=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id],scenario:'success',agent:'grok'});
    await ctx.wait(invalidEvidence);assert.equal(invalidEvidence.status,'failed');assert.match(invalidEvidence.error||'',/索引/);
    const badLine=generated([user],[{id:'u_001',name:'Alex',active:true}]);badLine.rules[0].evidence=[{file:user.evidence.file,line:99999,reason:'超出'}];
    await ctx.writeResult(badLine);
    const invalidLine=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id],scenario:'success',agent:'grok'});
    await ctx.wait(invalidLine);assert.equal(invalidLine.status,'failed');assert.match(invalidLine.error||'',/行号/);
    await ctx.writeResult(generated([user],[{id:'u_001',name:'Alex',active:true}],'业务已运行验证'));
    const claimed=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id],scenario:'success',agent:'grok'});
    await ctx.wait(claimed);assert.equal(claimed.status,'failed');assert.match(claimed.error||'',/运行或验证/);
    await ctx.writeResult(generated([user],[{id:'u_001',name:'Alex',active:true}]));
    const fresh=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id],scenario:'custom',customScenario:'库存不足',instructions:'custom-model',agent:'grok',model:'grok-4.1-custom'});
    await ctx.wait(fresh);assert.equal(fresh.status,'completed',fresh.error);assert.equal(fresh.proposal?.[0].scenario,'库存不足');
    const customPrompt=await fs.readFile(ctx.executable+'.prompt','utf8');assert.match(customPrompt,/库存不足/);assert.match(customPrompt,/custom-model/);
    const draft=paymentDependencies(ctx.bench.index!)[0];
    await ctx.bench.saveDependency(ctx.wf.id,{...draft,path:'/users/{accountId}'},user.id);
    assert.throws(()=>ctx.bench.reviewTask(fresh.id),/依赖已变化/);
    await assert.rejects(()=>ctx.bench.approveTask(fresh.id),/依赖已变化/);
    await assert.rejects(()=>ctx.bench.setRules(fresh.proposal),/依赖已变化/);
    await ctx.bench.saveDependency(ctx.wf.id,draft,user.id);
    assert.equal(ctx.bench.workspace.rules.length,0);
    const errored=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id],scenario:'success',instructions:'error-test',agent:'grok'});
    await ctx.wait(errored);assert.equal(errored.status,'failed');assert.match(errored.error||'',/cli exploded/);assert.equal(ctx.bench.workspace.rules.length,0);
    const cancelled=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[user.id],scenario:'success',instructions:'cancel-test',agent:'grok'});
    ctx.bench.agentManager.cancel(cancelled.id);assert.equal(cancelled.status,'cancelled');assert.equal(ctx.bench.workspace.rules.length,0);
    await ctx.writeResult(generated([ctx.deps[0]],[{id:'u_001',name:'Alex',active:true}]));
    const current=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[ctx.bench.activeWorkflow().dependencies[0].id],scenario:'success',agent:'grok'});
    await ctx.wait(current);assert.equal(current.status,'completed',current.error);
    await fs.appendFile(path.join(ctx.project,'src/main/java/dev/mockingbird/payment/PaymentService.java'),'\n// revision\n');
    await ctx.bench.reindex();
    assert.throws(()=>ctx.bench.reviewTask(current.id),/过期/);
    await assert.rejects(()=>ctx.bench.approveTask(current.id),/过期/);
    await assert.rejects(()=>ctx.bench.setRules(current.proposal),/过期/);
    assert.equal(ctx.bench.workspace.rules.length,0);
  }finally{await ctx.close();}
});

test('Nested source shapes are enforced before a generation proposal is completed',async()=>{
  const ctx=await setup();
  try{
    const file='src/main/java/dev/mockingbird/payment/Bundle.java';
    await fs.writeFile(path.join(ctx.project,file),bundleSource);
    await ctx.bench.reindex();await ctx.bench.confirmWorkflow(ctx.wf.id);
    const bundle=await ctx.bench.saveDependency(ctx.wf.id,{name:'Bundle API',client:'BundleClient',method:'POST',path:'/bundle',originalBase:'http://127.0.0.1:29099',configKey:'',responseType:'Bundle',file,line:bundleSource.split('\n').findIndex(line=>line.includes('class Bundle'))+1,note:'嵌套 DTO',callChain:[]});
    const good={...generated([bundle],[validBundle]).rules[0],assumptions:[],unresolved:['Map 可能含有动态键']};
    await ctx.writeResult({summary:'嵌套 DTO',rules:[good]});
    const task=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[bundle.id],scenario:'success',agent:'grok'});
    await ctx.wait(task);assert.equal(task.status,'completed',task.error);
    assert.match(task.proposal![0].unresolved?.join('\n')||'',/extra/);
    assert.match(task.proposal![0].unresolved?.join('\n')||'',/raw/);
    const bad={...good,body:JSON.stringify({...validBundle,lines:[{sku_name:'sku_001'}]})};
    await ctx.writeResult({summary:'缺字段',rules:[bad]});
    const failed=await ctx.bench.generateWithAgent({workflowId:ctx.wf.id,dependencyIds:[bundle.id],scenario:'success',agent:'grok'});
    await ctx.wait(failed);assert.equal(failed.status,'failed');assert.match(failed.error||'',/quantity/);assert.equal(failed.proposal,undefined);
    const index=await indexProject(ctx.project);
    const rule=generateRules([bundle],index)[0];rule.body=validBundle;
    validateResponseContracts([rule],[bundle],index);
  }finally{await ctx.close();}
});
