import type { Entry, Workspace } from '../shared/types';
import { projectRuntimePlan } from './launch';

// Request templates, validation and regression use the same configuration layers as Java.
export async function resolveEntryContextPath(workspace:Workspace,entry:Entry,routes?:Record<string,string>){
  const plan=await projectRuntimePlan(workspace,18080,undefined,routes,['server.servlet.context-path'],entry);
  const resolution=plan.resolutions[0];
  if(resolution.layers.some(layer=>layer.label.startsWith('配置冲突'))&&!resolution.layers.some(layer=>layer.wins))
    throw new Error('server.servlet.context-path 配置冲突，请核对运行模块配置');
  return resolution.effective;
}
