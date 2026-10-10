import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../server/workbench';
import { paymentDependencies } from '../tests/fixtures';
// One real Grok 4.7 generation against the payment example with contracts removed.
// It writes a local report and does not approve, save, or publish rules.
const root=process.cwd();
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-source-gen-'));
const project=path.join(temp,'payment-service');
await fs.cp(path.join(root,'examples/payment-service'),project,{recursive:true,filter:file=>!file.split(path.sep).some(part=>['target','.mockingbird'].includes(part))});
await fs.rm(path.join(project,'src/main/resources/mockingbird-contracts.json'),{force:true});
const bench=new Workbench({root,dataDir:path.join(temp,'data')});
const report:Record<string,unknown>={at:new Date().toISOString(),model:'grok-4.7',published:false};
try{
  await bench.init();
  const grok=bench.agents.find(agent=>agent.id==='grok');
  if(!grok?.installed){report.status='skipped';report.reason='Grok CLI 未安装';}
  else{
    await bench.importProject(project);
    const wf=await bench.analyzeEntry(bench.workspace.project!.entries.find(entry=>entry.path.endsWith('/create'))!.id);
    for(const draft of paymentDependencies(bench.index!))await bench.saveDependency(wf.id,draft);
    const task=await bench.generateWithAgent({workflowId:wf.id,dependencyIds:bench.activeWorkflow().dependencies.map(dep=>dep.id),scenario:'success',instructions:'不要使用 mockingbird-contracts。请根据 PaymentService 的成功分支和各 Response 类型生成。',agent:'grok',model:'grok-4.7'});
    for(let i=0;i<180&&task.status==='running';i++)await new Promise(resolve=>setTimeout(resolve,1000));
    report.status=task.status;report.error=task.error;report.summary=task.summary;
    report.rules=task.proposal?.map(rule=>({dependencyId:rule.dependencyId,name:rule.name,status:rule.status,body:rule.body,basis:rule.basis,evidence:rule.evidence,assumptions:rule.assumptions,unresolved:rule.unresolved}));
    report.savedRules=bench.workspace.rules.length;
    if(task.status!=='completed'||bench.workspace.rules.length!==0)process.exitCode=1;
  }
}finally{
  await bench.close();
  await fs.mkdir(path.join(root,'artifacts'),{recursive:true});
  await fs.writeFile(path.join(root,'artifacts/source-generation-report.json'),JSON.stringify(report,null,2));
  await fs.rm(temp,{recursive:true,force:true});
  console.log(JSON.stringify({status:report.status,error:report.error,savedRules:report.savedRules,rules:Array.isArray(report.rules)?report.rules.length:0}));
}
