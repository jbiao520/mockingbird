import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyRunConfig, normalizeRunConfig, resolveRuntime } from '../server/runtime-config';
import { emptyWorkspace, loadWorkspace, saveWorkspace } from '../server/storage';
import { indexProject, analyze } from '../server/analyzer';
import { projectLaunchCommand } from '../server/launch';
import { routePreview } from '../server/routes';
import type { RunConfig } from '../shared/types';

const blank=():RunConfig=>emptyRunConfig();
async function app(files:Record<string,string>,module='app'){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-runtime-'));
  const base=path.join(root,module,'src/main/resources');
  await fs.mkdir(base,{recursive:true});
  for(const[name,content]of Object.entries(files)){
    const file=path.join(root,name);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,content);
  }
  return{root,moduleDir:path.join(root,module)};
}
function resolve(root:string,moduleDir:string,runConfig:Partial<RunConfig>={},routes:Record<string,string>={},keys=['services.user.url'],env:NodeJS.ProcessEnv={},build:'Maven'|'Gradle'='Maven'){
  return resolveRuntime({root,moduleDir,moduleLabel:'app',build,runConfig:{...blank(),...runConfig},env,routes,keys,launchPort:18080,configLocation:'file:///routes.properties'});
}

test('Profile, external config, environment, JVM and arguments override in Spring order',async()=>{
  const fixture=await app({
    'app/src/main/resources/application.properties':'services.user.url=http://base.example\nspring.profiles.active=local\n',
    'app/src/main/resources/application-local.properties':'services.user.url=http://local.example\n',
    'app/src/main/resources/application-dev.properties':'services.user.url=http://dev.example\n',
    'config/application.properties':'services.user.url=http://external.example\n',
  });
  try{
    const profiled=await resolve(fixture.root,fixture.moduleDir);
    assert.deepEqual(profiled.profiles,['local']);
    assert.equal(profiled.profileSource.includes('application.properties'),true);
    assert.equal(profiled.resolutions[0].plain,'http://external.example');
    assert.equal(profiled.resolutions[0].layers.some(layer=>layer.label.includes('application-local.properties')&&!layer.wins),true);
    await fs.rm(path.join(fixture.root,'config/application.properties'));
    const dev=await resolve(fixture.root,fixture.moduleDir,{profiles:'local,dev'});
    assert.deepEqual(dev.profiles,['local','dev']);
    assert.equal(dev.resolutions[0].plain,'http://dev.example');
    assert.equal(dev.programArgs.includes('--spring.profiles.active=local,dev'),true);
    const fromEnv=await resolve(fixture.root,fixture.moduleDir,{profiles:'local'},{},['services.user.url'],{SERVICES_USER_URL:'http://env.example'});
    assert.equal(fromEnv.resolutions[0].plain,'http://env.example');
    assert.equal(fromEnv.resolutions[0].layers.at(-1)?.label,'环境变量 SERVICES_USER_URL');
    const fromJvm=await resolve(fixture.root,fixture.moduleDir,{jvm:'-Dservices.user.url=http://jvm.example'},{},['services.user.url'],{SERVICES_USER_URL:'http://env.example'});
    assert.equal(fromJvm.resolutions[0].plain,'http://jvm.example');
    assert.equal(fromJvm.jvmArguments,'-Dservices.user.url=http://jvm.example');
    const fromArgs=await resolve(fixture.root,fixture.moduleDir,{jvm:'-Dservices.user.url=http://jvm.example',args:'--services.user.url=http://args.example'});
    assert.equal(fromArgs.resolutions[0].effective,'http://args.example');
    assert.equal(fromArgs.resolutions[0].layers.at(-1)?.wins,true);
  }finally{await fs.rm(fixture.root,{recursive:true,force:true});}
});

