import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { FlowScenario, MockRule, RegressionRun, Workspace, Workflow, RequestLog } from '../shared/types';
import { getPointer, pointerParts } from '../shared/behavior';
import { scenarioDependencyFingerprint, scenarioRuleFingerprint, scenarioStaleReason } from '../shared/regression';
import { validateRules, validateResponseContracts } from './rules';
import { validateEntryRequest } from './request-shape';
import type { Index } from './analyzer';
import { MockRuntime, redact, terminate } from './runtime';
import { ProjectLauncher, routePreview } from './routes';
import { atomicWrite } from './storage';
import { resolveEntryContextPath } from './entry-runtime';
export const MAX_REGRESSION_REQUESTS=5000;

const scenarioInput=z.object({
  id:z.string().optional(),workflowId:z.string(),name:z.string().trim().min(1).max(100),
  request:z.object({method:z.enum(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']),path:z.string().startsWith('/').max(2000),headers:z.record(z.string(),z.string()),body:z.json().optional()}),
  mocks:z.array(z.object({dependencyId:z.string(),ruleId:z.string(),calls:z.number().int().min(0).max(5000).optional()})).max(200),
  expected:z.object({status:z.number().int().min(100).max(599),fields:z.record(z.string(),z.json())})
});
export function assertScenarioRequest(request:FlowScenario['request']){
  const url=new URL(request.path,'http://127.0.0.1');
  if(url.origin!=='http://127.0.0.1'||request.path.startsWith('//')||request.path.includes('\\')||url.hash||url.pathname.includes('{')||url.pathname.startsWith('/__admin'))throw new Error('入口请求路径非法或仍含占位符');
  for(const [key,value] of Object.entries(request.headers)){
    if(!/^[!#$%&'*+.^_`|~\w-]+$/.test(key)||/[\r\n\0]/.test(value))throw new Error('请求 Header 格式非法');
    if(/^(host|connection|content-length|transfer-encoding)$/i.test(key))throw new Error('不能覆盖请求 Header：'+key);
  }
  if(['GET','HEAD'].includes(request.method)&&request.body!==undefined)throw new Error('GET / HEAD 场景不能包含 Body');
}
export function scenarioRules(scenario:FlowScenario,rules:MockRule[],workflow:Workflow){
  const ids=new Set(scenario.mocks.map(m=>m.dependencyId));
  if(ids.size!==scenario.mocks.length||ids.size!==workflow.dependencies.length||workflow.dependencies.some(dep=>!ids.has(dep.id)))throw new Error('每个 Flow 依赖必须选择一条 Mock，不能重复或遗漏');
  return validateRules(scenario.mocks.map(m=>{
    const rule=rules.find(r=>r.id===m.ruleId&&r.dependencyId===m.dependencyId);
    if(!rule)throw new Error('所选 Mock 不存在或不属于此依赖');
    return {...rule,enabled:true};
  }),workflow.dependencies);
}
export function makeScenario(input:unknown,workspace:Workspace,index:Index,contextPath?:string):FlowScenario{
  const data=scenarioInput.parse(input),workflow=workspace.workflows.find(w=>w.id===data.workflowId);
  if(!workflow)throw new Error('Flow 不存在');
  if(workflow.revision!==index.project.revision)throw new Error('Flow 已过期，请核对依赖并确认源码版本');
  assertScenarioRequest(data.request);validateEntryRequest(index,workflow.entry.id,data.request,contextPath);
  if(Object.keys(data.expected.fields).length>100)throw new Error('每个场景最多 100 个响应字段断言');
  for(const pointer of Object.keys(data.expected.fields))pointerParts(pointer);
  const scenario:FlowScenario={...data,id:data.id||randomUUID(),revision:index.project.revision,dependencyFingerprint:scenarioDependencyFingerprint(workflow),mocks:[],updatedAt:new Date().toISOString()};
  scenario.mocks=data.mocks.map(m=>{
    const rule=workspace.rules.find(r=>r.id===m.ruleId&&r.dependencyId===m.dependencyId);
    if(!rule)throw new Error('所选 Mock 不存在或不属于此依赖');
    return {...m,fingerprint:scenarioRuleFingerprint(rule),name:rule.name+' · '+rule.scenario};
  });
  validateResponseContracts(scenarioRules(scenario,workspace.rules,workflow),workflow.dependencies,index);
  return scenario;
}
export function assertRunnableScenario(scenario:FlowScenario,workspace:Workspace,index:Index,contextPath?:string){
  const workflow=workspace.workflows.find(w=>w.id===scenario.workflowId);
  if(!workflow)throw new Error('Flow 不存在');
  const reason=scenarioStaleReason(scenario,workflow,workspace.rules,index.project.revision);if(reason)throw new Error(reason);
  assertScenarioRequest(scenario.request);validateEntryRequest(index,workflow.entry.id,scenario.request,contextPath);
  for(const dep of workflow.dependencies)if(dep.status==='unresolved'||!dep.configKey||!dep.originalBase)throw new Error(dep.name+' 无法接管为 Mock，请先确认 URL 和配置键');
  const rules=scenarioRules(scenario,workspace.rules,workflow);validateResponseContracts(rules,workflow.dependencies,index);
  return rules;
}
export function assertRegressionResponse(scenario:FlowScenario,status:number,body:string,journal:RequestLog[]){
  const errors:string[]=[];
  if(status!==scenario.expected.status)errors.push(`期望 HTTP ${scenario.expected.status}，实际 ${status}`);
  if(Object.keys(scenario.expected.fields).length){
    let parsed:unknown;
    try{parsed=JSON.parse(body);}catch{errors.push('入口响应不是合法 JSON');}
    if(parsed!==undefined)for(const [pointer,expected] of Object.entries(scenario.expected.fields)){
      const actual=getPointer(parsed,pointer);
      if(!isDeepStrictEqual(actual,expected))errors.push(redact(`${pointer||'整个响应'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)??'字段不存在'}`));
    }
  }
  for(const mock of scenario.mocks)if(mock.calls!==undefined){
    const actual=journal.filter(r=>r.matched&&r.ruleId===mock.ruleId).length;
    if(actual!==mock.calls)errors.push(`Mock ${mock.name||mock.ruleId}：期望调用 ${mock.calls} 次，实际 ${actual} 次`);
  }
  const unmatched=journal.filter(r=>!r.matched);
  if(unmatched.length)errors.push('存在未命中的下游请求：'+unmatched.map(r=>r.method+' '+r.url).slice(0,5).join('；'));
  if(journal.length>MAX_REGRESSION_REQUESTS)errors.push('下游请求超过 5000 条，无法完整验证调用次数');
  return errors;
}
async function freePort(){
  const server=net.createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;
}
async function responseText(response:Response){
  const reader=response.body?.getReader();if(!reader)return '';
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024)throw new Error('入口响应超过 1MB');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks).toString('utf8');
}
export function regressionReportPath(root:string,workflowId:string){return path.join(root,'.mockingbird','regression',createHash('sha256').update(workflowId).digest('hex')+'.json');}
export async function readRegressionReport(root:string,workflowId:string):Promise<RegressionRun|undefined>{
  try{return JSON.parse(await fs.readFile(regressionReportPath(root,workflowId),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
}
export class RegressionRunner {
  state?:RegressionRun;private controller?:AbortController;private job?:Promise<void>;
  constructor(private jar:string,private changed:()=>void){}
  get busy(){return !!this.job;}
  cancel(){this.controller?.abort();}
  async close(){this.cancel();await this.job;}
  start(workspace:Workspace,index:Index,workflowId:string,ids:string[],lifetime:AbortSignal,assertFresh:()=>void){
    if(this.busy)throw new Error('已有回归正在执行');
    const workflow=workspace.workflows.find(w=>w.id===workflowId);if(!workflow)throw new Error('Flow 不存在');
    if(!ids.length||ids.length>100||new Set(ids).size!==ids.length)throw new Error('请选择 1–100 个不同的场景');
    const scenarios=ids.map(id=>{const scenario=workspace.flowScenarios?.find(s=>s.id===id&&s.workflowId===workflowId);if(!scenario)throw new Error('场景不存在或不属于当前 Flow');return structuredClone(scenario);});
    const snapshot=structuredClone(workspace);snapshot.workflows=[structuredClone(workflow)];snapshot.activeWorkflowId=workflowId;
    for(const dep of snapshot.workflows[0].dependencies)dep.route='mock';
    this.controller=new AbortController();const signal=AbortSignal.any([this.controller.signal,lifetime]);signal.throwIfAborted();
    const run:RegressionRun={id:randomUUID(),workflowId,status:'preparing',startedAt:new Date().toISOString(),results:scenarios.map(s=>({scenarioId:s.id,name:s.name,status:'pending',errors:[]})),scenarios,logs:[]};
    this.state=run;
    // Hold busy until cleanup and report persistence finish.
    this.job=this.execute(run,snapshot,index,signal,assertFresh).finally(()=>{this.job=undefined;this.changed();});
    this.changed();return run;
  }
  private async execute(run:RegressionRun,workspace:Workspace,index:Index,signal:AbortSignal,assertFresh:()=>void){
    let directory:string|undefined,runtime:MockRuntime|undefined,launcher:ProjectLauncher|undefined;
    const updated=()=>{run.logs=[...(runtime?.state.logs||[]),...(launcher?.state.logs||[])].slice(-100);this.changed();};
    const fresh=()=>{signal.throwIfAborted();assertFresh();};
    try{
      fresh();
      const contextPath=await resolveEntryContextPath(workspace,workspace.workflows[0].entry,{});fresh();
      const rulesById=new Map<string,MockRule[]>();
      for(const scenario of run.scenarios){
        const result=run.results.find(r=>r.scenarioId===scenario.id)!;
        try{rulesById.set(scenario.id,assertRunnableScenario(scenario,workspace,index,contextPath));}
        catch(e){result.status='blocked';result.errors=[redact((e as Error).message)];}
      }
      if(!rulesById.size){run.status='completed';return;}
      directory=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-regression-'));fresh();
      const mockPort=await freePort();let javaPort=await freePort();while(javaPort===mockPort)javaPort=await freePort();
      const preview=await routePreview(workspace,mockPort,javaPort);
      if(preview.unsupported.length)throw new Error(preview.unsupported.map(d=>d.name+'：'+d.reason).join('；'));
      const shadowed=preview.changes.filter(change=>!change.mockWins);
      if(shadowed.length)throw new Error('回归无法接管下游 Mock：'+shadowed.map(change=>change.key+' 被启动配置覆盖').join('；')+'。请移除冲突的启动参数后重试');
      const config=path.join(directory,'routes.properties');await atomicWrite(config,preview.config);fresh();
      // Preserve one overflow entry so a capped journal can never pass an incomplete assertion.
      runtime=new MockRuntime(this.jar,path.join(directory,'wiremock'),updated,MAX_REGRESSION_REQUESTS+1);
      await runtime.start(mockPort,[...rulesById.values()][0],signal);fresh();
      launcher=new ProjectLauncher(updated);await launcher.start(workspace,javaPort,signal,config);
      const aborted=()=>{if(launcher?.child)terminate(launcher.child);};signal.addEventListener('abort',aborted,{once:true});
      try{
        while(launcher.state.status==='starting'){fresh();await delay(200,undefined,{signal});}
        if(launcher.state.status!=='running')throw new Error(launcher.state.error||'Java 项目启动失败');
        run.status='running';updated();
        for(const scenario of run.scenarios){
          const result=run.results.find(r=>r.scenarioId===scenario.id)!;if(result.status==='blocked')continue;
          fresh();result.status='running';updated();const started=Date.now();
          try{
            await runtime.publish(rulesById.get(scenario.id)!);
            await runtime.admin('scenarios/reset','POST');await runtime.admin('requests','DELETE');fresh();
            const request=scenario.request;
            const response=await fetch(`http://127.0.0.1:${javaPort}${request.path}`,{method:request.method,headers:{'Content-Type':'application/json',...request.headers},body:request.body===undefined?undefined:JSON.stringify(request.body),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(35000)])});
            const raw=await responseText(response);fresh();
            const journal=await runtime.requests(MAX_REGRESSION_REQUESTS+1);
            result.response={status:response.status,body:redact(raw.slice(0,65536)),truncated:raw.length>65536};
            result.requestCount=journal.length;
            result.requests=journal.slice(0,200).map(r=>({...r,body:r.body?.slice(0,4096),response:r.response?.slice(0,4096)}));
            result.errors=assertRegressionResponse(scenario,response.status,raw,journal);
            result.status=result.errors.length?'failed':'passed';
          }catch(e){
            result.status=signal.aborted?'cancelled':'failed';result.errors=[redact((e as Error).message)];
            if(signal.aborted)throw e;
            // A timed out entry may still be invoking downstreams; stop the batch to avoid contaminating the next case.
            throw new Error('请求执行异常，已停止后续场景：'+(e as Error).message);
          }finally{result.duration=Date.now()-started;updated();}
        }
        run.status='completed';
      }finally{signal.removeEventListener('abort',aborted);}
    }catch(e){
      run.status=signal.aborted?'cancelled':'failed';run.error=redact((e as Error).message);
    }finally{
      for(const result of run.results.filter(r=>['pending','running'].includes(r.status))){result.status=signal.aborted?'cancelled':'blocked';result.errors=[run.error||'执行环境未就绪'];}
      // Keep the public run active until both child processes are stopped.
      const finalStatus=run.status;run.status='cleaning';updated();
      try{await launcher?.stop();await runtime?.stop();if(directory)await fs.rm(directory,{recursive:true,force:true});}
      catch(e){run.error=redact('清理回归环境失败：'+(e as Error).message);}
      run.status=run.error&&!signal.aborted?'failed':finalStatus;run.endedAt=new Date().toISOString();updated();
      try{await atomicWrite(regressionReportPath(workspace.project!.path,run.workflowId),run);}catch(e){run.error=redact('保存回归报告失败：'+(e as Error).message);run.status='failed';updated();}
    }
  }
}
