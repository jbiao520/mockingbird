import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexProject, analyze, propertyForSource } from '../server/analyzer';
import { confirmDependency } from '../server/dependencies';
import { generateRequestTemplate, validateEntryRequest } from '../server/request-shape';
import { Workbench } from '../server/workbench';

async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-config-'));
  await fs.writeFile(path.join(root,'pom.xml'),'<project><packaging>pom</packaging></project>');
  for(const module of ['a','b','shared','a/nested']){
    await fs.mkdir(path.join(root,module,'src/main/java'),{recursive:true});
    await fs.mkdir(path.join(root,module,'src/main/resources'),{recursive:true});
    await fs.writeFile(path.join(root,module,'pom.xml'),'<project/>');
    await fs.writeFile(path.join(root,module,'src/main/java/Controller.java'),`@RestController public class Controller {
 @GetMapping("/${module}") public String get(){return "ok";}
}`);
    if(module!=='shared')await fs.writeFile(path.join(root,module,'src/main/resources/application.properties'),`services.user.url=http://${module.replace('/','-')}.example\nserver.servlet.context-path=/${module}/app\n`);
  }
  return root;
}
const draft={name:'User',client:'SharedClient',method:'GET' as const,path:'/users',originalBase:'http://wrong.example',configKey:'services.user.url',responseType:'String',file:'shared/src/main/java/Controller.java',line:2,note:'shared client',callChain:[]};

test('Module configuration follows the entry application, isolates nested modules and never falls back to siblings',async()=>{
  const root=await fixture();try{
    await fs.mkdir(path.join(root,'a/src/test/resources'),{recursive:true});
    await fs.writeFile(path.join(root,'a/src/test/resources/application.properties'),'services.user.url=http://test.example');
    const index=await indexProject(root);
    assert.equal(index.properties['services.user.url'],undefined);
    assert(index.project.warnings.some(w=>w.includes('services.user.url')));
    for(const module of ['a','b','a/nested']){
      const entry=index.project.entries.find(e=>e.path==='/'+module)!,wf=analyze(index,entry.id);
      const dep=confirmDependency(draft,index,wf,'manual');
      assert.equal(dep.originalBase,`http://${module.replace('/','-')}.example`);
      const template=generateRequestTemplate(index,entry.id);
      assert.equal(template.path,`/${module}/app/${module}`);
      assert.doesNotThrow(()=>validateEntryRequest(index,entry.id,template));
    }
    const entry=index.project.entries.find(e=>e.path==='/shared')!;
    assert.throws(()=>confirmDependency(draft,index,analyze(index,entry.id),'manual'),/未找到此配置项/);
    assert.equal(generateRequestTemplate(index,entry.id).path,'/shared');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Conflicting files in one module are rejected and changes to colliding values invalidate the revision',async()=>{
  const root=await fixture();try{
    const before=await indexProject(root);
    await fs.appendFile(path.join(root,'a/src/main/resources/application.properties'),'services.user.url=http://new-a.example\n');
    const after=await indexProject(root);
    assert.notEqual(before.project.revision,after.project.revision);
    assert.equal(propertyForSource(after,'services.user.url','a/src/main/java/Controller.java'),'http://new-a.example');
    await fs.writeFile(path.join(root,'a/src/main/resources/application.yml'),'services:\n  user:\n    url: http://conflict.example\n');
    const conflict=await indexProject(root),entry=conflict.project.entries.find(e=>e.path==='/a')!;
    assert.throws(()=>confirmDependency(draft,conflict,analyze(conflict,entry.id),'manual'),/模块 a 中存在冲突/);
    assert.equal(propertyForSource(conflict,'services.user.url','b/src/main/java/Controller.java'),'http://b.example');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Legacy wrong module addresses cannot be reconfirmed or applied; reindex checks the owning module',async()=>{
  const root=await fixture(),bench=new Workbench({root:process.cwd(),dataDir:path.join(root,'.data')});
  try{
    await bench.importProject(root);
    const wf=await bench.analyzeEntry(bench.workspace.project!.entries.find(e=>e.path==='/a')!.id);
    const dep=await bench.saveDependency(wf.id,draft);
    assert.equal(dep.originalBase,'http://a.example');
    bench.activeWorkflow().dependencies[0].originalBase='http://b.example';
    await assert.rejects(()=>bench.confirmWorkflow(wf.id),/配置地址已变化/);
    await assert.rejects(()=>bench.applyRoutes({[dep.id]:'mock'}),/配置地址已变化/);
    await assert.rejects(()=>fs.access(path.join(root,'.mockingbird/routes.properties')));
    await bench.saveDependency(wf.id,draft,dep.id);
    await bench.confirmWorkflow(wf.id);
    await fs.appendFile(path.join(root,'a/src/main/resources/application.properties'),'services.user.url=http://new-a.example\n');
    await bench.reindex();
    await assert.rejects(()=>bench.confirmWorkflow(wf.id),/配置地址已变化/);
    await bench.saveDependency(wf.id,draft,dep.id);await bench.confirmWorkflow(wf.id);
    assert.equal(bench.activeWorkflow().dependencies[0].originalBase,'http://new-a.example');
  }finally{await bench.close();await fs.rm(root,{recursive:true,force:true});}
});
