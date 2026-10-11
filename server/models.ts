import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import type { AgentInfo, AgentModel } from '../shared/types';
import { terminate, redact } from './runtime';
import { isFastModel } from '../shared/agent-options';
import { cliEnvironment } from './cli-environment';

export function parseOpenCodeModels(output:string):AgentModel[]{
  const clean=output.replace(/\x1b\[[0-9;]*m/g,'');
  const rows=[...clean.matchAll(/^([\w.-]+\/[^\s]+)\s*$/gm)];
  const models:AgentModel[]=[];
  for(let i=0;i<rows.length;i++){
    const id=rows[i][1];if(models.some(m=>m.id===id))continue;
    const block=clean.slice(rows[i].index!+rows[i][0].length,rows[i+1]?.index).trim();
    let metadata:any;try{metadata=JSON.parse(block);}catch{/* older CLI plain output */}
    const variants=metadata?.variants;
    const efforts=variants&&typeof variants==='object'?Object.keys(variants).filter(key=>variants[key]?.disabled!==true):[];
    models.push({id,name:metadata?.name||id,...(efforts.length?{efforts}:{})});
  }
  return models;
}
export function parseGrokModels(output:string):AgentModel[]{
  const clean=output.replace(/\x1b\[[0-9;]*m/g,'');
  const models:AgentModel[]=[];
  for(const line of clean.split(/\r?\n/)){
    const match=/^\s*[-*]\s+([\w][\w./:-]*)\s*(?:\(default\))?\s*$/.exec(line);
    if(match&&!models.some(m=>m.id===match[1])){
      const id=match[1],version=/^grok-4\.(5|6|7)(?:$|-)/.exec(id);
      models.push({id,name:id,isDefault:/\(default\)/.test(line),...(version?{efforts:['low','medium','high',...(version[1]!=='5'?['xhigh']:[])],defaultEffort:'medium'}:{})});
    }
  }
  return models;
}
export async function discoverModels(agent:AgentInfo):Promise<AgentModel[]>{
  const models=(await discoverModelCatalog(agent)).map(model=>isFastModel(model)?{...model,disabled:true}:model);
  if(models.some(model=>model.isDefault&&!isFastModel(model)&&!model.disabled))return models;
  const index=models.findIndex(model=>!model.disabled&&!isFastModel(model));
  return index<0?models:models.map((model,i)=>i===index?{...model,isDefault:true}:model);
}
async function discoverModelCatalog(agent:AgentInfo):Promise<AgentModel[]>{
  if(!agent.installed||!agent.path)throw new Error('请先安装并登录所选 CLI');
  if(agent.id==='grok'){
    const {stdout}=await promisify(execFile)(agent.path,['models'],{cwd:os.tmpdir(),timeout:20000,maxBuffer:4*1024*1024,env:cliEnvironment(agent.path)});
    const models=parseGrokModels(stdout);if(!models.length)throw new Error('Grok 未返回模型，请在终端运行 grok login 完成登录');return models;
  }
  if(agent.id==='opencode'){
    const {stdout}=await promisify(execFile)(agent.path,['models','--pure','--verbose'],{cwd:os.tmpdir(),timeout:20000,maxBuffer:4*1024*1024,env:{...cliEnvironment(agent.path),OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_DISABLE_AUTOUPDATE:'true'}});
    const models=parseOpenCodeModels(stdout);if(!models.length)throw new Error('OpenCode 未返回模型，请检查提供商配置');return models;
  }
  if(agent.id!=='codex')throw new Error('不支持的 Agent');
  return new Promise((resolve,reject)=>{
    const child=spawn(agent.path!,['app-server','--listen','stdio://'],{cwd:os.tmpdir(),env:cliEnvironment(agent.path),detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    let buffer='',stderr='',done=false,pages=0;const models:AgentModel[]=[];
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);terminate(child);if(error)reject(error);else if(!models.length)reject(new Error('Codex 未返回模型，请检查 CLI 登录状态'));else resolve(models);};
    const send=(message:unknown)=>child.stdin.write(JSON.stringify(message)+'\n');
    const timer=setTimeout(()=>finish(new Error('读取 Codex 模型超时，请重试')),20000);
    child.stdin.on('error',e=>finish(e));child.on('error',e=>finish(e));child.on('close',()=>{if(!done)finish(new Error('Codex 模型发现进程提前退出'+(stderr?'：'+stderr:'')));});
    child.stderr.on('data',chunk=>{stderr=redact(stderr+chunk.toString()).slice(-1000);});
    child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>4*1024*1024)return finish(new Error('Codex 模型响应过大'));
      const lines=buffer.split('\n');buffer=lines.pop()||'';
      for(const line of lines){
        let message:any;try{message=JSON.parse(line);}catch{continue;}
        if(message.id!==1&&message.id!==2)continue;
        if(message.error)return finish(new Error(message.error.message||'Codex 模型发现失败'));
        if(message.id===1){send({method:'initialized'});send({id:2,method:'model/list',params:{limit:100,includeHidden:false}});}
        else{
          for(const m of message.result?.data||[])if(!m.hidden&&typeof m.model==='string'&&!models.some(x=>x.id===m.model))models.push({id:m.model,name:m.displayName||m.model,isDefault:!!m.isDefault,...(Array.isArray(m.supportedReasoningEfforts)?{efforts:m.supportedReasoningEfforts.map((item:any)=>item.reasoningEffort).filter((value:unknown)=>typeof value==='string'),defaultEffort:m.defaultReasoningEffort}:{})});
          const cursor=message.result?.nextCursor;
          if(cursor&&++pages<20)send({id:2,method:'model/list',params:{limit:100,includeHidden:false,cursor}});else finish();
        }
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'mockingbird',title:'Mockingbird',version:'0.1.0'},capabilities:{experimentalApi:false}}});
  });
}
