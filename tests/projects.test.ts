import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { ProjectManager } from '../server/projects';
import { createServer } from '../server/api';
import { paymentDependencies } from './fixtures';
import { mockRequestPath } from '../shared/mock-routing';
import type { Workbench } from '../server/workbench';
import { createBehavior } from '../shared/behavior';
import type { MockRuntime } from '../server/runtime';

async function fixture(){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-projects-'));
  const roots=['service-a','service-b'].map(name=>path.join(temp,name));
  await Promise.all(roots.map(root=>fs.cp('examples/payment-service',root,{recursive:true,filter:s=>!s.includes('/target')&&!s.includes('/.mockingbird')})));
  return{temp,roots,options:{root:process.cwd(),dataDir:path.join(temp,'data')},remove:()=>fs.rm(temp,{recursive:true,force:true})};
}
async function prepare(bench:Workbench,name:string){
  const entry=bench.workspace.project!.entries.find(e=>e.path.endsWith('/create'))!,wf=await bench.analyzeEntry(entry.id);
  const dep=await bench.saveDependency(wf.id,paymentDependencies(bench.index!)[0]);
  const rules=bench.generate();rules[0].body={id:'u_001',name,active:true};await bench.setRules(rules);
  return{wf,dep,rule:bench.workspace.rules[0]};
}
async function waitUntil(check:()=>boolean,timeout=10000){const start=Date.now();while(!check()){if(Date.now()-start>timeout)throw new Error('Timed out');await new Promise(r=>setTimeout(r,25));}}
async function fakeAgent(temp:string){
  const cli=path.join(temp,'fake-grok.cjs');
  await fs.writeFile(cli,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),prompt=fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8');
const name=prompt.includes('task-a')?'a':'b',root=path.dirname(process.argv[1]);
fs.writeFileSync(path.join(root,'started-'+name),'started');
const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'release-'+name))){clearInterval(timer);console.log(JSON.stringify({text:JSON.stringify({summary:'finished-'+name,dependencies:[],rules:[]}),stopReason:'end_turn'}));}},30);
`,{mode:0o755});return{id:'grok',installed:true,path:cli};
}

test('Canonical project paths share one instance; concurrent opens keep ports, indexes, state and recent history separate',async()=>{
  const f=await fixture(),manager=new ProjectManager(f.options);await manager.init();
  try{
    const alias=path.join(f.temp,'alias');await fs.symlink(f.roots[0],alias);
    const [a,same,b]=await Promise.all([manager.open(f.roots[0]),manager.open(alias),manager.open(f.roots[1])]);
    assert.equal(a,same);assert.equal(manager.workbenches.size,2);assert.notEqual(a,b);
    assert.equal(a.agents,manager.agents);assert.equal(b.agents,manager.agents);
    assert.notEqual(a.runtime.state.port,b.runtime.state.port);assert.notEqual(a.launcher.state.port,b.launcher.state.port);
    assert.equal(new Set(manager.recent.map(r=>r.path)).size,2);
    const {rule}=await prepare(a,'Alice');assert.equal(b.workspace.rules.length,0);assert.equal(b.workspace.messages.length,0);
    assert.equal((await manager.open(alias)).workspace.rules[0].id,rule.id);
    await fs.appendFile(path.join(f.roots[0],'src/main/java/dev/mockingbird/payment/PaymentService.java'),'\n// changed a\n');
    await waitUntil(()=>a.state().problems.some(p=>p.includes('发生变化')));
    assert(!b.state().problems.some(p=>p.includes('发生变化')));
    assert.equal(JSON.parse(await fs.readFile(path.join(f.options.dataDir,'recent.json'),'utf8')).length,2);
  }finally{await manager.close();await f.remove();}
});

test('Two actual WireMock instances and Java children survive switching; closing A stops only A and reopening restores without starting',async()=>{
  const f=await fixture(),manager=new ProjectManager(f.options);await manager.init();
  try{
    const [a,b]=await Promise.all(f.roots.map(root=>manager.open(root))),idA=a.workspace.project!.id,idB=b.workspace.project!.id;
    const ra=await prepare(a,'Alice'),rb=await prepare(b,'Bob');
    const wrapper=`#!${process.execPath}\nconst net=require('node:net'),args=process.argv.join(' '),port=Number(/--server.port=(\\d+)/.exec(args)[1]);net.createServer(socket=>socket.end()).listen(port,'127.0.0.1');\n`;
    await Promise.all(f.roots.map(root=>fs.writeFile(path.join(root,'mvnw'),wrapper,{mode:0o755})));
    await Promise.all([manager.start(idA,'mock',a.runtime.state.port),manager.start(idB,'mock',b.runtime.state.port)]);
    await a.applyRoutes({[ra.dep.id]:'mock'});await b.applyRoutes({[rb.dep.id]:'mock'});
    await Promise.all([manager.start(idA,'launch',a.launcher.state.port),manager.start(idB,'launch',b.launcher.state.port)]);
    await waitUntil(()=>a.launcher.state.status==='running'&&b.launcher.state.status==='running');
    await manager.activate(idA,'window-one');await manager.activate(idB,'window-one');
    assert.equal(a.runtime.state.status,'running');assert.equal(a.launcher.state.status,'running');
    const request={target:'mock' as const,method:'GET',path:mockRequestPath(ra.rule).replace('{id}','u_001')};
    assert.equal(JSON.parse((await a.testRequest(request)).body).name,'Alice');
    assert.equal(JSON.parse((await b.testRequest(request)).body).name,'Bob');
    assert.notEqual((a.runtime as unknown as {cwd:string}).cwd,(b.runtime as unknown as {cwd:string}).cwd);
    await assert.rejects(()=>manager.start(idB,'mock',a.runtime.state.port),/已分配/);
    const pinnedPort=a.runtime.state.port;
    await manager.closeProject(idA,'window-one');assert.equal(a.runtime.child,undefined);assert.equal(a.launcher.child,undefined);
    assert.equal(b.runtime.state.status,'running');assert.equal(b.launcher.state.status,'running');assert.equal(JSON.parse((await b.testRequest(request)).body).name,'Bob');
    const reopened=await manager.open(f.roots[0]);assert.notEqual(reopened,a);assert.equal(reopened.runtime.state.status,'stopped');assert.equal(reopened.launcher.state.status,'stopped');
    assert.equal(reopened.runtime.state.port,pinnedPort);assert.equal(reopened.workspace.rules[0].body&&JSON.parse(JSON.stringify(reopened.workspace.rules[0].body)).name,'Alice');
    await assert.rejects(()=>manager.start(idA,'mock',pinnedPort+10),/先恢复 Real/);
    const blocker=net.createServer();await new Promise<void>(resolve=>blocker.listen(pinnedPort,'127.0.0.1',resolve));
    try{await assert.rejects(()=>manager.start(idA,'mock',pinnedPort),/被占用/);assert.equal(reopened.runtime.state.port,pinnedPort);const config=await fs.readFile(path.join(f.roots[0],'.mockingbird/routes.properties'),'utf8');assert(config.includes(':'+pinnedPort+'/'));}finally{await new Promise<void>(resolve=>blocker.close(()=>resolve()));}
  }finally{await manager.close();await f.remove();}
});

