import type { AgentModel } from './types';
export const isFastModel=(model:Pick<AgentModel,'id'|'name'>)=>/fast/i.test(model.id)||/fast/i.test(model.name);
export const modelDisabled=(model:AgentModel)=>!!model.disabled||isFastModel(model);
export function effectiveModel(models:AgentModel[],id:string){
  const chosen=id?models.find(m=>m.id===id):undefined;
  return chosen||models.find(m=>m.isDefault&&!modelDisabled(m))||models.find(m=>!modelDisabled(m));
}
export function resolveAgentOptions(models:AgentModel[],model?:string,effort?:string){
  if(model&&isFastModel({id:model,name:model}))throw new Error('Fast 模型已禁用，请选择其他模型');
  const selected=effectiveModel(models,model&&models.some(item=>item.id===model)?model:'');
  if(!selected)throw new Error('没有可用模型，请刷新模型列表并重新选择');
  if(modelDisabled(selected))throw new Error('Fast 模型已禁用，请选择其他模型');
  if(effort&&!selected.efforts?.includes(effort))throw new Error('所选模型不支持 Effort：'+effort);
  return{model:selected.id,effort:effort||selected.defaultEffort};
}
