import type { Index } from './analyzer';
// Heuristic Jackson-oriented reading of records, ordinary classes, enums, lists and naming aliases.
// It is not a Java type checker: unresolved generics, Map and JsonNode stay explicitly unverified.
type Simple = 'string'|'number'|'boolean';
type Shape = {kind:'primitive';simple:Simple;integral:boolean}|{kind:'enum';values:string[]}|{kind:'object';typeName:string;fields:{jsonName:string;type:string}[]}|{kind:'array';item:string}|{kind:'unknown';label:string};
const primitives:Record<string,{simple:Simple;integral:boolean}>={
  String:{simple:'string',integral:false},CharSequence:{simple:'string',integral:false},UUID:{simple:'string',integral:false},
  boolean:{simple:'boolean',integral:false},Boolean:{simple:'boolean',integral:false},
  int:{simple:'number',integral:true},long:{simple:'number',integral:true},short:{simple:'number',integral:true},byte:{simple:'number',integral:true},
  Integer:{simple:'number',integral:true},Long:{simple:'number',integral:true},Short:{simple:'number',integral:true},Byte:{simple:'number',integral:true},
  double:{simple:'number',integral:false},float:{simple:'number',integral:false},Double:{simple:'number',integral:false},Float:{simple:'number',integral:false},
  BigDecimal:{simple:'number',integral:false},BigInteger:{simple:'number',integral:true}
};
const collections=new Set(['List','Set','Collection','Iterable','ArrayList','LinkedList','HashSet']);
const unknownNames=new Set(['Map','HashMap','LinkedHashMap','TreeMap','JsonNode','ObjectNode','ArrayNode','JsonElement','Object','Serializable']);
function braceEnd(source:string,open:number){let depth=0;for(let i=open;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)return i;}return source.length-1;}
function parenEnd(source:string,open:number){let depth=0;for(let i=open;i<source.length;i++){if(source[i]==='(')depth++;else if(source[i]===')'&&--depth===0)return i;}return -1;}
function splitCommas(input:string){const parts:string[]=[];let depth=0,start=0;for(let i=0;i<input.length;i++){const c=input[i];if(c==='<'||c==='('||c==='[')depth++;else if(c==='>'||c===')'||c===']')depth=Math.max(0,depth-1);else if(c===','&&depth===0){parts.push(input.slice(start,i).trim());start=i+1;}}const last=input.slice(start).trim();if(last)parts.push(last);return parts;}
function annotationsNear(source:string,index:number){return source.slice(Math.max(0,index-500),index).split(/[;{}]/).pop()||'';}
function namingOf(notes:string):'snake'|'kebab'|'pascal'|'identity'{if(/SnakeCaseStrategy/.test(notes))return 'snake';if(/KebabCaseStrategy/.test(notes))return 'kebab';if(/UpperCamelCaseStrategy|PascalCaseStrategy/.test(notes))return 'pascal';return 'identity';}
function applyNaming(name:string,naming:'snake'|'kebab'|'pascal'|'identity'){if(naming==='snake')return name.replace(/[A-Z]/g,m=>'_'+m.toLowerCase()).replace(/^_/,'');if(naming==='kebab')return name.replace(/[A-Z]/g,m=>'-'+m.toLowerCase()).replace(/^-/,'');if(naming==='pascal')return name.charAt(0).toUpperCase()+name.slice(1);return name;}
function jsonName(fragment:string,javaName:string,naming:'snake'|'kebab'|'pascal'|'identity'){const explicit=/@JsonProperty\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/.exec(fragment);return explicit?.[1]||applyNaming(javaName,naming);}
function parseMember(fragment:string,naming:'snake'|'kebab'|'pascal'|'identity'){if(/@JsonIgnore\b/.test(fragment))return;const cleaned=fragment.replace(/@[\w.]+\s*(?:\((?:[^()"]|"(?:\\.|[^"\\])*")*\))?/g,'').replace(/\s+/g,' ').trim();const match=/^(?:(?:public|protected|private|final|transient|volatile)\s+)*([\w.$]+(?:\s*<.+>)?(?:\s*\[\])*)\s+(\w+)$/.exec(cleaned);if(!match||['class','record','enum','if','return','new'].includes(match[2]))return;return{type:match[1].replace(/\s+/g,''),jsonName:jsonName(fragment,match[2],naming)};}
function declaration(index:Index,simple:string){const re=new RegExp('\\b(record|class|enum)\\s+'+simple+'\\b');for(const source of index.sources.values()){const found=re.exec(source);if(!found)continue;const notes=annotationsNear(source,found.index);if(found[1]==='record'){const open=source.indexOf('(',found.index);const close=open<0?-1:parenEnd(source,open);if(close<0)continue;return{kind:'record' as const,notes,body:source.slice(open+1,close)};}const open=source.indexOf('{',found.index);if(open<0)continue;return{kind:found[1] as 'class'|'enum',notes,body:source.slice(open+1,braceEnd(source,open))};}}
function classFields(body:string,naming:'snake'|'kebab'|'pascal'|'identity'){const fields:{jsonName:string;type:string}[]=[];const re=/((?:@[^\n;{}]*\s*)*)(?:public|protected|private)\s+(?:final\s+)?(?!static\b)([\w.$]+(?:\s*<[^;=]+>)?(?:\s*\[\])*)\s+(\w+)\s*(?:=[^;]*)?;/g;let match:RegExpExecArray|null;while((match=re.exec(body))){const member=parseMember(`${match[1]} ${match[2]} ${match[3]}`,naming);if(member)fields.push(member);}return fields;}
function enumValues(body:string){const head=body.split(';')[0];return [...head.matchAll(/(?:^|[{\s,])([A-Za-z_][A-Za-z0-9_]*)\s*(?=[(,}]|$)/g)].map(m=>m[1]);}
function shapeOf(index:Index,typeName:string,stack:string[]):Shape{
  const type=typeName.trim().replace(/\s+/g,' ');
  if(type.endsWith('[]'))return{kind:'array',item:type.slice(0,-2).trim()};
  const generic=/^([\w.$]+)\s*<([\s\S]+)>$/.exec(type);if(generic){const raw=generic[1].split('.').pop()!,args=splitCommas(generic[2]);if(raw==='Optional')return shapeOf(index,args[0]||'Object',stack);if(collections.has(raw))return{kind:'array',item:(args[0]||'Object').replace(/^\?(?:\s+extends|\s+super)?\s*/,'')||'Object'};if(unknownNames.has(raw))return{kind:'unknown',label:type};}
  const simple=type.replace(/\[\]$/,'').split('.').pop()!;
  const primitive=primitives[simple];if(primitive)return{kind:'primitive',...primitive};
  if(unknownNames.has(simple))return{kind:'unknown',label:type};
  if(stack.includes(simple))return{kind:'unknown',label:type+' 循环引用'};
  const declared=declaration(index,simple);if(!declared)return{kind:'unknown',label:type};
  const naming=namingOf(declared.notes);
  if(declared.kind==='enum'){const values=enumValues(declared.body);return values.length?{kind:'enum',values}:{kind:'unknown',label:type};}
  if(declared.kind==='record'){const fields=splitCommas(declared.body).map(part=>parseMember(part,naming)).filter((f):f is {type:string;jsonName:string}=>!!f);return fields.length?{kind:'object',typeName:simple,fields}:{kind:'unknown',label:type};}
  const fields=classFields(declared.body,naming);return fields.length?{kind:'object',typeName:simple,fields}:{kind:'unknown',label:type+' 未解析到字段'};
}
export function validateResponseShape(body:unknown,typeName:string,index:Index){const unresolved:string[]=[];const visit=(value:unknown,type:string,path:string,stack:string[])=>{
  const shape=shapeOf(index,type,stack);
  if(shape.kind==='unknown'){unresolved.push(`${path} 类型 ${shape.label} 未能解析，结构未校验`);return;}
  if(shape.kind==='primitive'){if(typeof value!==shape.simple||(shape.simple==='number'&&(typeof value!=='number'||!Number.isFinite(value)||(shape.integral&&!Number.isInteger(value)))))throw new Error(`${path} 应为 ${shape.simple==='number'&&shape.integral?'整数':shape.simple==='number'?'数字':shape.simple==='boolean'?'boolean':'字符串'}`);return;}
  if(shape.kind==='enum'){if(typeof value!=='string'||!shape.values.includes(value))throw new Error(`${path} 应为枚举值 ${shape.values.join('、')}`);return;}
  if(shape.kind==='array'){if(!Array.isArray(value))throw new Error(`${path} 应为 JSON 数组`);value.forEach((item,i)=>visit(item,shape.item,`${path}[${i}]`,stack));return;}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${path} 应为 JSON 对象`);
  const record=value as Record<string,unknown>;
  for(const field of shape.fields){if(!(field.jsonName in record))throw new Error(`缺少字段 ${field.jsonName}`);visit(record[field.jsonName],field.type,path==='$'?field.jsonName:`${path}.${field.jsonName}`,[...stack,shape.typeName]);}
};visit(body,typeName,'$',[]);return{unresolved};}
