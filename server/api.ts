import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { Workbench, type Options } from './workbench';
import { detectAgents } from './agents';
import { redact } from './runtime';
import { exportMocks } from './exports';
import { discoverModels } from './models';
import type { Server } from 'node:http';

export async function createServer(options:Options,port=4317){
  const workbench=new Workbench(options);await workbench.init();
  const app=express();
  let actualPort=port;
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    const host=req.headers.host||'';
    if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host))return res.status(403).json({error:'仅允许本机连接'});
    if(req.path.startsWith('/api')){
      const origin=req.headers.origin;
      const allowed=new Set([`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`,...(process.env.NODE_ENV!=='production'?['http://127.0.0.1:5173','http://localhost:5173']:[])]);
      if(origin&&!allowed.has(origin))return res.status(403).json({error:'拒绝跨源请求'});
      if(!['GET','HEAD'].includes(req.method)&&!req.is('application/json'))return res.status(415).json({error:'请求必须使用 application/json'});
    }
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');next();
  });
  app.use(express.json({limit:'5mb'}));
  const handle=(fn:(req:express.Request)=>unknown,serial=false):express.RequestHandler=>async(req,res)=>{
    try{const value=await(serial?workbench.serial(()=>Promise.resolve(fn(req))):fn(req));res.json(value??{ok:true});}
    catch(e){const message=redact((e as Error).message);res.status(400).json({error:message});}
  };
  app.get('/api/state',handle(()=>workbench.state()));
  app.post('/api/projects/choose',handle(async()=>{if(!options.chooseDirectory)throw new Error('目录选择器只在桌面应用中可用，请输入本地路径');return{path:await options.chooseDirectory()};}));
  app.post('/api/projects/import',handle(req=>workbench.importProject(String(req.body.path||'')),true));
  app.post('/api/projects/reindex',handle(()=>workbench.reindex(),true));
  app.get('/api/source',handle(async req=>({source:await workbench.source(String(req.query.path||''))})));
  app.post('/api/workflows/analyze',handle(req=>workbench.analyzeEntry(req.body.entryId),true));
  app.post('/api/workflows/dependencies',handle(req=>workbench.saveDependency(req.body.workflowId,req.body.dependency,req.body.dependencyId,req.body.taskId,req.body.candidateIndex),true));
  app.post('/api/workflows/dependencies/remove',handle(req=>workbench.removeDependency(req.body.workflowId,req.body.dependencyId),true));
  app.post('/api/workflows/confirm',handle(req=>workbench.confirmWorkflow(req.body.id),true));
  app.post('/api/workflows/select',handle(req=>workbench.selectWorkflow(req.body.id),true));
  app.post('/api/rules/generate',handle(req=>({rules:workbench.generate(req.body.ids,req.body.scenario,req.body.workflowId)})));
  app.post('/api/rules/generate/ai',handle(req=>workbench.generateWithAgent(req.body),true));
  app.put('/api/rules',handle(req=>workbench.setRules(req.body.rules),true));
  app.post('/api/rules/export',handle(async req=>{
    const artifact=exportMocks(req.body.rules??workbench.workspace.rules,req.body.format,workbench.workspace.project?.name,workbench.runtime.state.port,req.body.includeDisabled===true);
    if(options.saveExport){const savedPath=await options.saveExport(artifact);return{savedPath,cancelled:!savedPath};}
    return artifact;
  }));
  app.post('/api/routes/preview',handle(req=>workbench.setRoutes(req.body.routes||{},Number(req.body.launchPort||18080))));
  app.post('/api/routes/apply',handle(req=>workbench.applyRoutes(req.body.routes||{}),true));
  app.post('/api/snapshots',handle(req=>workbench.snapshot(String(req.body.name||'')),true));
  app.post('/api/snapshots/restore',handle(req=>workbench.restore(req.body.id),true));
  app.post('/api/runtime/start',handle(async req=>{const desired=Number(req.body.port||9090);if(workbench.workspace.workflows.some(w=>w.dependencies.some(d=>d.route==='mock'))&&desired!==workbench.runtime.state.port)throw new Error('Mock 路由已应用，请先恢复 Real 路由再更改服务端口');await workbench.runtime.start(desired,workbench.workspace.rules);},true));
  app.post('/api/runtime/stop',handle(()=>workbench.runtime.stop(),true));
  app.get('/api/requests',handle(async()=>({requests:await workbench.runtime.requests()})));
  app.post('/api/requests/test',handle(req=>workbench.testRequest(req.body)));
  app.post('/api/launch/start',handle(req=>workbench.launcher.start(workbench.workspace,Number(req.body.port||18080)),true));
  app.post('/api/launch/stop',handle(()=>workbench.launcher.stop(),true));
  app.post('/api/agents/detect',handle(async()=>{workbench.agents=await detectAgents();return workbench.agents;}));
  app.get('/api/agents/:id/models',handle(async req=>{
    const agent=workbench.agents.find(a=>a.id===req.params.id);if(!agent)throw new Error('不支持的 Agent');
    return{models:await discoverModels(agent)};
  }));
  app.post('/api/agents/run',handle(req=>workbench.chat(req.body.agent,req.body.prompt,req.body.model,req.body.workflowId),true));
  app.post('/api/agents/cancel',handle(req=>workbench.agentManager.cancel(req.body.id)));
  app.post('/api/agents/review',handle(req=>workbench.reviewTask(req.body.id)));
  app.post('/api/agents/approve',handle(req=>workbench.approveTask(req.body.id),true));
  app.post('/api/terminal',handle(req=>workbench.terminalCommand(req.body.command),true));
  app.use('/api',(_req,res)=>res.status(404).json({error:'API 不存在'}));
  const renderer=path.join(options.root,'dist/renderer');
  app.use(express.static(renderer));app.get('/{*path}',(_req,res)=>res.sendFile(path.join(renderer,'index.html')));
  const server=await new Promise<Server>((resolve,reject)=>{const s=app.listen(port,'127.0.0.1',()=>resolve(s));s.on('error',reject);});
  const address=server.address();if(address&&typeof address!=='string')actualPort=address.port;
  const close=async()=>{await workbench.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});};
  return{server,workbench,port:actualPort,close};
}
