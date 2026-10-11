import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { ConfigLayer, ConfigResolution, RunConfig } from '../shared/types';

export const emptyRunConfig=():RunConfig=>({profiles:'',env:'',jvm:'',module:'',args:''});

const stringField=(value:unknown,label:string,max:number)=>{
  if(value==null)return '';
  if(typeof value!=='string')throw new Error(label+'必须是文本');
  if(value.length>max)throw new Error(label+'超过 '+max+' 字符');
  return value;
};

export function tokenize(input:string){
  const tokens:string[]=[];let current='',quote='';
  for(let i=0;i<input.length;i++){
    const char=input[i];
    if(quote){
      if(char===quote)quote='';
      else if(char==='\\'&&quote==='"'&&i+1<input.length)current+=input[++i];
      else current+=char;
    }else if(char==='"'||char==="'")quote=char;
    else if(/\s/.test(char)){if(current){tokens.push(current);current='';}}
    else current+=char;
  }
  if(quote)throw new Error('运行参数的引号未闭合');
  if(current)tokens.push(current);
  return tokens;
}

export function parseEnv(text:string){
  const env:Record<string,string>={};
  for(const raw of text.split('\n')){
    const line=raw.trim();if(!line||line.startsWith('#'))continue;
    const body=line.startsWith('export ')?line.slice(7).trim():line;
    const eq=body.indexOf('=');
    if(eq<=0)throw new Error('环境变量格式应为 KEY=VALUE：'+line);
    const key=body.slice(0,eq).trim(),value=body.slice(eq+1);
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))throw new Error('环境变量名无效：'+key);
    env[key]=value;
  }
  return env;
}

export function normalizeRunConfig(input:unknown):RunConfig{
  const source=input&&typeof input==='object'?input as Record<string,unknown>:{};
  const profiles=stringField(source.profiles,'Spring profile',200);
  const env=stringField(source.env,'环境变量',8000);
  const jvm=stringField(source.jvm,'JVM 参数',4000);
  const moduleName=stringField(source.module,'应用模块',500);
  const args=stringField(source.args,'启动参数',4000);
  const names=profiles.split(',').map(item=>item.trim()).filter(Boolean);
  if(names.some(name=>!/^[\w.-]+$/.test(name)))throw new Error('Spring profile 只允许字母、数字、点、下划线和连字符');
  parseEnv(env);tokenize(jvm);tokenize(args);
  if(moduleName&&(moduleName.includes('..')||!/^[\w./-]+$/.test(moduleName)))throw new Error('应用模块路径无效');
  return{profiles:names.join(','),env,jvm,module:moduleName,args};
}

const envName=(key:string)=>key.replace(/[.-]/g,'_').toUpperCase();
function definedProperties(tokens:string[]){
  const map=new Map<string,string>();
  for(const token of tokens){
    if(!token.startsWith('-D'))continue;
    const body=token.slice(2),eq=body.indexOf('='),key=eq<0?body:body.slice(0,eq);
    if(!key||key.startsWith('spring-boot.run.'))continue;
    map.set(key,eq<0?'':body.slice(eq+1));
  }
  return map;
}
function optionProperties(tokens:string[]){
  const map=new Map<string,string>();
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i];if(!token.startsWith('--')||token==='--')continue;
    const body=token.slice(2),eq=body.indexOf('=');
    if(eq>=0)map.set(body.slice(0,eq),body.slice(eq+1));
    else if(i+1<tokens.length&&!tokens[i+1].startsWith('-'))map.set(body,tokens[++i]);
    else map.set(body,'true');
  }
  return map;
}
function fromProperties(map:Map<string,string>,key:string){
  if(map.has(key))return map.get(key);
  const relaxed=envName(key);
  return map.has(relaxed)?map.get(relaxed):undefined;
}
function fromEnv(env:NodeJS.ProcessEnv,key:string){
  if(env[envName(key)]!==undefined)return env[envName(key)];
  return env[key];
}

