import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workspace } from '../shared/types';
import { validateRules } from './rules';
import { isManualEntry } from './entries';
import { emptyRunConfig, normalizeRunConfig } from './runtime-config';
export const emptyWorkspace=():Workspace=>({project:null,workflows:[],rules:[],messages:[],selectedAgent:'local',flowScenarios:[],runConfig:emptyRunConfig(),manualEntries:[]});
export async function atomicWrite(file:string,value:unknown){
  await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(tmp,typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}
}
export async function loadWorkspace(root:string){
  try{
    const saved=JSON.parse(await fs.readFile(path.join(root,'.mockingbird/workspace.json'),'utf8'));
    const defaults=emptyWorkspace();
    // Only load supported fields; retired workspace data is discarded on the next save.
    const ws=Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,saved[key]??value])) as unknown as Workspace;
    ws.activeWorkflowId=saved.activeWorkflowId;
    try{ws.runConfig=normalizeRunConfig(saved.runConfig??{});}catch{ws.runConfig=emptyRunConfig();}
    ws.manualEntries=Array.isArray(saved.manualEntries)?saved.manualEntries.filter(isManualEntry).slice(0,200):[];
    const dependencies=ws.workflows.flatMap(w=>w.dependencies);
    ws.rules=validateRules(ws.rules,dependencies);
    return ws;
  }
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return emptyWorkspace();throw new Error('工作区配置无法读取，已有文件已保留：'+(e as Error).message);}
}
export async function saveWorkspace(ws:Workspace){if(ws.project)await atomicWrite(path.join(ws.project.path,'.mockingbird/workspace.json'),ws);}
