import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Dependency, DependencyDraft, Workflow } from '../shared/types';
import { propertyForSource, type Index } from './analyzer';

const reference=z.object({file:z.string().max(2000),line:z.number().int().min(1)});
export const dependencyDraftSchema=z.object({
  name:z.string().trim().min(1).max(200),client:z.string().trim().min(1).max(200),
  method:z.enum(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']),path:z.string().trim().max(2000),
  originalBase:z.string().trim().max(2000),configKey:z.string().trim().max(200),responseType:z.string().trim().max(200),
  file:z.string().max(2000),line:z.number().int().min(1),note:z.string().max(5000),callChain:z.array(reference).max(40)
});

export function sourceEvidence(index:Index,file:string,line:number){
  const source=index.sources.get(file);
  if(!source)throw new Error('源码文件未在当前项目索引中：'+file);
  const lines=source.split('\n');
  if(line>lines.length)throw new Error('源码行号超出文件范围：'+file);
  return{file,line,snippet:lines.slice(line-1,line+2).join('\n').trim()};
}

// Validate all references before changing a workflow; snippets always come from the project.
export function validateDependencyDraft(input:unknown,index:Index):DependencyDraft{
  const draft=dependencyDraftSchema.parse(input);
  if(draft.file)sourceEvidence(index,draft.file,draft.line);
  for(const ref of draft.callChain)sourceEvidence(index,ref.file,ref.line);
  return draft;
}

export function confirmDependency(input:unknown,index:Index,wf:Workflow,kind:'manual'|'ai',existing?:Dependency):Dependency{
  const draft=validateDependencyDraft(input,index);
  if(!draft.path.startsWith('/')||draft.path.startsWith('//')||draft.path.startsWith('/__admin')||/[?#\s]/.test(draft.path))throw new Error('请确认请求路径，以 / 开头，不包含查询串、空格或 fragment');
  let base=draft.originalBase;
  if(draft.configKey){
    const configured=propertyForSource(index,draft.configKey,wf.entry.file);
    if(!configured)throw new Error('未找到此配置项，请核对或清空配置键');
    base=configured;
  }
  if(base){
    let url:URL;try{url=new URL(base);}catch{throw new Error('基础地址未解析，请填写完整 HTTP 地址或清空');}
    if(!['http:','https:'].includes(url.protocol)||url.search||url.hash||url.username||url.password)throw new Error('基础地址必须是无查询串、fragment 或认证信息的 HTTP 地址');
    base=base.replace(/\/$/,'');
  }
  if(existing?.route==='mock'&&(existing.configKey!==draft.configKey||existing.originalBase!==base||existing.path!==draft.path||existing.method!==draft.method))throw new Error('请先将此依赖恢复 Real 路由再修改地址');
  if(wf.dependencies.some(d=>d.id!==existing?.id&&d.method===draft.method&&d.path===draft.path&&(d.originalBase||'')===base))throw new Error('此 HTTP 依赖已存在，可点击节点编辑');
  const ref=draft.file?draft:{file:wf.entry.file,line:wf.entry.line};
  const evidence=draft.file?sourceEvidence(index,ref.file,ref.line):{file:'',line:1,snippet:''};
  const sourceMethod=index.methods.find(m=>m.file===ref.file&&m.line<=ref.line&&m.end>=index.sources.get(ref.file)!.split('\n').slice(0,ref.line-1).join('\n').length);
  const chain=draft.callChain.map(ref=>index.methods.find(m=>m.file===ref.file&&m.line===ref.line)).filter(m=>m!==undefined);
  const methods=[...chain,...(sourceMethod?[sourceMethod]:[])];
  let parent=wf.entry.methodId;
  for(const method of methods){
    if(method.id===parent)continue;
    if(!wf.methods.some(m=>m.id===method.id))wf.methods.push({id:method.id,className:method.className,name:method.name,file:method.file,line:method.line});
    if(!wf.edges.some(e=>e.source===parent&&e.target===method.id))wf.edges.push({source:parent,target:method.id,label:kind==='ai'?'AI 推断':'用户指定'});
    parent=method.id;
  }
  const id=existing?.id||randomUUID();
  wf.edges=wf.edges.filter(e=>e.target!==id);wf.edges.push({source:parent,target:id,label:draft.client});
  return{id,name:draft.name,client:draft.client,method:draft.method,path:draft.path,url:base+draft.path,configKey:draft.configKey||undefined,originalBase:base||undefined,sourceMethod:parent,evidence:{...evidence,kind,note:draft.note||(draft.file?'用户已确认；实际请求需运行验证':'用户手动添加，未指定源码位置；实际请求需运行验证')},status:'confirmed',route:existing?.route||'real',responseType:draft.responseType||undefined};
}

export function pruneWorkflow(wf:Workflow){
  const needed=new Set([wf.entry.methodId,...wf.dependencies.map(d=>d.id)]);
  let changed=true;
  while(changed){changed=false;for(const edge of wf.edges)if(needed.has(edge.target)&&!needed.has(edge.source)){needed.add(edge.source);changed=true;}}
  wf.methods=wf.methods.filter(m=>needed.has(m.id));wf.edges=wf.edges.filter(e=>needed.has(e.source)&&needed.has(e.target));
}
