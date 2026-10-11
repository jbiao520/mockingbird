import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveAgentOptions } from '../shared/agent-options';
import { discoverModels, parseOpenCodeModels } from '../server/models';
import { AgentManager } from '../server/agents';
import type { Index } from '../server/analyzer';
import type { Workspace } from '../shared/types';

test('Fast models cannot be selected or used as defaults, and effort is model-specific',()=>{
  const models=[{id:'provider/quick',name:'FAST model',isDefault:true},{id:'normal',name:'Normal',efforts:['medium','high'],defaultEffort:'medium'}];
  assert.deepEqual(resolveAgentOptions(models),{model:'normal',effort:'medium'});
  assert.deepEqual(resolveAgentOptions(models,'missing-model'),{model:'normal',effort:'medium'});
  assert.throws(()=>resolveAgentOptions(models,'provider/quick'),/Fast/);
  assert.throws(()=>resolveAgentOptions(models,'grok-4.7-build-fast'),/Fast/);
  assert.throws(()=>resolveAgentOptions(models,'normal','ultra'),/不支持/);
  assert.throws(()=>resolveAgentOptions(models.slice(0,1)),/没有可用/);
  assert.deepEqual(resolveAgentOptions(models,'normal','high'),{model:'normal',effort:'high'});
});

test('OpenCode verbose catalogs preserve model names and configured variants',()=>{
  const output='provider/model\n'+JSON.stringify({name:'Model',variants:{low:{},high:{},disabled:{disabled:true}}},null,2)+'\nprovider/plain\n';
  assert.deepEqual(parseOpenCodeModels(output),[{id:'provider/model',name:'Model',efforts:['low','high']},{id:'provider/plain',name:'provider/plain'}]);
});

test('Codex discovery retains supported efforts and disables Fast display names',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-effort-models-')),cli=path.join(temp,'cli');
  try{
    await fs.writeFile(cli,`#!${process.execPath}\nrequire('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));if(m.method==='model/list')console.log(JSON.stringify({id:m.id,result:{data:[{model:'normal',displayName:'Normal',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'low'},{model:'quick',displayName:'Fast'}]}}));});`,{mode:0o755});
    const models=await discoverModels({id:'codex',installed:true,path:cli});
    assert.deepEqual(models[0].efforts,['low','high']);assert.equal(models[0].defaultEffort,'low');assert.equal(models[1].disabled,true);
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});

for(const id of ['codex','grok','opencode'])test(`${id} sends effort to its CLI and rejects Fast before spawning`,async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-effort-launch-')),cli=path.join(temp,'cli'),capture=path.join(temp,'args.json');
  const manager=new AgentManager(()=>{},async()=>{});
  const index={project:{revision:'test',entries:[]},sources:new Map(),contracts:{}} as unknown as Index;
  const ws={project:null,workflows:[],rules:[],messages:[],selectedAgent:id} as Workspace;
  try{
    await fs.writeFile(cli,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));process.exit(1);`,{mode:0o755});
    await assert.rejects(()=>manager.run({id,installed:true,path:cli},'test',index,ws,'model-fast',undefined,'high'),/Fast/);
    await assert.rejects(()=>fs.access(capture));
    const task=await manager.run({id,installed:true,path:cli},'test',index,ws,'normal',undefined,'high');
    for(let i=0;i<100&&task.status==='running';i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(task.status,'failed');assert.equal(task.effort,'high');
    const args=JSON.parse(await fs.readFile(capture,'utf8')) as string[];
    if(id==='codex')assert(args.includes('model_reasoning_effort="high"'));
    else assert.equal(args[args.indexOf(id==='grok'?'--reasoning-effort':'--variant')+1],'high');
  }finally{await manager.stopAll();await fs.rm(temp,{recursive:true,force:true});}
});
