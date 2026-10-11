import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../server/workbench';
import { entryId } from '../server/analyzer';
import type { EntryDraft, Task } from '../shared/types';

const legacyFile='src/main/java/dev/mockingbird/payment/LegacyOrderController.java';
const legacySource=`package dev.mockingbird.payment;

public class LegacyOrderController {
    @GetMapping("/legacy/orders")
    public String listOrders() {
        return "ok";
    }

    @PostMapping("/legacy/orders")
    public String createOrder() {
        return "created";
    }
}
`;

async function setup(){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-entries-')),project=path.join(temp,'project');
  await fs.cp('examples/payment-service',project,{recursive:true,filter:file=>!file.split(path.sep).some(part=>['target','.mockingbird'].includes(part))});
  await fs.writeFile(path.join(project,legacyFile),legacySource);
  const bench=new Workbench({root:process.cwd(),dataDir:path.join(temp,'data')});
  await bench.importProject(project);
  return{temp,project,bench,close:async()=>{await bench.close();await fs.rm(temp,{recursive:true,force:true});}};
}
async function wait(task:Task){for(let i=0;i<100&&task.status==='running';i++)await new Promise(resolve=>setTimeout(resolve,20));}

test('AI entry discovery stays review-only until selected candidates are submitted',async()=>{
  const ctx=await setup();
  try{
    assert.equal(ctx.bench.workspace.project!.entries.some(entry=>entry.file===legacyFile),false);
    const list=ctx.bench.index!.methods.find(method=>method.name==='listOrders')!;
    const create=ctx.bench.index!.methods.find(method=>method.name==='createOrder')!;
    const known=ctx.bench.workspace.project!.entries.find(entry=>entry.path.endsWith('/create'))!;
    const drafts:EntryDraft[]=[
      {method:'GET',path:'/legacy/orders',className:list.className,name:list.name,file:list.file,line:list.line,note:'类上没有 Controller 注解'},
      {method:'POST',path:'/legacy/orders',className:create.className,name:create.name,file:create.file,line:create.line+2,note:'行号落在方法体内'},
      {method:known.method,path:known.path,className:known.className,name:known.name,file:known.file,line:known.line,note:'已经索引过'},
      {method:'GET',path:'/missing',className:'Missing',name:'missing',file:'src/Missing.java',line:1,note:'文件不存在'}
    ];
    const executable=path.join(ctx.temp,'fake-codex.cjs');
    const result=JSON.stringify({summary:'找到两个未标注入口',entries:drafts});
    await fs.writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[args.indexOf('--sandbox')+1]!=='read-only')throw new Error('missing read-only sandbox');
const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
if(!schema.properties.entries)throw new Error('entry schema missing');
if(!fs.readFileSync('project/${legacyFile}','utf8').includes('listOrders'))throw new Error('legacy controller missing from snapshot');
const result=${result};
let input='';
process.stdin.on('data',chunk=>{input+=chunk;});
process.stdin.on('end',()=>{
  if(!input.includes('只看订单控制器'))throw new Error('user prompt missing');
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
});
`);
    await fs.chmod(executable,0o755);
    ctx.bench.agents=[{id:'codex',installed:true,path:executable}];
    await assert.rejects(()=>ctx.bench.discoverEntries({prompt:'找入口',agent:'local'}),/CLI/);
    const task=await ctx.bench.discoverEntries({prompt:'只看订单控制器',agent:'codex'});
    await wait(task);
    assert.equal(task.status,'completed',task.error);
    assert.equal(task.kind,'entry-discovery');
    assert.equal(task.workflowId,undefined);
    assert.equal(task.entryProposal?.length,2);
    assert.equal(task.entryProposal?.[1].line,create.line);
    assert.match(task.summary||'',/已忽略 2 条/);
    assert.equal(ctx.bench.workspace.project!.entries.some(entry=>entry.file===legacyFile),false);
    await assert.rejects(()=>ctx.bench.acceptEntries({taskId:task.id,selected:[{index:0,method:'GET',path:'legacy'}]}),/候选 1/);
    assert.equal(task.approved,undefined);
    await assert.rejects(()=>ctx.bench.acceptEntries({taskId:task.id,selected:[{index:0,method:'POST',path:known.path}]}),/已在入口列表中/);
    const saved=await ctx.bench.acceptEntries({taskId:task.id,selected:[{index:0,method:'POST',path:'/manual/orders/'}]});
    assert.equal(saved.accepted.length,1);
    assert.equal(saved.accepted[0].method,'POST');
    assert.equal(saved.accepted[0].path,'/manual/orders');
    assert.equal(saved.accepted[0].id,entryId(list.id,'/manual/orders'));
    assert.equal(ctx.bench.workspace.manualEntries?.length,1);
    assert.equal(task.approved,true);
    await assert.rejects(()=>ctx.bench.acceptEntries({taskId:task.id,selected:[{index:1,method:'POST',path:'/legacy/orders'}]}),/已经提交/);
    const wf=await ctx.bench.analyzeEntry(saved.accepted[0].id);
    assert.equal(wf.dependencies.length,0);
    assert.equal(wf.entry.method,'POST');
    await ctx.bench.close();
    const reopened=new Workbench({root:process.cwd(),dataDir:path.join(ctx.temp,'data-2')});
    try{
      await reopened.importProject(ctx.project);
      const again=reopened.workspace.project!.entries.find(entry=>entry.path==='/manual/orders');
      assert.equal(again?.id,saved.accepted[0].id);
      assert.equal(reopened.workspace.manualEntries?.length,1);
      await fs.writeFile(path.join(ctx.project,legacyFile),'// shifted\n'+legacySource);
      await reopened.reindex();
      const shifted=reopened.workspace.manualEntries?.[0];
      assert.equal(shifted?.id,saved.accepted[0].id);
      assert.notEqual(shifted?.methodId,list.id);
      assert.equal((await reopened.analyzeEntry(saved.accepted[0].id)).id,wf.id);
    }finally{await reopened.close();}
  }finally{await ctx.close();}
});

test('Reindex drops a manual entry when static discovery or the handler disappears',async()=>{
  const ctx=await setup();
  try{
    const list=ctx.bench.index!.methods.find(method=>method.name==='listOrders')!;
    const task:Task={id:'entry-task',agent:'codex',prompt:'发现入口',status:'completed',startedAt:new Date().toISOString(),output:'',kind:'entry-discovery',revision:ctx.bench.index!.project.revision,entryProposal:[{method:'GET',path:'/legacy/orders',className:list.className,name:list.name,file:list.file,line:list.line,note:'手动确认前的候选'}]};
    ctx.bench.agentManager.tasks.push(task);
    const saved=await ctx.bench.acceptEntries({taskId:task.id,selected:[{index:0,method:'GET',path:'/legacy/orders'}]});
    await fs.writeFile(path.join(ctx.project,legacyFile),legacySource.replace('public class','@RestController public class'));
    await ctx.bench.reindex();
    assert.equal(ctx.bench.workspace.manualEntries?.length,0);
    const indexed=ctx.bench.workspace.project!.entries.filter(entry=>entry.method==='GET'&&entry.path==='/legacy/orders');
    assert.equal(indexed.length,1);
    assert.equal(indexed[0].id,saved.accepted[0].id);
    assert.equal(ctx.bench.workspace.project!.entries.filter(entry=>entry.method==='POST'&&entry.path==='/legacy/orders').length,1);
    assert.match(ctx.bench.problems.join('\n'),/已由静态索引发现/);
    await fs.writeFile(path.join(ctx.project,legacyFile),'package dev.mockingbird.payment;\npublic class LegacyOrderController {}\n');
    await ctx.bench.reindex();
    assert.equal(ctx.bench.workspace.project!.entries.some(entry=>entry.path==='/legacy/orders'),false);
    await assert.rejects(()=>ctx.bench.analyzeEntry(saved.accepted[0].id),/入口不存在/);
    const stale:Task={...task,id:'stale-entry',approved:false,revision:saved.accepted[0].id};
    ctx.bench.agentManager.tasks.push(stale);
    await assert.rejects(()=>ctx.bench.acceptEntries({taskId:stale.id,selected:[{index:0,method:'GET',path:'/legacy/orders'}]}),/过期/);
  }finally{await ctx.close();}
});
