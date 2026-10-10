import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Workbench } from '../server/workbench';
const root=process.cwd(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-cli-')),project=path.join(temp,'payment-service');
await fs.cp(path.join(root,'examples/payment-service'),project,{recursive:true,filter:s=>!s.includes('/target')&&!s.includes('/.mockingbird')});
const bench=new Workbench({root,dataDir:path.join(temp,'data')});const results:unknown[]=[];
const selected=process.env.AGENT_FILTER||(process.argv.includes('--grok')?'grok':process.argv.includes('--opencode')?'opencode':'codex');
try{await bench.init();await bench.importProject(project);await bench.analyzeEntry(bench.workspace.project!.entries[0].id);
  for(const agent of bench.agents.filter(a=>a.id===selected)){
    console.log(`Testing ${agent.id} ${agent.version}`);
    const task=await bench.chat(agent.id,'发现当前支付 API 的所有 HTTP 下游，返回 dependencies 候选及文件行号，沿调用阅读源码快照。不要生成 Mock，rules=[]。',agent.id==='opencode'?process.env.OPENCODE_TEST_MODEL:agent.id==='grok'?process.env.GROK_TEST_MODEL:undefined);
    while(task.status==='running')await new Promise(r=>setTimeout(r,1000));
    console.log(JSON.stringify({agent:agent.id,status:task.status,summary:task.summary,error:task.error}));
    results.push({agent:agent.id,version:agent.version,model:agent.id==='opencode'?process.env.OPENCODE_TEST_MODEL:agent.id==='grok'?process.env.GROK_TEST_MODEL:undefined,status:task.status,summary:task.summary,error:task.error});
    if(task.status!=='completed')process.exitCode=1;
    if(task.status==='completed'){
      assert.equal(task.dependencyProposal?.length,4);
      assert.equal(bench.activeWorkflow().dependencies.length,0);
      for(const [i,draft] of task.dependencyProposal!.entries())await bench.saveDependency(task.workflowId!,draft,undefined,task.id,i);
    }
    if(task.status==='completed'&&process.argv.includes('--generate')){
      const generated=await bench.chat(agent.id,'为当前 Flow 的全部四个依赖生成 Success Mock，HTTP 200。严格使用上下文 contracts 中提供的四个响应样本，保持所有字段和类型；summary 简短列出依据。rules 必须覆盖四个 dependencyId，body 为 JSON 字符串。');
      while(generated.status==='running')await new Promise(r=>setTimeout(r,1000));
      assert.equal(generated.status,'completed',generated.error);assert.equal(generated.proposal?.length,4);
      assert.equal(bench.workspace.rules.length,0,'AI candidates must not publish without approval');
      await bench.approveTask(generated.id);assert.equal(bench.workspace.rules.length,4);assert(generated.approved);
      results.push({agent:agent.id,operation:'mock-generation-and-approval',status:generated.status,rules:generated.proposal?.length,summary:generated.summary});
      console.log(`✓ ${agent.id}: 4 AI-generated candidate mocks validated and explicitly approved`);
      const cancelled=await bench.chat(agent.id,'进一步详细分析当前支付 Flow 的所有业务分支。');bench.agentManager.cancel(cancelled.id);assert.equal(cancelled.status,'cancelled');results.push({agent:agent.id,operation:'cancel',status:cancelled.status});console.log(`✓ ${agent.id}: task cancellation`);
    }
  }
}finally{await bench.close();await fs.mkdir(path.join(root,'artifacts'),{recursive:true});const file=path.join(root,'artifacts/agent-report.json');let reports:any[]=[];try{const previous=JSON.parse(await fs.readFile(file,'utf8'));reports=previous.runs||[previous];}catch{}reports.push({at:new Date().toISOString(),results});await fs.writeFile(file,JSON.stringify({runs:reports},null,2));await fs.rm(temp,{recursive:true,force:true});}
