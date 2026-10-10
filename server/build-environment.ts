import path from 'node:path';
import os from 'node:os';
import { constants, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cliEnvironment } from './cli-environment';

const exec=promisify(execFile);
const keys=['PATH','JAVA_HOME','MAVEN_HOME','M2_HOME','GRADLE_HOME'] as const;
let loginEnvironment:Promise<NodeJS.ProcessEnv>|undefined;

async function readLoginEnvironment():Promise<NodeJS.ProcessEnv>{
  if(process.platform==='win32')return{};
  const shell=process.env.SHELL||os.userInfo().shell||(process.platform==='darwin'?'/bin/zsh':'/bin/sh');
  try{
    // Only request build-related variables; shell banners are ignored by the marker.
    const command=`printf '\\0MOCKINGBIRD_BUILD_ENV\\0%s\\0%s\\0%s\\0%s\\0%s\\0' "$PATH" "$JAVA_HOME" "$MAVEN_HOME" "$M2_HOME" "$GRADLE_HOME"`;
    const {stdout}=await exec(shell,['-ilc',command],{timeout:5000,maxBuffer:256*1024});
    const marker='\0MOCKINGBIRD_BUILD_ENV\0',start=stdout.lastIndexOf(marker);
    if(start<0)return{};
    const values=stdout.slice(start+marker.length).split('\0'),environment:NodeJS.ProcessEnv={};
    keys.forEach((key,i)=>{if(values[i])environment[key]=values[i];});return environment;
  }catch{return{};}
}

export async function buildEnvironment():Promise<NodeJS.ProcessEnv>{
  const inherited=cliEnvironment(),login=await(loginEnvironment??=readLoginEnvironment());
  const environment={...inherited,...login};
  const directories=[login.PATH,inherited.PATH,...['JAVA_HOME','MAVEN_HOME','M2_HOME','GRADLE_HOME'].map(key=>environment[key]?path.join(environment[key]!,'bin'):undefined)];
  environment.PATH=[...new Set(directories.filter((d):d is string=>!!d).flatMap(d=>d.split(path.delimiter)).filter(Boolean))].join(path.delimiter);
  return environment;
}

export async function resolveBuildExecutable(name:string,env:NodeJS.ProcessEnv){
  const extensions=process.platform==='win32'?(env.PATHEXT||'.EXE;.CMD;.BAT').split(';'):[''];
  for(const directory of (env.PATH||'').split(path.delimiter).filter(Boolean)){
    for(const extension of extensions){
      const candidate=path.resolve(directory,name+extension);
      try{await fs.access(candidate,constants.X_OK);if((await fs.stat(candidate)).isFile())return candidate;}catch{/* continue searching */}
    }
  }
  throw new Error(`未找到 ${name} 可执行文件。请安装构建工具，或在 shell 配置中设置 PATH / ${name==='mvn'?'MAVEN_HOME 或 M2_HOME':'GRADLE_HOME'}，然后重启 Mockingbird。`);
}
