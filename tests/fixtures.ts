import type { DependencyDraft, Workflow } from '../shared/types';
import type { Index } from '../server/analyzer';
import { confirmDependency } from '../server/dependencies';

// Explicit user declarations for the example; no discovery matcher is used.
export function paymentDependencies(index:Index):DependencyDraft[]{
  return [
    ['User','Feign','GET','/users/{userId}','@GetMapping','UserResponse'],
    ['Inventory','RestTemplate','POST','/inventory/reserve','postForObject','InventoryResponse'],
    ['Risk','WebClient','POST','/risk/check','.uri','RiskResponse'],
    ['Bank','OkHttp','POST','/bank/charge','.url','BankResponse']
  ].map(([name,client,method,path,marker,responseType])=>{
    const file=[...index.sources.keys()].find(f=>f.endsWith('/'+name+'Client.java'))!;
    return{name:name+' API',client,method:method as DependencyDraft['method'],path,configKey:'services.'+name.toLowerCase()+'.url',originalBase:'',responseType,file,line:index.sources.get(file)!.split('\n').findIndex(l=>l.includes(marker))+1,note:'用户提供的示例依赖',callChain:[]};
  });
}
export function declaredPaymentFlow(index:Index,wf:Workflow){
  wf.dependencies=paymentDependencies(index).map(d=>confirmDependency(d,index,wf,'manual'));return wf;
}
