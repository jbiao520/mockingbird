import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { indexProject, analyze } from '../server/analyzer';
import { emptyWorkspace } from '../server/storage';
import { projectLaunchCommand } from '../server/launch';
import { ProjectLauncher, routePreview } from '../server/routes';
import { resolveBuildExecutable } from '../server/build-environment';

async function multiModule(root:string){
  await fs.writeFile(path.join(root,'pom.xml'),'<project><packaging>pom</packaging><properties><spring-boot.version>3.4.5</spring-boot.version></properties><modules><module>checkout-service</module><module>order-service</module></modules></project>');
  for(const name of ['checkout-service','order-service']){
    const dir=path.join(root,name);await fs.mkdir(path.join(dir,'src/main/java'),{recursive:true});
    await fs.writeFile(path.join(dir,'pom.xml'),'<project><parent><artifactId>parent</artifactId></parent><artifactId>'+name+'</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
    await fs.writeFile(path.join(dir,'src/main/java/Controller.java'),'@RestController public class Controller { @GetMapping("/'+name+'") public String get(){return "ok";} }');
  }
  const index=await indexProject(root),ws=emptyWorkspace();ws.project=index.project;
  ws.workflows=index.project.entries.map(e=>analyze(index,e.id));ws.activeWorkflowId=ws.workflows[0].id;return ws;
}

test('Maven launcher follows the selected Flow and inherited Boot version',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"mockingbird launch ' "));
  try{
    const ws=await multiModule(root);
    for(const wf of ws.workflows){
      ws.activeWorkflowId=wf.id;const spec=await projectLaunchCommand(ws,18123);
      assert.equal(spec.cwd,ws.project!.path);assert.equal(spec.args[0],'-f');
      assert.equal(spec.args[1],path.join(ws.project!.path,wf.entry.path.slice(1),'pom.xml'));
      assert.equal(spec.args[2],'org.springframework.boot:spring-boot-maven-plugin:3.4.5:run');
      assert(spec.args[3].includes('--server.port=18123'));
      assert.equal((await routePreview(ws,9090,18123)).command,spec.command);
      assert(spec.command.includes("'\\''"));
    }
    ws.activeWorkflowId=undefined;await assert.rejects(()=>projectLaunchCommand(ws),/先选择/);
    ws.activeWorkflowId=ws.workflows[0].id;ws.workflows[0].entry.file='../other/Controller.java';
    await assert.rejects(()=>projectLaunchCommand(ws),/项目范围/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Single-module Maven project keeps its root and managed plugin version',async()=>{
  const ws=emptyWorkspace(),index=await indexProject('examples/payment-service');ws.project=index.project;
  const spec=await projectLaunchCommand(ws);assert.equal(spec.cwd,index.project.path);
  assert.equal(spec.args[0],'org.springframework.boot:spring-boot-maven-plugin:3.5.7:run');assert(!spec.args.includes('-f'));
});

