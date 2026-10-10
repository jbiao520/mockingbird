import type { BehaviorCase, BehaviorRequest, MockBehavior, MockRule } from './types';

export const escapePointer=(key:string)=>key.replace(/~/g,'~0').replace(/\//g,'~1');
export function pointerParts(pointer:string){
  if(pointer==='')return[];
  if(!pointer.startsWith('/')||/~(?![01])/.test(pointer))throw new Error('字段路径应为 JSON Pointer，如 /user/id');
  const parts=pointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'));
  if(parts.some(p=>['__proto__','prototype','constructor'].includes(p)))throw new Error('不支持此字段路径');
  return parts;
}
export function getPointer(value:unknown,pointer:string):unknown{
  return pointerParts(pointer).reduce<unknown>((item,key)=>item!==null&&typeof item==='object'&&Object.hasOwn(item,key)?(item as Record<string,unknown>)[key]:undefined,value);
}
export function setPointer(value:unknown,pointer:string,next:unknown):unknown{
  const parts=pointerParts(pointer);if(!parts.length)return structuredClone(next);
  const result=structuredClone(value);let cursor=result as Record<string,unknown>;
  for(const part of parts.slice(0,-1)){if(!cursor||typeof cursor!=='object'||!Object.hasOwn(cursor,part))throw new Error('响应字段不存在：'+pointer);cursor=cursor[part] as Record<string,unknown>;}
  if(!cursor||typeof cursor!=='object'||!Object.hasOwn(cursor,parts.at(-1)!))throw new Error('响应字段不存在：'+pointer);
  cursor[parts.at(-1)!]=structuredClone(next);return result;
}
export function fields(value:unknown,prefix=''):Array<{path:string;value:unknown}>{
  if(value!==null&&typeof value==='object'&&Object.keys(value).length)return Object.entries(value).flatMap(([key,item])=>fields(item,prefix+'/'+escapePointer(key)));
  return[{path:prefix,value}];
}
export function createBehavior(rule:MockRule):MockBehavior{
  return{schemaVersion:1,sample:{path:rule.path.replace(/\{[^}]+\}/g,'sample')+(Object.keys(rule.query).length?'?'+new URLSearchParams(rule.query):''),headers:{...rule.requestHeaders},...(rule.requestBody===undefined?{}:{body:structuredClone(rule.requestBody)})},cases:[],matchers:[],bindings:[],exceptions:[]};
}
// Samples use a shared base plus only the changed fields; arrays are replaced.
export function mergeSample(base:unknown,patch:unknown):unknown{
  if(!base||!patch||typeof base!=='object'||typeof patch!=='object'||Array.isArray(base)||Array.isArray(patch))return structuredClone(patch);
  const result=structuredClone(base) as Record<string,unknown>;
  for(const[key,value]of Object.entries(patch)){if(['__proto__','constructor','prototype'].includes(key))throw new Error('不支持此样例字段');result[key]=Object.hasOwn(result,key)?mergeSample(result[key],value):structuredClone(value);}
  return result;
}
export function caseRequest(base:BehaviorRequest,test:BehaviorCase):BehaviorRequest{
  return{path:test.patch.path??base.path,headers:{...base.headers,...test.patch.headers},...(base.body===undefined&&test.patch.body===undefined?{}:{body:test.patch.body===undefined?base.body:test.patch.bodyMode==='replace'?structuredClone(test.patch.body):mergeSample(base.body,test.patch.body)})};
}
export function sampleDifference(base:unknown,next:unknown):unknown{
  if(JSON.stringify(base)===JSON.stringify(next))return{};
  if(base&&next&&typeof base==='object'&&typeof next==='object'&&!Array.isArray(base)&&!Array.isArray(next))return Object.fromEntries(Object.entries(next).filter(([key,value])=>JSON.stringify((base as Record<string,unknown>)[key])!==JSON.stringify(value)).map(([key,value])=>[key,sampleDifference((base as Record<string,unknown>)[key],value)]));
  return next;
}
export function sequenceName(rule:MockRule){return 'mockingbird-'+(rule.service?.namespace||'local').replace(/[^\w-]/g,'_')+'-'+rule.id;}
