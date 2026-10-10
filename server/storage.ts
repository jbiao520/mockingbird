import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workspace } from '../shared/types';
import { validateRules } from './rules';
export const emptyWorkspace=():Workspace=>({project:null,workflows:[],rules:[],snapshots:[],messages:[],selectedAgent:'local'});
export async function atomicWrite(file:string,value:unknown){
  await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(tmp,typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}
}
export async function loadWorkspace(root:string){
  try{const content=JSON.parse(await fs.readFile(path.join(root,'.mockingbird/workspace.json'),'utf8'));validateRules(content.rules);for(const s of content.snapshots||[])validateRules(s.rules);return{...emptyWorkspace(),...content} as Workspace;}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return emptyWorkspace();throw new Error('工作区配置无法读取，已有文件已保留：'+(e as Error).message);}
}
export async function saveWorkspace(ws:Workspace){if(ws.project)await atomicWrite(path.join(ws.project.path,'.mockingbird/workspace.json'),ws);}
