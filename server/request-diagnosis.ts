import { randomUUID } from 'node:crypto';
import type { DiagnosisAdoption, MockRule, UnmatchedDiagnosis } from '../shared/types';
import { actualRequest, applyUnmatched, diagnoseUnmatched } from '../shared/near-miss';
import { validateRules } from './rules';
import type { MockRuntime } from './runtime';

async function loggedRequest(runtime:MockRuntime,id:string){
  if(runtime.state.status!=='running')throw new Error('Mock Server 尚未运行');
  const entry=await runtime.journalEntry(id);
  return {request:actualRequest(entry.request||{}),states:await runtime.scenarioStates()};
}
export async function diagnoseLoggedRequest(runtime:MockRuntime,rules:MockRule[],id:string):Promise<UnmatchedDiagnosis>{
  const logged=await loggedRequest(runtime,id);
  return diagnoseUnmatched(logged.request,rules,logged.states);
}
export async function adoptLoggedRequest(runtime:MockRuntime,rules:MockRule[],input:{id?:string;candidateId?:string;clauseIds?:unknown}):Promise<DiagnosisAdoption>{
  const logged=await loggedRequest(runtime,String(input.id||''));
  const clauseIds=Array.isArray(input.clauseIds)?input.clauseIds.filter((item):item is string=>typeof item==='string'):[];
  const adopted=applyUnmatched(rules,logged.request,logged.states,String(input.candidateId||''),clauseIds,randomUUID());
  const [rule]=validateRules([adopted.rule]);
  return {...adopted,rule};
}