test('Explicit plugin versions override Boot dependency versions',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-version-'));
  try{
    const ws=await multiModule(root),pom=path.join(root,'checkout-service/pom.xml');
    await fs.writeFile(pom,'<project><parent><artifactId>parent</artifactId></parent><properties><plugin.version>3.4.6</plugin.version></properties><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId><version>${plugin.version}</version></plugin></plugins></build></project>');
    ws.activeWorkflowId=ws.workflows.find(w=>w.entry.path==='/checkout-service')!.id;
    assert((await projectLaunchCommand(ws)).args.includes('org.springframework.boot:spring-boot-maven-plugin:3.4.6:run'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Gradle multi-module launch uses the selected task and root wrapper',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-gradle-launch-'));
  try{
    const ws=await multiModule(root);ws.project!.build='Gradle';
    await fs.writeFile(path.join(root,'build.gradle'),'');await fs.writeFile(path.join(root,'gradlew'),'');
    for(const module of ws.project!.modules)await fs.writeFile(path.join(root,module,'build.gradle.kts'),'');
    const spec=await projectLaunchCommand(ws);
    assert.equal(spec.executable,path.join(ws.project!.path,'gradlew'));assert.equal(spec.args[0],':checkout-service:bootRun');
    assert(spec.args[1].startsWith('--args=--spring.config.additional-location='));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('ProjectLauncher spawns the wrapper with module arguments and reaches running',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-wrapper-')),launcher=new ProjectLauncher(()=>{});
  const probe=net.createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=(probe.address() as net.AddressInfo).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  try{
    const ws=await multiModule(root);
    await fs.mkdir(path.join(root,'.mockingbird'));await fs.writeFile(path.join(root,'.mockingbird/routes.properties'),'');
    const wrapper=path.join(root,'mvnw');
    await fs.writeFile(wrapper,`#!${process.execPath}\nconst fs=require('node:fs'),net=require('node:net');const args=process.argv.slice(2);fs.writeFileSync('launch-args.json',JSON.stringify(args));if(args[0]!=='-f'||!args[1].endsWith('/checkout-service/pom.xml'))process.exit(2);net.createServer(s=>s.end()).listen(${port},'127.0.0.1');\n`,{mode:0o755});
    const expected=await projectLaunchCommand(ws,port);await launcher.start(ws,port);
    for(let i=0;i<60&&launcher.state.status==='starting';i++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(launcher.state.status,'running',launcher.state.logs.join('\n'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'launch-args.json'),'utf8')),expected.args);
    assert.equal(launcher.state.logs[0],'$ '+expected.command);
    await launcher.stop();assert.equal(launcher.state.status,'stopped');
  }finally{await launcher.stop();await fs.rm(root,{recursive:true,force:true});}
});

test('Finder environment discovers custom Maven and preserves shell Java settings',async()=>{
  if(process.platform==='win32')return;
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-finder-'));
  const probe=net.createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=(probe.address() as net.AddressInfo).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  try{
    const ws=await multiModule(root),bin=path.join(root,'custom-maven/bin'),jdk=path.join(root,'custom-jdk'),shell=path.join(root,'login-shell');
    await fs.mkdir(bin,{recursive:true});await fs.mkdir(path.join(jdk,'bin'),{recursive:true});
    await fs.symlink(process.execPath,path.join(bin,'node'));
    await fs.writeFile(path.join(bin,'mvn'),`#!/usr/bin/env node\nconst fs=require('node:fs'),net=require('node:net');fs.writeFileSync('finder-launch.json',JSON.stringify({args:process.argv.slice(2),javaHome:process.env.JAVA_HOME,path:process.env.PATH}));net.createServer(s=>s.end()).listen(${port},'127.0.0.1');`,{mode:0o755});
    await fs.writeFile(shell,`#!/bin/sh\nexport PATH="${bin}"\nexport JAVA_HOME="${jdk}"\nprintf 'shell startup banner\\n'\nexec /bin/sh -c "$2"\n`,{mode:0o755});
    await fs.mkdir(path.join(root,'.mockingbird'));await fs.writeFile(path.join(root,'.mockingbird/routes.properties'),'');
    const workspaceFile=path.join(root,'workspace.json');await fs.writeFile(workspaceFile,JSON.stringify(ws));
    const source=`import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {ProjectLauncher} from './server/routes.ts';import {projectLaunchCommand} from './server/launch.ts';
      process.versions.electron='test';const ws=JSON.parse(await fs.readFile(process.argv[1],'utf8')),port=Number(process.argv[2]),launcher=new ProjectLauncher(()=>{});
      try{const spec=await projectLaunchCommand(ws,port);assert(spec.executable.endsWith('/custom-maven/bin/mvn'));assert(spec.env.JAVA_HOME.endsWith('/custom-jdk'));
        await launcher.start(ws,port);for(let i=0;i<80&&launcher.state.status==='starting';i++)await new Promise(r=>setTimeout(r,50));assert.equal(launcher.state.status,'running',launcher.state.logs.join('\\n'));
        const actual=JSON.parse(await fs.readFile(path.join(ws.project.path,'finder-launch.json'),'utf8'));assert.deepEqual(actual.args,spec.args);assert.equal(actual.javaHome,spec.env.JAVA_HOME);assert(actual.path.includes('/custom-jdk/bin'));
      }finally{await launcher.stop();}`;
    await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',source,workspaceFile,String(port)],{cwd:process.cwd(),env:{...process.env,PATH:'/usr/bin:/bin',SHELL:shell,JAVA_HOME:undefined,MAVEN_HOME:undefined,M2_HOME:undefined,GRADLE_HOME:undefined},timeout:15000});
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Missing build tool reports a useful error before spawn',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-missing-build-'));
  try{await assert.rejects(()=>resolveBuildExecutable('mvn',{PATH:root}),/未找到 mvn.*MAVEN_HOME/);}
  finally{await fs.rm(root,{recursive:true,force:true});}
});
