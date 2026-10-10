import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { MockRule } from '../shared/types';
import { ruleGroups, setScenarioEnabled, toggleScenario } from '../shared/rule-groups';
import { validateRules } from '../server/rules';

const rule=(patch:Partial<MockRule>):MockRule=>({id:randomUUID(),dependencyId:'user',name:'User',scenario:'Success',method:'GET',path:'/users/{id}',status:200,headers:{'Content-Type':'application/json'},body:{ok:true},delay:0,enabled:true,query:{},requestHeaders:{},basis:'Sample',version:1,...patch});

test('rules group by scenario in first-seen order',()=>{
  const groups=ruleGroups([rule({scenario:'Error',name:'E'}),rule({name:'A'}),rule({scenario:'Error',name:'E2'}),rule({scenario:'库存不足',name:'C'})]);
  assert.deepEqual(groups.map(group=>group.scenario),['Error','Success','库存不足']);
  assert.deepEqual(groups[0].rules.map(item=>item.name),['E','E2']);
});

test('enabling a scenario turns that group on and closes overlapping rules elsewhere',()=>{
  const success=rule({name:'User success',enabled:false,query:{status:'ok'}});
  const error=rule({name:'User error',scenario:'Error',status:503,enabled:true});
  const inventory=rule({name:'Inventory error',scenario:'Error',dependencyId:'inventory',method:'POST',path:'/inventory',status:503,enabled:true});
  const distinct=rule({name:'User flagged',scenario:'Flagged',enabled:true,query:{status:'flagged'}});
  const result=setScenarioEnabled([success,error,inventory,distinct],'Success',true);
  assert.equal(result.rules.find(item=>item.name==='User success')!.enabled,true);
  assert.equal(result.rules.find(item=>item.name==='User error')!.enabled,false);
  assert.equal(result.rules.find(item=>item.name==='Inventory error')!.enabled,true);
  assert.equal(result.rules.find(item=>item.name==='User flagged')!.enabled,true);
  assert.deepEqual(result.disabledScenarios,['Error']);
  assert.equal(validateRules(result.rules).length,4);
});

test('disabling a scenario leaves other groups untouched',()=>{
  const success=rule({name:'User success'});
  const error=rule({name:'User error',scenario:'Error',enabled:false,status:503});
  const result=setScenarioEnabled([success,error],'Success',false);
  assert.equal(result.rules[0].enabled,false);
  assert.equal(result.rules[1].enabled,false);
  assert.equal(result.disabledScenarios.length,0);
});

test('a scenario keeps every rule that does not overlap, and only the earlier overlapping rule',()=>{
  const first=rule({name:'Primary',query:{status:'ok'}});
  const second=rule({name:'Duplicate',enabled:false,query:{status:'ok'}});
  const matched=rule({name:'By status',enabled:false,query:{status:'flagged'}});
  const result=setScenarioEnabled([first,second,matched],'Success',true);
  assert.deepEqual(result.rules.map(item=>item.enabled),[true,false,true]);
  assert.deepEqual(result.skipped,['Duplicate']);
  assert.equal(validateRules(result.rules).length,3);
  const again=toggleScenario(result.rules,'Success',true);
  assert.equal(again.every(item=>item.enabled),false);
});
