import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Entry, Workspace } from '../shared/types';
import { exists, sourceModule } from './analyzer';
import { buildEnvironment, resolveBuildExecutable } from './build-environment';
import { emptyRunConfig, normalizeRunConfig, readRoutes, resolveRuntime } from './runtime-config';

const pluginArg=(token:string)=>/\s/.test(token)?'"'+token.replaceAll('"','\\"')+'"':token;

const shellQuote=(value:string)=>/^[\w./:=@-]+$/.test(value)?value:"'"+value.replaceAll("'","'\\''")+"'";
const xmlText=(xml:string,tag:string)=>new RegExp(`<${tag}\\s*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1].trim();

// Read local parent POMs so unversioned plugins use the project's Boot version.
async function bootGoal(pom:string,root:string):Promise<string>{
  const poms:string[]=[],seen=new Set<string>();
  while(!seen.has(pom)){
    seen.add(pom);
    const xml=(await fs.readFile(pom,'utf8')).replace(/<!--[\s\S]*?-->/g,'');poms.unshift(xml);
    const parent=xmlText(xml,'parent');if(!parent)break;
    const relative=xmlText(parent,'relativePath');if(relative===''||/<relativePath\s*\/>/.test(parent))break;
    const next=path.resolve(path.dirname(pom),relative??'../pom.xml');
    if(!next.startsWith(root+path.sep)||!await exists(next))break;pom=next;
  }
  const properties:Record<string,string>={};let pluginVersion:string|undefined,bootVersion:string|undefined;
  for(const xml of poms){
    for(const m of (xmlText(xml,'properties')||'').matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g))properties[m[1]]=m[2].trim();
    const parent=xmlText(xml,'parent');
    if(parent&&xmlText(parent,'artifactId')==='spring-boot-starter-parent')bootVersion=xmlText(parent,'version');
    for(const m of xml.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g))if(xmlText(m[1],'artifactId')==='spring-boot-dependencies')bootVersion=xmlText(m[1],'version');
    for(const m of xml.matchAll(/<plugin\b[^>]*>([\s\S]*?)<\/plugin>/g))if(xmlText(m[1],'artifactId')==='spring-boot-maven-plugin')pluginVersion=xmlText(m[1],'version')||pluginVersion;
  }
  let version=pluginVersion||bootVersion||properties['spring-boot.version'];
  for(let i=0;version&&i<10&&version.includes('${');i++)version=version.replace(/\$\{([^}]+)\}/g,(match,key)=>properties[key]??match);
  return version&&/^[\w.+-]+$/.test(version)?`org.springframework.boot:spring-boot-maven-plugin:${version}:run`:'spring-boot:run';
}

export async function projectRuntimePlan(ws:Workspace,port=18080,configPath?:string,previewRoutes?:Record<string,string>,keys?:string[],entryOverride?:Entry){
  if(!ws.project)throw new Error('请先导入项目');
  const root=path.resolve(ws.project.path),workflow=ws.workflows.find(w=>w.id===ws.activeWorkflowId);
  const entry=entryOverride??workflow?.entry;
  const runConfig=normalizeRunConfig(ws.runConfig??emptyRunConfig());
  let module=root;
  const buildFile=async(dir:string)=>ws.project!.build==='Maven'?await exists(path.join(dir,'pom.xml')):await exists(path.join(dir,'build.gradle'))||await exists(path.join(dir,'build.gradle.kts'));
  if(runConfig.module){
    if(runConfig.module!=='.'&&!ws.project.modules.includes(runConfig.module))throw new Error('运行模块不存在：'+runConfig.module);
    module=path.resolve(root,runConfig.module);
    const relative=path.relative(root,module);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('运行模块不在项目范围内');
    if(!await buildFile(module))throw new Error('运行模块没有构建文件');
  }else if(entry){
    const source=path.resolve(root,entry.file);
    if(!source.startsWith(root+path.sep))throw new Error('Flow 入口不在项目范围内');
    module=path.dirname(source);
    while(module!==root&&!await buildFile(module))module=path.dirname(module);
  }else if(ws.project.modules.some(m=>m!=='.'))throw new Error('多模块项目请先选择要运行的 API Flow');
  const location=configPath||path.join(root,'.mockingbird/routes.properties');
  const routes=previewRoutes??await readRoutes(location);
  const moduleLabel=module===root?'.':path.relative(root,module).split(path.sep).join('/');
  const plan=await resolveRuntime({
    root,moduleDir:module,moduleLabel,build:ws.project.build,runConfig,env:await buildEnvironment(),routes,
    keys:keys??Object.keys(routes),launchPort:port,configLocation:pathToFileURL(location).href,
    entryModule:entry?sourceModule({project:ws.project},entry.file):undefined,
  });
  return{moduleDir:module,cwd:root,location,...plan};
}

export async function projectLaunchCommand(ws:Workspace,port=18080,configPath?:string,previewRoutes?:Record<string,string>,keys?:string[]){
  if(!ws.project)throw new Error('请先导入项目');
  const plan=await projectRuntimePlan(ws,port,configPath,previewRoutes,keys);
  const {moduleDir:module,cwd:root,location}=plan;
  const runArgs=plan.programArgs.map(pluginArg).join(' ');
  let executable:string,args:string[];
  const wrapper=ws.project.build==='Maven'?'mvnw':'gradlew';
  executable=await exists(path.join(root,wrapper))?path.join(root,wrapper):await exists(path.join(module,wrapper))?path.join(module,wrapper):await resolveBuildExecutable(ws.project.build==='Maven'?'mvn':'gradle',plan.env);
  if(ws.project.build==='Maven'){
    const pom=path.join(module,'pom.xml');
    if(xmlText((await fs.readFile(pom,'utf8')).replace(/<!--[\s\S]*?-->/g,''),'packaging')==='pom')throw new Error('Flow 对应聚合模块，无法启动；请选择应用模块中的 API Flow');
    args=[...(module===root?[]:['-f',pom]),await bootGoal(pom,root),`-Dspring-boot.run.arguments=${runArgs}`,...(plan.jvmArguments?[`-Dspring-boot.run.jvmArguments=${plan.jvmArguments}`]:[])];
  }else{
    const task=module===root?'bootRun':':'+path.relative(root,module).split(path.sep).join(':')+':bootRun';
    args=[task,`--args=${runArgs}`];
  }
  return{...plan,executable,args,command:[executable,...args].map(shellQuote).join(' ')};
}
