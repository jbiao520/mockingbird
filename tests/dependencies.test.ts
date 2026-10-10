import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../server/workbench';
import { paymentDependencies } from './fixtures';
import type { DependencyDraft, Task } from '../shared/types';
import { dependencyService } from '../shared/mock-routing';

async function setup(){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-discovery-')),project=path.join(temp,'project');
  await fs.cp('examples/payment-service',project,{recursive:true,filter:file=>!file.split(path.sep).some(part=>['target','.mockingbird'].includes(part))});
  const bench=new Workbench({root:process.cwd(),dataDir:path.join(temp,'data')});
  await bench.importProject(project);
  const wf=await bench.analyzeEntry(bench.workspace.project!.entries.find(e=>e.path.endsWith('/create'))!.id);
  return{temp,project,bench,wf,close:async()=>{await bench.close();await fs.rm(temp,{recursive:true,force:true});}};
}

test('Manual custom dependencies survive edit, reopen and persistence and generate mocks without a known base',async()=>{
  const ctx=await setup();const {bench,wf}=ctx;
  try{
    assert.equal(wf.dependencies.length,0);
    const draft:DependencyDraft={...paymentDependencies(bench.index!)[0],name:'Custom gateway',client:'AcmeGateway',configKey:'',originalBase:'',path:'/custom/{id}'};
    const dep=await bench.saveDependency(wf.id,draft);
    assert.equal(dep.client,'AcmeGateway');assert.equal(dep.status,'confirmed');assert.equal(dep.evidence.kind,'manual');
    const rules=bench.generate();assert.equal(rules.length,1);
    await assert.rejects(()=>bench.setRoutes({[dep.id]:'mock'}),/无法自动路由/);
    await bench.saveDependency(wf.id,{...draft,name:'Renamed gateway'},dep.id);
    await bench.analyzeEntry(wf.entry.id);assert.equal(bench.activeWorkflow().dependencies[0].id,dep.id);
    await bench.setRules(rules);
    await assert.rejects(()=>bench.saveDependency(wf.id,{...draft,path:'/changed'},dep.id),/Mock 规则/);
    assert.equal(bench.activeWorkflow().dependencies[0].path,'/custom/{id}');
    await assert.rejects(()=>bench.removeDependency(wf.id,dep.id),/Mock 规则/);
    await bench.importProject(ctx.project);
    assert.equal(bench.activeWorkflow().dependencies[0].name,'Renamed gateway');assert.equal(bench.workspace.rules[0].dependencyId,dep.id);
    await bench.setRules([]);await bench.removeDependency(wf.id,dep.id);assert.equal(bench.activeWorkflow().dependencies.length,0);
  }finally{await ctx.close();}
});

