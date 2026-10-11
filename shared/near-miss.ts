import type { DiagnosisAdoption, DiagnosisCandidate, DiagnosisClause, DiagnosisStatus, HttpMethod, MockRule, RequestCondition, UnmatchedDiagnosis } from './types';
import { getPointer, pointerParts, sequenceName } from './behavior';
import { mockBasePath, mockRequestPath } from './mock-routing';
import { overlaps } from './rule-groups';
import { ruleFingerprint } from './rule-edit';

// Compares a logged request with the same conditions requestMapping publishes to WireMock.
// Ranking is deterministic: path shape, then method, then fewer failed clauses, then more matched clauses.
const METHODS: HttpMethod[] = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
const HOP = /^(host|connection|content-length|accept-encoding|transfer-encoding|keep-alive|content-encoding|te|trailer|upgrade|proxy-connection)$/i;
const SECRET = /password|secret|token|authorization|cookie|api[-_]?key/i;
const HEADER = /^[\w!#$%&'*+.^`|~-]+$/;
const DIMENSIONS = ['method','path','header','query','body'] as const;

export interface ActualRequest { method:string;pathname:string;query:Record<string,string[]>;headers:Record<string,string[]>;bodyText?:string;json:boolean;jsonBody?:unknown }

interface Edit {
  id:string;
  kind:'set-header'|'set-query'|'set-matcher'|'set-exception'|'project-body'|'partial-body'|'add-header'|'add-query'|'add-body'|'enable';
  name?:string;value?:unknown;index?:number;exceptionId?:string;pointer?:string;remove?:boolean;operator?:'eq';
}
interface Built { clauses:DiagnosisClause[];edits:Edit[];requestFailed:number;requestMatched:number;shape:boolean;methodOk:boolean;distance:number }

const escapeRegex = (value:string) => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const sensitive = (name:string) => SECRET.test(name);
const shown = (field:string,value:unknown) => {
  if(sensitive(field))return '[已隐藏]';
  const text = typeof value==='string'?value:JSON.stringify(value)??'';
  const clean = text.replace(/Bearer\s+\S+/gi,'Bearer [已隐藏]');
  return clean.length>80?clean.slice(0,80)+'…':clean;
};
const valuesOf = (value:unknown):string[] => {
  if(typeof value==='string')return [value];
  if(Array.isArray(value))return value.flatMap(valuesOf);
  if(value&&typeof value==='object'&&Array.isArray((value as {values?:unknown}).values))return valuesOf((value as {values:unknown[]}).values);
  return [];
};
const decodePart = (value:string) => {try{return decodeURIComponent(value.replace(/\+/g,' '));}catch{return value;}};

export function actualRequest(raw:{method?:string;url?:string;headers?:Record<string,unknown>;queryParams?:Record<string,unknown>;body?:unknown}):ActualRequest {
  const url = String(raw.url||'/');
  const hash = url.split('#')[0];
  const mark = hash.indexOf('?');
  const pathname = mark===-1?hash:hash.slice(0,mark);
  const query:Record<string,string[]> = {};
  if(raw.queryParams&&typeof raw.queryParams==='object'){
    for(const [key,value] of Object.entries(raw.queryParams)){
      const parsed = valuesOf(value);
      if(parsed.length)query[key]=parsed;
    }
  }else if(mark!==-1){
    for(const pair of hash.slice(mark+1).split('&')){
      if(!pair)continue;
      const [key,value=''] = pair.split('=');
      const name = decodePart(key);
      (query[name]||=[]).push(decodePart(value));
    }
  }
  const headers:Record<string,string[]> = {};
  for(const [key,value] of Object.entries(raw.headers||{})){
    const parsed = valuesOf(value);
    if(parsed.length)headers[key.toLowerCase()]=parsed;
  }
  const bodyText = typeof raw.body==='string'&&raw.body!==''?raw.body:undefined;
  if(bodyText===undefined)return {method:String(raw.method||'GET').toUpperCase(),pathname:pathname||'/',query,headers,json:false};
  try{return {method:String(raw.method||'GET').toUpperCase(),pathname:pathname||'/',query,headers,bodyText,json:true,jsonBody:JSON.parse(bodyText)};}
  catch{return {method:String(raw.method||'GET').toUpperCase(),pathname:pathname||'/',query,headers,bodyText,json:false};}
}

const segments = (path:string) => path.split('/').filter((part,index)=>!(index===0&&part===''));
const pathPattern = (fullPath:string) => fullPath.split(/(\{[^}]+\})/g).map(part=>part.startsWith('{')?'[^/]+':escapeRegex(part)).join('');
const shapeMatches = (fullPath:string,pathname:string) => fullPath.includes('{')?new RegExp('^'+pathPattern(fullPath)+'$').test(pathname):pathname===fullPath;
const segmentEqual = (expected:string,actual:string) => expected===actual||/^\{[^}]+\}$/.test(expected);
function segmentDistance(expected:string[],actual:string[]){
  const dp = Array.from({length:expected.length+1},()=>new Array<number>(actual.length+1).fill(0));
  for(let i=0;i<=expected.length;i++)dp[i][0]=i;
  for(let j=0;j<=actual.length;j++)dp[0][j]=j;
  for(let i=1;i<=expected.length;i++)for(let j=1;j<=actual.length;j++){
    const cost = segmentEqual(expected[i-1],actual[j-1])?0:1;
    dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+cost);
  }
  return dp[expected.length][actual.length];
}
function explainPath(expectedPath:string,actualPath:string){
  const expected = segments(expectedPath),actual = segments(actualPath);
  if(expected.length===actual.length&&expected.every((part,index)=>segmentEqual(part,actual[index])))return `路径 ${expectedPath} 与实际 ${actualPath} 一致。`;
  const notes:string[] = [];
  const width = Math.max(expected.length,actual.length);
  for(let i=0;i<width&&notes.length<4;i++){
    if(expected[i]===undefined)notes.push(`实际多了 /${actual[i]}`);
    else if(actual[i]===undefined)notes.push(`实际缺少 /${expected[i]}`);
    else if(!segmentEqual(expected[i],actual[i]))notes.push(`第 ${i+1} 段期望 ${expected[i]}，实际 ${actual[i]}`);
  }
  return `期望 ${expectedPath}，实际 ${actualPath}。`+notes.join('；')+(notes.length?'。':'');
}
const relativePath = (rule:MockRule,pathname:string) => {
  const prefix = mockBasePath(rule.service);
  if(prefix&&(pathname===prefix||pathname.startsWith(prefix+'/'))){const rest=pathname.slice(prefix.length);return rest.startsWith('/')?rest||'/':'/'+rest;}
  return pathname||'/';
};
const placeholder = (fullPath:string,pathname:string,field:string) => {
  const expected = fullPath.slice(1).split('/'),actual = pathname.slice(1).split('/');
  const index = expected.indexOf('{'+field+'}');
  return index>=0&&actual.length===expected.length?actual[index]:undefined;
};
const readPointer = (value:unknown,pointer:string) => {try{return getPointer(value,pointer);}catch{return undefined;}};
const primitiveText = (value:unknown) => value===undefined?undefined:value===null?'null':typeof value==='object'?JSON.stringify(value):String(value);
const fullMatch = (pattern:string,value:string) => {const found=new RegExp(pattern).exec(value);return !!found&&found.index===0&&found[0].length===value.length;};

