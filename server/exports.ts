import { STATUS_CODES } from 'node:http';
import type { Dependency } from '../shared/types';
import { ruleMappings, validateRules } from './rules';
import { mockRequestPath } from '../shared/mock-routing';
import { createBehavior } from '../shared/behavior';

export function exportMocks(input:unknown,format:unknown,name='Mockingbird',port=9090,includeDisabled=false,dependencies?:Dependency[]){
  if(format!=='wiremock'&&format!=='postman')throw new Error('请选择 WireMock 或 Postman Collection');
  const rules=validateRules(input,dependencies).filter(r=>includeDisabled||r.enabled);
  if(!rules.length)throw new Error('没有可导出的规则');
  if(format==='wiremock'&&includeDisabled){
    // WireMock has no enabled flag: validate the selected scenarios together.
    validateRules(rules.map(r=>({...r,enabled:true})));
  }
  const filename=name.replace(/[^\p{L}\p{N}._-]/gu,'_').slice(0,100)||'Mockingbird';
  const data=format==='wiremock'?{mappings:rules.flatMap(ruleMappings)}:{
    info:{name:name+' Mocks',schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',description:'Mockingbird 导出的请求和响应 Examples。路径变量示例值可修改。Postman Mock Server 需另行创建并配置匹配；规则延迟不自动生效。'},
    variable:[{key:'baseUrl',value:`http://127.0.0.1:${port}`,type:'string'}],
    item:rules.map(rule=>{
      const actualPath=mockRequestPath(rule);
      const sample=(rule.behavior||createBehavior(rule)).sample;
      const variables=[...new Set([...actualPath.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]))];
      const requestPath=actualPath.replace(/\{([^}]+)\}/g,':$1');
      const query=Object.entries(rule.behavior?Object.fromEntries(new URLSearchParams(sample.path.split('?')[1]||'')):rule.query).map(([key,value])=>({key,value}));
      const headers=Object.entries(sample.headers).map(([key,value])=>({key,value}));
      if(sample.body!==undefined&&!headers.some(h=>h.key.toLowerCase()==='content-type'))headers.push({key:'Content-Type',value:'application/json'});
      const request={method:rule.method,header:headers,url:{raw:'{{baseUrl}}'+requestPath+(query.length?'?'+query.map(q=>encodeURIComponent(q.key)+'='+encodeURIComponent(q.value)).join('&'):''),host:['{{baseUrl}}'],path:requestPath.slice(1).split('/'),query,variable:variables.map(key=>({key,value:'sample',description:'请替换为实际路径参数'}))},...(sample.body===undefined?{}:{body:{mode:'raw',raw:JSON.stringify(sample.body,null,2),options:{raw:{language:'json'}}}}),description:`${rule.basis}\n场景：${rule.scenario}；${rule.enabled?'已启用':'未启用'}；原始延迟：${rule.delay} ms。${rule.behavior?'\n动态字段、例外、调用步骤与连接故障仅在 WireMock 导出中保留执行语义；此 Example 为基础响应样本。':''}`};
      return{name:rule.name+' · '+rule.scenario,request,response:[{name:rule.name+' · '+rule.scenario,originalRequest:request,status:STATUS_CODES[rule.status]||String(rule.status),code:rule.status,header:Object.entries(rule.headers).map(([key,value])=>({key,value})),body:JSON.stringify(rule.body,null,2),_postman_previewlanguage:'json'}]};
    })
  };
  return{filename:filename+(format==='wiremock'?'.wiremock.json':'.postman_collection.json'),content:JSON.stringify(data,null,2)};
}
