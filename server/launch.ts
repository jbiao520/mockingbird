import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Workspace } from '../shared/types';
import { exists } from './analyzer';

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

export async function projectLaunchCommand(ws:Workspace,port=18080){
  if(!ws.project)throw new Error('请先导入项目');
  const root=path.resolve(ws.project.path),workflow=ws.workflows.find(w=>w.id===ws.activeWorkflowId);
  let module=root;
  const buildFile=async(dir:string)=>ws.project!.build==='Maven'?await exists(path.join(dir,'pom.xml')):await exists(path.join(dir,'build.gradle'))||await exists(path.join(dir,'build.gradle.kts'));
  if(workflow){
    const source=path.resolve(root,workflow.entry.file);
    if(!source.startsWith(root+path.sep))throw new Error('Flow 入口不在项目范围内');
    module=path.dirname(source);
    while(module!==root&&!await buildFile(module))module=path.dirname(module);
  }else if(ws.project.modules.some(m=>m!=='.'))throw new Error('多模块项目请先选择要运行的 API Flow');
  const location=path.join(root,'.mockingbird/routes.properties');
  const runArgs=`--spring.config.additional-location=${pathToFileURL(location).href} --server.port=${port} --server.address=127.0.0.1`;
  let executable:string,args:string[];
  const wrapper=ws.project.build==='Maven'?'mvnw':'gradlew';
  executable=await exists(path.join(root,wrapper))?path.join(root,wrapper):await exists(path.join(module,wrapper))?path.join(module,wrapper):ws.project.build==='Maven'?'mvn':'gradle';
  if(ws.project.build==='Maven'){
    const pom=path.join(module,'pom.xml');
    if(xmlText((await fs.readFile(pom,'utf8')).replace(/<!--[\s\S]*?-->/g,''),'packaging')==='pom')throw new Error('Flow 对应聚合模块，无法启动；请选择应用模块中的 API Flow');
    args=[...(module===root?[]:['-f',pom]),await bootGoal(pom,root),`-Dspring-boot.run.arguments=${runArgs}`];
  }else{
    const task=module===root?'bootRun':':'+path.relative(root,module).split(path.sep).join(':')+':bootRun';
    args=[task,`--args=${runArgs}`];
  }
  return{executable,args,cwd:root,location,module,command:[executable,...args].map(shellQuote).join(' ')};
}