function jsonEqual(expected:unknown,actual:unknown,partial:boolean):boolean{
  if(expected===actual)return true;
  if(expected===null||actual===null||typeof expected!=='object'||typeof actual!=='object')return false;
  if(Array.isArray(expected)||Array.isArray(actual)){
    if(!Array.isArray(expected)||!Array.isArray(actual))return false;
    if(partial?actual.length<expected.length:expected.length!==actual.length)return false;
    return expected.every((item,index)=>jsonEqual(item,actual[index],partial));
  }
  const left=expected as Record<string,unknown>,right=actual as Record<string,unknown>;
  for(const key of Object.keys(left))if(!Object.hasOwn(right,key)||!jsonEqual(left[key],right[key],partial))return false;
  return partial||Object.keys(right).every(key=>Object.hasOwn(left,key));
}
function bodyDiff(expected:unknown,actual:unknown,partial:boolean,pointer=''):{messages:string[];extras:boolean;changed:boolean}{
  const messages:string[]=[];let extras=false,changed=false;
  const miss=(text:string)=>{changed=true;messages.push(text);};
  const extra=(text:string)=>{extras=true;messages.push(text);};
  const walk=(left:unknown,right:unknown,path:string)=>{
    if(jsonEqual(left,right,partial))return;
    if(left&&right&&typeof left==='object'&&typeof right==='object'&&!Array.isArray(left)&&!Array.isArray(right)){
      for(const key of Object.keys(left)){
        const next=path+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1');
        if(!Object.hasOwn(right,key))miss(`缺少 ${next}`);
        else walk((left as Record<string,unknown>)[key],(right as Record<string,unknown>)[key],next);
      }
      if(!partial)for(const key of Object.keys(right))if(!Object.hasOwn(left,key))extra(`多了 ${path+'/'+key}`);
      return;
    }
    if(Array.isArray(left)&&Array.isArray(right)){
      left.forEach((item,index)=>index<right.length?walk(item,right[index],path+'/'+index):miss(`缺少 ${path}/${index}`));
      if(right.length>left.length){if(!partial)extra(`${path||'数组'} 多了 ${right.length-left.length} 项`);}
      else if(left.length>right.length)miss(`${path||'数组'} 少了 ${left.length-right.length} 项`);
      return;
    }
    miss(`${path||'body'} 期望 ${shown(path,left)}，实际 ${shown(path,right)}`);
  };
  walk(expected,actual,pointer);
  return {messages,extras,changed};
}
function projectBody(expected:unknown,actual:unknown):unknown{
  if(Array.isArray(expected)&&Array.isArray(actual))return expected.map((item,index)=>index<actual.length?projectBody(item,actual[index]):structuredClone(item));
  if(expected&&actual&&typeof expected==='object'&&typeof actual==='object'&&!Array.isArray(expected)&&!Array.isArray(actual)){
    const result:Record<string,unknown>={};
    for(const key of Object.keys(expected))if(Object.hasOwn(actual,key))result[key]=projectBody((expected as Record<string,unknown>)[key],(actual as Record<string,unknown>)[key]);
    return result;
  }
  return structuredClone(actual);
}
function putPointer(body:unknown,pointer:string,value:unknown){
  const parts=pointerParts(pointer);
  const root=body&&typeof body==='object'&&!Array.isArray(body)?structuredClone(body) as Record<string,unknown>:{};
  let cursor=root;
  for(const part of parts.slice(0,-1)){
    if(!cursor[part]||typeof cursor[part]!=='object'||Array.isArray(cursor[part]))cursor[part]={};
    cursor=cursor[part] as Record<string,unknown>;
  }
  cursor[parts.at(-1)!]=structuredClone(value);
  return root;
}
const leafFields = (value:unknown,prefix=''):Array<{path:string;value:unknown}> => {
  if(Array.isArray(value))return value.flatMap((item,index)=>leafFields(item,prefix+'/'+index));
  if(value&&typeof value==='object'){
    const entries=Object.entries(value).filter(([key])=>!['__proto__','prototype','constructor'].includes(key));
    if(entries.length)return entries.flatMap(([key,item])=>leafFields(item,prefix+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1')));
  }
  return prefix?[{path:prefix,value}]:[];
};

const clause = (id:string,dimension:DiagnosisClause['dimension'],status:DiagnosisStatus,summary:string,proposal?:DiagnosisClause['proposal'],optional=false):DiagnosisClause => ({id,dimension,status,summary,...(optional?{optional}:{}),...(proposal?{proposal}:{})});
const anyValue = (values:string[]|undefined,test:(value:string)=>boolean) => !!values?.some(test);

function stringCondition(source:'header'|'query',field:string,operator:RequestCondition['operator'],expected:unknown,actual:string[]|undefined){
  const label=source==='header'?'Header':'Query';
  const present=!!actual?.length;
  if(operator==='exists')return {ok:present,summary:present?`${label} ${field} 存在。`:`缺少 ${label} ${field}。`,remove:!present};
  if(operator==='missing')return {ok:!present,summary:present?`${label} ${field} 实际存在。`:`${label} ${field} 不存在，符合。`,remove:false};
  if(!present)return {ok:false,summary:`缺少 ${label} ${field}。`,remove:true};
  if(operator==='contains'){const ok=anyValue(actual,value=>value.includes(String(expected)));return {ok,summary:ok?`${label} ${field} 包含期望文本。`:`${label} ${field} 不包含 ${shown(field,expected)}。`,remove:false,rewrite:!ok};}
  if(operator==='regex'){let ok=false;try{ok=anyValue(actual,value=>fullMatch(String(expected),value));}catch{return {ok:false,summary:`${label} ${field} 的正则无效。`,remove:false};}return {ok,summary:ok?`${label} ${field} 符合正则。`:`${label} ${field} 不符合正则。`,remove:false,rewrite:!ok};}
  const ok=anyValue(actual,value=>value===String(expected));
  return {ok,summary:ok?`${label} ${field} 期望 ${shown(field,expected)}，实际相符。`:`${label} ${field} 期望 ${shown(field,expected)}，实际 ${shown(field,actual?.[0])}。`,remove:false};
}
function pathCondition(rulePath:string,pathname:string,condition:RequestCondition){
  const actual=placeholder(rulePath,pathname,condition.field);
  if(actual===undefined)return {ok:true,summary:`路径上没有 {${condition.field}}，这条条件没有参与匹配。`,skip:true};
  if(condition.operator==='exists'||!['eq','contains','regex'].includes(condition.operator))return {ok:true,summary:`路径 {${condition.field}} 实际是 ${shown(condition.field,actual)}。`};
  if(condition.operator==='eq'){const ok=actual===String(condition.value);return {ok,summary:ok?`路径 {${condition.field}} 是 ${shown(condition.field,actual)}。`:`路径 {${condition.field}} 期望 ${shown(condition.field,condition.value)}，实际 ${shown(condition.field,actual)}。`};}
  if(condition.operator==='contains'){const ok=actual.includes(String(condition.value));return {ok,summary:ok?`路径 {${condition.field}} 包含期望文本。`:`路径 {${condition.field}} 不包含 ${shown(condition.field,condition.value)}。`,rewrite:!ok};}
  try{const ok=fullMatch(String(condition.value),actual);return {ok,summary:ok?`路径 {${condition.field}} 符合正则。`:`路径 {${condition.field}} 不符合正则。`,rewrite:!ok};}
  catch{return {ok:false,summary:`路径 {${condition.field}} 的正则无效。`};}
}
function bodyCondition(request:ActualRequest,condition:RequestCondition){
  if(!request.json)return {ok:false,summary:`Body ${condition.field} 无法比较，请求体不是 JSON。`};
  const actual=readPointer(request.jsonBody,condition.field);
  const missing=actual===undefined;
  if(condition.operator==='exists')return {ok:!missing,summary:missing?`Body ${condition.field} 不存在。`:`Body ${condition.field} 存在。`,remove:missing};
  if(['gt','gte','lt','lte'].includes(condition.operator)){
    const op={gt:'>',gte:'≥',lt:'<',lte:'≤'}[condition.operator as 'gt'];
    if(typeof actual!=='number')return {ok:false,summary:`Body ${condition.field} 需要数字才能比较 ${op} ${shown(condition.field,condition.value)}。`};
    const expected=Number(condition.value);
    const ok={gt:actual>expected,gte:actual>=expected,lt:actual<expected,lte:actual<=expected}[condition.operator as 'gt'];
    return {ok,summary:ok?`Body ${condition.field} ${actual} ${op} ${expected}。`:`Body ${condition.field} 要求 ${op} ${expected}，实际 ${actual}。`,retarget:!ok};
  }
  if(missing)return {ok:false,summary:`Body ${condition.field} 不存在。`,remove:true};
  const text=primitiveText(actual);
  if(condition.operator==='contains'){const ok=typeof actual==='string'&&actual.includes(String(condition.value));return {ok,summary:ok?`Body ${condition.field} 包含期望文本。`:`Body ${condition.field} 不包含 ${shown(condition.field,condition.value)}。`,rewrite:!ok&&typeof actual==='string'};}
  if(condition.operator==='regex'){let ok=false;try{ok=typeof text==='string'&&fullMatch(String(condition.value),text);}catch{return {ok:false,summary:`Body ${condition.field} 的正则无效。`};}return {ok,summary:ok?`Body ${condition.field} 符合正则。`:`Body ${condition.field} 不符合正则。`,rewrite:!ok&&typeof actual!=='object'};}
  if(actual!==null&&typeof actual==='object')return {ok:false,summary:`Body ${condition.field} 是对象，等于条件无法比较。`};
  const ok=text===primitiveText(condition.value);
  return {ok,summary:ok?`Body ${condition.field} 期望 ${shown(condition.field,condition.value)}，实际相符。`:`Body ${condition.field} 期望 ${shown(condition.field,condition.value)}，实际 ${shown(condition.field,actual)}。`};
}

const variantsOf = (rule:MockRule) => [{id:'__base',label:'基础条件'},...(rule.behavior?.exceptions||[]).map(item=>({id:item.id,label:'例外 · '+item.name}))];
const countable = (item:DiagnosisClause) => DIMENSIONS.includes(item.dimension as typeof DIMENSIONS[number])&&!item.optional;

function evaluate(rule:MockRule,variant:string,request:ActualRequest,states:Record<string,string>):Built {
  const clauses:DiagnosisClause[]=[];const edits:Edit[]=[];
  const fullPath=mockRequestPath(rule);
  const shape=shapeMatches(fullPath,request.pathname);
  const methodOk=request.method===rule.method;
  const distance=segmentDistance(segments(rule.path),segments(relativePath(rule,request.pathname)));
  clauses.push(clause('method','method',methodOk?'match':'mismatch',methodOk?`Method ${request.method} 符合。`:`Method 期望 ${rule.method}，实际 ${request.method}。`));
  clauses.push(clause('path','path',shape?'match':'mismatch',explainPath(rule.path,relativePath(rule,request.pathname))));
  if(!shape){
    for(const dimension of ['header','query','body'] as const)clauses.push(clause('dim:'+dimension,dimension,'skipped','路径不同，未比较这项。'));
    finish(clauses,rule,false,states);
    return score(clauses,edits,shape,methodOk,distance);
  }
  const conditions=[...(rule.behavior?.matchers||[]),...(variant==='__base'?[]:rule.behavior?.exceptions.find(item=>item.id===variant)?.conditions||[])];
  const headerNames=new Set(Object.keys(rule.requestHeaders).map(name=>name.toLowerCase()));
  const queryNames=new Set(Object.keys(rule.query));
  if(!Object.keys(rule.requestHeaders).length&&!conditions.some(item=>item.source==='header'))clauses.push(clause('dim:header','header','unconstrained','未限制，不参与匹配。'));
  for(const [name,expected] of Object.entries(rule.requestHeaders)){
    const actual=request.headers[name.toLowerCase()];
    const hidden=sensitive(name);
    const ok=anyValue(actual,value=>value===expected);
    const summary=!actual?.length?`缺少 Header ${name}。`:ok?`Header ${name} 符合。`:`Header ${name} 期望 ${shown(name,expected)}，实际 ${shown(name,actual[0])}。`;
    const id='header:rule:'+name.toLowerCase();
    clauses.push(clause(id,'header',ok?'match':'mismatch',summary,!ok&&!hidden?{label:actual?.length?`把 Header ${name} 的期望改成 ${shown(name,actual[0])}`:`去掉 Header ${name} 的要求（这次请求没有这个 Header）`,defaultSelected:true}:undefined));
    if(!ok&&!hidden)edits.push({id,kind:'set-header',name,value:actual?.[0]});
  }
  for(const [index,condition] of conditions.entries())if(condition.source==='header')addCondition(clauses,edits,rule,variant,index,condition,request,fullPath);
  if(!Object.keys(rule.query).length&&!conditions.some(item=>item.source==='query'))clauses.push(clause('dim:query','query','unconstrained','未限制，不参与匹配。'));
  for(const [name,expected] of Object.entries(rule.query)){
    const actual=request.query[name];
    const hidden=sensitive(name);
    const ok=anyValue(actual,value=>value===expected);
    const summary=!actual?.length?`缺少 Query ${name}。`:ok?`Query ${name} 符合。`:`Query ${name} 期望 ${shown(name,expected)}，实际 ${shown(name,actual[0])}。`;
    const id='query:rule:'+name;
    clauses.push(clause(id,'query',ok?'match':'mismatch',summary,!ok&&!hidden?{label:actual?.length?`把 Query ${name} 的期望改成 ${shown(name,actual[0])}`:`去掉 Query ${name} 的要求（这次请求没有这个参数）`,defaultSelected:true}:undefined));
    if(!ok&&!hidden)edits.push({id,kind:'set-query',name,value:actual?.[0]});
  }
  for(const [index,condition] of conditions.entries())if(condition.source==='query'||condition.source==='path'||condition.source==='body')addCondition(clauses,edits,rule,variant,index,condition,request,fullPath);
  if(rule.requestBody===undefined&&!conditions.some(item=>item.source==='body'))clauses.push(clause('dim:body','body','unconstrained','未限制，不参与匹配。'));
  if(rule.requestBody!==undefined){
    const id='body';
    if(!request.json)clauses.push(clause(id,'body','mismatch','Body 不是 JSON，规则要求 JSON。'));
    else{
      const partial=rule.bodyMatchMode==='partial';
      const diff=bodyDiff(rule.requestBody,request.jsonBody,partial);
      if(!diff.messages.length)clauses.push(clause(id,'body','match',partial?'Body 符合部分匹配。':'Body 符合完整匹配。'));
      else{
        const summary=diff.messages.slice(0,6).join('；')+(diff.messages.length>6?`；等共 ${diff.messages.length} 处。`:'。');
        clauses.push(clause(id,'body','mismatch',summary,diff.changed?{label:'把已约束的 Body 字段改成这次请求的值',defaultSelected:true}:undefined));
        if(diff.changed)edits.push({id,kind:'project-body'});
        if(!partial&&diff.extras){
          clauses.push(clause('body-mode','body','mismatch','完整匹配还会拒绝请求里多出来的字段。',{label:'改为部分匹配，忽略多出来的字段',defaultSelected:false}));
          edits.push({id:'body-mode',kind:'partial-body'});
        }
      }
    }
  }
  if(shape&&methodOk)offerOptional(clauses,edits,rule,request,headerNames,queryNames,conditions);
  const requestOk=!clauses.some(item=>countable(item)&&item.status==='mismatch');
  finish(clauses,rule,requestOk,states);
  return score(clauses,edits,shape,methodOk,distance);
}
function addCondition(clauses:DiagnosisClause[],edits:Edit[],rule:MockRule,variant:string,index:number,condition:RequestCondition,request:ActualRequest,fullPath:string){
  const owned=variant!=='__base'&&index>=(rule.behavior?.matchers.length||0);
  const localIndex=owned?index-(rule.behavior?.matchers.length||0):index;
  const id=owned?`exception:${variant}:${localIndex}`:`matcher:${index}`;
  const where=owned?{kind:'set-exception' as const,exceptionId:variant,index:localIndex}:{kind:'set-matcher' as const,index};
  if(condition.source==='path'){
    const result=pathCondition(fullPath,request.pathname,condition);
    if(result.skip){clauses.push(clause(id,'path','unconstrained',result.summary));return;}
    const proposal=!result.ok&&!sensitive(condition.field)?result.rewrite?{label:`把路径 {${condition.field}} 的条件改成等于 ${shown(condition.field,placeholder(fullPath,request.pathname,condition.field))}`,defaultSelected:false}:condition.operator==='eq'?{label:`把路径 {${condition.field}} 的期望改成 ${shown(condition.field,placeholder(fullPath,request.pathname,condition.field))}`,defaultSelected:true}:undefined:undefined;
    clauses.push(clause(id,'path',result.ok?'match':'mismatch',result.summary,proposal));
    if(proposal)edits.push({...where,id,operator:'eq',value:placeholder(fullPath,request.pathname,condition.field)});
    return;
  }
  if(condition.source==='header'||condition.source==='query'){
    const actual=condition.source==='header'?request.headers[condition.field.toLowerCase()]:request.query[condition.field];
    const result=stringCondition(condition.source,condition.field,condition.operator,condition.value,actual);
    const hidden=sensitive(condition.field);
    const proposal=!result.ok&&!hidden?result.remove?{label:`删除这条${condition.source==='header'?' Header ':' Query '}条件 ${condition.field}`,defaultSelected:true}:result.rewrite?{label:`把 ${condition.field} 的条件改成等于 ${shown(condition.field,actual?.[0])}`,defaultSelected:false}:condition.operator==='eq'?{label:`把 ${condition.field} 的期望改成 ${shown(condition.field,actual?.[0])}`,defaultSelected:true}:undefined:undefined;
    clauses.push(clause(id,condition.source,result.ok?'match':'mismatch',result.summary,proposal));
    if(proposal&&result.remove)edits.push({...where,id,remove:true});
    else if(proposal)edits.push({...where,id,operator:'eq',value:condition.source==='header'||condition.source==='query'?actual?.[0]:condition.value});
    return;
  }
  const result=bodyCondition(request,condition);
  const hidden=sensitive(condition.field);
  const actual=request.json?readPointer(request.jsonBody,condition.field):undefined;
  const primitive=actual===null||['string','number','boolean'].includes(typeof actual);
  const proposal=!result.ok&&!hidden?result.remove?{label:`删除 Body ${condition.field} 的存在条件`,defaultSelected:false}:result.retarget&&typeof actual==='number'?{label:`把 Body ${condition.field} 的 ${condition.operator} ${shown(condition.field,condition.value)} 改为 ${condition.operator} ${actual}`,defaultSelected:true}:result.rewrite&&primitive?{label:`把 Body ${condition.field} 的条件改成等于 ${shown(condition.field,actual)}`,defaultSelected:false}:condition.operator==='eq'&&primitive?{label:`把 Body ${condition.field} 的期望改成 ${shown(condition.field,actual)}`,defaultSelected:true}:undefined:undefined;
  clauses.push(clause(id,'body',result.ok?'match':'mismatch',result.summary,proposal));
  if(!proposal)return;
  if(result.remove)edits.push({...where,id,remove:true});
  else if(result.retarget&&typeof actual==='number')edits.push({...where,id,value:actual});
  else edits.push({...where,id,operator:'eq',value:actual});
}
function offerOptional(clauses:DiagnosisClause[],edits:Edit[],rule:MockRule,request:ActualRequest,headerNames:Set<string>,queryNames:Set<string>,conditions:RequestCondition[]){
  const conditionedHeaders=new Set(conditions.filter(item=>item.source==='header').map(item=>item.field.toLowerCase()));
  const conditionedQuery=new Set(conditions.filter(item=>item.source==='query').map(item=>item.field));
  let headers=0,queries=0,bodies=0;
  for(const [name,values] of Object.entries(request.headers)){
    if(headers>=8||headerNames.has(name)||conditionedHeaders.has(name)||HOP.test(name)||sensitive(name)||!HEADER.test(name))continue;
    const id='optional-header:'+name;
    clauses.push(clause(id,'header','unconstrained',`请求带有 Header ${name}。`,{label:`增加 Header ${name} = ${shown(name,values[0])}`,defaultSelected:false},true));
    edits.push({id,kind:'add-header',name,value:values[0]});headers++;
  }
  for(const [name,values] of Object.entries(request.query)){
    if(queries>=8||queryNames.has(name)||conditionedQuery.has(name)||sensitive(name)||!HEADER.test(name)||name.length>200)continue;
    const id='optional-query:'+name;
    clauses.push(clause(id,'query','unconstrained',`请求带有 Query ${name}。`,{label:`增加 Query ${name} = ${shown(name,values[0])}`,defaultSelected:false},true));
    edits.push({id,kind:'add-query',name,value:values[0]});queries++;
  }
  if(!request.json||(rule.requestBody!==undefined&&rule.bodyMatchMode!=='partial'))return;
  for(const field of leafFields(request.jsonBody)){
    if(bodies>=8||sensitive(field.path)||field.path.length>1000||(field.value!==null&&typeof field.value==='object'))continue;
    let parts:string[];try{parts=pointerParts(field.path);}catch{continue;}
    if(parts.some(part=>/^\d+$/.test(part))||(rule.requestBody!==undefined&&readPointer(rule.requestBody,field.path)!==undefined))continue;
    const id='optional-body:'+field.path;
    clauses.push(clause(id,'body','unconstrained',`请求 Body 含有 ${field.path}。`,{label:`按部分匹配增加 ${field.path} = ${shown(field.path,field.value)}`,defaultSelected:false},true));
    edits.push({id,kind:'add-body',pointer:field.path,value:field.value});bodies++;
  }
}
function finish(clauses:DiagnosisClause[],rule:MockRule,requestOk:boolean,states:Record<string,string>){
  if(!rule.enabled)clauses.push(clause('enabled','enabled','mismatch','规则未启用，Mock Server 不会使用它。',{label:'启用这条规则',defaultSelected:true}));
  const sequence=rule.behavior?.sequence;
  if(!sequence)return;
  if(!rule.enabled){clauses.push(clause('sequence','sequence','skipped','规则未启用，调用步骤未生效。'));return;}
  if(!requestOk){clauses.push(clause('sequence','sequence','skipped','请求条件未符合，未用调用步骤解释这次未命中。'));return;}
  const accepted=sequence.steps.map((_,index)=>index===0?'Started':'step-'+index);
  const current=states[sequenceName(rule)]||'Started';
  if(accepted.includes(current))clauses.push(clause('sequence','sequence','match',`当前调用步骤是 ${current}。`));
  else clauses.push(clause('sequence','sequence','mismatch',sequence.end==='stop'&&current==='Finished'?'条件都符合，但调用步骤已经停止，不再接收请求。':`条件都符合，但当前调用步骤是 ${current}，没有步骤会接收这次请求。`));
}
function score(clauses:DiagnosisClause[],edits:Edit[],shape:boolean,methodOk:boolean,distance:number):Built{
  return {clauses,edits,shape,methodOk,distance,requestFailed:clauses.filter(item=>countable(item)&&item.status==='mismatch').length,requestMatched:clauses.filter(item=>countable(item)&&item.status==='match').length};
}
function scoped(pathname:string,rules:MockRule[]){
  const prefixes=[...new Set(rules.map(rule=>mockBasePath(rule.service)).filter(Boolean))];
  const matched=prefixes.filter(prefix=>pathname===prefix||pathname.startsWith(prefix+'/')).sort((a,b)=>b.length-a.length);
  if(matched.length){const prefix=matched[0];return rules.filter(rule=>mockBasePath(rule.service)===prefix);}
  if(pathname.startsWith('/__mockingbird/'))return [];
  return rules.filter(rule=>!rule.service);
}
const candidateFrom = (rule:MockRule,variant:{id:string;label:string},built:Built):DiagnosisCandidate => ({
  id:rule.id+'::'+variant.id,ruleId:rule.id,name:rule.name,scenario:rule.scenario,variantLabel:variant.label,enabled:rule.enabled,
  pathMatched:built.shape,methodMatched:built.methodOk,failedClauses:built.requestFailed,matchedClauses:built.requestMatched,priority:rule.priority??5,clauses:built.clauses
});
const byRank = (left:DiagnosisCandidate&{distance:number},right:DiagnosisCandidate&{distance:number}) => Number(right.methodMatched)-Number(left.methodMatched)||left.failedClauses-right.failedClauses||right.matchedClauses-left.matchedClauses||left.priority-right.priority||left.name.localeCompare(right.name,'zh')||left.variantLabel.localeCompare(right.variantLabel,'zh');

export function diagnoseUnmatched(request:ActualRequest,rules:MockRule[],states:Record<string,string>={}):UnmatchedDiagnosis{
  if(!rules.length)return {message:'当前项目没有 Mock 规则。',scope:'empty',candidates:[]};
  const rulesInScope=scoped(request.pathname,rules);
  if(!rulesInScope.length)return {message:'没有和这条路径对应的下游规则。',scope:'outside',candidates:[]};
  const scored=rulesInScope.flatMap(rule=>variantsOf(rule).map(variant=>{const built=evaluate(rule,variant.id,request,states);return {...candidateFrom(rule,variant,built),distance:built.distance};}));
  const ranked=scored.filter(item=>item.pathMatched).sort(byRank);
  if(ranked.length){
    const closest=ranked[0];
    return {message:`最接近的是「${closest.name} · ${closest.scenario}」的${closest.variantLabel}。`+(ranked.length>1?` 另有 ${Math.min(ranked.length,3)-1} 条路径相同的规则。`:''),scope:'ranked',candidates:ranked.slice(0,3)};
  }
  const similar=scored.filter(item=>item.id.endsWith('::__base')).sort((left,right)=>left.distance-right.distance||Number(right.methodMatched)-Number(left.methodMatched)||left.priority-right.priority||left.name.localeCompare(right.name,'zh'));
  return {message:'没有路径相同的规则。下面只比较路径最接近的规则的 method 和 path。',scope:'similar',candidates:similar.slice(0,3)};
}
export function variantMatchesRequest(request:ActualRequest,rule:MockRule,variant='base'){
  const built=evaluate(rule,variant,request,{});
  return built.shape&&built.methodOk&&built.requestFailed===0;
}
export function matchesPublished(request:ActualRequest,rules:MockRule[],states:Record<string,string>={}){
  return rules.some(rule=>rule.enabled&&variantsOf(rule).some(variant=>{
    const built=evaluate(rule,variant.id,request,states);
    const sequence=built.clauses.find(item=>item.id==='sequence');
    return built.shape&&built.methodOk&&built.requestFailed===0&&sequence?.status!=='mismatch';
  }));
}

const applyEdit = (draft:MockRule,edit:Edit) => {
  if(edit.kind==='set-header'||edit.kind==='add-header'){
    const key=Object.keys(draft.requestHeaders).find(name=>name.toLowerCase()===edit.name);
    if(edit.value===undefined){if(key)delete draft.requestHeaders[key];}
    else draft.requestHeaders[key||edit.name!]=String(edit.value);
  }else if(edit.kind==='set-query'||edit.kind==='add-query'){
    if(edit.value===undefined)delete draft.query[edit.name!];
    else draft.query[edit.name!]=String(edit.value);
  }else if(edit.kind==='project-body')draft.requestBody=projectBody(draft.requestBody,edit.value);
  else if(edit.kind==='partial-body')draft.bodyMatchMode='partial';
  else if(edit.kind==='add-body'){draft.requestBody=putPointer(draft.requestBody,edit.pointer!,edit.value);if(!draft.bodyMatchMode)draft.bodyMatchMode='partial';}
  else if(edit.kind==='enable')draft.enabled=true;
};
function applyCondition(condition:RequestCondition,edit:Edit){
  if(edit.operator==='eq'){condition.operator='eq';condition.value=edit.value;}
  else if(edit.value!==undefined)condition.value=edit.value;
}
function applyEdits(rule:MockRule,edits:Edit[],body:unknown){
  const draft=structuredClone(rule);
  const bodyEdit=edits.find(edit=>edit.kind==='project-body');
  if(bodyEdit)bodyEdit.value=body;
  for(const edit of edits.filter(item=>item.kind!=='set-matcher'&&item.kind!=='set-exception'))applyEdit(draft,edit);
  const behavior=draft.behavior;
  if(behavior){
    for(const edit of edits.filter(item=>item.kind==='set-matcher'&&!item.remove))applyCondition(behavior.matchers[edit.index!],edit);
    const removed=new Set(edits.filter(item=>item.kind==='set-matcher'&&item.remove).map(item=>item.index));
    if(removed.size)behavior.matchers=behavior.matchers.filter((_,index)=>!removed.has(index));
    for(const edit of edits.filter(item=>item.kind==='set-exception'&&!item.remove)){
      const exception=behavior.exceptions.find(item=>item.id===edit.exceptionId);
      if(exception)applyCondition(exception.conditions[edit.index!],edit);
    }
    for(const exception of behavior.exceptions){
      const removedConditions=new Set(edits.filter(item=>item.kind==='set-exception'&&item.remove&&item.exceptionId===exception.id).map(item=>item.index));
      if(removedConditions.size)exception.conditions=exception.conditions.filter((_,index)=>!removedConditions.has(index));
    }
    behavior.exceptions=behavior.exceptions.filter(item=>item.conditions.length>0);
  }
  return draft;
}
export function applyUnmatched(rules:MockRule[],request:ActualRequest,states:Record<string,string>,candidateId:string,clauseIds:string[],newId:string):DiagnosisAdoption{
  const diagnosis=diagnoseUnmatched(request,rules,states);
  const candidate=diagnosis.candidates.find(item=>item.id===candidateId);
  const rule=rules.find(item=>item.id===candidate?.ruleId);
  if(!candidate||!rule)throw new Error('规则已变化，请重新诊断');
  const variant=candidateId.slice(candidateId.indexOf('::')+2);
  const built=evaluate(rule,variant,request,states);
  const baseFingerprint=ruleFingerprint(rule);
  if(!candidate.pathMatched||!candidate.methodMatched){
    if(!METHODS.includes(request.method as HttpMethod))throw new Error('不支持的请求方法');
    const path=relativePath(rule,request.pathname);
    if(!path.startsWith('/')||path.includes('?')||path.includes('#')||path.startsWith('/__admin')||path.length>2000)throw new Error('这条请求的路径不能写成规则');
    const created:MockRule={id:newId,dependencyId:rule.dependencyId,name:clip(rule.name+' · 未命中请求',200),scenario:'未命中请求',method:request.method as HttpMethod,path,service:rule.service?structuredClone(rule.service):undefined,status:rule.status,headers:structuredClone(rule.headers),body:structuredClone(rule.body),delay:rule.delay,enabled:false,query:{},requestHeaders:{},priority:rule.priority,basis:`根据未命中请求生成，响应复制自「${rule.name} · ${rule.scenario}」，待审核。`,version:1,evidence:rule.evidence?structuredClone(rule.evidence):undefined};
    return {rule:created,created:true,summary:`已生成新规则草稿「${created.name}」，使用这次请求的 method 和 path。审核后保存才会发布。`,baseFingerprint};
  }
  const selected=new Set(clauseIds);
  const edits=built.edits.filter(edit=>selected.has(edit.id));
  if(selected.has('enabled')&&built.clauses.some(item=>item.id==='enabled'&&item.proposal))edits.push({id:'enabled',kind:'enable'});
  if(!edits.length)throw new Error('请选择要采纳的匹配条件');
  let next=applyEdits(rule,edits,request.jsonBody);
  const note='根据未命中请求调整了匹配条件，待审核。';
  if(!next.basis.includes(note))next.basis=`${next.basis?next.basis+' ':''}${note}`;
  next.version=rule.version+1;
  let summary='匹配条件已写入草稿，审核后保存才会发布。';
  if(next.enabled&&rules.some(item=>item.id!==next.id&&item.enabled&&overlaps(item,next))){
    if(!edits.some(edit=>edit.kind!=='enable'))throw new Error('与已启用规则冲突，不能只启用这条规则。请先给场景加上互斥条件');
    next={...next,enabled:false,basis:next.basis+' 与已启用规则冲突，草稿保持关闭。'};
    summary+=' 与已启用规则冲突，草稿保持关闭。';
  }
  if(ruleFingerprint({...next,version:0,basis:''})===ruleFingerprint({...rule,version:0,basis:''})&&next.enabled===rule.enabled)throw new Error('这些选择没有改变匹配条件');
  return {rule:next,created:false,summary,baseFingerprint};
}
const clip=(value:string,max:number)=>value.length>max?value.slice(0,max):value;
