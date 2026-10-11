import { z } from 'zod';
import type { Entry, EntryDraft, HttpMethod, JavaMethod, Task } from '../shared/types';
import { entryId, type Index } from './analyzer';

const methods=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'] as const;
export const entryDraftSchema=z.object({
  method:z.enum(methods),
  path:z.string().trim().min(1).max(2000),
  className:z.string().trim().min(1).max(200),
  name:z.string().trim().min(1).max(200),
  file:z.string().trim().min(1).max(2000),
  line:z.number().int().min(1),
  note:z.string().max(2000)
});
const claimsExecuted=(text:string)=>/(?:已经|已)(?:实际)?(?:运行|执行)|已验证业务|verified (?:at|by) runtime/i.test(text)&&!/未(?:经|实际)?(?:运行|执行)|没有(?:运行|执行)|不代表|不表示|并非/.test(text);

export function normalizeEntryPath(input:string){
  const path=input.trim();
  if(!path.startsWith('/')||path.startsWith('//')||path.startsWith('/__admin')||/[?#\s\\]/.test(path))throw new Error('请确认请求路径，以 / 开头，不包含查询串、空格或 fragment');
  return path.replace(/\/{2,}/g,'/').replace(/\/$/,'')||'/';
}

export function isManualEntry(value:unknown):value is Entry{
  if(!value||typeof value!=='object')return false;
  const entry=value as Entry;
  return typeof entry.id==='string'&&typeof entry.methodId==='string'&&typeof entry.path==='string'&&entry.path.startsWith('/')&&typeof entry.file==='string'&&typeof entry.className==='string'&&typeof entry.name==='string'&&Number.isInteger(entry.line)&&entry.line>0&&methods.includes(entry.method as HttpMethod);
}

// The indexed method line is the first annotation line. A candidate may point at
// the signature or a nearby annotation, so accept a declaration that covers the
// line, otherwise the closest same-name method within a short window.
export function resolveHandler(index:Index,draft:Pick<EntryDraft,'file'|'line'|'className'|'name'>){
  const file=draft.file.replaceAll('\\','/');
  const source=index.sources.get(file);
  if(!source||!file.endsWith('.java'))throw new Error('源码文件未在当前项目索引中：'+file);
  const lines=source.split('\n');
  if(draft.line>lines.length)throw new Error('源码行号超出文件范围：'+file);
  const at=lines.slice(0,draft.line-1).join('\n').length;
  const covers=(method:JavaMethod)=>method.line<=draft.line&&method.end>=at;
  const named=index.methods.filter(method=>method.file===file&&method.name===draft.name&&method.className===draft.className);
  const pool=named.length?named:index.methods.filter(method=>method.file===file&&method.name===draft.name);
  const ranked=[...pool].sort((a,b)=>Math.abs(a.line-draft.line)-Math.abs(b.line-draft.line)||a.line-b.line);
  const found=ranked.find(covers)||ranked.find(method=>Math.abs(method.line-draft.line)<=30);
  if(!found)throw new Error(`找不到处理方法 ${draft.className}.${draft.name}（${file}:${draft.line}）`);
  return found;
}

export function validateEntryDraft(input:unknown,index:Index):EntryDraft{
  const draft=entryDraftSchema.parse(input);
  const path=normalizeEntryPath(draft.path);
  const method=resolveHandler(index,{...draft,file:draft.file.replaceAll('\\','/')});
  return{method:draft.method,path,className:method.className,name:method.name,file:method.file,line:method.line,note:draft.note.trim()};
}

export function buildManualEntry(index:Index,draft:EntryDraft):Entry{
  const confirmed=validateEntryDraft(draft,index);
  const handler=index.methods.find(method=>method.file===confirmed.file&&method.name===confirmed.name&&method.className===confirmed.className&&method.line===confirmed.line);
  if(!handler)throw new Error(`找不到处理方法 ${confirmed.className}.${confirmed.name}`);
  return{id:entryId(handler.id,confirmed.path),method:confirmed.method,path:confirmed.path,className:handler.className,name:handler.name,file:handler.file,line:handler.line,methodId:handler.id};
}

function rematch(index:Index,entry:Entry){
  const exact=index.methods.find(method=>method.id===entry.methodId);
  if(exact)return exact;
  const same=index.methods.filter(method=>method.file===entry.file&&method.className===entry.className&&method.name===entry.name);
  if(same.length===1)return same[0];
  const closest=[...same].sort((a,b)=>Math.abs(a.line-entry.line)-Math.abs(b.line-entry.line))[0];
  if(closest&&Math.abs(closest.line-entry.line)<=80)return closest;
}

// Indexed discoveries win when the HTTP method and path already match. Manual
// entries keep their id so an open Flow still finds them after a line shift.
export function mergeManualEntries(index:Index,manual:Entry[]){
  const dropped:string[]=[];
  const kept:Entry[]=[];
  const taken=new Set(index.project.entries.map(entry=>`${entry.method} ${entry.path}`));
  for(const entry of manual){
    if(!isManualEntry(entry)){dropped.push('无效的手动入口已移除');continue;}
    const handler=rematch(index,entry);
    if(!handler){dropped.push(`${entry.method} ${entry.path} 的处理方法已不在索引中`);continue;}
    const key=`${entry.method} ${entry.path}`;
    if(taken.has(key)){dropped.push(`${key} 已由静态索引发现，手动入口已合并`);continue;}
    taken.add(key);
    kept.push({...entry,className:handler.className,name:handler.name,file:handler.file,line:handler.line,methodId:handler.id});
  }
  return{index:{...index,project:{...index.project,entries:[...index.project.entries,...kept]}},manual:kept,dropped};
}

export function acceptEntryDiscovery(task:Task,result:unknown,index:Index){
  if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Agent 未返回有效的入口发现结果');
  const row=result as {summary?:unknown;entries?:unknown};
  if(typeof row.summary!=='string'||!row.summary.trim()||!Array.isArray(row.entries))throw new Error('Agent 未返回有效的入口发现结果');
  if(claimsExecuted(row.summary))throw new Error('发现说明声称已经运行或验证业务行为');
  if(row.entries.length>100)throw new Error('入口候选超过 100 个，请缩小发现范围');
  const proposals:EntryDraft[]=[];
  const skipped:string[]=[];
  const seen=new Set(index.project.entries.map(entry=>`${entry.method} ${entry.path}`));
  for(const item of row.entries){
    try{
      const draft=validateEntryDraft(item,index);
      if(claimsExecuted(draft.note))throw new Error(draft.className+'.'+draft.name+' 的说明声称已经运行或验证');
      const key=`${draft.method} ${draft.path}`;
      if(seen.has(key)){skipped.push(key+' 已在入口列表中');continue;}
      seen.add(key);proposals.push(draft);
    }catch(error){skipped.push((error as Error).message);}
  }
  task.entryProposal=proposals;
  const extra=skipped.length?`。已忽略 ${skipped.length} 条无效或已存在的候选`:'';
  task.summary=row.summary.trim().replace(/[。\s]*$/,'')+extra+(row.summary.includes('未经运行')?'':'。静态阅读源码得出，未经运行或调用验证。');
}
