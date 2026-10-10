import type { MockRule } from './types';
import { mockRequestPath } from './mock-routing';

function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
  return JSON.stringify(value)??'undefined';
}
export function overlaps(a:MockRule,b:MockRule){
  if((a.priority??5)!==(b.priority??5))return false;
  if(a.method!==b.method)return false;
  const left=mockRequestPath(a).split('/'),right=mockRequestPath(b).split('/');if(left.length!==right.length)return false;
  if(!left.every((segment,i)=>segment===right[i]||/\{[^}]+\}/.test(segment)||/\{[^}]+\}/.test(right[i])))return false;
  const disjoint=(x:Record<string,string>,y:Record<string,string>)=>Object.keys(x).some(key=>key in y&&x[key]!==y[key]);
  const headers=(input:Record<string,string>)=>Object.fromEntries(Object.entries(input).map(([key,value])=>[key.toLowerCase(),value]));
  if(disjoint(a.query,b.query)||disjoint(headers(a.requestHeaders),headers(b.requestHeaders)))return false;
  if(a.bodyMatchMode==='partial'||b.bodyMatchMode==='partial'||a.behavior?.matchers.length||b.behavior?.matchers.length)return true;
  return a.requestBody===undefined||b.requestBody===undefined||canonical(a.requestBody)===canonical(b.requestBody);
}
export function ruleGroups(rules:MockRule[]){
  const groups:{scenario:string;rules:MockRule[]}[]=[];
  for(const rule of rules){
    const group=groups.find(item=>item.scenario===rule.scenario);
    if(group)group.rules.push(rule);else groups.push({scenario:rule.scenario,rules:[rule]});
  }
  return groups;
}
export function blockedInGroup(rules:MockRule[]){
  const kept:MockRule[]=[];
  return rules.filter(rule=>{
    if(!kept.some(previous=>overlaps(previous,rule))){kept.push(rule);return false;}
    return true;
  });
}
export function setScenarioEnabled(rules:MockRule[],scenario:string,enabled:boolean){
  if(!rules.some(rule=>rule.scenario===scenario))return{rules,disabledScenarios:[] as string[],skipped:[] as string[]};
  if(!enabled)return{rules:rules.map(rule=>rule.scenario===scenario?{...rule,enabled:false}:rule),disabledScenarios:[],skipped:[]};
  const active:MockRule[]=[],skipped:string[]=[];
  const members=rules.filter(rule=>rule.scenario===scenario).map(rule=>{
    const next={...rule,enabled:!active.some(previous=>overlaps(previous,rule))};
    if(next.enabled)active.push(next);else skipped.push(rule.name);
    return next;
  });
  const memberById=new Map(members.map(rule=>[rule.id,rule]));
  const disabled=new Set<string>();
  const next=rules.map(rule=>{
    if(rule.scenario===scenario)return memberById.get(rule.id)!;
    if(rule.enabled&&active.some(member=>overlaps(member,rule))){disabled.add(rule.scenario);return{...rule,enabled:false};}
    return rule;
  });
  return{rules:next,disabledScenarios:[...disabled],skipped};
}
export function toggleScenario(rules:MockRule[],scenario:string,enabled:boolean){
  const next=setScenarioEnabled(rules,scenario,enabled);
  if(!enabled||JSON.stringify(next.rules)!==JSON.stringify(rules))return next.rules;
  return setScenarioEnabled(rules,scenario,false).rules;
}
