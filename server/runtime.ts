import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import type { MockRule,RequestLog,RuntimeStatus } from '../shared/types';
import { ruleMappings,validateRules } from './rules';
import { sequenceName } from '../shared/behavior';
import { exists } from './analyzer';
export const DEFAULT_REQUEST_JOURNAL_ENTRIES=1000;
class AdminError extends Error {constructor(endpoint:string,readonly status:number){super(`WireMock ${endpoint}: HTTP ${status}`);}}
export function redact(s:string){return s.replace(/Bearer\s+[\w.\-]+/gi,'Bearer [REDACTED]').replace(/((?:password|secret|token|api[_-]?key|authorization)\s*["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,'$1[REDACTED]');}
export async function assertPort(port:number){if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口必须为 1024–65535');const s=net.createServer();await new Promise<void>((resolve,reject)=>{s.once('error',()=>reject(new Error(`端口 ${port} 已被占用`)));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve()));});}
export function terminate(c:ChildProcess){if(!c.pid)return;try{if(process.platform==='win32')c.kill();else process.kill(-c.pid,'SIGTERM');}catch{c.kill();}const timer=setTimeout(()=>{try{if(process.platform!=='win32')process.kill(-c.pid!,'SIGKILL');else c.kill('SIGKILL');}catch{}},2500);timer.unref();c.once('close',()=>clearTimeout(timer));}
export class MockRuntime{
  state:RuntimeStatus={status:'stopped',port:9090,ready:false,logs:[]};child?:ChildProcess;private auth='';
  constructor(public jar:string,private cwd:string,private changed:()=>void,private journalLimit=DEFAULT_REQUEST_JOURNAL_ENTRIES){
    if(!Number.isInteger(journalLimit)||journalLimit<1)throw new Error('请求日志上限必须为正整数');
  }
  async init(){this.state.ready=await exists(this.jar)&&(await fs.stat(this.jar)).size>1000000;}
  private log(s:string){this.state.logs.push(redact(s));this.state.logs=this.state.logs.slice(-300);this.changed();}
  async admin(endpoint:string,method='GET',data?:unknown){const res=await fetch(`http://127.0.0.1:${this.state.port}/__admin/${endpoint}`,{method,headers:{'Content-Type':'application/json',Authorization:'Basic '+this.auth},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(5000)});if(!res.ok)throw new AdminError(endpoint,res.status);const content=await res.text();return content?JSON.parse(content):{};}
  async start(port:number,rules:MockRule[],signal?:AbortSignal){
    signal?.throwIfAborted();
    if(this.child)throw new Error('Mock Server 已启动或正在启动');validateRules(rules);await assertPort(port);await this.init();if(!this.state.ready)throw new Error('WireMock 未安装，请运行 npm run setup:runtime');await fs.mkdir(this.cwd,{recursive:true});
    signal?.throwIfAborted();
    const password=randomBytes(24).toString('hex');this.auth=Buffer.from('mockingbird:'+password).toString('base64');this.state={...this.state,status:'starting',port,error:undefined,logs:[]};this.changed();
    // WireMock 3.13.2 can cancel chunked POST streams during h2c upgrade.
    // Let Java clients fall back to HTTP/1.1 for the local plaintext listener.
    const child=spawn(process.env.JAVA_PATH||'java',['-jar',this.jar,'--port',String(port),'--bind-address','127.0.0.1','--root-dir',this.cwd,'--admin-api-basic-auth','mockingbird:'+password,'--disable-banner','--disable-http2-plain','--max-request-journal-entries',String(this.journalLimit)],{detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});this.child=child;let spawnError:Error|undefined;
    const abort=()=>terminate(child);signal?.addEventListener('abort',abort,{once:true});child.once('close',()=>signal?.removeEventListener('abort',abort));
    child.stdout?.on('data',b=>this.log(b.toString().replaceAll(password,'[REDACTED]')));child.stderr?.on('data',b=>this.log(b.toString().replaceAll(password,'[REDACTED]')));
    child.on('error',e=>{spawnError=e;this.state.status='failed';this.state.error=e.message;this.child=undefined;this.changed();});child.on('close',code=>{if(this.child===child){this.child=undefined;if(this.state.status!=='stopped'){this.state.status='failed';this.state.error=`WireMock 意外退出（${code}）`;this.changed();}}});
    try{for(let i=0;i<120;i++){signal?.throwIfAborted();if(spawnError)throw spawnError;if(child.exitCode!==null)throw new Error('WireMock 启动失败：'+this.state.logs.slice(-3).join(''));try{await this.admin('mappings');}catch(e){if(i===119)throw e;await new Promise(r=>setTimeout(r,250));continue;}await this.publish(rules);this.state.status='running';this.changed();return;}}catch(e){await this.stop();this.state.status='failed';this.state.error=(e as Error).message;this.changed();throw e;}
  }
  private published:MockRule[]=[];
  async publish(rules:MockRule[]){
    const valid=validateRules(rules);if(!this.child)return;
    await this.admin('mappings/import','POST',{mappings:valid.filter(r=>r.enabled).flatMap(ruleMappings),importOptions:{duplicatePolicy:'OVERWRITE',deleteAllNotInImport:true}});
    for(const r of valid.filter(r=>r.enabled&&r.behavior?.sequence)){
      const before=this.published.find(p=>p.id===r.id);
      if(!before?.enabled||JSON.stringify(before.behavior?.sequence)!==JSON.stringify(r.behavior?.sequence))await this.admin('scenarios/'+encodeURIComponent(sequenceName(r))+'/state','PUT',{state:'Started'});
    }
    this.published=structuredClone(valid);
  }
  async resetSequence(rule:MockRule){if(this.state.status!=='running')throw new Error('Mock Server 尚未运行');if(!rule.behavior?.sequence)throw new Error('此行为没有调用步骤');await this.admin('scenarios/'+encodeURIComponent(sequenceName(rule))+'/state','PUT',{state:'Started'});}
  async requests(limit=200):Promise<RequestLog[]>{if(this.state.status!=='running')return[];if(!Number.isInteger(limit)||limit<1)throw new Error('请求日志查询数量必须为正整数');const count=Math.min(limit,this.journalLimit),data=await this.admin('requests?limit='+count);return(data.requests||[]).slice(0,count).map((r:any)=>({id:r.id,method:r.request.method,url:r.request.url,status:r.responseDefinition?.fault?0:r.response?.status||r.responseDefinition?.status||404,fault:r.responseDefinition?.fault,matched:Boolean(r.wasMatched),rule:r.stubMapping?.name,ruleId:r.stubMapping?.metadata?.mockingbirdRuleId||r.stubMapping?.id,headers:Object.fromEntries(Object.entries(r.request.headers||{}).map(([k,v]:[string,any])=>[k,redact(String(Array.isArray(v)?v[0]:v))]).filter(([k])=>!/authorization|cookie|token|secret|api[-_]?key|^host$|^connection$|^content-length$|^accept-encoding$/i.test(k))),at:r.request.loggedDateString||new Date(r.request.loggedDate).toISOString(),body:redact(r.request.body||''),response:redact(r.response?.body||''),duration:r.timing?.totalTime}));}
  async journalEntry(id:string){
    if(this.state.status!=='running')throw new Error('Mock Server 尚未运行');
    if(!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id))throw new Error('请求记录 ID 非法');
    try{return await this.admin('requests/'+id);}catch(e){if(e instanceof AdminError&&e.status===404)throw new Error('请求记录已不在 Mock Server 日志中，请重新发送');throw e;}
  }
  async scenarioStates(){if(this.state.status!=='running')return {} as Record<string,string>;const data=await this.admin('scenarios');return Object.fromEntries((data.scenarios||[]).map((item:{name:string;state:string})=>[item.name,item.state])) as Record<string,string>;}
  async stop(){const child=this.child;this.child=undefined;this.published=[];this.state.status='stopped';this.state.error=undefined;this.changed();if(child){const done=once(child,'close').catch(()=>{});terminate(child);await Promise.race([done,new Promise(r=>setTimeout(r,3500))]);}}
}
