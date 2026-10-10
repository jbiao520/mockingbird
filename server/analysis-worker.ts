import { parentPort,workerData } from 'node:worker_threads';
import { indexProject,analyze } from './analyzer';
async function main(){
  try{const data=workerData;const result=data.action==='index'?await indexProject(data.value.path,message=>parentPort?.postMessage({progress:message})):analyze(data.value.index,data.value.entryId);parentPort?.postMessage({result});}
  catch(e){parentPort?.postMessage({error:(e as Error).message});}
}
void main();
