import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MockRule } from '../shared/types';
import { exportMocks } from '../server/exports';
import { discoverModels, parseOpenCodeModels, parseGrokModels } from '../server/models';
import { MockRuntime } from '../server/runtime';
import { createServer } from '../server/api';

const rule=():MockRule=>({id:randomUUID(),dependencyId:'user',name:'User',scenario:'Success',method:'POST',path:'/users/{id}',status:201,headers:{'Content-Type':'application/json'},body:{ok:true},delay:5,enabled:true,query:{q:'a & b'},requestHeaders:{'X-Scenario':'success'},requestBody:{amount:12},basis:'Sample',version:1});

test('Exports preserve matchers and Examples, scope disabled scenarios and reject conflicts',()=>{
  const success=rule(),error={...rule(),scenario:'Error',status:503,enabled:false};
  const wire=JSON.parse(exportMocks([success,error],'wiremock','用户',9090).content);
  assert.equal(wire.mappings.length,1);assert.deepEqual(wire.mappings[0].request.queryParameters.q,{equalTo:'a & b'});
  assert.deepEqual(wire.mappings[0].response.jsonBody,{ok:true});assert.equal(wire.mappings[0].response.fixedDelayMilliseconds,5);
  assert.throws(()=>exportMocks([success,error],'wiremock','Users',9090,true),/冲突/);
  assert.throws(()=>exportMocks([error],'wiremock'),/没有/);assert.throws(()=>exportMocks([success],'unknown'),/请选择/);
  const postman=JSON.parse(exportMocks([success,error],'postman','Users',9123,true).content);
  assert.equal(postman.item.length,2);assert.equal(postman.variable[0].value,'http://127.0.0.1:9123');
  const item=postman.item[0];assert.equal(item.request.url.raw,'{{baseUrl}}/users/:id?q=a%20%26%20b');assert.equal(item.request.url.variable[0].key,'id');
  assert.equal(item.response[0].code,201);assert.equal(item.response[0].body,JSON.stringify(success.body,null,2));
  assert.equal(item.request.body.raw,JSON.stringify(success.requestBody,null,2));assert(item.request.header.some((h:any)=>h.key==='Content-Type'));
});

test('WireMock imports exported JSON and serves only matching requests',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-export-runtime-'));
  const runtime=new MockRuntime(path.resolve('runtime/wiremock-standalone-3.13.2.jar'),temp,()=>{});
  try{
    await runtime.start(19291,[]);
    await runtime.admin('mappings/import','POST',JSON.parse(exportMocks([rule()],'wiremock').content));
    const base='http://127.0.0.1:19291/users/u_001?q=a%20%26%20b';
    const response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json','X-Scenario':'success'},body:'{"amount":12}'});
    assert.equal(response.status,201);assert.deepEqual(await response.json(),{ok:true});
    const mismatch=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json','X-Scenario':'error'},body:'{"amount":12}'});assert.equal(mismatch.status,404);
  }finally{await runtime.stop();await fs.rm(temp,{recursive:true,force:true});}
});

test('Export API returns downloadable files, rejects invalid formats and supports desktop save cancellation',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-export-api-'));
  let saved:unknown;
  const service=await createServer({root:process.cwd(),dataDir:temp,saveExport:async artifact=>{saved=artifact;return null;}},0);
  try{
    const project=path.join(temp,'project');await fs.cp('examples/payment-service',project,{recursive:true,filter:s=>!s.includes('/target')&&!s.includes('/.mockingbird')});
    const bench=await service.projects.open(project);const url=`http://127.0.0.1:${service.port}/api/projects/${bench.workspace.project!.id}/rules/export`;
    const post=(format:string)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rules:[rule()],format})});
    const response=await post('postman');assert.equal(response.status,200);assert.deepEqual(await response.json(),{savedPath:null,cancelled:true});assert(saved);
    assert.equal((await post('invalid')).status,400);
    delete service.projects.options.saveExport;
    const download=await (await post('wiremock')).json();assert(download.filename.endsWith('.wiremock.json'));assert.equal(JSON.parse(download.content).mappings.length,1);
  }finally{await service.close();await fs.rm(temp,{recursive:true,force:true});}
});