test('Mock routes lose to environment variables unless launch arguments escalate them',async()=>{
  const fixture=await app({'app/src/main/resources/application.properties':'services.user.url=http://base.example\n'});
  const mock='http://127.0.0.1:9090/__mockingbird/config-services.user.url';
  try{
    const plain=await resolve(fixture.root,fixture.moduleDir,{},{'services.user.url':mock});
    assert.equal(plain.resolutions[0].mockWins,true);
    assert.equal(plain.resolutions[0].effective,mock);
    assert.equal(plain.programArgs.some(arg=>arg.startsWith('--services.user.url=')),false);
    const shadowed=await resolve(fixture.root,fixture.moduleDir,{},{'services.user.url':mock},['services.user.url'],{SERVICES_USER_URL:'http://env.example'});
    assert.equal(shadowed.resolutions[0].mockWins,true);
    assert.equal(shadowed.resolutions[0].plain,'http://env.example');
    assert.equal(shadowed.resolutions[0].effective,mock);
    assert.equal(shadowed.programArgs.includes(`--services.user.url=${mock}`),true);
    assert.match(shadowed.resolutions[0].note??'',/Mock 会生效/);
    const explicit=await resolve(fixture.root,fixture.moduleDir,{args:'--services.user.url=http://user.example'},{'services.user.url':mock},['services.user.url'],{SERVICES_USER_URL:'http://env.example'});
    assert.equal(explicit.resolutions[0].mockWins,false);
    assert.equal(explicit.resolutions[0].effective,'http://user.example');
    assert.equal(explicit.programArgs.includes(`--services.user.url=${mock}`),false);
    assert.match(explicit.resolutions[0].note??'',/启动参数/);
  }finally{await fs.rm(fixture.root,{recursive:true,force:true});}
});

test('YAML profile documents, placeholders and same-directory conflicts stay visible',async()=>{
  const fixture=await app({
    'app/src/main/resources/application.yml':'services:\n  user:\n    url: http://${USER_HOST:base.example}\n---\nspring:\n  config:\n    activate:\n      on-profile: local\nservices:\n  user:\n    url: http://yaml-local.example\n',
    'app/src/main/resources/application.properties':'services.user.url=http://properties.example\n',
  });
  try{
    const conflict=await resolve(fixture.root,fixture.moduleDir);
    assert.equal(conflict.resolutions[0].plain,'');
    assert.equal(conflict.resolutions[0].layers.some(layer=>layer.label.startsWith('配置冲突')),true);
    await fs.rm(path.join(fixture.moduleDir,'src/main/resources/application.properties'));
    const yaml=await resolve(fixture.root,fixture.moduleDir,{profiles:'local'});
    assert.equal(yaml.resolutions[0].plain,'http://yaml-local.example');
    const placeholder=await resolve(fixture.root,fixture.moduleDir,{},{},['services.user.url'],{USER_HOST:'from-env.example'});
    assert.equal(placeholder.resolutions[0].plain,'http://from-env.example');
    const fallback=await resolve(fixture.root,fixture.moduleDir);
    assert.equal(fallback.resolutions[0].plain,'http://base.example');
  }finally{await fs.rm(fixture.root,{recursive:true,force:true});}
});

