import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { indexProject } from '../server/analyzer';
import { generateRequestTemplate, validateEntryRequest } from '../server/request-shape';
import { createServer } from '../server/api';

async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-request-'));
  await fs.writeFile(path.join(root,'pom.xml'),'<project/>');
  await fs.writeFile(path.join(root,'Controller.java'),`import org.springframework.web.bind.annotation.*;
@RestController public class Controller {
 @PostMapping("/orders/{id}") public String create(@PathVariable("id") long id, @RequestParam(name="count", defaultValue="2") int count, @RequestHeader("X-Active") boolean active, @RequestBody Order body){return "ok";}
 @GetMapping("/health") public String health(){return "ok";}
 @PostMapping("/optional") public String optional(@RequestBody(required=false) Order body){return "ok";}
 @PostMapping("/custom") public String custom(@RequestBody Custom body){return "ok";}
 @PostMapping("/cycle") public String cycle(@RequestBody Node body){return "ok";}
}`);
  await fs.writeFile(path.join(root,'Order.java'),`import java.util.List; import com.fasterxml.jackson.annotation.JsonProperty;
public record Order(@JsonProperty("user_id") long userId, Long accountId, String name, boolean active, double amount, List<Item> items, State state) {}`);
  await fs.writeFile(path.join(root,'Item.java'),'public class Item { private int quantity; private String sku; }');
  await fs.writeFile(path.join(root,'State.java'),'public enum State { NEW, DONE }');
  await fs.writeFile(path.join(root,'Custom.java'),'@JsonDeserialize(using=Converter.class) public class Custom { private long value; }');
  await fs.writeFile(path.join(root,'Node.java'),'public record Node(long id, Node child) {}');
  return root;
}

