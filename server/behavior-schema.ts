import { z } from 'zod';
import type { MockRule } from '../shared/types';
import { getPointer, pointerParts } from '../shared/behavior';

export const headerName=/^[\w!#$%&'*+.^`|~-]+$/;
const headers=z.record(z.string().regex(headerName).max(200),z.string().max(10000).refine(v=>!/[\r\n]/.test(v),'Header 不允许换行'));
const pointer=z.string().max(1000).refine(p=>{try{pointerParts(p);return true;}catch{return false;}},'字段路径应为 JSON Pointer，如 /user/id');
export const conditionSchema=z.object({source:z.enum(['body','header','query','path']),field:z.string().max(1000),operator:z.enum(['eq','contains','regex','exists','missing','gt','gte','lt','lte']),value:z.json().optional()}).strict().superRefine((v,ctx)=>{
  const error=(message:string)=>ctx.addIssue({code:'custom',message});
  if(v.source==='body'){try{pointerParts(v.field);}catch(e){error((e as Error).message);}if(v.operator==='missing')error('Body 缺失匹配请使用部分 JSON 或高级规则；当前支持存在匹配');}
  else if(!v.field||!headerName.test(v.field))error('字段名称无效');
  if(v.source==='path'&&v.operator==='missing')error('路径参数始终存在，不能配置不存在匹配');
  if(!['exists','missing'].includes(v.operator)&&v.value===undefined)error('匹配条件缺少值');
  if(['gt','gte','lt','lte'].includes(v.operator)&&(v.source!=='body'||typeof v.value!=='number'))error('大小比较要求 Body 数字字段和数字值');
  if(v.operator==='eq'&&(v.value===null||typeof v.value==='object'))error('条件等于仅支持字符串、数字、布尔值；对象请用部分 JSON 匹配');
  if(['regex','contains'].includes(v.operator)&&typeof v.value!=='string')error('包含或正则要求字符串');
  if(v.operator==='regex'){try{new RegExp(v.value as string);}catch{error('正则表达式非法');}}
});
const fault=z.enum(['EMPTY_RESPONSE','CONNECTION_RESET_BY_PEER','MALFORMED_RESPONSE_CHUNK','RANDOM_DATA_THEN_CLOSE']);
const overrides=z.record(pointer,z.json());
const source=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('request'),source:z.enum(['body','header','query','path']),field:z.string().max(1000),fallback:z.json()}).strict(),
  z.object({kind:z.literal('uuid'),variable:z.string().regex(/^[A-Za-z][\w]{0,50}$/)}).strict(),
  z.object({kind:z.literal('now')}).strict(),
  z.object({kind:z.literal('condition'),condition:conditionSchema,then:z.json(),otherwise:z.json()}).strict()
]);
export const behaviorRequestSchema=z.object({path:z.string().startsWith('/').max(2000).refine(p=>!p.startsWith('//')&&!p.includes('#')&&!p.includes('://')&&!decodeURIComponentSafe(p).startsWith('/__admin'),'样例路径非法'),headers,body:z.json().optional()}).strict();
function decodeURIComponentSafe(p:string){try{return decodeURIComponent(p);}catch{return '/__admin';}}
export const behaviorCaseSchema=z.object({id:z.string().min(1).max(100),name:z.string().min(1).max(100),patch:z.object({path:behaviorRequestSchema.shape.path.optional(),headers:headers.optional(),body:z.json().optional(),bodyMode:z.enum(['merge','replace']).optional()}).strict(),expected:z.object({matched:z.boolean().optional(),status:z.number().int().min(100).max(599).optional(),fields:overrides.optional(),fault:z.boolean().optional()}).strict(),calls:z.number().int().min(1).max(12)}).strict();
export const behaviorSchema=z.object({schemaVersion:z.literal(1),sample:behaviorRequestSchema,cases:z.array(behaviorCaseSchema).max(30),matchers:z.array(conditionSchema).max(20),bindings:z.array(z.object({target:pointer,value:source}).strict()).max(100),exceptions:z.array(z.object({id:z.string().min(1).max(100),name:z.string().min(1).max(100),conditions:z.array(conditionSchema).min(1).max(20),overrides,status:z.number().int().min(100).max(599).optional(),fault:fault.optional()}).strict()).max(12),sequence:z.object({steps:z.array(z.object({name:z.string().min(1).max(100),status:z.number().int().min(100).max(599),overrides,fault:fault.optional(),delay:z.number().int().min(0).max(30000).optional()}).strict()).min(1).max(10),end:z.enum(['hold','loop','stop'])}).strict().optional(),fault:fault.optional()}).strict();

export function validateBehavior(rule:MockRule){
  const b=rule.behavior;if(!b)return;
  if(JSON.stringify(b).length>1024*1024)throw new Error('行为配置超过 1MB');
  const checkTargets=(paths:string[])=>{for(const p of paths)if(getPointer(rule.body,p)===undefined)throw new Error('响应字段不存在：'+p);for(let i=0;i<paths.length;i++)for(let j=i+1;j<paths.length;j++)if(paths[i]===paths[j]||paths[i].startsWith(paths[j]+'/')||paths[j].startsWith(paths[i]+'/'))throw new Error('响应字段配置重复或包含父子路径');};
  checkTargets(b.bindings.map(v=>v.target));
  for(const item of [...b.exceptions,...(b.sequence?.steps||[])])checkTargets(Object.keys(item.overrides));
  for(const collection of [b.cases,b.exceptions])if(new Set(collection.map(i=>i.id)).size!==collection.length)throw new Error('样例或例外 ID 重复');
  const pathNames=[...rule.path.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]);
  const references:Array<{source:'body'|'header'|'query'|'path';field:string}>=[...b.matchers,...b.exceptions.flatMap(e=>e.conditions)];
  for(const binding of b.bindings){if(binding.value.kind==='condition')references.push(binding.value.condition);if(binding.value.kind==='request')references.push(binding.value);}
  for(const ref of references){if(ref.source==='body')pointerParts(ref.field);else if(!ref.field||!headerName.test(ref.field))throw new Error('字段名称无效');if(ref.source==='path'&&!pathNames.includes(ref.field))throw new Error('路径参数不存在：'+ref.field);}
  // Legacy matchers and new matchers are ANDed, never silently overwritten.
  for(const c of b.matchers)if(c.source==='header'&&Object.keys(rule.requestHeaders).some(k=>k.toLowerCase()===c.field.toLowerCase())||c.source==='query'&&c.field in rule.query)throw new Error('重复的 Query / Header 条件，请在高级配置中移除旧的精确匹配');
}
