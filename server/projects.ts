import { resolveAgentOptions } from '../shared/agent-options';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentInfo, ApplicationState, ProjectView, State } from '../shared/types';
import { Workbench, type Options } from './workbench';
import { atomicWrite } from './storage';
import { detectAgents } from './agents';
import { discoverModels } from './models';
import { assertPort } from './runtime';

const viewSchema=z.object({schemaVersion:z.literal(1),values:z.record(z.string(),z.unknown())});
const clientSchema=z.string().regex(/^[\w-]{1,100}$/);
const validPort=(port:unknown):port is number=>Number.isInteger(port)&&Number(port)>=1024&&Number(port)<=65535;

/** Owns project lifetimes; the active project belongs to a client, never to the server. */
export class ProjectManager {
  readonly workbenches=new Map<string,Workbench>();
  private opening=new Map<string,Promise<Workbench>>();
  private closing=new Set<string>();
  private owners=new Map<string,string>();
  private clients=new Map<string,number>();
  private writeTail:Promise<unknown>=Promise.resolve();
  private portTail:Promise<unknown>=Promise.resolve();
  private modelCache=new Map<string,ReturnType<typeof discoverModels>>();
  private closePromise?:Promise<void>;
  private stopping=false;
  agents:AgentInfo[]=[];
  recent:State['recent']=[];
  selectedModels:Record<string,string>={};
  runtimeReady=false;
  constructor(readonly options:Options){}
  async init(){
    await fs.mkdir(this.options.dataDir,{recursive:true});
    this.agents=await detectAgents();
    const probe=new Workbench({...this.options,managed:true,agents:this.agents});
    await probe.runtime.init();this.runtimeReady=probe.runtime.state.ready;
    try{this.recent=JSON.parse(await fs.readFile(path.join(this.options.dataDir,'recent.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    try{this.selectedModels=z.record(z.string(),z.string()).parse(JSON.parse(await fs.readFile(path.join(this.options.dataDir,'settings.json'),'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  private write<T>(fn:()=>Promise<T>){const run=this.writeTail.then(fn);this.writeTail=run.catch(()=>{});return run;}
  private directory(id:string){return path.join(this.options.dataDir,'projects',id);}
  get(id:string){
    const bench=this.workbenches.get(id);
    if(!bench||this.closing.has(id))throw new Error('项目未打开或正在关闭，请重新打开项目');
    return bench;
  }
  heartbeat(clientId:string){this.clients.set(clientSchema.parse(clientId),Date.now());}
  owner(id:string){
    const owner=this.owners.get(id);
    // Desktop lifetimes are explicit. Browser leases allow recovering after a tab crashes.
    if(owner&&!this.options.desktop&&Date.now()-(this.clients.get(owner)||0)>120000){this.owners.delete(id);return undefined;}
    return owner;
  }
  assertOwner(id:string,clientId?:string){
    const owner=this.owner(id);
    if(owner&&owner!==clientId)throw new Error('项目已在另一个窗口打开，请切换到该窗口');
    if(clientId){clientSchema.parse(clientId);if(owner)this.heartbeat(clientId);}
  }
  async activate(id:string,clientId:string){
    this.get(id);this.heartbeat(clientId);
    const owner=this.owner(id);
    if(owner&&owner!==clientId){
      if(this.options.focusWindow&&await this.options.focusWindow(owner))return{focused:true};
      throw new Error('项目已在另一个窗口打开，请切换到该窗口');
    }
    this.owners.set(id,clientId);return{focused:false};
  }
  state():ApplicationState{
    return{projects:[...this.workbenches].map(([id,b])=>({id,name:b.workspace.project!.name,path:b.workspace.project!.path,runtime:{status:b.runtime.state.status,port:b.runtime.state.port},launch:{status:b.launcher.state.status,port:b.launcher.state.port},runningTasks:b.agentManager.tasks.filter(t=>t.status==='running').length,ownerId:this.owner(id),closing:this.closing.has(id)})),recent:this.recent,agents:this.agents,samplePath:this.options.samplePath||path.join(this.options.root,'examples/payment-service'),desktop:Boolean(this.options.desktop),runtimeReady:this.runtimeReady,selectedModels:this.selectedModels};
  }
  projectState(id:string){return{...this.get(id).state(),recent:this.recent,agents:this.agents};}
  async open(input:string){
    if(this.stopping)throw new Error('应用正在退出');
    const root=await fs.realpath(path.resolve(z.string().trim().min(1,'请选择 Java 项目目录').parse(input)));
    const id=createHash('sha256').update(root).digest('hex').slice(0,16);
    if(this.closing.has(id))throw new Error('项目正在关闭，请稍后重新打开');
    const existing=this.workbenches.get(id);
    if(existing){await this.remember(existing);return existing;}
    const pending=this.opening.get(id);if(pending)return pending;
    const promise=this.openNew(id,root);this.opening.set(id,promise);
    try{return await promise;}finally{this.opening.delete(id);}
  }
  private async openNew(id:string,root:string){
    const bench=new Workbench({...this.options,dataDir:this.directory(id),managed:true,agents:this.agents});
    try{
      await bench.init();await bench.importProject(root);
      let ports:{mock?:number;launch?:number}={};
      try{ports=JSON.parse(await fs.readFile(path.join(this.directory(id),'ports.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      const allocate=this.portTail.then(async()=>{
      const pinned=bench.workspace.workflows.some(w=>w.dependencies.some(d=>d.route==='mock'));
      // Applied routes retain their endpoint even when busy; never silently redirect Java.
      if(!pinned)bench.runtime.state.port=await this.availablePort(validPort(ports.mock)?ports.mock:9090);
      bench.launcher.state.port=await this.availablePort(validPort(ports.launch)?ports.launch:18080,[bench.runtime.state.port]);
      if(this.stopping)throw new Error('应用正在退出');
      this.workbenches.set(id,bench);});this.portTail=allocate.catch(()=>{});await allocate;await this.remember(bench);return bench;
    }catch(e){this.workbenches.delete(id);await bench.close();throw e;}
  }
  private remember(bench:Workbench){return this.write(async()=>{
    const project=bench.workspace.project!;
    this.recent=[{name:project.name,path:project.path,openedAt:new Date().toISOString()},...this.recent.filter(r=>r.path!==project.path)].slice(0,20);
    await atomicWrite(path.join(this.options.dataDir,'recent.json'),this.recent);
  });}
  private reserved(port:number,except?:string){return [...this.workbenches].some(([id,b])=>id!==except&&(b.runtime.state.port===port||b.launcher.state.port===port));}
  private async availablePort(preferred:number,extra:number[]=[]){
    for(let port=preferred;port<=65535;port++){
      if(this.reserved(port)||extra.includes(port))continue;
      try{await assertPort(port);return port;}catch{/* Try the next port before any route is applied. */}
    }
    throw new Error('没有可用的本机服务端口');
  }
  async start(id:string,kind:'mock'|'launch',port:number){
    const run=this.portTail.then(async()=>{
      const bench=this.get(id);
      if(this.reserved(port,id)||(kind==='mock'?bench.launcher.state.port:bench.runtime.state.port)===port)throw new Error(`端口 ${port} 已分配给其它项目或服务，请选择其它端口`);
      if(kind==='mock'){
        if(bench.workspace.workflows.some(w=>w.dependencies.some(d=>d.route==='mock'))&&port!==bench.runtime.state.port)throw new Error('Mock 路由已应用，请先恢复 Real 路由再更改服务端口');
        await bench.runtime.start(port,bench.workspace.rules,bench.signal);
      }else await bench.launcher.start(bench.workspace,port,bench.signal);
      await this.savePorts(id,bench);
    });this.portTail=run.catch(()=>{});return run;
  }
  private savePorts(id:string,bench:Workbench){return atomicWrite(path.join(this.directory(id),'ports.json'),{mock:bench.runtime.state.port,launch:bench.launcher.state.port});}
  async readView(id:string):Promise<ProjectView>{
    this.get(id);
    try{return viewSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory(id),'view.json'),'utf8'))) as ProjectView;}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return{schemaVersion:1,values:{}};throw new Error('项目草稿无法读取，已有文件已保留：'+(e as Error).message);}
  }
  saveView(id:string,input:unknown){const view=viewSchema.parse(input);this.get(id);return this.write(()=>atomicWrite(path.join(this.directory(id),'view.json'),view));}
  saveSettings(input:unknown){const models=z.record(z.string().max(100),z.string().max(200)).parse(input);return this.write(async()=>{const next={...this.selectedModels,...models};await atomicWrite(path.join(this.options.dataDir,'settings.json'),next);this.selectedModels=next;});}
  async agentOptions(id:string,model?:string,effort?:string){return resolveAgentOptions(await this.models(id),model,effort);}
  async detect(){this.agents=await detectAgents();this.modelCache.clear();for(const b of this.workbenches.values())b.agents=this.agents;return this.agents;}
  models(id:string,refresh=false){
    if(refresh)this.modelCache.delete(id);
    let pending=this.modelCache.get(id);
    if(!pending){const agent=this.agents.find(a=>a.id===id);if(!agent)throw new Error('不支持的 Agent');pending=discoverModels(agent);const attempt=pending;this.modelCache.set(id,pending);pending.catch(()=>{if(this.modelCache.get(id)===attempt)this.modelCache.delete(id);});}
    return pending;
  }
  async newWindow(id:string,clientId:string){
    this.assertOwner(id,clientId);this.get(id);
    if(!this.options.openProjectWindow)throw new Error('新窗口只在桌面应用中可用');
    const next=randomUUID(),previous=this.owners.get(id);this.heartbeat(next);this.owners.set(id,next);
    try{await this.options.openProjectWindow(id,next);return{clientId:next};}catch(e){if(previous)this.owners.set(id,previous);else this.owners.delete(id);this.clients.delete(next);throw e;}
  }
  async closeProject(id:string,clientId?:string){
    this.assertOwner(id,clientId);const bench=this.get(id);this.closing.add(id);
    try{await bench.close();await this.savePorts(id,bench);this.workbenches.delete(id);this.owners.delete(id);}
    finally{this.closing.delete(id);}
  }
  async closeClient(clientId:string){
    await Promise.all([...this.owners].filter(([,owner])=>owner===clientId).map(([id])=>this.closeProject(id,clientId)));this.clients.delete(clientId);
  }
  close(){
    if(!this.closePromise)this.closePromise=(async()=>{
      this.stopping=true;await Promise.allSettled(this.opening.values());
      await Promise.all([...this.workbenches].map(async([id,b])=>{await b.close();await this.savePorts(id,b);}));
      await this.writeTail;this.workbenches.clear();this.owners.clear();this.clients.clear();
    })();return this.closePromise;
  }
}
