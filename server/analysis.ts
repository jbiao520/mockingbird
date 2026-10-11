import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Index } from './analyzer';
import type { Workflow } from '../shared/types';
export function compute<T=Index|Workflow>(root:string,action:'index'|'analyze',value:unknown,progress?:(message:string)=>void,signal?:AbortSignal):Promise<T>{
  if(signal?.aborted)return Promise.reject(new Error('项目正在关闭'));
  const dev=Boolean(process.argv[1]?.endsWith('.ts'));
  const entry=path.join(root,dev?'server/analysis-worker.ts':'dist/analysis-worker.mjs');
  return new Promise((resolve,reject)=>{
    const worker=new Worker(entry,{workerData:{action,value},execArgv:dev?['--import','tsx']:[]});let settled=false;
    const finish=(error?:Error,result?:T)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(result!);};
    const abort=()=>finish(new Error('项目正在关闭'));
    const timer=setTimeout(()=>finish(new Error('索引任务超过 2 分钟，请选择更小的模块')),120000);timer.unref();
    signal?.addEventListener('abort',abort,{once:true});
    worker.on('message',data=>{if(data.progress){if(!settled)progress?.(data.progress);return;}finish(data.error?new Error(data.error):undefined,data.result);});
    worker.on('error',e=>finish(e));worker.on('exit',code=>{if(!settled)finish(new Error(`分析进程退出（${code}）`));});
  });
}