interface Doc { values:Record<string,string>;profiles?:string[];skipped?:string }
interface RawFile { relative:string;filenameProfile?:string;locationRank:number;docs:Doc[] }
interface Group { rank:number;kind:string;profile?:string;files:{relative:string;values:Record<string,string>}[] }

function flatten(value:unknown,prefix:string,out:Record<string,string>){
  if(Array.isArray(value)){
    if(value.every(item=>item==null||typeof item!=='object'))out[prefix]=value.map(item=>String(item)).join(',');
    else value.forEach((item,index)=>flatten(item,prefix?`${prefix}[${index}]`:String(index),out));
    return;
  }
  if(value&&typeof value==='object'){for(const[key,item]of Object.entries(value as Record<string,unknown>))flatten(item,prefix?`${prefix}.${key}`:key,out);return;}
  if(value!=null&&prefix)out[prefix]=String(value);
}
function documentProfiles(raw:unknown):string[]|undefined|null{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return undefined;
  const on=(raw as {spring?:{config?:{activate?:{'on-profile'?:unknown}}}}).spring?.config?.activate?.['on-profile'];
  if(on==null)return undefined;
  const text=Array.isArray(on)?on.join(','):String(on);
  if(/[!&()]/.test(text))return null;
  const names=text.split(/[|,]/).map(item=>item.trim()).filter(Boolean);
  if(!names.length||names.some(name=>!/^[\w.-]+$/.test(name)))return null;
  return names;
}
function parseDocuments(text:string,yaml:boolean):Doc[]{
  if(!yaml){
    const values:Record<string,string>={};
    for(const line of text.split('\n')){const match=/^\s*([^#!\s][^=:\s]*)\s*[=:]\s*(.*?)\s*$/.exec(line);if(match)values[match[1]]=match[2];}
    return[{values}];
  }
  let documents:YAML.Document[];
  try{documents=YAML.parseAllDocuments(text);}catch{return[{values:{},skipped:'YAML 解析失败'}];}
  if(documents.some(document=>document.errors.length))return[{values:{},skipped:'YAML 解析失败'}];
  return documents.map(document=>{
    const raw=document.toJSON() as unknown;
    if(!raw||typeof raw!=='object')return{values:{}};
    const profiles=documentProfiles(raw);
    if(profiles===null)return{values:{},skipped:'无法解析的 profile 表达式已跳过'};
    const values:Record<string,string>={};flatten(raw,'',values);return{values,profiles};
  });
}

async function readLocation(directory:string,root:string,locationRank:number){
  let names:string[]=[];
  try{names=await fs.readdir(directory);}catch{return[];}
  const files:RawFile[]=[];
  for(const name of names){
    const match=/^application(?:-([\w.-]+))?\.(properties|yml|yaml)$/.exec(name);if(!match)continue;
    const absolute=path.join(directory,name);
    try{
      const stat=await fs.stat(absolute);
      if(!stat.isFile()||stat.size>1024*1024)continue;
      files.push({relative:path.relative(root,absolute).split(path.sep).join('/'),filenameProfile:match[1],locationRank,docs:parseDocuments(await fs.readFile(absolute,'utf8'),match[2]!=='properties')});
    }catch{/* unreadable config is reported by the launcher output, not by skipping the whole resolution */}
  }
  return files;
}

function lastProfile(names:string[],active:string[]){
  return [...active].reverse().find(profile=>names.includes(profile));
}
function groupsFor(files:RawFile[],active:string[],warnings:string[]){
  const grouped=new Map<string,Group>();
  const ensure=(rank:number,kind:string,profile:string|undefined)=>{
    const id=rank+':'+(profile??'');
    return grouped.get(id)??grouped.set(id,{rank,kind,profile,files:[]}).get(id)!;
  };
  for(const file of files){
    const perProfile=new Map<string,{relative:string;values:Record<string,string> }>();
    const put=(profile:string|undefined,values:Record<string,string>)=>{
      const id=profile??'';
      const slot=perProfile.get(id)??{relative:file.relative,values:{}};
      Object.assign(slot.values,values);perProfile.set(id,slot);
    };
    for(const doc of file.docs){
      if(doc.skipped){warnings.push(`${file.relative} ${doc.skipped}`);continue;}
      if(file.filenameProfile){
        if(!active.includes(file.filenameProfile))continue;
        if(doc.profiles&&!lastProfile(doc.profiles,active))continue;
        put(doc.profiles?lastProfile(doc.profiles,active):file.filenameProfile,doc.values);
      }else if(!doc.profiles)put(undefined,doc.values);
      else{const profile=lastProfile(doc.profiles,active);if(profile)put(profile,doc.values);}
    }
    for(const[id,contribution]of perProfile){
      const profile=id||undefined;
      const slot=profile?active.indexOf(profile)+1:0;
      ensure(file.locationRank*100+slot,file.locationRank<2?'模块配置':'外部配置',profile).files.push(contribution);
    }
  }
  return [...grouped.values()].sort((a,b)=>a.rank-b.rank);
}

function collapse(group:Group){
  const seen=new Map<string,{value:string;file:string}>(),conflicts=new Map<string,string>();
  for(const file of group.files)for(const[key,value]of Object.entries(file.values)){
    const previous=seen.get(key);
    if(!previous)seen.set(key,{value,file:file.relative});
    else if(previous.value!==value)conflicts.set(key,`${previous.file}=${previous.value}；${file.relative}=${value}`);
  }
  const values=new Map<string,string>();
  for(const[key,item]of seen)if(!conflicts.has(key))values.set(key,item.value);
  const relatives=[...new Set(group.files.map(file=>file.relative))];
  const profile=group.profile?`（profile ${group.profile}）`:'';
  return{values,conflicts,label:`${group.kind} ${relatives.join('、')}${profile}`};
}

function resolvePlaceholders(raw:string,lookup:(key:string)=>string|undefined){
  let unresolved=false;const stack=new Set<string>();
  const walk=(text:string):string=>text.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g,(match,key:string,fallback?:string)=>{
    const name=key.trim();
    if(stack.has(name)){unresolved=true;return match;}
    stack.add(name);
    const found=lookup(name);
    const next=found!==undefined?found:fallback;
    const resolved=next===undefined?(unresolved=true,match):walk(next);
    stack.delete(name);return resolved;
  });
  let value=raw;
  for(let i=0;i<8&&value.includes('${');i++){const next=walk(value);if(next===value)break;value=next;}
  if(value.includes('${'))unresolved=true;
  return{value,unresolved};
}

export interface RuntimePlan {
  profiles:string[];profileSource:string;module:string;warnings:string[];
  programArgs:string[];jvmArguments?:string;env:NodeJS.ProcessEnv;
  extraEnv:{key:string;value:string}[];resolutions:ConfigResolution[];
}
export async function resolveRuntime(input:{
  root:string;moduleDir:string;moduleLabel:string;build:'Maven'|'Gradle';runConfig:RunConfig;
  env:NodeJS.ProcessEnv;routes:Record<string,string>;keys:string[];launchPort:number;configLocation:string;entryModule?:string;
}):Promise<RuntimePlan>{
  const runConfig=normalizeRunConfig(input.runConfig);
  const warnings:string[]=[];
  const moduleResources=path.join(input.moduleDir,'src/main/resources');
  const files=[
    ...await readLocation(moduleResources,input.root,0),
    ...await readLocation(path.join(moduleResources,'config'),input.root,1),
    ...await readLocation(input.root,input.root,2),
    ...await readLocation(path.join(input.root,'config'),input.root,3),
  ];
  const baseGroups=groupsFor(files.map(file=>({...file,docs:file.docs.filter(doc=>!file.filenameProfile&&!doc.profiles&&!doc.skipped)})),[],warnings);
  let profileValue:string|undefined,profileSource='未启用';
  for(const group of baseGroups){
    const collapsed=collapse(group);
    if(collapsed.conflicts.has('spring.profiles.active'))warnings.push('spring.profiles.active '+collapsed.conflicts.get('spring.profiles.active'));
    else if(collapsed.values.has('spring.profiles.active')){profileValue=collapsed.values.get('spring.profiles.active');profileSource=collapsed.label;}
  }
  const extra=parseEnv(runConfig.env);
  const env:NodeJS.ProcessEnv={...input.env,...extra};
  const envProfile=fromEnv(env,'spring.profiles.active');
  if(envProfile!==undefined){profileValue=envProfile;profileSource='环境变量 SPRING_PROFILES_ACTIVE';}
  const jvmTokens=tokenize(runConfig.jvm);
  const jvmProperties=definedProperties(jvmTokens);
  const userProperties=optionProperties(tokenize(runConfig.args));
  const gradle=input.build==='Gradle';
  const promoted=gradle?jvmProperties:new Map<string,string>();
  const systemProperties=gradle?new Map<string,string>():jvmProperties;
  const promotedProfile=fromProperties(promoted,'spring.profiles.active');
  if(promotedProfile!==undefined){profileValue=promotedProfile;profileSource='JVM 参数 -Dspring.profiles.active（Gradle 改为启动参数）';}
  const systemProfile=fromProperties(systemProperties,'spring.profiles.active');
  if(systemProfile!==undefined){profileValue=systemProfile;profileSource='JVM 参数 -Dspring.profiles.active';}
  const userProfile=fromProperties(userProperties,'spring.profiles.active');
  if(userProfile!==undefined){profileValue=userProfile;profileSource='启动参数 --spring.profiles.active';}
  else if(runConfig.profiles){profileValue=runConfig.profiles;profileSource='运行配置';}
  const profiles=(profileValue??'').split(',').map(item=>item.trim()).filter(Boolean);
  if(!profiles.length)profileSource='未启用';
  const groups=groupsFor(files,profiles,warnings).map(collapse);
  const fileMap=new Map<string,string>();
  const layers=new Map<string,Array<ConfigLayer&{skip?:boolean}>>();
  const known=new Set<string>([...input.keys,...Object.keys(input.routes)]);
  const remember=(key:string,layer:ConfigLayer&{skip?:boolean})=>{
    known.add(key);
    const list=layers.get(key)??[];list.push(layer);layers.set(key,list);
  };
  for(const group of groups){
    for(const[key,value]of group.values){fileMap.set(key,value);known.add(key);}
    for(const key of known){
      if(group.conflicts.has(key))remember(key,{label:'配置冲突 '+group.label,value:group.conflicts.get(key)!,wins:false,skip:true});
      else if(group.values.has(key))remember(key,{label:group.label,value:group.values.get(key)!,wins:false});
    }
  }
  const plain=new Map(fileMap),higher=new Map(fileMap);
  for(const[key,value]of Object.entries(input.routes)){higher.set(key,value);remember(key,{label:'.mockingbird/routes.properties',value,wins:false});}
  for(const key of [...systemProperties.keys(),...promoted.keys(),...userProperties.keys()])known.add(key);
  const overlay=(read:(key:string)=>string|undefined,label:(key:string)=>string)=>{
    for(const key of [...known]){
      const value=read(key);if(value===undefined)continue;
      plain.set(key,value);higher.set(key,value);remember(key,{label:label(key),value,wins:false});
    }
  };
  overlay(key=>fromEnv(env,key),key=>`环境变量 ${envName(key)}`);
  overlay(key=>fromProperties(systemProperties,key),key=>`JVM 参数 -D${key}`);
  overlay(key=>fromProperties(promoted,key),key=>`JVM 参数 -D${key}（Gradle 改为启动参数）`);
  const escalations=new Map<string,string>();
  for(const[key,value]of Object.entries(input.routes)){
    if(fromProperties(userProperties,key)!==undefined)continue;
    if(higher.get(key)!==value)escalations.set(key,value);
  }
  for(const[key,value]of escalations){higher.set(key,value);remember(key,{label:`Mock 启动参数 --${key}`,value,wins:false});}
  if(!userProfile&&runConfig.profiles){
    plain.set('spring.profiles.active',runConfig.profiles);higher.set('spring.profiles.active',runConfig.profiles);
    remember('spring.profiles.active',{label:'运行配置 --spring.profiles.active',value:runConfig.profiles,wins:false});
  }
  overlay(key=>fromProperties(userProperties,key),key=>`启动参数 --${key}`);
  const lookup=(map:Map<string,string>)=>(key:string)=>map.get(key)??fromEnv(env,key);
  const requested=input.keys.length?[...new Set(input.keys)]:[...Object.keys(input.routes)];
  const resolutions:ConfigResolution[]=requested.map(key=>{
    const list=(layers.get(key)??[]).map(({skip:_,...layer})=>layer);
    for(const layer of list)layer.wins=false;
    const winning=[...list].reverse().find(layer=>!layer.label.startsWith('配置冲突'));
    if(winning)winning.wins=true;
    const plainRaw=plain.get(key)??'',effectiveRaw=higher.get(key)??'';
    const plainResolved=resolvePlaceholders(plainRaw,lookup(plain));
    const effectiveResolved=resolvePlaceholders(effectiveRaw,lookup(higher));
    const mockValue=input.routes[key];
    const mockWins=mockValue!==undefined&&effectiveResolved.value===mockValue;
    const notes:string[]=[];
    if(mockValue!==undefined&&!mockWins)notes.push(`启动参数已指定 ${key}，高于 Mock 覆盖，运行时仍使用启动参数中的值。`);
    else if(escalations.has(key))notes.push(`环境变量或 JVM 参数高于 routes.properties，启动命令已追加 --${key}，Mock 会生效。`);
    if(plainResolved.unresolved||effectiveResolved.unresolved)notes.push('占位符未能完整解析。');
    const conflict=list.filter(layer=>layer.label.startsWith('配置冲突')).at(-1);
    if(!winning&&conflict)notes.push(conflict.value);
    return{key,layers:list,effective:effectiveResolved.value,plain:plainResolved.value,mockWins,note:notes.join('')||undefined};
  });
  const flags=jvmTokens.filter(token=>!token.startsWith('-D'));
  if(gradle&&flags.length)warnings.push('Gradle bootRun 不能从命令行带上这些 JVM 参数，本次未传入应用进程：'+flags.join(' '));
  if(input.entryModule&&input.entryModule!==input.moduleLabel)warnings.push('运行模块与当前 API 所在模块不同，配置按运行模块计算');
  const programArgs=[
    `--spring.config.additional-location=${input.configLocation}`,
    `--server.port=${input.launchPort}`,
    '--server.address=127.0.0.1',
    ...[...promoted].filter(([key])=>key!=='spring.profiles.active'||!runConfig.profiles||userProfile!==undefined).map(([key,value])=>value===''?`--${key}`:`--${key}=${value}`),
    ...(!userProfile&&runConfig.profiles?[`--spring.profiles.active=${runConfig.profiles}`]:[]),
    ...[...escalations].map(([key,value])=>`--${key}=${value}`),
    ...tokenize(runConfig.args),
  ];
  return{
    profiles,profileSource,module:input.moduleLabel,warnings,programArgs,
    jvmArguments:!gradle&&runConfig.jvm.trim()?runConfig.jvm.trim():undefined,
    env,extraEnv:Object.entries(extra).map(([key,value])=>({key,value})),resolutions,
  };
}

export async function readRoutes(file:string){
  try{
    const routes:Record<string,string>={};
    for(const line of (await fs.readFile(file,'utf8')).split('\n')){const match=/^\s*([^#!\s][^=:\s]*)\s*[=:]\s*(.*?)\s*$/.exec(line);if(match)routes[match[1]]=match[2];}
    return routes;
  }catch{return{};}
}