test('Background AI completion stays in its owning project and closing one project cancels only its task',async()=>{
  const f=await fixture(),manager=new ProjectManager(f.options);await manager.init();
  try{
    const [a,b]=await Promise.all(f.roots.map(root=>manager.open(root))),agent=await fakeAgent(f.temp);
    a.agents=b.agents=[agent];const wa=await a.analyzeEntry(a.workspace.project!.entries[0].id),wb=await b.analyzeEntry(b.workspace.project!.entries[0].id);
    const taskA=await a.chat('grok','task-a',undefined,wa.id),taskB=await b.chat('grok','task-b',undefined,wb.id);
    await manager.activate(a.workspace.project!.id,'window-one');await manager.activate(b.workspace.project!.id,'window-one');
    await fs.writeFile(path.join(f.temp,'release-a'),'go');await waitUntil(()=>taskA.status==='completed');
    assert(a.workspace.messages.some(m=>m.content==='finished-a'));assert(!b.workspace.messages.some(m=>m.content==='finished-a'));assert.equal(taskB.status,'running');
    await fs.rm(path.join(f.temp,'release-a'));const nextA=await a.chat('grok','task-a again',undefined,wa.id);
    await manager.closeProject(a.workspace.project!.id,'window-one');assert.equal(nextA.status,'cancelled');assert.equal(taskB.status,'running');
    await fs.writeFile(path.join(f.temp,'release-b'),'go');await waitUntil(()=>taskB.status==='completed');
    assert(b.workspace.messages.some(m=>m.content==='finished-b'));assert(!b.workspace.messages.some(m=>m.taskId===taskA.id));
  }finally{await manager.close();await f.remove();}
});

test('Project views remain unpublished, persist across restart, and shared settings have one application owner',async()=>{
  const f=await fixture(),manager=new ProjectManager(f.options);await manager.init();
  const [a,b]=await Promise.all(f.roots.map(root=>manager.open(root))),idA=a.workspace.project!.id,idB=b.workspace.project!.id;
  try{
    await prepare(a,'Saved');const view={schemaVersion:1 as const,values:{tabs:[{id:'mocks',kind:'mocks',title:'Mock Rules'}],activeTab:'mocks',draftRules:[{...a.workspace.rules[0],body:{id:'u_001',name:'Draft',active:true}}],testBody:'{"invalid":',prompt:'unsent A',draftRevision:a.index!.project.revision}};
    await manager.saveView(idA,view);await manager.saveView(idB,{schemaVersion:1,values:{prompt:'unsent B'}});
    assert.equal(JSON.parse(JSON.stringify(a.workspace.rules[0].body)).name,'Saved');assert.deepEqual(await manager.readView(idA),view);
    await Promise.all([manager.saveSettings({grok:'model-one'}),manager.saveSettings({codex:'model-two'})]);await manager.close();
    const restarted=new ProjectManager(f.options);await restarted.init();
    try{assert.deepEqual(restarted.selectedModels,{grok:'model-one',codex:'model-two'});const reopened=await restarted.open(f.roots[0]);assert.deepEqual(await restarted.readView(reopened.workspace.project!.id),view);assert.equal(JSON.parse(JSON.stringify(reopened.workspace.rules[0].body)).name,'Saved');assert.equal(reopened.runtime.child,undefined);}finally{await restarted.close();}
  }finally{await manager.close();await f.remove();}
});

