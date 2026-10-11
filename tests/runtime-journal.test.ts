import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { MockRuntime } from '../server/runtime';
import type { MockRule } from '../shared/types';

test('WireMock caps retained requests, limits query payloads and retrieves diagnosis records by ID',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-journal-'));
  const probe=net.createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=(probe.address() as net.AddressInfo).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const runtime=new MockRuntime(path.resolve('runtime/wiremock-standalone-3.13.2.jar'),directory,()=>{},8);
  const rule:MockRule={id:randomUUID(),dependencyId:'journal',name:'Journal',scenario:'Success',method:'POST',path:'/journal',status:200,headers:{'Content-Type':'application/json'},body:{ok:true},delay:0,enabled:true,query:{},requestHeaders:{},basis:'Test',version:1};
  try{
    await runtime.start(port,[rule]);
    const send=async(n:number)=>{const response=await fetch(`http://127.0.0.1:${port}/journal`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({n,data:'x'.repeat(4096)})});assert.equal(response.status,200);await response.text();};
    await send(0);const first=(await runtime.requests())[0];
    for(let n=1;n<12;n++)await send(n);
    const all=await runtime.admin('requests');assert.equal(all.requests.length,8);
    const endpoints:string[]=[],admin=runtime.admin.bind(runtime);
    runtime.admin=async(endpoint,method,data)=>{endpoints.push(endpoint);return admin(endpoint,method,data);};
    const recent=await runtime.requests(2);assert.equal(recent.length,2);
    assert.equal(JSON.parse(recent[0].body!).n,11);assert.equal(JSON.parse(recent[1].body!).n,10);
    assert.deepEqual(endpoints,['requests?limit=2']);
    const actual=await admin('requests?limit=2');assert.equal(actual.requests.length,2);
    assert(Buffer.byteLength(JSON.stringify(actual))<Buffer.byteLength(JSON.stringify(all))/2);
    const record=await runtime.journalEntry(recent[0].id);assert.equal(record.id,recent[0].id);
    assert.equal(endpoints.at(-1),'requests/'+recent[0].id);
    await assert.rejects(()=>runtime.journalEntry(first.id),/已不在.*日志/);
    await assert.rejects(()=>runtime.journalEntry('../mappings'),/ID 非法/);
  }finally{await runtime.stop();await fs.rm(directory,{recursive:true,force:true});}
});
