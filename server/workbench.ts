import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { State, Workspace, MockRule, Task, Message, Workflow } from '../shared/types';
import { readSource, type Index } from './analyzer';
import { emptyWorkspace, saveWorkspace, loadWorkspace, atomicWrite } from './storage';
import { MockRuntime, redact } from './runtime';
import { detectAgents, AgentManager } from './agents';
import { generateRules, validateRules, validateResponseContracts, assertSourceEvidence } from './rules';
import type { GenerationLaunch } from './agents';
import { routePreview, writeRoutes, ProjectLauncher } from './routes';
import { compute } from './analysis';
import { confirmDependency, pruneWorkflow } from './dependencies';
const exec=promisify(execFile);
function dependencyFingerprint(wf:Workflow,ids:string[]){return ids.map(id=>{const dep=wf.dependencies.find(item=>item.id===id);return dep?`${dep.id}\t${dep.method}\t${dep.path}\t${dep.responseType||''}\t${dep.status}`:`missing:${id}`;}).join('\n');}
export interface Options { root:string; dataDir:string; runtimeDir?:string; samplePath?:string; desktop?:boolean; chooseDirectory?:()=>Promise<string|null>;saveExport?:(artifact:{filename:string;content:string})=>Promise<string|null> }
export class Workbench extends EventEmitter{
  workspace:Workspace=emptyWorkspace();index?:Index;
  runtime:MockRuntime;launcher:ProjectLauncher;agents:State['agents']=[];agentManager:AgentManager;
  recent:State['recent']=[];problems:string[]=[];terminal:string[]=[];
  indexing?:string;
  private watcher?:FSWatcher;
  private sourceChanged=false;
  private mutationTail:Promise<unknown>=Promise.resolve();
  constructor(public options:Options){
    super();this.runtime=new MockRuntime(path.join(options.runtimeDir||path.join(options.root,'runtime'),'wiremock-standalone-3.13.2.jar'),path.join(options.dataDir,'wiremock'),()=>this.changed());
    this.launcher=new ProjectLauncher(()=>this.changed());
    this.agentManager=new AgentManager(()=>this.changed(),async task=>{
      this.addMessage('assistant',task.status==='completed'?task.summary||'任务完成':task.status==='cancelled'?'任务已取消':`Agent 任务失败：${task.error}`,task.id,task.proposal?.length?'mocks':this.activeWorkflowSafe()?'workflow':undefined);
      await saveWorkspace(this.workspace);this.changed();
    });
  }
  async init(){await fs.mkdir(this.options.dataDir,{recursive:true});await this.runtime.init();this.agents=await detectAgents();try{this.recent=JSON.parse(await fs.readFile(path.join(this.options.dataDir,'recent.json'),'utf8'));}catch{/* initial state */}}
  changed(){this.emit('change');}
  state():State{return{workspace:this.workspace,runtime:this.runtime.state,launch:this.launcher.state,tasks:this.agentManager.tasks,agents:this.agents,recent:this.recent,problems:[...(this.sourceChanged?['源码或配置发生变化，请重新索引并分析 Flow']:[]),...this.problems,...(this.workspace.project?.warnings||[]),...(this.workspace.workflows.find(w=>w.id===this.workspace.activeWorkflowId)?.warnings||[])],terminal:this.terminal,samplePath:this.options.samplePath||path.join(this.options.root,'examples/payment-service'),desktop:Boolean(this.options.desktop),indexing:this.indexing};}
  private watchProject(){
    this.watcher?.close();this.sourceChanged=false;
    try{
      this.watcher=watch(this.requireIndex().project.path,{recursive:true},(_event,file)=>{
        if(!file||this.sourceChanged)return;
        const name=file.toString().replaceAll('\\','/');
        if(name.split('/').some(part=>part.startsWith('.')||['target','build','node_modules'].includes(part)))return;
        if(!/\.java$|(?:^|\/)(?:application[^/]*\.(?:properties|ya?ml)|pom\.xml|build\.gradle(?:\.kts)?|mockingbird-contracts\.json)$/.test(name))return;
        this.sourceChanged=true;this.changed();
      });
      this.watcher.on('error',()=>{this.problems.push('无法监测源码变更，请使用重新索引按钮更新项目');this.changed();});
    }catch{this.problems.push('无法监测源码变更，请使用重新索引按钮更新项目');}
  }
  private requireFreshIndex(){if(this.sourceChanged)throw new Error('源码或配置发生变化，请先重新索引，再分析 Flow');return this.requireIndex();}
  serial<T>(fn:()=>Promise<T>):Promise<T>{const run=this.mutationTail.then(fn,fn);this.mutationTail=run.catch(()=>{});return run;}
  requireIndex(){if(!this.index)throw new Error('请先导入 Java 项目');return this.index;}
  activeWorkflow(){const wf=this.workspace.workflows.find(w=>w.id===this.workspace.activeWorkflowId);if(!wf)throw new Error('请先分析 API Flow');return wf;}
  addMessage(role:Message['role'],content:string,taskId?:string,action?:Message['action']){this.workspace.messages.push({id:randomUUID(),role,content:redact(content),at:new Date().toISOString(),taskId,action});this.workspace.messages=this.workspace.messages.slice(-100);}
  async importProject(projectPath:string){
    if(this.agentManager.tasks.some(t=>t.status==='running'))throw new Error('请先取消运行中的 Agent 任务');
    let index:Index;this.indexing='扫描 Java 项目';this.changed();
    try{index=await compute<Index>(this.options.root,'index',{path:projectPath},message=>{this.indexing=message;this.changed();});}finally{this.indexing=undefined;this.changed();}
    const loaded=await loadWorkspace(index.project.path);
    await this.runtime.stop();await this.launcher.stop();
    this.index=index;this.workspace={...loaded,project:index.project};this.agentManager.tasks=[];
    const routeFile=path.join(index.project.path,'.mockingbird/routes.properties');
    try{const config=await fs.readFile(routeFile,'utf8'),savedPort=/=http:\/\/127\.0\.0\.1:(\d+)/.exec(config)?.[1];if(savedPort)this.runtime.state.port=Number(savedPort);}catch{/* routes not yet applied */}
    if(this.workspace.workflows.some(w=>w.revision!==index.project.revision))this.problems=['源码发生变化，保存的 Flow 可能过期，请重新分析'];else this.problems=[];
    this.recent=[{name:index.project.name,path:index.project.path,openedAt:new Date().toISOString()},...this.recent.filter(r=>r.path!==index.project.path)].slice(0,12);
    await atomicWrite(path.join(this.options.dataDir,'recent.json'),this.recent);this.watchProject();this.changed();return this.state();
  }
  async reindex(){let index:Index;this.indexing='重新索引';this.changed();try{index=await compute<Index>(this.options.root,'index',{path:this.requireIndex().project.path},message=>{this.indexing=message;this.changed();});}finally{this.indexing=undefined;this.changed();}this.index=index;this.workspace.project=index.project;this.problems=this.workspace.workflows.some(w=>w.revision!==index.project.revision)?['源码发生变化，Flow 已过期，请核对依赖并确认源码版本']:[];this.watchProject();this.changed();return this.state();}
  async analyzeEntry(id:string){
    const index=this.requireFreshIndex(),old=this.workspace.workflows.find(w=>w.entry.id===id);
    const entry=index.project.entries.find(e=>e.id===id);if(!entry)throw new Error('API 入口不存在，请重新索引');
    // Reopening never discards manually confirmed dependencies, even after a source change.
    if(old){this.workspace.activeWorkflowId=old.id;await saveWorkspace(this.workspace);this.changed();return old;}
    const wf=await compute<Workflow>(this.options.root,'analyze',{index,entryId:id});
    this.workspace.workflows.push(wf);this.workspace.activeWorkflowId=wf.id;
    this.addMessage('assistant',`已打开 ${wf.entry.method} ${wf.entry.path}。请手动添加 HTTP 依赖，或指挥 AI 发现并确认依赖。`,undefined,'workflow');
    await saveWorkspace(this.workspace);this.changed();return wf;
  }
  async saveDependency(workflowId:string,input:unknown,dependencyId?:string,taskId?:string,candidateIndex?:number){
    const index=this.requireFreshIndex(),ws=structuredClone(this.workspace),wf=ws.workflows.find(w=>w.id===workflowId);
    if(!wf)throw new Error('Flow 不存在');
    const existing=dependencyId?wf.dependencies.find(d=>d.id===dependencyId):undefined;
    if(dependencyId&&!existing)throw new Error('依赖不存在');
    const task=taskId?this.agentManager.tasks.find(t=>t.id===taskId):undefined;
    if(taskId&&(!task||task.status!=='completed'||task.workflowId!==wf.id||task.revision!==index.project.revision||!Number.isInteger(candidateIndex)||!task.dependencyProposal?.[candidateIndex!]))throw new Error('AI 候选已过期或不属于当前 Flow，请重新发现');
    if(task?.acceptedDependencies?.includes(candidateIndex!))throw new Error('此候选已经加入 Flow');
    const dep=confirmDependency(input,index,wf,task?'ai':existing?.evidence.kind==='ai'?'ai':'manual',existing);
    if(existing&&ws.rules.some(r=>r.dependencyId===existing.id)&&(existing.method!==dep.method||existing.path!==dep.path))throw new Error('请先删除此依赖的 Mock 规则，再修改请求方法或路径');
    wf.dependencies=existing?wf.dependencies.map(d=>d.id===dep.id?dep:d):[...wf.dependencies,dep];
    pruneWorkflow(wf);await saveWorkspace(ws);this.workspace=ws;
    if(task)task.acceptedDependencies=[...(task.acceptedDependencies||[]),candidateIndex!];
    this.changed();return dep;
  }
  async removeDependency(workflowId:string,dependencyId:string){
    const ws=structuredClone(this.workspace),wf=ws.workflows.find(w=>w.id===workflowId),dep=wf?.dependencies.find(d=>d.id===dependencyId);
    if(!wf||!dep)throw new Error('依赖不存在');
    if(dep.route==='mock')throw new Error('请先恢复 Real 路由再移除依赖');
    if(ws.rules.some(r=>r.dependencyId===dep.id))throw new Error('请先删除此依赖的 Mock 规则再移除依赖');
    wf.dependencies=wf.dependencies.filter(d=>d.id!==dep.id);wf.edges=wf.edges.filter(e=>e.target!==dep.id);pruneWorkflow(wf);
    await saveWorkspace(ws);this.workspace=ws;this.changed();
  }
  async confirmWorkflow(id:string){
    const index=this.requireFreshIndex(),ws=structuredClone(this.workspace),wf=ws.workflows.find(w=>w.id===id);
    if(!wf)throw new Error('Flow 不存在');
    for(const dep of wf.dependencies){
      if(dep.evidence.file&&!index.sources.has(dep.evidence.file))throw new Error(dep.name+' 的源码文件已移除，请先编辑或移除此依赖');
      if(dep.configKey&&index.properties[dep.configKey]?.replace(/\/$/,'')!==dep.originalBase)throw new Error(dep.name+' 的配置地址已变化，请先编辑并确认');
    }
    wf.revision=index.project.revision;wf.analyzedAt=new Date().toISOString();await saveWorkspace(ws);this.workspace=ws;this.changed();
  }
  async selectWorkflow(id:string){if(!this.workspace.workflows.some(w=>w.id===id))throw new Error('Flow 不存在');this.workspace.activeWorkflowId=id;await saveWorkspace(this.workspace);this.changed();}
  generate(ids?:string[],scenario='Success',workflowId?:string){
    const index=this.requireFreshIndex(),wf=workflowId?this.workspace.workflows.find(item=>item.id===workflowId):this.activeWorkflow();
    if(!wf)throw new Error('Flow 不存在');
    if(wf.revision!==index.project.revision)throw new Error('Flow 已过期，请核对依赖并确认源码版本');
    if(ids?.length&&new Set(ids).size!==ids.length)throw new Error('依赖范围包含重复 ID');
    if(ids?.some(id=>!wf.dependencies.some(dep=>dep.id===id)))throw new Error('依赖不在当前 Flow');
    const deps=ids?.length?wf.dependencies.filter(d=>ids.includes(d.id)):wf.dependencies;
    const rules=generateRules(deps,index,scenario);if(!rules.length)throw new Error('没有可生成的已解析依赖，请检查待确认项');
    return rules;
  }
  async generateWithAgent(input:unknown){
    const parsed=z.object({workflowId:z.string().min(1),dependencyIds:z.array(z.string().min(1)).min(1).max(100),scenario:z.enum(['success','rejection','custom']),customScenario:z.string().max(100).optional(),instructions:z.string().max(4000).optional(),agent:z.string().min(1),model:z.string().max(200).optional()}).parse(input);
    if(parsed.agent==='local')throw new Error('源码生成必须选择已安装的 CLI，不能使用本地模板');
    const index=this.requireFreshIndex(),wf=this.workspace.workflows.find(item=>item.id===parsed.workflowId);
    if(!wf)throw new Error('Flow 不存在');
    if(wf.revision!==index.project.revision)throw new Error('Flow 已过期，请核对依赖并确认源码版本');
    if(new Set(parsed.dependencyIds).size!==parsed.dependencyIds.length)throw new Error('依赖范围包含重复 ID');
    const deps=parsed.dependencyIds.map(id=>{const dep=wf.dependencies.find(item=>item.id===id);if(!dep)throw new Error('依赖不在当前 Flow：'+id);if(dep.status==='unresolved')throw new Error('依赖尚未确认，不能生成 Mock：'+dep.name);return dep;});
    const scenarioName=parsed.scenario==='success'?'Success':parsed.scenario==='rejection'?'Business rejection':(parsed.customScenario||'').trim();
    if(!scenarioName)throw new Error('请填写自定义场景');
    const info=this.agents.find(agent=>agent.id===parsed.agent);
    if(!info?.installed||!info.path)throw new Error('所选 Agent 未安装，已停止。不会改用本地模板。');
    const scope={dependencyIds:deps.map(dep=>dep.id),scenario:parsed.scenario,scenarioName,instructions:(parsed.instructions||'').trim(),model:parsed.model?.trim()||undefined,fingerprint:dependencyFingerprint(wf,parsed.dependencyIds)};
    const launch:GenerationLaunch={workflow:structuredClone(wf),scope};
    this.addMessage('user',`根据源码为 ${wf.entry.method} ${wf.entry.path} 的 ${deps.map(dep=>dep.name).join('、')} 生成「${scenarioName}」Mock${scope.instructions?'。'+scope.instructions:''}`);
    await saveWorkspace(this.workspace);
    return this.agentManager.run(info,scope.instructions||scenarioName,index,this.workspace,scope.model,launch);
  }
  private assertTaskFresh(task:Task){
    let index:Index;try{index=this.requireFreshIndex();}catch{throw new Error('源码或配置已变化，AI 候选已过期，请重新索引并重新生成');}
    if(!task.workflowId||task.revision!==index.project.revision)throw new Error('AI 候选绑定的源码版本已过期，请重新生成');
    const wf=this.workspace.workflows.find(item=>item.id===task.workflowId);
    if(!wf||wf.revision!==index.project.revision)throw new Error('AI 候选绑定的 Flow 已过期，请核对依赖后重新生成');
    if(task.generation&&dependencyFingerprint(wf,task.generation.dependencyIds)!==task.generation.fingerprint)throw new Error('所选依赖已变化，AI 候选不能应用，请重新生成');
  }
  reviewTask(id:string){
    const task=this.agentManager.tasks.find(item=>item.id===id);
    if(!task?.proposal?.length||task.status!=='completed')throw new Error('没有可审核的候选规则');
    if(task.approved)throw new Error('候选已经应用');
    if(task.revision)this.assertTaskFresh(task);
    return{rules:task.proposal};
  }
  async setRules(input:unknown){
    const rules=validateRules(input);const dependencies=this.workspace.workflows.flatMap(w=>w.dependencies);
    for(const task of this.agentManager.tasks)if(task.proposal?.length&&!task.approved&&task.revision&&task.proposal.some(proposal=>rules.some(rule=>rule.id===proposal.id)))this.assertTaskFresh(task);
    for(const rule of rules){if(!dependencies.some(d=>d.id===rule.dependencyId))throw new Error(`规则 ${rule.name} 对应的依赖已不存在，请重新生成`);if(rule.evidence?.length)assertSourceEvidence(rule.evidence,this.requireIndex());}
    validateResponseContracts(rules,dependencies,this.requireIndex());
    const previous=this.workspace.rules;
    const next=rules.map(r=>{const before=previous.find(p=>p.id===r.id);return{...r,version:before&&JSON.stringify({...before,version:0})!==JSON.stringify({...r,version:0})?before.version+1:before?.version||1};});
    await this.runtime.publish(next);
    const changed=JSON.stringify(previous)!==JSON.stringify(next);
    const before={id:randomUUID(),name:'ChangeSet · before mock update',createdAt:new Date().toISOString(),revision:this.requireIndex().project.revision,workflowId:this.workspace.activeWorkflowId,rules:structuredClone(previous),routes:Object.fromEntries(dependencies.map(d=>[d.id,d.route])),port:this.runtime.state.port};
    const ws={...this.workspace,rules:next,snapshots:changed?[before,...this.workspace.snapshots].slice(0,50):this.workspace.snapshots};
    try{await saveWorkspace(ws);}catch(e){await this.runtime.publish(previous);throw e;}
    this.workspace=ws;
    for(const task of this.agentManager.tasks)if(task.proposal?.length&&task.proposal.every(r=>next.some(n=>n.id===r.id)))task.approved=true;
    this.problems=[];this.changed();return next;
  }
  async setRoutes(input:Record<string,'real'|'mock'>){
    const changes=z.record(z.string(),z.enum(['real','mock'])).parse(input);
    const ws=structuredClone(this.workspace);
    const deps=ws.workflows.flatMap(w=>w.dependencies);
    for(const[id,route]of Object.entries(changes)){
      const dep=deps.find(d=>d.id===id);if(!dep)throw new Error('依赖不存在');
      if(route==='mock'&&(!dep.configKey||dep.status==='unresolved'))throw new Error(`${dep.name} 无法自动路由：URL 未解析或没有可覆盖的配置项`);
      dep.route=route;
    }
    const preview=await routePreview(ws,this.runtime.state.port);return {workspace:ws,preview};
  }
  async applyRoutes(input:Record<string,'real'|'mock'>){
    const {workspace:ws,preview}=await this.setRoutes(input);const original=(await routePreview(this.workspace,this.runtime.state.port)).config;
    await writeRoutes(ws,this.runtime.state.port);
    try{await saveWorkspace(ws);}catch(e){await atomicWrite(path.join(this.requireIndex().project.path,'.mockingbird/routes.properties'),original);throw e;}
    this.workspace=ws;if(this.launcher.child)this.launcher.state.stale=true;this.changed();return preview;
  }
  async snapshot(name:string){
    const wf=this.workspace.workflows.find(w=>w.id===this.workspace.activeWorkflowId);
    const snapshot={id:randomUUID(),name:name.trim()||'Environment snapshot',createdAt:new Date().toISOString(),revision:this.requireIndex().project.revision,workflowId:wf?.id,rules:structuredClone(this.workspace.rules),routes:Object.fromEntries(this.workspace.workflows.flatMap(w=>w.dependencies).map(d=>[d.id,d.route])),port:this.runtime.state.port};
    const ws={...this.workspace,snapshots:[snapshot,...this.workspace.snapshots].slice(0,50)};await saveWorkspace(ws);this.workspace=ws;this.changed();return snapshot;
  }
  async restore(id:string){
    const snapshot=this.workspace.snapshots.find(s=>s.id===id);if(!snapshot)throw new Error('Snapshot 不存在');
    if(this.runtime.child&&snapshot.port!==this.runtime.state.port)throw new Error('Snapshot 端口与运行服务不同，请先停止 Mock Server 后恢复');
    const ws=structuredClone(this.workspace);ws.rules=validateRules(snapshot.rules);
    const known=new Set(ws.workflows.flatMap(w=>w.dependencies).map(d=>d.id));if(snapshot.rules.some(r=>!known.has(r.dependencyId)))throw new Error('Snapshot 对应旧的 Flow，请恢复原源码并重新导入后再试');
    for(const dep of ws.workflows.flatMap(w=>w.dependencies))dep.route=snapshot.routes[dep.id]||'real';
    const prev=(await routePreview(this.workspace,this.runtime.state.port)).config;
    await this.runtime.publish(ws.rules);
    try{await writeRoutes(ws,snapshot.port);await saveWorkspace(ws);}catch(e){await this.runtime.publish(this.workspace.rules);await atomicWrite(path.join(this.requireIndex().project.path,'.mockingbird/routes.properties'),prev);throw e;}
    this.workspace=ws;this.runtime.state.port=snapshot.port;if(this.launcher.child)this.launcher.state.stale=true;
    this.addMessage('assistant',`已恢复快照「${snapshot.name}」的 Mock 与路由配置。运行中的 Java 项目需要重启以载入恢复后的路由。`);await saveWorkspace(ws);this.changed();
  }
  async chat(agent:string,prompt:string,model?:string,workflowId?:string){
    if(!prompt.trim()||prompt.length>10000)throw new Error('请输入 1–10,000 字符的请求');this.requireFreshIndex();
    if(workflowId)await this.selectWorkflow(workflowId);
    this.workspace.selectedAgent=agent;this.addMessage('user',prompt);await saveWorkspace(this.workspace);
    if(agent==='local'){
      const task:Task={id:randomUUID(),agent:'local',prompt,status:'running',startedAt:new Date().toISOString(),output:''};this.agentManager.tasks.unshift(task);this.changed();
      try{
        if(/生成|generate|mock/i.test(prompt)&&!/启动|start|stop|停止/i.test(prompt)){task.proposal=this.generate(undefined,/异常|失败|error/i.test(prompt)?'Error':'Success');task.summary=`已根据本地 DTO / 响应样本生成 ${task.proposal.length} 条候选规则。请在 Mock Review 中查看差异并应用。`;}
        else if(/分析|flow|调用链|analy/i.test(prompt)){
          const entry=this.workspace.project!.entries.find(e=>prompt.includes(e.path))||this.workspace.project!.entries.find(e=>e.id===this.activeWorkflowSafe()?.entry.id)||this.workspace.project!.entries[0];if(!entry)throw new Error('未找到可分析的 Controller');await this.analyzeEntry(entry.id);task.summary='已打开 Flow。请手动添加依赖，或选择 Codex / OpenCode 发现依赖。';
        }else task.summary='本地助手支持打开 API Flow 和生成已确认依赖的 Mock。更复杂的自然语言分析或修改，请选择 Codex / OpenCode。启动服务、路由和项目运行请使用工作台按钮。';
        task.status='completed';task.endedAt=new Date().toISOString();this.addMessage('assistant',task.summary,task.id,task.proposal?'mocks':'workflow');
      }catch(e){task.status='failed';task.error=(e as Error).message;this.addMessage('assistant',task.error,task.id);}
      await saveWorkspace(this.workspace);this.changed();return task;
    }
    const info=this.agents.find(a=>a.id===agent);if(!info)throw new Error('Agent 不存在');
    if(/分析|发现|依赖|flow|调用链|生成|mock|discover|dependenc/i.test(prompt)){
      const entry=this.workspace.project!.entries.find(e=>prompt.includes(e.path))||(!this.activeWorkflowSafe()?this.workspace.project!.entries[0]:undefined);
      if(entry&&this.activeWorkflowSafe()?.entry.id!==entry.id)await this.analyzeEntry(entry.id);
    }
    return this.agentManager.run(info,prompt,this.index!,this.workspace,model);
  }
  activeWorkflowSafe(){return this.workspace.workflows.find(w=>w.id===this.workspace.activeWorkflowId);}
  async approveTask(id:string){
    const task=this.agentManager.tasks.find(t=>t.id===id);if(!task?.proposal?.length)throw new Error('没有候选规则');
    if(task.approved)throw new Error('候选已经应用');
    if(task.revision)this.assertTaskFresh(task);
    if(task.kind==='generate'&&task.generation){
      const selected=new Set(task.generation.dependencyIds),proposalIds=new Set(task.proposal.map(rule=>rule.id));
      await this.setRules([...this.workspace.rules.filter(rule=>!proposalIds.has(rule.id)).map(rule=>selected.has(rule.dependencyId)?{...rule,enabled:false}:rule),...task.proposal]);
    }else{const replace=new Set(task.proposal.map(r=>r.id)),deps=new Set(task.proposal.map(r=>r.dependencyId));await this.setRules([...this.workspace.rules.filter(r=>!replace.has(r.id)&&!deps.has(r.dependencyId)),...task.proposal]);}
    task.approved=true;this.changed();
  }
  async testRequest(input:{target:'mock'|'project';method:string;path:string;body?:unknown;headers?:Record<string,string>}){
    const data=z.object({target:z.enum(['mock','project']),method:z.enum(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']),path:z.string().startsWith('/').max(2000),body:z.json().optional(),headers:z.record(z.string(),z.string()).optional()}).parse(input);
    if(data.path.startsWith('//')||data.path.startsWith('/__admin')||data.path.includes('://'))throw new Error('请求路径非法');
    const runtime=data.target==='mock'?this.runtime.state:this.launcher.state;if(runtime.status!=='running')throw new Error('目标服务尚未运行');
    const url=`http://127.0.0.1:${runtime.port}${data.path}`;const started=Date.now();
    const response=await fetch(url,{method:data.method,headers:{'Content-Type':'application/json',...data.headers},body:['GET','HEAD'].includes(data.method)?undefined:JSON.stringify(data.body??{}),redirect:'error',signal:AbortSignal.timeout(35000)});
    const body=redact((await response.text()).slice(0,1024*1024));
    return{status:response.status,headers:Object.fromEntries(response.headers),body,duration:Date.now()-started,url};
  }
  async terminalCommand(command:string){
    const choices:Record<string,[string,string[]]>={'java --version':['java',['--version']],'mvn --version':['mvn',['--version']],'git status --short':['git',['status','--short']],'git rev-parse HEAD':['git',['rev-parse','HEAD']]};
    const spec=choices[command];if(!spec)throw new Error('首版终端仅允许列表中的诊断命令');
    this.terminal.push('$ '+command);try{const result=await exec(spec[0],spec[1],{cwd:this.index?.project.path||this.options.root,timeout:10000,maxBuffer:1024*1024});this.terminal.push(redact(result.stdout+result.stderr));}catch(e){this.terminal.push(redact((e as Error).message));}this.terminal=this.terminal.slice(-100);this.changed();
  }
  source(relative:string){return readSource(this.requireIndex(),relative);}
  async close(){this.watcher?.close();await Promise.all([this.agentManager.stopAll(),this.runtime.stop(),this.launcher.stop()]);}
}
