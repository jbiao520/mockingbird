import { propertyForSource, type Index } from './analyzer';
import { shapeOf } from './response-shape';
import type { RequestTemplate } from '../shared/types';

// Split method parameters without splitting annotation arguments or generic types.
function parameters(input:string){
  const parts:string[]=[];let depth=0,start=0,quoted=false;
  for(let i=0;i<input.length;i++){const c=input[i];if(c==='"'&&input[i-1]!=='\\')quoted=!quoted;if(quoted)continue;if('(<['.includes(c))depth++;else if(')>]'.includes(c))depth--;else if(c===','&&depth===0){parts.push(input.slice(start,i));start=i+1;}}
  if(input.slice(start).trim())parts.push(input.slice(start));return parts;
}
const primitive=/^(?:boolean|byte|short|int|long|float|double|char)$/;
function wireShape(index:Index,type:string,stack:string[]){
  // Custom Jackson conversions and generic DTOs cannot be inferred safely here.
  const simple=type.split('<')[0].split('.').at(-1)!.trim();
  const candidates=[...index.sources.values()].filter(s=>new RegExp('\\b(?:class|record|enum)\\s+'+simple+'\\b').test(s));
  if(candidates.length>1)return {kind:'unknown' as const,label:type+' 存在同名类型'};
  const source=candidates[0];
  if(source&&(/@(?:[\w]+\.)*Json(?:Deserialize|Serialize|Format|Unwrapped|Value|Creator|TypeInfo|Setter|AutoDetect|IgnoreProperties)\b/.test(source)||/@[\w.]+\.Json\w+\b/.test(source)||/@JsonNaming\b/.test(source)&&!/SnakeCaseStrategy|KebabCaseStrategy|UpperCamelCaseStrategy|PascalCaseStrategy|LowerCamelCaseStrategy/.test(source)||new RegExp('\\bclass\\s+'+simple+'\\s*(?:<|extends\\b)').test(source)||type.includes('<')))
    return {kind:'unknown' as const,label:type+' 的泛型、继承或 Jackson 转换需人工确认'};
  if(type==='char'||type==='Character')return {kind:'primitive' as const,simple:'string' as const,integral:false};
  return shapeOf(index,type,stack);
}
function visit(index:Index,type:string,value:unknown,path:string,stack:string[],warnings:string[],generate:boolean):unknown{
  if(stack.length>20){warnings.push(`${path} 嵌套过深，需人工确认`);return null;}
  const shape=wireShape(index,type,stack);
  if(shape.kind==='unknown'){warnings.push(`${path}: ${shape.label} 未能确认，请按源码填写`);return null;}
  if(!generate&&value===null){if(primitive.test(type))throw new Error(`${path} (${type}) 不能为 null`);return null;}
  if(shape.kind==='primitive'){
    if(generate)return shape.simple==='number'?1:shape.simple==='boolean'?true:type==='char'||type==='Character'?'a':'sample';
    if(typeof value!==shape.simple||(shape.simple==='number'&&(!Number.isFinite(value)||shape.integral&&!Number.isSafeInteger(value))))throw new Error(`${path} (${type}) 应为 ${shape.simple==='number'?(shape.integral?'安全范围内的整数':'数字'):shape.simple==='boolean'?'boolean':'字符串'}，实际为 ${typeof value}`);
    if(typeof value==='number'){const ranges:Record<string,number>={byte:128,Byte:128,short:32768,Short:32768,int:2147483648,Integer:2147483648};const limit=ranges[type.split('.').at(-1)!];if(limit&&(value < -limit||value>=limit))throw new Error(`${path} 超出 ${type} 的取值范围`);}
    if((type==='char'||type==='Character')&&(value as string).length!==1)throw new Error(`${path} 应为单个字符`);
    return value;
  }
  if(shape.kind==='enum'){if(generate)return shape.values[0];if(typeof value!=='string'||!shape.values.includes(value))throw new Error(`${path} 应为枚举值 ${shape.values.join('、')}`);return value;}
  if(shape.kind==='array'){
    if(generate)return [visit(index,shape.item,undefined,`${path}[0]`,[...stack,type],warnings,true)];
    if(!Array.isArray(value))throw new Error(`${path} 应为 JSON 数组`);
    value.forEach((item,i)=>visit(index,shape.item,item,`${path}[${i}]`,[...stack,type],warnings,false));return value;
  }
  if(!generate&&(!value||typeof value!=='object'||Array.isArray(value)))throw new Error(`${path} 应为 JSON 对象`);
  const result:Record<string,unknown>={};
  for(const field of shape.fields){
    const fieldPath=`${path}.${field.jsonName}`;
    // DTO fields can be omitted unless validation constraints are known.
    if(!generate&&!(field.jsonName in (value as object)))continue;
    result[field.jsonName]=visit(index,field.type,generate?undefined:(value as Record<string,unknown>)[field.jsonName],fieldPath,[...stack,shape.typeName],warnings,generate);
  }
  return generate?result:value;
}
function contract(index:Index,entryId:string){
  const entry=index.project.entries.find(e=>e.id===entryId),method=index.methods.find(m=>m.id===entry?.methodId);
  if(!entry||!method)throw new Error('入口 API 不存在，请重新索引');
  const bindings=parameters(method.parameters).map(fragment=>{
    const annotation=/@(RequestBody|PathVariable|RequestParam|RequestHeader)\b(?:\s*\(([^)]*)\))?/.exec(fragment);
    const clean=fragment.replace(/@[\w.]+\s*(?:\((?:[^()"]|"(?:\\.|[^"\\])*")*\))?/g,'').replace(/\bfinal\s+/g,'').trim();
    const match=/^(.+?)\s+(\w+)$/.exec(clean);
    return {kind:annotation?.[1],notes:annotation?.[2]||'',type:match?.[1].replace(/\s+/g,'')||'Object',name:/(?:\b(?:value|name)\s*=\s*)?"([^"]+)"/.exec(annotation?.[2]||'')?.[1]||match?.[2]||'',fragment};
  });
  return{entry,bindings};
}
function entryRequestPath(index:Index,entry:{file:string;path:string},contextPath?:string){
  const prefix=(contextPath??propertyForSource(index,'server.servlet.context-path',entry.file)??'').trim();
  if(!prefix||prefix==='/')return entry.path;
  if(!prefix.startsWith('/')||/[?#{}\s\\]|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(prefix))throw new Error('server.servlet.context-path 未能解析为有效路径，请核对入口模块配置');
  return prefix.replace(/\/+$/,'')+entry.path;
}
export function generateRequestTemplate(index:Index,entryId:string,contextPath?:string):RequestTemplate{
  const {entry,bindings}=contract(index,entryId),warnings:string[]=[],headers:Record<string,string>={},query=new URLSearchParams();let path=entryRequestPath(index,entry,contextPath),body:unknown;
  for(const binding of bindings){
    if(!binding.kind){warnings.push(`参数 ${binding.name} 的 Spring 绑定方式未确认，请手动填写`);continue;}
    const sample=visit(index,binding.type,undefined,binding.kind==='RequestBody'?'body':binding.name,[],warnings,true);
    if(binding.kind==='RequestBody'){body=sample;headers['Content-Type']='application/json';if(['GET','HEAD'].includes(entry.method))warnings.push('此入口声明了请求 Body，但 GET / HEAD 请求不会发送 Body');}
    else if(sample!==null&&typeof sample!=='object'){
      const text=/\bdefaultValue\s*=\s*"([^"]*)"/.exec(binding.notes)?.[1]??String(sample);
      if(binding.kind==='PathVariable')path=path.replace(new RegExp('\\{'+binding.name+'(?::[^}]+)?\\}','g'),encodeURIComponent(text));
      else if(binding.kind==='RequestParam')query.set(binding.name,text);
      else headers[binding.name]=text;
    }else warnings.push(`参数 ${binding.name} 不能自动转换为路径、查询串或 Header，请手动填写`);
  }
  if(path.includes('{'))warnings.push('部分路径参数未解析，请替换路径中的占位符');
  return{entryId,revision:index.project.revision,method:entry.method,path:path+(query.size?'?'+query:''),body,headers,warnings:[...new Set(warnings)]};
}
export function validateEntryRequest(index:Index,entryId:string,input:{method:string;path:string;body?:unknown;headers?:Record<string,string>},contextPath?:string){
  const {entry,bindings}=contract(index,entryId);
  const requestPath=entryRequestPath(index,entry,contextPath);
  const actual=new URL(input.path,'http://localhost').pathname;
  const pattern=requestPath.split(/(\{[^}]+\})/).map(p=>p.startsWith('{')?'[^/]+':p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('');
  if(input.method!==entry.method||!new RegExp('^'+pattern+'$').test(actual))throw new Error('请求方法或路径已偏离入口 API，请重新点击“验证入口 API”');
  const warnings:string[]=[];
  const captures=new RegExp('^'+requestPath.split(/(\{[^}]+\})/).map(p=>p.startsWith('{')?'([^/]+)':p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('')+'$').exec(actual)!;
  const names=[...entry.path.matchAll(/\{([^}:]+)(?::[^}]+)?\}/g)].map(m=>m[1]);
  const query=new URL(input.path,'http://localhost').searchParams;
  for(const binding of bindings.filter(b=>b.kind&&b.kind!=='RequestBody')){
    const text=binding.kind==='PathVariable'?captures[names.indexOf(binding.name)+1]:binding.kind==='RequestParam'?query.get(binding.name):Object.entries(input.headers||{}).find(([key])=>key.toLowerCase()===binding.name.toLowerCase())?.[1];
    if(text===undefined||text===null){if(!/\brequired\s*=\s*false|\bdefaultValue\s*=/.test(binding.notes))throw new Error(`缺少参数 ${binding.name}`);continue;}
    const shape=wireShape(index,binding.type,[]),decoded=binding.kind==='PathVariable'?decodeURIComponent(text):text;
    if(shape.kind==='primitive'||shape.kind==='enum'){
      let value:unknown=decoded;
      if(shape.kind==='primitive'&&shape.simple==='number'){if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(decoded))throw new Error(`${binding.name} (${binding.type}) 应为数字`);value=Number(decoded);}
      if(shape.kind==='primitive'&&shape.simple==='boolean'){if(!['true','false'].includes(decoded))throw new Error(`${binding.name} 应为 true 或 false`);value=decoded==='true';}
      visit(index,binding.type,value,binding.name,[],warnings,false);
    }else warnings.push(`参数 ${binding.name} 的类型 ${binding.type} 未校验，请手动确认`);
  }
  for(const binding of bindings.filter(b=>b.kind==='RequestBody')){
    if(input.body===undefined||input.body===null){if(!/\brequired\s*=\s*false/.test(binding.notes))throw new Error('入口 API 需要请求 Body');continue;}
    visit(index,binding.type,input.body,'body',[],warnings,false);
  }
  return{warnings:[...new Set(warnings)]};
}
