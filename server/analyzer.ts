import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'java-parser';
import YAML from 'yaml';
import type { Project, JavaMethod, FileNode, Entry, Workflow, HttpMethod } from '../shared/types';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,16);
const lineAt=(s:string,n:number)=>s.slice(0,n).split('\n').length;
const ignored=new Set(['.git','.idea','.gradle','target','build','node_modules','.mockingbird','.settings','dist']);
export async function exists(p:string){try{await fs.access(p);return true;}catch{return false;}}
function mask(s:string,literals=false){return s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,m=>m.startsWith('/')||literals?m.replace(/[^\n]/g,' '):m);}
function closeAt(s:string,start:number,left='{',right='}') {const clean=mask(s,true);let depth=0;for(let i=start;i<clean.length;i++){if(clean[i]===left)depth++;if(clean[i]===right&&--depth===0)return i;}return s.length-1;}
function depthAt(s:string,start:number,end:number){let d=0;for(let i=start;i<end;i++){if(s[i]==='{')d++;if(s[i]==='}')d--;}return d;}
function mapping(s:string):{method:HttpMethod;path:string}|undefined{const m=/@(Get|Post|Put|Patch|Delete|Head|Options|Request)Mapping\s*(?:\(([\s\S]*?)\))?/.exec(s);if(!m)return;return{method:(m[1]==='Request'?/RequestMethod\.(\w+)/.exec(m[2]||'')?.[1]||'GET':m[1].toUpperCase()) as HttpMethod,path:/"([^"\n]*)"/.exec(m[2]||'')?.[1]||''};}
const joinPath=(...s:string[])=>('/'+s.filter(Boolean).join('/')).replace(/\/{2,}/g,'/').replace(/\/$/,'')||'/';
export interface ProjectConfig {file:string;module:string;properties:Record<string,string>}
export interface Index {project:Project;methods:JavaMethod[];sources:Map<string,string>;properties:Record<string,string>;configFiles?:ProjectConfig[];classHeaders:Map<string,string>;contracts:Record<string,unknown>}
export function sourceModule(index:{project:Pick<Project,'modules'>},file:string){
  return index.project.modules.filter(m=>m!=='.'&&(file===m||file.startsWith(m+'/'))).sort((a,b)=>b.length-a.length)[0]||'.';
}
// Resolve runtime properties from the entry application's module, including when
// the HTTP client lives in a shared library. Sibling and parent POM resources
// are not automatically part of that application's Spring configuration.
export function propertyForSource(index:Index,key:string,file:string):string|undefined{
  if(!index.configFiles)return index.properties[key];
  const module=sourceModule(index,file),matches=index.configFiles.filter(c=>c.module===module&&Object.hasOwn(c.properties,key));
  const values=new Set(matches.map(c=>c.properties[key]));
  if(values.size>1)throw new Error(`配置项 ${key} 在模块 ${module} 中存在冲突，请核对：${matches.map(c=>c.file).join('、')}`);
  return matches[0]?.properties[key];
}
export async function indexProject(input:string,progress?:(message:string)=>void):Promise<Index>{
  const root=await fs.realpath(path.resolve(input));if(!(await fs.stat(root)).isDirectory())throw new Error('请选择 Java 项目目录');
  const build:Project['build']=await exists(path.join(root,'pom.xml'))?'Maven':'Gradle';
  if(build==='Gradle'&&!await exists(path.join(root,'build.gradle'))&&!await exists(path.join(root,'build.gradle.kts')))throw new Error('未发现 pom.xml 或 build.gradle(.kts)，请选择项目根目录');
  const sources=new Map<string,string>(),properties:Record<string,string>={},warnings:string[]=[],methods:JavaMethod[]=[],entries:Entry[]=[],classHeaders=new Map<string,string>(),modules:string[]=[];
  const configFiles:ProjectConfig[]=[];
  let fileCount=0;
  async function walk(dir:string):Promise<FileNode[]>{
    const nodes:FileNode[]=[];const items=(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name));
    for(const item of items){
      if(ignored.has(item.name)||item.name.startsWith('.')||item.isSymbolicLink())continue;
      if(++fileCount>20000)throw new Error('文件数超过 20,000，请选择更小的模块目录');
      if(fileCount%50===0)progress?.(`扫描文件 · ${fileCount}`);
      const absolute=path.join(dir,item.name),relative=path.relative(root,absolute).split(path.sep).join('/');
      if(item.isDirectory()){nodes.push({name:item.name,path:relative,directory:true,children:await walk(absolute)});continue;}
      nodes.push({name:item.name,path:relative,directory:false});
      if(item.name==='pom.xml'||/^build\.gradle/.test(item.name))if(dir!==root)modules.push(path.relative(root,dir));
      if(item.name.endsWith('.java')&&!/(^|\/)test\//.test(relative)){if((await fs.stat(absolute)).size>1024*1024){warnings.push(relative+' 超过 1MB，已跳过');continue;}sources.set(relative,await fs.readFile(absolute,'utf8'));}
      if(/^application\.(properties|ya?ml)$/.test(item.name)&&!/(^|\/)test\//.test(relative)){
        const content=await fs.readFile(absolute,'utf8');
        const values:Record<string,string>={};
        if(item.name.endsWith('.properties'))for(const l of content.split('\n')){const p=/^\s*([^#!\s][^=:\s]*)\s*[=:]\s*(.*?)\s*$/.exec(l);if(p)values[p[1]]=p[2];}
        else try{const flatten=(v:unknown,prefix='')=>{if(v&&typeof v==='object')for(const[k,val]of Object.entries(v))flatten(val,prefix?prefix+'.'+k:k);else if(v!=null)values[prefix]=String(v);};flatten(YAML.parse(content));}catch{warnings.push(relative+' YAML 解析失败');}
        configFiles.push({file:relative,module:'.',properties:values});
      }
    }return nodes;
  }
  const files=await walk(root);if(!sources.size)throw new Error('未找到 Java 源文件');
  const moduleProject={modules:modules.map(m=>m.split(path.sep).join('/'))};
  for(const config of configFiles)config.module=sourceModule({project:moduleProject},config.file);
  const propertyValues=new Map<string,Set<string>>();
  for(const config of configFiles)for(const[key,value]of Object.entries(config.properties)){
    const values=propertyValues.get(key)||new Set<string>();values.add(value);propertyValues.set(key,values);
  }
  for(const[key,values]of propertyValues){
    if(values.size===1)properties[key]=[...values][0];
    else warnings.push(`配置项 ${key} 存在多个值，将按入口模块解析；同一模块内的冲突需人工确认`);
  }
  let parsedCount=0;
  for(const[file,source]of sources){
    progress?.(`解析 Java · ${++parsedCount}/${sources.size}`);
    try{parse(source);}catch{warnings.push(file+' 语法解析失败，仅保留有限静态检索结果，请核对');}
    const clean=mask(source),balance=mask(source,true),cls=/\b(class|interface|record)\s+(\w+)/.exec(clean);if(!cls)continue;
    const className=cls[2],classOpen=clean.indexOf('{',cls.index),header=source.slice(0,classOpen);classHeaders.set(className,header);
    const fields:Record<string,string>={};for(const f of clean.matchAll(/\b(?:private|protected|public)\s+(?:static\s+)?(?:final\s+)?([\w.]+)(?:<[^;=]+?>)?\s+(\w+)\s*(?:[;=])/g))if(depthAt(balance,classOpen,f.index!)===1)fields[f[2]]=f[1].split('.').pop()!;
    const rx=/((?:@[\w.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*)*)(?:(?:public|private|protected|static|final|default|synchronized|abstract)\s+)*([\w.]+(?:\s*<[^{};=]+>)?(?:\[\])?)\s+(\w+)\s*\(([^{};]*?)\)\s*(?:throws\s+[\w.,\s]+)?([\{;])/g;
    for(const m of clean.matchAll(rx)){
      if(depthAt(balance,classOpen,m.index!)!==1||['if','for','while','switch','catch','new','return'].includes(m[3])||m[2]==='new'||m[3]===className)continue;
      const open=m.index!+m[0].length-1,end=m[5]==='{'?closeAt(source,open):open,id=`${className}.${m[3]}@${file}:${lineAt(source,m.index!)}`;
      methods.push({id,className,name:m[3],returnType:m[2].trim(),parameters:m[4],body:m[5]==='{'?source.slice(open+1,end):'',file,line:lineAt(source,m.index!),annotations:m[1],fields,start:open+1,end});
      if(/@(RestController|Controller)\b/.test(header)){const route=mapping(m[1]);if(route)entries.push({id:hash(id+route.path),method:route.method,path:joinPath(mapping(header)?.path||'',route.path),className,name:m[3],file,line:lineAt(source,m.index!),methodId:id});}
    }
  }
  if(!entries.length)warnings.push('未识别到 Spring MVC 入口。首版支持直接注解的 Controller，继承和组合注解需人工确认。');
  const buildSource=await fs.readFile(path.join(root,build==='Maven'?'pom.xml':await exists(path.join(root,'build.gradle'))?'build.gradle':'build.gradle.kts'),'utf8');
  const javaVersion=/<java.version>(.*?)<|<maven.compiler.(?:source|release)>(.*?)<|JavaLanguageVersion.of\((\d+)\)|VERSION_(\d+)/.exec(buildSource)?.slice(1).find(Boolean)||'未声明';
  let contracts:Record<string,unknown>={};try{contracts=JSON.parse(await fs.readFile(path.join(root,'src/main/resources/mockingbird-contracts.json'),'utf8'));}catch{/* optional samples */}
  const revision=hash([...sources].map(([f,s])=>f+s).join('')+JSON.stringify(configFiles));
  return{project:{id:hash(root),name:path.basename(root),path:root,build,javaVersion,modules:moduleProject.modules.length?moduleProject.modules:['.'],files,entries,indexedAt:new Date().toISOString(),revision,warnings,fileCount},methods,sources,properties,configFiles,classHeaders,contracts};
}
// Opening an API creates an entry-only workflow. Dependencies are supplied by users or AI.
export function analyze(index:Index,entryId:string):Workflow{
  const entry=index.project.entries.find(e=>e.id===entryId);
  if(!entry)throw new Error('API 入口不存在，请重新索引');
  const first=index.methods.find(m=>m.id===entry.methodId);
  if(!first)throw new Error('找不到入口方法');
  return{id:hash(entry.id+index.project.revision),entry,methods:[{id:first.id,className:first.className,name:first.name,file:first.file,line:first.line}],edges:[],dependencies:[],revision:index.project.revision,analyzedAt:new Date().toISOString(),warnings:[]};
}
export async function readSource(index:Index,relative:string){const candidate=await fs.realpath(path.resolve(index.project.path,relative));if(!candidate.startsWith(index.project.path+path.sep))throw new Error('文件不在项目范围内');if(!/\.(java|xml|properties|ya?ml|json|gradle|kts|md|txt)$/.test(candidate))throw new Error('仅支持源码和配置文本');if((await fs.stat(candidate)).size>1024*1024)throw new Error('文件超过 1MB');return fs.readFile(candidate,'utf8');}