test('Model discovery initializes Codex, follows pagination and hides non-picker models',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-model-test-'));
  const cli=path.join(temp,'codex');
  try{
    await fs.writeFile(cli,`#!${process.execPath}
const readline=require('node:readline');let initialized=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);let result;
 if(m.method==='initialize')result={};
 if(m.method==='initialized'){initialized=true;return;}
 if(m.method==='model/list'){
  if(!initialized)process.exit(1);
  result=m.params.cursor?{data:[{model:'second',displayName:'Second'},{model:'hidden',hidden:true}],nextCursor:null}:{data:[{model:'first',displayName:'First',isDefault:true}],nextCursor:'page2'};
 }
 console.log(JSON.stringify({id:m.id,result}));
});`,{mode:0o755});
    assert.deepEqual(await discoverModels({id:'codex',installed:true,path:cli}),[{id:'first',name:'First',isDefault:true},{id:'second',name:'Second',isDefault:false}]);
    assert.deepEqual(parseOpenCodeModels('\x1b[0mprovider/custom-model\nprovider/custom-model\nnoise\nopencode/free\n'),[{id:'provider/custom-model',name:'provider/custom-model'},{id:'opencode/free',name:'opencode/free'}]);
    await fs.writeFile(cli,`#!${process.execPath}\nprocess.exit(1);`,{mode:0o755});
    await assert.rejects(()=>discoverModels({id:'codex',installed:true,path:cli}),/提前退出/);
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('Model discovery launches env-node CLI wrappers with a minimal desktop PATH',async()=>{
  if(process.platform==='win32')return;
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-desktop-path-'));
  const cli=path.join(temp,'mock-cli');
  try{
    await fs.symlink(process.execPath,path.join(temp,'node'));
    await fs.writeFile(cli,`#!/usr/bin/env node
if(process.argv.includes('models')){console.log('provider/test-model');process.exit(0);}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='model/list')console.log(JSON.stringify({id:m.id,result:{data:[{model:'test-model',displayName:'Test'}],nextCursor:null}}));
});`,{mode:0o755});
    const source=`import assert from 'node:assert/strict';import {discoverModels} from './server/models.ts';
      process.versions.electron='test';
      const cli=process.argv[1];
      assert.equal((await discoverModels({id:'codex',installed:true,path:cli}))[0].id,'test-model');
      assert.equal((await discoverModels({id:'opencode',installed:true,path:cli}))[0].id,'provider/test-model');`;
    await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',source,cli],{cwd:process.cwd(),env:{...process.env,PATH:'/usr/bin:/bin'},timeout:15000});
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('Grok model discovery parses its CLI catalog and default selection',async()=>{
  assert.deepEqual(parseGrokModels('You are logged in.\nDefault model: grok-4.7\nAvailable models:\n * grok-4.7 (default)\n - grok-4.5\n - grok-4.5\n'),[{id:'grok-4.7',name:'grok-4.7',isDefault:true,efforts:['low','medium','high','xhigh'],defaultEffort:'medium'},{id:'grok-4.5',name:'grok-4.5',isDefault:false,efforts:['low','medium','high'],defaultEffort:'medium'}]);
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-grok-models-'));
  const cli=path.join(temp,'grok');
  try{
    await fs.writeFile(cli,`#!${process.execPath}\nif(process.argv[2]!=='models')process.exit(1);console.log('  - grok-4.5');`,{mode:0o755});
    assert.equal((await discoverModels({id:'grok',installed:true,path:cli}))[0].id,'grok-4.5');
    await fs.writeFile(cli,`#!${process.execPath}\nconsole.log('Not logged in');`,{mode:0o755});
    await assert.rejects(()=>discoverModels({id:'grok',installed:true,path:cli}),/grok login/);
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});
