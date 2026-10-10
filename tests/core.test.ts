import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { indexProject,analyze,readSource } from '../server/analyzer';
import { validateRules,generateRules,mapping,validateResponseContracts } from '../server/rules';
import { routePreview } from '../server/routes';
import { emptyWorkspace } from '../server/storage';
import { redact } from '../server/runtime';
import { createServer } from '../server/api';
import { Workbench } from '../server/workbench';
import { declaredPaymentFlow, paymentDependencies } from './fixtures';

test('Spring Controller index opens an empty Flow; declared dependencies carry source evidence',async()=>{
  const index=await indexProject('examples/payment-service');assert.equal(index.project.entries.length,2);assert(!index.methods.some(m=>m.name==='OkHttpClient'||m.name==='RestTemplate'));
  const entry=index.project.entries.find(e=>e.path==='/api/payment/create')!,empty=analyze(index,entry.id);assert.equal(empty.dependencies.length,0);assert.equal(empty.methods.length,1);const wf=declaredPaymentFlow(index,empty);assert.equal(wf.dependencies.length,4);assert(wf.dependencies.every(d=>d.configKey&&d.status==='confirmed'));
  const status=analyze(index,index.project.entries.find(e=>e.path==='/api/payment/status')!.id);assert.equal(status.dependencies.length,0);
  for(const dep of wf.dependencies){const src=index.sources.get(dep.evidence.file)!;assert(src.split('\n')[dep.evidence.line-1].includes(dep.client==='Feign'?'@GetMapping':dep.client==='RestTemplate'?'postForObject':dep.client==='WebClient'?'.uri':'.url'));}
  await assert.rejects(()=>readSource(index,'../../prd.md'));
});
test('Validation rejects conflicts, malformed headers, invalid body and delay',async()=>{
  const index=await indexProject('examples/payment-service'),wf=declaredPaymentFlow(index,analyze(index,index.project.entries[0].id)),rules=generateRules(wf.dependencies,index);
  assert.equal(validateRules(rules).length,4);const copy=structuredClone(rules[0]);copy.id=crypto.randomUUID();assert.throws(()=>validateRules([...rules,copy]),/冲突/);
  copy.enabled=false;assert.equal(validateRules([...rules,copy]).length,5);
  copy.enabled=true;copy.path='/users/{anotherName}';assert.throws(()=>validateRules([...rules,copy]),/冲突/);
  copy.path=rules[0].path;copy.query={scenario:'error'};assert.throws(()=>validateRules([...rules,copy]),/冲突/);
  rules[0].query={scenario:'success'};assert.equal(validateRules([...rules,copy]).length,5);
  const invalid=structuredClone(rules);invalid[0].headers['X-Bad']='line\r\ninjection';assert.throws(()=>validateRules(invalid),/Header/);
  invalid[0].headers={};invalid[0].delay=-1;assert.throws(()=>validateRules(invalid));
  const user=rules.find(r=>r.method==='GET')!;const map=mapping(user);assert('urlPathPattern' in map.request);assert(new RegExp(map.request.urlPathPattern).test('/users/u_001'));assert(!new RegExp('^'+map.request.urlPathPattern+'$').test('/users/a/b'));
});
test('Gradle YAML is indexed without automatic HTTP discovery',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-gradle-'));
  try{
    await fs.writeFile(path.join(temp,'build.gradle'),'java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }');
    await fs.writeFile(path.join(temp,'application.yml'),'remote:\n  url: http://127.0.0.1:19000\n');
    await fs.writeFile(path.join(temp,'Controller.java'),'import org.springframework.web.bind.annotation.*; @RestController public class Controller { @GetMapping("/dynamic") public String dynamic(){return new CustomGateway().send(resolve());} private String resolve(){return "http://unknown";} }');
    const index=await indexProject(temp);assert.equal(index.project.build,'Gradle');assert.equal(index.project.javaVersion,'21');assert.equal(index.properties['remote.url'],'http://127.0.0.1:19000');
    assert.equal(analyze(index,index.project.entries[0].id).dependencies.length,0);
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});
test('Shared configuration cannot silently mix Real and Mock',async()=>{
  const index=await indexProject('examples/payment-service'),wf=declaredPaymentFlow(index,analyze(index,index.project.entries[0].id)),ws=emptyWorkspace();ws.project=index.project;ws.workflows=[wf];wf.dependencies[0].route='mock';wf.dependencies[1].configKey=wf.dependencies[0].configKey;await assert.rejects(()=>routePreview(ws,9090),/共享/);
});
test('Local API rejects cross-origin mutation and arbitrary shell execution',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-api-'));const service=await createServer({root:process.cwd(),dataDir:temp},0);
  try{const base=`http://127.0.0.1:${service.port}`;const response=await fetch(base+'/api/terminal',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:'{}'});assert.equal(response.status,403);
    const plain=await fetch(base+'/api/terminal',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});assert.equal(plain.status,415);
    const cmd=await fetch(base+'/api/terminal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:'rm -rf /'})});assert.equal(cmd.status,400);
  }finally{await service.close();await fs.rm(temp,{recursive:true,force:true});}
});
test('Sensitive tokens are redacted',()=>{assert(!redact('Bearer abcdefg.123').includes('abcdefg'));assert(!redact('{"token":"sensitive","password":"secret"}').includes('sensitive'));});

test('Available record contracts reject wrong response types',async()=>{
  const index=await indexProject('examples/payment-service'),wf=declaredPaymentFlow(index,analyze(index,index.project.entries[0].id)),rules=generateRules(wf.dependencies,index);
  validateResponseContracts(rules,wf.dependencies,index);
  const user=rules.find(r=>r.method==='GET')!;user.body={id:'u_001',name:'Alex',active:'yes'};
  assert.throws(()=>validateResponseContracts(rules,wf.dependencies,index),/active/);
});
test('Source changes invalidate analysis until reindex; managed files do not',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-watch-'));
  const sample=path.join(temp,'project'),bench=new Workbench({root:process.cwd(),dataDir:path.join(temp,'data')});
  try{
    await fs.cp('examples/payment-service',sample,{recursive:true,filter:file=>!file.split(path.sep).some(part=>['target','.mockingbird'].includes(part))});
    await bench.importProject(sample);const wf=await bench.analyzeEntry(bench.workspace.project!.entries[0].id);for(const draft of paymentDependencies(bench.index!))await bench.saveDependency(wf.id,draft);
    await fs.mkdir(path.join(sample,'.mockingbird'),{recursive:true});await fs.writeFile(path.join(sample,'.mockingbird','test.json'),'{}');
    await new Promise(resolve=>setTimeout(resolve,100));assert(!bench.state().problems.some(p=>p.includes('请重新索引')));
    const file=path.join(sample,'src/main/java/dev/mockingbird/payment/PaymentController.java');
    await fs.appendFile(file,'\n// Source change\n');
    for(let attempt=0;attempt<30&&!bench.state().problems.some(p=>p.includes('请重新索引'));attempt++)await new Promise(resolve=>setTimeout(resolve,50));
    assert(bench.state().problems.some(p=>p.includes('请重新索引')));assert.throws(()=>bench.generate(),/重新索引/);
    await bench.reindex();assert.throws(()=>bench.generate(),/Flow 已过期/);
    await bench.analyzeEntry(bench.workspace.project!.entries[0].id);assert.equal(bench.activeWorkflow().dependencies.length,4);await bench.confirmWorkflow(wf.id);assert.equal(bench.generate().length,4);
  }finally{await bench.close();await fs.rm(temp,{recursive:true,force:true});}
});