test('Entry samples follow Java DTO types, JSON aliases and Spring parameter bindings',async()=>{
  const root=await fixture();try{
    const index=await indexProject(root),entry=index.project.entries.find(e=>e.name==='create')!;
    const template=generateRequestTemplate(index,entry.id);
    assert.equal(template.path,'/orders/1?count=2');assert.deepEqual(template.headers,{'X-Active':'true','Content-Type':'application/json'});
    assert.deepEqual(template.body,{user_id:1,accountId:1,name:'sample',active:true,amount:1,items:[{quantity:1,sku:'sample'}],state:'NEW'});
    assert.deepEqual(template.warnings,[]);assert.deepEqual(validateEntryRequest(index,entry.id,template).warnings,[]);
    const health=generateRequestTemplate(index,index.project.entries.find(e=>e.name==='health')!.id);assert.equal(health.body,undefined);assert.deepEqual(health.headers,{});
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Validation rejects wrong nested types, unsafe long values and changed endpoints',async()=>{
  const root=await fixture();try{
    const index=await indexProject(root),entry=index.project.entries.find(e=>e.name==='create')!,template=generateRequestTemplate(index,entry.id);
    for(const [field,value,pattern] of [['user_id','1',/body.user_id.*整数/],['accountId',Number.MAX_SAFE_INTEGER+1,/安全范围/],['active','true',/body.active.*boolean/],['state','INVALID',/枚举/],['items',[{quantity:'1'}],/items\[0\].quantity/]] as const){
      assert.throws(()=>validateEntryRequest(index,entry.id,{...template,body:{...(template.body as object),[field]:value}}),pattern);
    }
    assert.throws(()=>validateEntryRequest(index,entry.id,{...template,body:undefined}),/需要请求 Body/);
    assert.throws(()=>validateEntryRequest(index,entry.id,{...template,path:'/health'}),/偏离入口/);
    assert.throws(()=>validateEntryRequest(index,entry.id,{...template,path:'/orders/nope?count=2'}),/id.*数字/);
    assert.throws(()=>validateEntryRequest(index,entry.id,{...template,headers:{}}),/X-Active/);
    assert.doesNotThrow(()=>validateEntryRequest(index,entry.id,{...template,body:{accountId:null}}));
    assert.throws(()=>validateEntryRequest(index,entry.id,{...template,body:{user_id:null}}),/不能为 null/);
    const optional=index.project.entries.find(e=>e.name==='optional')!;assert.doesNotThrow(()=>validateEntryRequest(index,optional.id,{method:'POST',path:'/optional'}));
    for(const name of ['custom','cycle']){const sample=generateRequestTemplate(index,index.project.entries.find(e=>e.name===name)!.id);assert(sample.warnings.length>0);}
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('HTTP client rejects invalid or stale entry payloads before making an outbound request',async()=>{
  const root=await fixture(),service=await createServer({root:process.cwd(),dataDir:path.join(root,'data')},0);
  const received:{method?:string;path?:string;body:string}[]=[];
  const target=createHttpServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({method:req.method,path:req.url,body});res.setHeader('Content-Type','application/json');res.end('{"ok":true}');});
  await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
  try{
    await fs.writeFile(path.join(root,'application.properties'),'server.servlet.context-path=/shop\n');
    const bench=await service.projects.open(root);
    const entry=bench.workspace.project!.entries.find(e=>e.name==='create')!;
    const base=`http://127.0.0.1:${service.port}/api/projects/${bench.workspace.project!.id}`,post=async(route:string,body:unknown)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const response=await post('/requests/template',{entryId:entry.id});assert.equal(response.status,200);const template=await response.json();
    assert.equal(template.path,'/shop/orders/1?count=2');
    const address=target.address();assert(address&&typeof address!=='string');bench.launcher.state.status='running';bench.launcher.state.port=address.port;
    const invalid=await post('/requests/test',{...template,target:'project',body:{...template.body,user_id:'u_001'}});assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/user_id.*整数/);
    const stale=await post('/requests/test',{...template,target:'project',revision:'old'});assert.equal(stale.status,400);assert.match((await stale.json()).error,/过期/);
    assert.equal((await post('/requests/test',{...template,target:'project',path:'/orders/1?count=2'})).status,400);
    assert.equal(received.length,0);
    const valid=await post('/requests/test',{...template,target:'project'});assert.equal(valid.status,200);assert.equal((await valid.json()).status,200);assert.equal(JSON.parse(received[0].body).user_id,1);
    assert.equal(received[0].path,'/shop/orders/1?count=2');
    const health=await bench.requestTemplate(bench.workspace.project!.entries.find(e=>e.name==='health')!.id);
    assert.equal((await post('/requests/test',{...health,target:'project'})).status,200);assert.equal(received[1].method,'GET');assert.equal(received[1].body,'');
    assert.equal(received[1].path,'/shop/health');
  }finally{await service.close();await new Promise<void>(resolve=>{target.close(()=>resolve());target.closeAllConnections();});await fs.rm(root,{recursive:true,force:true});}
});

test('Context paths share generation and validation semantics for YAML, root and literal prefixes',async()=>{
  const root=await fixture();try{
    for(const prefix of ['/shop/v1.0','/shop/','/','']){
      await fs.writeFile(path.join(root,'application.yml'),`server:\n  servlet:\n    context-path: ${JSON.stringify(prefix)}\n`);
      const index=await indexProject(root),entry=index.project.entries.find(e=>e.name==='create')!;
      const template=generateRequestTemplate(index,entry.id),base=prefix==='/'?'':prefix.replace(/\/$/,'');
      assert.equal(template.path,base+'/orders/1?count=2');
      assert.doesNotThrow(()=>validateEntryRequest(index,entry.id,template));
      assert.throws(()=>validateEntryRequest(index,entry.id,{...template,path:base+'/orders/nope?count=2'}),/id.*数字/);
      if(prefix==='/shop/v1.0')assert.throws(()=>validateEntryRequest(index,entry.id,{...template,path:'/shop/v1X0/orders/1?count=2'}),/偏离入口/);
    }
    await fs.writeFile(path.join(root,'application.yml'),'server:\n  servlet:\n    context-path: "${APP_CONTEXT}"\n');
    const index=await indexProject(root),entry=index.project.entries.find(e=>e.name==='health')!;
    assert.throws(()=>generateRequestTemplate(index,entry.id),/context-path.*未能解析/);
    assert.throws(()=>validateEntryRequest(index,entry.id,{method:'GET',path:'/health'}),/context-path.*未能解析/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('HTTP templates and validation follow profiles, environment, JVM and arguments, including changed configuration',async()=>{
  const root=await fixture();
  const resources=path.join(root,'src/main/resources');await fs.mkdir(resources,{recursive:true});
  await fs.writeFile(path.join(resources,'application.properties'),'server.servlet.context-path=/base\n');
  await fs.writeFile(path.join(resources,'application-dev.properties'),'server.servlet.context-path=/profile\n');
  const service=await createServer({root:process.cwd(),dataDir:path.join(root,'data')},0);
  const paths:string[]=[];
  const target=createHttpServer((req,res)=>{paths.push(req.url!);res.end('ok');});
  await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
  try{
    const bench=await service.projects.open(root),entry=bench.workspace.project!.entries.find(e=>e.name==='health')!;
    bench.launcher.state.status='running';bench.launcher.state.port=(target.address() as {port:number}).port;
    const base=`http://127.0.0.1:${service.port}/api/projects/${bench.workspace.project!.id}`;
    const post=(route:string,data:unknown)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    let previous:ReturnType<typeof generateRequestTemplate>|undefined;
    for(const [config,prefix] of [
      [{profiles:'dev'},'/profile'],
      [{profiles:'dev',env:'SERVER_SERVLET_CONTEXT_PATH=/environment'},'/environment'],
      [{profiles:'dev',env:'SERVER_SERVLET_CONTEXT_PATH=/environment',jvm:'-Dserver.servlet.context-path=/jvm'},'/jvm'],
      [{profiles:'dev',env:'SERVER_SERVLET_CONTEXT_PATH=/environment',jvm:'-Dserver.servlet.context-path=/jvm',args:'--server.servlet.context-path=/arguments'},'/arguments'],
      [{args:'--server.servlet.context-path=/'},''],
    ] as const){
      await bench.saveRunConfig(config);
      const response=await post('/requests/template',{entryId:entry.id});assert.equal(response.status,200);
      const template=await response.json();assert.equal(template.path,prefix+'/health');
      if(previous){const rejected=await post('/requests/test',{...previous,target:'project'});assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/偏离入口/);}
      const sent=await post('/requests/test',{...template,target:'project'});assert.equal(sent.status,200);assert.equal((await sent.json()).status,200);
      previous=template;
    }
    assert.deepEqual(paths,['/profile/health','/environment/health','/jvm/health','/arguments/health','/health']);
  }finally{await service.close();await new Promise<void>(resolve=>{target.close(()=>resolve());target.closeAllConnections();});await fs.rm(root,{recursive:true,force:true});}
});
