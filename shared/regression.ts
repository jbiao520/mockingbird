import type { FlowScenario, MockRule, Workflow } from './types';
import { ruleFingerprint } from './rule-edit';

export function scenarioRuleFingerprint(rule:MockRule){
  const {enabled:_enabled,version:_version,...definition}=rule;
  return ruleFingerprint(definition);
}
export function scenarioDependencyFingerprint(workflow:Workflow){
  return ruleFingerprint({entry:workflow.entry,dependencies:workflow.dependencies.map(({route:_route,...dep})=>dep)});
}
export function scenarioStaleReason(scenario:FlowScenario,workflow:Workflow,rules:MockRule[],revision:string){
  if(scenario.revision!==revision||workflow.revision!==revision)return '源码版本已变化，请核对后重新保存场景';
  if(scenario.dependencyFingerprint!==scenarioDependencyFingerprint(workflow))return 'Flow 依赖已变化，请重新保存场景';
  for(const selected of scenario.mocks){
    const rule=rules.find(r=>r.id===selected.ruleId&&r.dependencyId===selected.dependencyId);
    if(!rule)return '场景引用的 Mock 已删除，请重新选择';
    if(scenarioRuleFingerprint(rule)!==selected.fingerprint)return 'Mock 内容已变化，请核对后重新保存场景';
  }
  return '';
}
