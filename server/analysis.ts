import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Index } from './analyzer';
import type { Workflow } from '../shared/types';
export function compute<T=Index|Workflow>(root:string,action:'index'|'analyze',value:unknown,progress?:(message:string)=>void):Promise<T>{
  const dev=Boolean(process.argv[1]?.endsWith('.ts'));
  const entry=path.join(root,dev?'server/analysis-worker.ts':'dist/analysis-worker.mjs');
  return new Promise((resolve,reject)=>{
    const worker=new Worker(entry,{workerData:{action,value},execArgv:dev?['--import','tsx']:[]});let settled=false;
    const timer=setTimeout(()=>{settled=true;void worker.terminate();reject(new Error('索引任务超过 2 分钟，请选择更小的模块'));},120000);timer.unref();
    worker.on('message',data=>{if(data.progress){progress?.(data.progress);return;}settled=true;clearTimeout(timer);void worker.terminate();data.error?reject(new Error(data.error)):resolve(data.result);});
    worker.on('error',e=>{settled=true;clearTimeout(timer);reject(e);});worker.on('exit',code=>{if(!settled){clearTimeout(timer);reject(new Error(`分析进程退出（${code}）`));}});
  });
}
