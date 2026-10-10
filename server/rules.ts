import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Dependency, MockRule, RuleEvidence } from '../shared/types';
import { overlaps } from '../shared/rule-groups';
import { dependencyService, mockRequestPath } from '../shared/mock-routing';
import type { Index } from './analyzer';
import { validateResponseShape } from './response-shape';
const stringMap=z.record(z.string().min(1).max(200),z.string().max(10000));
const evidenceSchema=z.object({file:z.string().min(1).max(500),line:z.number().int().positive(),reason:z.string().min(1).max(2000)});
const noteList=z.array(z.string().min(1).max(2000)).max(20);
const serviceSchema=z.object({namespace:z.string().min(1).max(2000).regex(/^[\w.%~!-]+$/).refine(s=>s!=='.'&&s!=='..'),basePath:z.string().max(2000).refine(p=>p===''||p.startsWith('/')&&!/[?#{}\s]/.test(p),'基础路径非法')});
export const ruleSchema=z.object({id:z.uuid(),dependencyId:z.string().min(1),name:z.string().min(1).max(200),scenario:z.string().min(1).max(100),method:z.enum(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']),path:z.string().startsWith('/').max(2000).refine(p=>!p.startsWith('/__admin')&&!p.includes('?')&&!p.includes('#'),'Path 不允许 __admin、查询串或 fragment'),service:serviceSchema.optional(),status:z.number().int().min(100).max(599),headers:stringMap,body:z.json(),delay:z.number().int().min(0).max(30000),enabled:z.boolean(),query:stringMap,requestHeaders:stringMap,requestBody:z.json().optional(),basis:z.string(),version:z.number().int().min(1),evidence:z.array(evidenceSchema).max(20).optional(),assumptions:noteList.optional(),unresolved:noteList.optional()});
export function validateRules(input:unknown,dependencies?:Dependency[]):MockRule[]{
  const byId=new Map(dependencies?.map(dep=>[dep.id,dep]));
  const rules=z.array(ruleSchema).max(1000).parse(input).map(rule=>{const dep=byId.get(rule.dependencyId);return dep?{...rule,service:dependencyService(dep)}:rule;});const ids=new Set<string>(),enabled:MockRule[]=[];
  for(const r of rules){
    if(ids.has(r.id))throw new Error('规则 ID 重复：'+r.name);ids.add(r.id);
    for(const[k,v]of Object.entries({...r.headers,...r.requestHeaders}))if(!/^[\w!#$%&'*+.^`|~-]+$/.test(k)||/[\r\n]/.test(v))throw new Error(r.name+' HTTP Header 非法');
    if(JSON.stringify(r.body).length>1024*1024)throw new Error(r.name+' 响应超过 1MB');
    if(r.enabled){if(enabled.some(previous=>overlaps(previous,r)))throw new Error(`${r.method} ${r.path} 存在冲突的启用场景，请关闭其中一个场景或添加互斥匹配条件`);enabled.push(r);}
  }return rules;
}
// Known records, classes, lists, enums and Jackson aliases are checked.
// Map, JsonNode and unrecognized types are reported as unverified rather than rejected or invented.
export function responseUnresolved(body:unknown,type:string|undefined,index:Index,status:number){
  if(status<200||status>=400)return[`HTTP ${status} 未按成功响应的 DTO 结构校验`];
  if(!type?.trim())return['响应类型未知，未校验 JSON 结构'];
  return validateResponseShape(body,type.trim(),index).unresolved;
}
export function validateResponseContracts(rules:MockRule[],deps:Dependency[],index:Index){
  for(const rule of rules){
    if(rule.status>=400||rule.status<200)continue;
    const type=deps.find(d=>d.id===rule.dependencyId)?.responseType?.trim();
    if(!type)continue;
    try{validateResponseShape(rule.body,type,index);}catch(e){throw new Error(`${rule.name} 响应不符合 ${type}：${(e as Error).message}`);}
  }
}
export function assertSourceEvidence(evidence:RuleEvidence[]|undefined,index:Index){
  if(!evidence?.length)throw new Error('每条规则至少需要一条当前索引中的源码证据');
  for(const item of evidence){
    const source=index.sources.get(item.file);
    if(!source)throw new Error(`证据文件不在当前源码索引中：${item.file}`);
    const lines=source.split('\n');
    if(!Number.isInteger(item.line)||item.line<1||item.line>lines.length||!lines[item.line-1]?.trim())throw new Error(`证据行号无效：${item.file}:${item.line}`);
  }
}
function dtoSample(type:string,index:Index):unknown{
  const primitive=(t:string)=>/boolean|Boolean/.test(t)?true:/int|long|double|float|Integer|Long|BigDecimal/.test(t)?1:/List|Set|\[\]/.test(t)?[]:t==='String'?'sample':null;
  const direct=primitive(type);if(direct!==null)return direct;
  for(const source of index.sources.values()){
    const name=type.replace(/[^\w]/g,''),record=new RegExp('record\\s+'+name+'\\s*\\(([^)]*)\\)').exec(source);
    if(record){const result:Record<string,unknown>={};for(const f of record[1].split(',')){const p=/([\w<>.]+)\s+(\w+)\s*$/.exec(f.trim());if(p)result[p[2]]=primitive(p[1])??{};}return result;}
    if(new RegExp('class\\s+'+name+'\\b').test(source)){const result:Record<string,unknown>={};for(const f of source.matchAll(/private\s+(?!static)([\w<>.]+)\s+(\w+)\s*;/g))result[f[2]]=primitive(f[1])??{};if(Object.keys(result).length)return result;}
  }return{success:true};
}
export function generateRules(deps:Dependency[],index:Index,scenario='Success'):MockRule[]{return deps.filter(d=>d.status!=='unresolved').map(d=>{
  const contract=index.contracts[`${d.method} ${d.path}`];return{id:randomUUID(),dependencyId:d.id,name:d.name,scenario,method:d.method,path:d.path,service:dependencyService(d),status:scenario==='Error'?503:200,headers:{'Content-Type':'application/json'},body:scenario==='Error'?{error:'DOWNSTREAM_UNAVAILABLE',message:'模拟下游服务异常'}:contract??dtoSample(d.responseType||'',index),delay:0,enabled:true,query:{},requestHeaders:{},basis:contract?'项目提供的响应样本：src/main/resources/mockingbird-contracts.json':'根据 DTO / 通用模板生成，业务字段与契约未验证，请审核',version:1};});}
export function mapping(rule:MockRule){const actualPath=mockRequestPath(rule);const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const pattern=actualPath.split(/(\{[^}]+\})/g).map(p=>p.startsWith('{')?'[^/]+':escape(p)).join('');return{id:rule.id,name:rule.name+' · '+rule.scenario,request:{method:rule.method,...(actualPath.includes('{')?{urlPathPattern:pattern}:{urlPath:actualPath}),queryParameters:Object.fromEntries(Object.entries(rule.query).map(([k,v])=>[k,{equalTo:v}])),headers:Object.fromEntries(Object.entries(rule.requestHeaders).map(([k,v])=>[k,{equalTo:v}])),...(rule.requestBody===undefined?{}:{bodyPatterns:[{equalToJson:JSON.stringify(rule.requestBody)}]})},response:{status:rule.status,headers:rule.headers,jsonBody:rule.body,fixedDelayMilliseconds:rule.delay}};}
