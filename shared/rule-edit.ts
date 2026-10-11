import type { MockRule, Task } from './types';
export function ruleFingerprint(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(ruleFingerprint).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+ruleFingerprint(v)).join(',')+'}';
  return JSON.stringify(value)??'undefined';
}
export function reviewRuleEdit(rules:MockRule[],task:Task):MockRule[] {
  const original=task.ruleEdit?.rule,candidate=task.proposal?.[0];
  if(!original||!candidate||task.status!=='completed'||task.approved||task.proposal?.length!==1||candidate.id!==original.id)throw new Error('没有可审核的规则修改');
  const current=rules.find(rule=>rule.id===original.id);
  if(ruleFingerprint(current)!==ruleFingerprint(original)&&ruleFingerprint(current)!==ruleFingerprint(candidate))throw new Error('当前草稿已变化，请重新请求 AI 修改，避免覆盖你的修改');
  return rules.map(rule=>rule.id===original.id?candidate:rule);
}