test('Scoped HTTP routes enforce window ownership, transfer to a new window, and reject unknown IDs or stale drafts',async()=>{
  const f=await fixture();let focus='',newWindow='';
  const service=await createServer({...f.options,desktop:true,focusWindow:async client=>{focus=client;return true;},openProjectWindow:async(_id,client)=>{newWindow=client;}},0);
  const base=`http://127.0.0.1:${service.port}/api`;
  const call=(route:string,data?:unknown,client='one',method=data===undefined?'GET':'POST')=>fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Mockingbird-Client':client},body:data===undefined?undefined:JSON.stringify(data)});
  try{
    const opened=await (await call('/projects/open',{path:f.roots[0]})).json(),id=opened.projectId;
    assert.equal((await call('/projects/'+id+'/activate',{clientId:'one'})).status,200);
    assert.deepEqual(await (await call('/projects/'+id+'/activate',{clientId:'two'},'two')).json(),{focused:true});assert.equal(focus,'one');
    assert.equal((await call('/projects/'+id+'/state',undefined,'two')).status,400);
    assert.equal((await call('/projects/missing/state')).status,400);assert.equal((await call('/rules',{},'one','PUT')).status,404);
    const bench=service.projects.get(id);await prepare(bench,'Saved');
    const stale=await call('/projects/'+id+'/rules',{rules:bench.workspace.rules,revision:'old'},'one','PUT');assert.equal(stale.status,400);assert.match((await stale.json()).error,/过期/);
    await call('/projects/'+id+'/view',{schemaVersion:1,values:{prompt:'saved before transfer'}},'one','PUT');
    assert.equal((await call('/projects/'+id+'/window',{clientId:'one'})).status,200);assert(newWindow);
    assert.equal((await call('/projects/'+id+'/view',undefined,'one')).status,400);
    assert.equal((await call('/projects/'+id+'/view',undefined,newWindow)).status,200);
    assert.equal((await call('/projects/'+id+'/close',{},'one')).status,400);
    assert.equal((await call('/projects/'+id+'/close',{},newWindow)).status,200);assert.equal(service.projects.workbenches.size,0);
  }finally{await service.close();await f.remove();}
});

test('Failed opens preserve existing sessions; closing cancels analysis and drains queued mutations',async()=>{
  const f=await fixture(),manager=new ProjectManager(f.options);await manager.init();
  try{
    const a=await manager.open(f.roots[0]);await fs.mkdir(path.join(f.roots[1],'.mockingbird'));
    await fs.writeFile(path.join(f.roots[1],'.mockingbird/workspace.json'),'{invalid');
    await assert.rejects(()=>manager.open(f.roots[1]),/无法读取/);assert.equal(manager.get(a.workspace.project!.id),a);assert.equal(manager.workbenches.size,1);
    assert.equal(await fs.readFile(path.join(f.roots[1],'.mockingbird/workspace.json'),'utf8'),'{invalid');
    const indexing=a.track(()=>a.serial(()=>a.reindex()));await new Promise(r=>setTimeout(r,20));
    const closed=manager.closeProject(a.workspace.project!.id);await assert.rejects(indexing,/正在关闭/);await closed;
    await assert.rejects(()=>a.serial(async()=>a.addMessage('user','late mutation')),/正在关闭/);assert(!a.workspace.messages.some(m=>m.content==='late mutation'));
  }finally{await manager.close();await f.remove();}
});


test('Closing a project cancels a delayed behavior preview and cannot publish its draft',async()=>{
  const f=await fixture(),manager=new ProjectManager(f.options);await manager.init();
  try{
    const bench=await manager.open(f.roots[0]);const {rule}=await prepare(bench,'Saved');
    const draft={...rule,delay:20000,behavior:createBehavior(rule)};
    const preview=bench.track(()=>bench.serial(()=>bench.previewBehavior({rules:[draft],ruleId:rule.id})));
    const active=()=>((bench.previewer as unknown as {active?:MockRuntime}).active);
    await waitUntil(()=>active()?.state.status==='running');const start=Date.now();
    const closing=manager.closeProject(bench.workspace.project!.id);
    await assert.rejects(preview);await closing;assert(Date.now()-start<4000);
    assert.equal(active()?.child,undefined);assert.equal(bench.workspace.rules[0].delay,0);
  }finally{await manager.close();await f.remove();}
});