test('AI discovery sees a complete source snapshot and returns reviewable candidates that require explicit confirmation',async()=>{
  const ctx=await setup();const {bench,wf}=ctx;
  try{
    // This wrapper is unrelated to the entry's syntactic calls and outside the old source pack.
    const extra='src/main/java/dev/mockingbird/payment/CustomGateway.java';
    await fs.writeFile(path.join(ctx.project,extra),'public class CustomGateway { public String invoke(){ return transport.send(target()); } }\n');
    await bench.reindex();await bench.confirmWorkflow(wf.id);
    const draft:DependencyDraft={name:'Wrapped transport',client:'CustomGateway',method:'POST',path:'',originalBase:'',configKey:'',responseType:'',file:extra,line:1,note:'动态路径由用户补充',callChain:[]};
    const executable=path.join(ctx.temp,'fake-codex.cjs');
    await fs.writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[args.indexOf('--sandbox')+1]!=='read-only')throw new Error('missing read-only sandbox');
if(args.includes('shell_tool'))throw new Error('discovery search was disabled');
if(!fs.readFileSync('project/${extra}','utf8').includes('transport.send'))throw new Error('missing custom wrapper in snapshot');
const result=${JSON.stringify({summary:'找到自定义封装，路径需确认',dependencies:[draft],rules:[]})};
process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}})));
`);await fs.chmod(executable,0o700);
    bench.agents=[{id:'codex',installed:true,path:executable}];
    const task=await bench.chat('codex','帮我看看 transport.send 这个封装调用',undefined,wf.id);
    for(let i=0;i<100&&task.status==='running';i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(task.status,'completed',task.error);assert.equal(task.dependencyProposal?.length,1);assert.equal(bench.activeWorkflow().dependencies.length,0);assert.equal(bench.workspace.rules.length,0);
    await assert.rejects(()=>bench.saveDependency(wf.id,draft,undefined,task.id,0),/请求路径/);
    await assert.rejects(()=>bench.saveDependency(wf.id,{...draft,path:'/wrapped',file:'../outside.java'},undefined,task.id,0),/源码文件/);
    const accepted=await bench.saveDependency(wf.id,{...draft,path:'/wrapped'},undefined,task.id,0);
    assert.equal(accepted.evidence.kind,'ai');assert.match(accepted.evidence.snippet,/transport.send/);assert.equal(accepted.status,'confirmed');
    assert.deepEqual(task.acceptedDependencies,[0]);assert.equal(bench.generate().length,1);
    await assert.rejects(()=>bench.saveDependency(wf.id,{...draft,path:'/wrapped'},undefined,task.id,0),/已经加入/);
    const other=await bench.analyzeEntry(bench.workspace.project!.entries.find(e=>e.path.endsWith('/status'))!.id);
    await assert.rejects(()=>bench.saveDependency(other.id,{...draft,path:'/wrapped'},undefined,task.id,0),/不属于/);
    // A still-pending candidate cannot be accepted after reindexing a different revision.
    const stale:Task={...task,id:'stale-task',acceptedDependencies:[]};bench.agentManager.tasks.push(stale);
    await fs.appendFile(path.join(ctx.project,extra),'// changed\n');await bench.reindex();
    await assert.rejects(()=>bench.saveDependency(wf.id,{...draft,path:'/another'},undefined,stale.id,0),/过期/);
  }finally{await ctx.close();}
});

test('Configuration and source evidence are checked before saving; stale flows preserve confirmed dependencies',async()=>{
  const ctx=await setup();const {bench,wf}=ctx;
  try{
    const draft=paymentDependencies(bench.index!)[0];
    await assert.rejects(()=>bench.saveDependency(wf.id,{...draft,configKey:'invented.url'}),/配置项/);
    await assert.rejects(()=>bench.saveDependency(wf.id,{...draft,line:10000}),/行号/);
    const dep=await bench.saveDependency(wf.id,draft);await bench.applyRoutes({[dep.id]:'mock'});
    await assert.rejects(()=>bench.saveDependency(wf.id,{...draft,path:'/another'},dep.id),/恢复 Real/);
    await bench.applyRoutes({[dep.id]:'real'});
    const config=path.join(ctx.project,'src/main/resources/application.properties');await fs.appendFile(config,'\nservices.user.url=http://127.0.0.1:29001\n');
    await bench.reindex();await bench.analyzeEntry(wf.entry.id);assert.equal(bench.activeWorkflow().dependencies.length,1);
    await assert.rejects(()=>bench.confirmWorkflow(wf.id),/配置地址已变化/);
    await bench.saveDependency(wf.id,draft,dep.id);await bench.confirmWorkflow(wf.id);
    assert.equal(bench.activeWorkflow().dependencies[0].originalBase,'http://127.0.0.1:29001');assert.equal(bench.generate().length,1);
  }finally{await ctx.close();}
});

test('Grok CLI generates reviewable mocks, honors selected model and handles errors and cancellation',async()=>{
  const ctx=await setup();const {bench,wf}=ctx;
  try{
    const dep=await bench.saveDependency(wf.id,paymentDependencies(bench.index!)[0]);
    const executable=path.join(ctx.temp,'fake-grok.cjs');
    const result={summary:'Grok 候选',dependencies:[],rules:[{dependencyId:dep.id,status:200,body:JSON.stringify({id:'u_001',name:'Alex',active:true})}]};
    await fs.writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
assert.equal(value('--reasoning-effort'),'medium');assert.equal(value('--sandbox'),'read-only');assert.equal(value('--tools'),'read_file,grep,list_dir');assert.equal(value('--deny'),'MCPTool');assert(args.includes('--no-subagents'));assert(args.includes('--disable-web-search'));assert.equal(value('--permission-mode'),'dontAsk');
assert(fs.existsSync('project/project-context.json'));assert.equal(fs.realpathSync(value('--cwd')),fs.realpathSync(process.cwd()));
const prompt=fs.readFileSync(value('--prompt-file'),'utf8');
if(prompt.includes('cancel-test'))setInterval(()=>{},1000);
else if(prompt.includes('error-test')){console.log(JSON.stringify({type:'error',message:'test failure'}));process.exit(1);}
else{assert.equal(value('--model'),prompt.includes('custom-test')?'grok-4.1-custom':'grok-4.7');process.stdout.write(JSON.stringify({text:JSON.stringify(${JSON.stringify(result)}),stopReason:'end_turn'},null,2));}
`,{mode:0o755});
    bench.agents=[{id:'grok',installed:true,path:executable}];
    const wait=async(task:Task)=>{for(let i=0;i<150&&task.status==='running';i++)await new Promise(r=>setTimeout(r,20));assert.notEqual(task.status,'running');};
    const task=await bench.chat('grok','生成 Mock');await wait(task);assert.equal(task.status,'completed',task.error);assert.equal(task.proposal?.length,1);assert.equal(bench.workspace.rules.length,0);assert.deepEqual(task.proposal?.[0].service,dependencyService(dep));
    await bench.approveTask(task.id);assert.equal(bench.workspace.rules.length,1);
    const custom=await bench.chat('grok','custom-test','grok-4.1-custom');await wait(custom);assert.equal(custom.status,'completed',custom.error);
    const failed=await bench.chat('grok','error-test');await wait(failed);assert.equal(failed.status,'failed');assert.match(failed.error!,/test failure/);
    const cancelled=await bench.chat('grok','cancel-test');bench.agentManager.cancel(cancelled.id);assert.equal(cancelled.status,'cancelled');
    await bench.close();
    const saved=JSON.parse(await fs.readFile(path.join(ctx.project,'.mockingbird/workspace.json'),'utf8'));
    assert(saved.messages.some((m:any)=>m.taskId===cancelled.id));
    assert(cancelled.endedAt);assert(bench.workspace.messages.some(m=>m.taskId===cancelled.id));
  }finally{await ctx.close();}
});
