import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type { BehaviorCase, BehaviorPreview, Dependency, MockRule } from '../shared/types';
import { caseRequest, createBehavior, getPointer } from '../shared/behavior';
import { mockBasePath } from '../shared/mock-routing';
import { MockRuntime, redact } from './runtime';
import { validateRules } from './rules';
import { validateResponseShape } from './response-shape';
import type { Index } from './analyzer';

async function freePort(){const server=net.createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
export class BehaviorPreviewer {
  private active?:MockRuntime;
  private busy=false;
  constructor(private jar:string){}
  async close(){await this.active?.stop();}
  async run(input:MockRule[],ruleId:string,cases?:BehaviorCase[],index?:Index,dependencies?:Dependency[]):Promise<BehaviorPreview[]>{
    if(this.busy)throw new Error('已有行为预览正在运行，请等待完成');
    const rules=validateRules(input,dependencies),rule=rules.find(r=>r.id===ruleId);if(!rule)throw new Error('预览行为不存在');
    const behavior=rule.behavior||createBehavior(rule);
    const tests=cases??(behavior.cases.length?behavior.cases:[{id:'base',name:'基础请求',patch:{},expected:{matched:true},calls:behavior.sequence?.steps.length||1}]);
    if(!tests.length||tests.length>30)throw new Error('请选择 1–30 个请求样例');
    this.busy=true;let directory:string|undefined;
    try{
      directory=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-preview-'));const port=await freePort();
      const runtime=new MockRuntime(this.jar,directory,()=>{});this.active=runtime;
      // Preview the selected API independently, including an unpublished disabled scenario.
      await runtime.start(port,[{...rule,enabled:true}]);
      const reports:BehaviorPreview[]=[];
      for(const test of tests){
        await runtime.admin('scenarios/reset','POST');await runtime.admin('requests','DELETE');
        const sample=caseRequest(behavior.sample,test),url=new URL(mockBasePath(rule.service)+sample.path,`http://127.0.0.1:${port}`);
        if(url.origin!==`http://127.0.0.1:${port}`||url.pathname.startsWith('/__admin'))throw new Error('样例路径非法');
        const calls:BehaviorPreview['calls']=[];
        for(let n=0;n<test.calls;n++){
          const started=Date.now();let status=0,text='',body:unknown,fault:string|undefined;const errors:string[]=[];
          try{
            const response=await fetch(url,{method:rule.method,headers:{'Content-Type':'application/json',...sample.headers},body:['GET','HEAD'].includes(rule.method)||sample.body===undefined?undefined:JSON.stringify(sample.body),redirect:'error',signal:AbortSignal.timeout(35000)});
            status=response.status;text=await response.text();
            if(text.length>1024*1024)throw new Error('响应超过 1MB');
            try{body=JSON.parse(text);}catch{if(rule.method!=='HEAD'&&![204,304].includes(status)&&response.headers.get('content-type')?.includes('json'))errors.push('渲染结果不是合法 JSON');}
            if(status===500&&/HandlebarsException|UncheckedExecutionException|JsonException/.test(text))errors.push('动态响应渲染失败，请检查字段来源和条件');
          }catch(e){fault=(e as Error).message;}
          const journal=await runtime.requests(),latest=journal[0];const matched=Boolean(latest?.matched&&latest.ruleId===rule.id);
          if(test.expected.matched!==undefined&&matched!==test.expected.matched)errors.push(test.expected.matched?'未命中当前行为':'意外命中当前行为');
          // Expectations apply to the last call, so retry cases assert the eventual result.
          if(n===test.calls-1){
            if(test.expected.status!==undefined&&status!==test.expected.status)errors.push(`期望 HTTP ${test.expected.status}，实际 ${status||'传输失败'}`);
            if(test.expected.fault!==undefined&&Boolean(fault)!==test.expected.fault)errors.push('传输故障与期望不一致');
            for(const[p,value]of Object.entries(test.expected.fields||{}))if(JSON.stringify(getPointer(body,p))!==JSON.stringify(value))errors.push('响应字段与期望不同：'+p);
          }
          if(fault&&!latest?.fault&&test.expected.fault!==true)errors.push('请求失败：'+fault);
          const dep=dependencies?.find(d=>d.id===rule.dependencyId);
          if(index&&matched&&status>=200&&status<400&&!fault&&rule.method!=='HEAD'&&![204,304].includes(status)&&dep?.responseType){try{validateResponseShape(body,dep.responseType,index);}catch(e){errors.push('响应契约：'+(e as Error).message);}}
          calls.push({status,body:body===undefined?undefined:JSON.parse(redact(JSON.stringify(body))),text:redact(text),matched,rule:latest?.rule,fault:fault?redact(latest?.fault||fault):undefined,duration:Date.now()-started,errors});
        }
        reports.push({caseId:test.id,name:test.name,calls,passed:calls.every(c=>!c.errors.length)});
      }
      return reports;
    }finally{await this.active?.stop();this.active=undefined;this.busy=false;if(directory)await fs.rm(directory,{recursive:true,force:true});}
  }
}
