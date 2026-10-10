import { createHash } from 'node:crypto';
import type { BehaviorException, BehaviorStep, FieldBinding, MockRule, RequestCondition } from '../shared/types';
import { pointerParts, sequenceName, setPointer } from '../shared/behavior';
import { mockRequestPath } from '../shared/mock-routing';

const literal=(value:unknown)=>JSON.stringify(value);
const jsonPath=(pointer:string)=>'$'+pointerParts(pointer).map(p=>/^\d+$/.test(p)?`[${p}]`:`[${literal(p)}]`).join('');
interface TemplateConstants { (value:unknown):string;bodyRef:(pointer:string)=>string }
const outputJson=(ref:string)=>`{{#eq ${ref} null}}null{{else}}{{{toJson ${ref}}}}{{/eq}}`;
function reference(rule:MockRule,source:RequestCondition['source'],field:string,constant:TemplateConstants){
  if(source==='body')return constant.bodyRef(field);
  if(source==='path'){const segments=mockRequestPath(rule).slice(1).split('/');const i=segments.indexOf('{'+field+'}');return `request.pathSegments.[${i}]`;}
  // Bracket access preserves field names containing hyphens or dots.
  return `request.${source==='header'?'headers':'query'}.[${field}].[0]`;
}
function conditionTemplate(rule:MockRule,c:RequestCondition,yes:string,no:string,constant:TemplateConstants){
  const ref=reference(rule,c.source,c.field,constant);
  if(c.operator==='exists'||c.operator==='missing'){const op=c.operator==='exists'?'neq':'eq';return `{{#${op} ${ref} null}}${yes}{{else}}${no}{{/${op}}}`;}
  const op={eq:'eq',contains:'contains',regex:'matches',gt:'gt',gte:'gte',lt:'lt',lte:'lte'}[c.operator];
  return `{{#${op} ${ref} ${constant(c.value)}}}${yes}{{else}}${no}{{/${op}}}`;
}
function bindingTemplate(rule:MockRule,binding:FieldBinding,constant:TemplateConstants){
  const v=binding.value;
  if(v.kind==='uuid')return `{{{toJson mb_${v.variable}}}}`;
  if(v.kind==='now')return `{{{toJson (now format="yyyy-MM-dd'T'HH:mm:ss.SSSXXX")}}}`;
  if(v.kind==='condition')return conditionTemplate(rule,v.condition,v.then===null?'null':`{{{toJson ${constant(v.then)}}}}`,v.otherwise===null?'null':`{{{toJson ${constant(v.otherwise)}}}}`,constant);
  return outputJson(`(val ${reference(rule,v.source,v.field,constant)} default=${constant(v.fallback)})`);
}
function templateBody(rule:MockRule,body:unknown,bindings:FieldBinding[]){
  const variables=[...new Set(bindings.flatMap(b=>b.value.kind==='uuid'?[b.value.variable]:[]))];
  const at=new Map(bindings.map(b=>[b.target,b]));
  const constants:unknown[]=[];
  const bodyRefs=new Map<string,string>();
  const constant:TemplateConstants=Object.assign((v:unknown)=>{constants.push(v);return `parameters.mbConstants.[${constants.length-1}]`;},{bodyRef:(pointer:string)=>{if(!bodyRefs.has(pointer))bodyRefs.set(pointer,'mbBody'+bodyRefs.size);return bodyRefs.get(pointer)+'.[0]';}});
  const encode=(value:unknown,pointer:string):string=>{
    const bound=at.get(pointer);if(bound)return bindingTemplate(rule,bound,constant);
    if(Array.isArray(value))return '['+value.map((v,i)=>encode(v,pointer+'/'+i)).join(',')+']';
    if(value!==null&&typeof value==='object')return '{\n'+Object.entries(value).map(([key,v])=>`{{{toJson ${constant(key)}}}}`+':'+encode(v,pointer+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1'))).join(',\n')+'\n}';
    // Constants can contain template delimiters without executing as helpers.
    return typeof value==='string'?`{{{toJson ${constant(value)}}}}`:JSON.stringify(value);
  };
  const encoded=encode(body,'');
  // An indeterminate JSONPath returns a list, preserving null, false and zero.
  // Direct .[0] access avoids WireMock lookup's fallback to its input object.
  const prelude=bodyRefs.size?`{{#if request.body}}{{parseJson request.body "mbInput"}}{{else}}{{val ${constant({})} assign="mbInput"}}{{/if}}`+[...bodyRefs].map(([pointer,name])=>`{{val (jsonPath (array mbInput) ${constant('$[*]'+jsonPath(pointer).slice(1))}) assign="${name}"}}`).join(''):'';
  const headers=Object.fromEntries(Object.entries(rule.headers).map(([key,value])=>[key,`{{{${constant(value)}}}}`]));
  const template=prelude+variables.map(name=>`{{val (randomValue type="UUID") assign="mb_${name}"}}`).join('')+encoded;
  return{body:template,headers,transformers:['response-template'],transformerParameters:{mbConstants:constants}};
}
function pattern(c:RequestCondition){
  if(c.operator==='exists')return{absent:false};if(c.operator==='missing')return{absent:true};
  return{[{eq:'equalTo',contains:'contains',regex:'matches'}[c.operator as 'eq'|'contains'|'regex']||'equalTo']:String(c.value)};
}
function bodyPattern(c:RequestCondition){
  const expression=jsonPath(c.field);
  if(c.operator==='exists')return{matchesJsonPath:expression};
  if(['gt','gte','lt','lte'].includes(c.operator)){
    const nested=expression.slice(1),op={gt:'>',gte:'>=',lt:'<',lte:'<='}[c.operator as 'gt'];
    return{matchesJsonPath:`$[?(@${nested} ${op} ${c.value})]`};
  }
  return{matchesJsonPath:{expression,...pattern(c)}};
}
export function requestMapping(rule:MockRule,conditions:RequestCondition[]=[]){
  const actualPath=mockRequestPath(rule),escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pathPattern=actualPath.split(/(\{[^}]+\})/g).map(p=>p.startsWith('{')?'[^/]+':escape(p)).join('');
  const query:Record<string,unknown>=Object.fromEntries(Object.entries(rule.query).map(([k,v])=>[k,{equalTo:v}]));
  const headers:Record<string,unknown>=Object.fromEntries(Object.entries(rule.requestHeaders).map(([k,v])=>[k.toLowerCase(),{equalTo:v}]));
  const bodyPatterns:unknown[]=rule.requestBody===undefined?[]:[{equalToJson:JSON.stringify(rule.requestBody),...(rule.bodyMatchMode==='partial'?{ignoreExtraElements:true}:{})}];
  const pathConstraints:string[]=[];
  const add=(map:Record<string,unknown>,key:string,p:unknown)=>{map[key]=map[key]?{and:[map[key],p]}:p;};
  for(const c of conditions){if(c.source==='body')bodyPatterns.push(bodyPattern(c));else if(c.source==='header')add(headers,c.field.toLowerCase(),pattern(c));else if(c.source==='query')add(query,c.field,pattern(c));else{
    // A path condition applies to the captured segment without exposing the service prefix.
    const index=actualPath.slice(1).split('/').indexOf('{'+c.field+'}');
    const selected=actualPath.slice(1).split('/').map((s,i)=>i===index?(c.operator==='eq'?escape(String(c.value)):c.operator==='regex'?String(c.value):c.operator==='contains'?`[^/]*${escape(String(c.value))}[^/]*`:'[^/]+'):s.startsWith('{')?'[^/]+':escape(s)).join('/');
    pathConstraints.push('/'+selected);
  }}
  return{method:rule.method,...(actualPath.includes('{')?{urlPathPattern:pathConstraints.map(p=>`(?=${p}$)`).join('')+pathPattern}:{urlPath:actualPath}),queryParameters:query,headers,...(bodyPatterns.length?{bodyPatterns}:{})};
}
function responseMapping(rule:MockRule,step?:BehaviorStep,exception?:BehaviorException){
  const b=rule.behavior;const fault=exception?.fault??step?.fault??b?.fault;
  if(fault)return{fault,fixedDelayMilliseconds:step?.delay??rule.delay};
  let body=structuredClone(rule.body);const changed=[...Object.entries(step?.overrides||{}),...Object.entries(exception?.overrides||{})];
  for(const[p,value]of changed)body=setPointer(body,p,value);
  const bindings=(b?.bindings||[]).filter(binding=>!changed.some(([p])=>binding.target===p||binding.target.startsWith(p+'/')||p.startsWith(binding.target+'/')));
  return{status:exception?.status??step?.status??rule.status,...(bindings.length?templateBody(rule,body,bindings):{jsonBody:body,headers:rule.headers}),fixedDelayMilliseconds:step?.delay??rule.delay};
}
function derivedId(id:string,suffix:string){const hex=createHash('sha256').update(id+':'+suffix).digest('hex').slice(0,32);return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20);}
export function ruleMappings(rule:MockRule){
  const b=rule.behavior,steps=b?.sequence?.steps||[undefined];
  return steps.flatMap((step,i)=>[...(b?.exceptions||[]),undefined].map((exception,j)=>({
    id:step||exception?derivedId(rule.id,`step-${i}-exception-${exception?.id||'default'}`):rule.id,
    name:rule.name+' · '+rule.scenario+(exception?' · '+exception.name:'')+(step?' · '+step.name:''),metadata:{mockingbirdRuleId:rule.id},
    priority:(rule.priority??5)*100+(exception?j:99),
    ...(step?{scenarioName:sequenceName(rule),requiredScenarioState:i===0?'Started':'step-'+i,newScenarioState:i<steps.length-1?'step-'+(i+1):b!.sequence!.end==='loop'?'Started':b!.sequence!.end==='stop'?'Finished':i===0?'Started':'step-'+i}:{}),
    request:requestMapping(rule,[...(b?.matchers||[]),...(exception?.conditions||[])]),response:responseMapping(rule,step,exception)
  })));
}
export function contractBodies(rule:MockRule){
  return(rule.behavior?.sequence?.steps||[undefined]).flatMap(step=>[...(rule.behavior?.exceptions||[]),undefined].map(exception=>{
    let body=structuredClone(rule.body);for(const[p,v]of [...Object.entries(step?.overrides||{}),...Object.entries(exception?.overrides||{})])body=setPointer(body,p,v);
    return{body,status:exception?.status??step?.status??rule.status,fault:exception?.fault??step?.fault??rule.behavior?.fault};
  }));
}