test('Resolution follows the selected module and Gradle promotes system properties',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-runtime-modules-'));
  try{
    for(const module of ['a','b']){
      await fs.mkdir(path.join(root,module,'src/main/resources'),{recursive:true});
      await fs.writeFile(path.join(root,module,'src/main/resources/application.properties'),`services.user.url=http://${module}.example\n`);
    }
    const selected=await resolveRuntime({root,moduleDir:path.join(root,'b'),moduleLabel:'b',build:'Gradle',runConfig:{...blank(),jvm:'-Dservices.user.url=http://jvm.example -Xmx512m',profiles:'local'},env:{},routes:{},keys:['services.user.url'],launchPort:18080,configLocation:'file:///routes.properties',entryModule:'a'});
    assert.equal(selected.resolutions[0].plain,'http://jvm.example');
    assert.equal(selected.programArgs.includes('--services.user.url=http://jvm.example'),true);
    assert.equal(selected.programArgs.includes('--spring.profiles.active=local'),true);
    assert.equal(selected.jvmArguments,undefined);
    assert.match(selected.warnings.join('\n'),/Xmx/);
    assert.match(selected.warnings.join('\n'),/运行模块/);
    assert.equal(normalizeRunConfig({profiles:' local, dev '}).profiles,'local,dev');
    assert.throws(()=>normalizeRunConfig({profiles:'local dev'}),/Spring profile/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Launch command keeps the selected module, profiles and JVM arguments',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-runtime-launch-'));
  try{
    await fs.writeFile(path.join(root,'pom.xml'),'<project><packaging>pom</packaging><modules><module>checkout-service</module><module>order-service</module></modules></project>');
    for(const name of ['checkout-service','order-service']){
      await fs.mkdir(path.join(root,name,'src/main/java'),{recursive:true});
      await fs.mkdir(path.join(root,name,'src/main/resources'),{recursive:true});
      await fs.writeFile(path.join(root,name,'pom.xml'),'<project><artifactId>'+name+'</artifactId></project>');
      await fs.writeFile(path.join(root,name,'src/main/java/Controller.java'),'@RestController public class Controller { @GetMapping("/'+name+'") public String get(){return "ok";} }');
      await fs.writeFile(path.join(root,name,'src/main/resources/application.properties'),'mockingbird.downstream.url=http://'+name+'.example\n');
    }
    const index=await indexProject(root),ws=emptyWorkspace();ws.project=index.project;
    ws.workflows=index.project.entries.map(entry=>analyze(index,entry.id));
    ws.activeWorkflowId=ws.workflows.find(workflow=>workflow.entry.path==='/checkout-service')!.id;
    ws.runConfig={profiles:'local',env:'DEMO_FLAG=1',jvm:'-Ddemo.flag=jvm',module:'order-service',args:'--demo.flag=args'};
    const spec=await projectLaunchCommand(ws,18123);
    assert.equal(spec.args[1],path.join(ws.project!.path,'order-service/pom.xml'));
    assert(spec.args.some(arg=>arg.includes('--spring.profiles.active=local')&&arg.includes('--server.port=18123')&&arg.includes('--demo.flag=args')));
    assert(spec.args.some(arg=>arg.startsWith('-Dspring-boot.run.jvmArguments=-Ddemo.flag=jvm')));
    assert.equal(spec.env.DEMO_FLAG,'1');
    assert.match(spec.warnings.join('\n'),/运行模块/);
    const workflow=ws.workflows[0];
    workflow.dependencies=[{id:'dep',name:'User',client:'Client',method:'GET',path:'/users',url:'http://order-service.example/users',configKey:'mockingbird.downstream.url',originalBase:'http://order-service.example',sourceMethod:'',evidence:{file:'',line:1,snippet:'',kind:'manual',note:''},status:'confirmed',route:'mock'}];
    const preview=await routePreview(ws,9090,18123);
    assert.equal(preview.changes[0].before,'http://order-service.example');
    assert.equal(preview.module,'order-service');
    assert.equal(preview.resolutions[0].mockWins,true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Saved run configuration reloads and invalid configuration is dropped',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-runtime-save-'));
  try{
    const ws=emptyWorkspace();
    ws.project={id:'p',name:'p',path:root,build:'Maven',javaVersion:'17',modules:['.'],files:[],entries:[],indexedAt:'',revision:'r',warnings:[],fileCount:1};
    ws.runConfig={profiles:'local',env:'A=1',jvm:'',module:'',args:''};
    await saveWorkspace(ws);
    assert.equal((await loadWorkspace(root)).runConfig?.profiles,'local');
    const saved=JSON.parse(await fs.readFile(path.join(root,'.mockingbird/workspace.json'),'utf8'));
    saved.runConfig={profiles:'bad profile'};
    await fs.writeFile(path.join(root,'.mockingbird/workspace.json'),JSON.stringify(saved));
    assert.deepEqual((await loadWorkspace(root)).runConfig,emptyRunConfig());
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
