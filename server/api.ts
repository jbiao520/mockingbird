import express from 'express';
import path from 'node:path';
import { Workbench, type Options } from './workbench';
import { ProjectManager } from './projects';
import { redact } from './runtime';
import { exportMocks } from './exports';
import type { Server } from 'node:http';

export async function createServer(options:Options,port=4317){
  const projects=new ProjectManager(options);await projects.init();
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
  const client=(req:express.Request)=>req.get('X-Mockingbird-Client');
  const globalHandle=(fn:(req:express.Request)=>unknown):express.RequestHandler=>async(req,res)=>{
    try{res.json(await fn(req)??{ok:true});}catch(e){res.status(400).json({error:redact((e as Error).message)});}
  };
  app.get('/api/state',globalHandle(()=>projects.state()));
  app.post('/api/session',globalHandle(req=>projects.heartbeat(req.body.clientId)));
  app.patch('/api/settings/models',globalHandle(req=>projects.saveSettings(req.body.models)));
  app.post('/api/projects/choose',globalHandle(async req=>{if(!options.chooseDirectory)throw new Error('目录选择器只在桌面应用中可用，请输入本地路径');return{path:await options.chooseDirectory(client(req))};}));
  app.post('/api/projects/open',globalHandle(async req=>{const bench=await projects.open(String(req.body.path||''));return{projectId:bench.workspace.project!.id};}));
  app.post('/api/projects/:projectId/activate',globalHandle(req=>projects.activate(String(req.params.projectId),String(req.body.clientId||''))));
  app.post('/api/projects/:projectId/window',globalHandle(req=>projects.newWindow(String(req.params.projectId),String(req.body.clientId||''))));
  app.post('/api/projects/:projectId/close',globalHandle(req=>projects.closeProject(String(req.params.projectId),client(req))));
  app.post('/api/agents/detect',globalHandle(()=>projects.detect()));
  app.get('/api/agents/:id/models',globalHandle(async req=>({models:await projects.models(String(req.params.id),req.query.refresh==='true')})));
  const router=express.Router({mergeParams:true});
  const handle=(fn:(req:express.Request,workbench:Workbench)=>unknown,serial=false):express.RequestHandler=>async(req,res)=>{
    try{
      const id=String(req.params.projectId),workbench=projects.get(id);projects.assertOwner(id,client(req));
      const value=await workbench.track(()=>serial?workbench.serial(()=>Promise.resolve(fn(req,workbench))):Promise.resolve(fn(req,workbench)));
      res.json(value??{ok:true});
    }catch(e){res.status(400).json({error:redact((e as Error).message)});}
  };
  router.get('/state',handle(req=>projects.projectState(String(req.params.projectId))));
  router.get('/view',handle(req=>projects.readView(String(req.params.projectId))));
  router.put('/view',handle(req=>projects.saveView(String(req.params.projectId),req.body)));
  router.post('/reindex',handle((_req,workbench)=>workbench.reindex(),true));
  router.get('/source',handle(async(req,workbench)=>({source:await workbench.source(String(req.query.path||''))})));
  router.post('/workflows/analyze',handle((req,workbench)=>workbench.analyzeEntry(req.body.entryId),true));
  router.post('/workflows/dependencies',handle((req,workbench)=>workbench.saveDependency(req.body.workflowId,req.body.dependency,req.body.dependencyId,req.body.taskId,req.body.candidateIndex),true));
  router.post('/workflows/dependencies/remove',handle((req,workbench)=>workbench.removeDependency(req.body.workflowId,req.body.dependencyId),true));
  router.post('/workflows/confirm',handle((req,workbench)=>workbench.confirmWorkflow(req.body.id),true));
  router.post('/workflows/select',handle((req,workbench)=>workbench.selectWorkflow(req.body.id),true));
  router.post('/rules/generate',handle((req,workbench)=>({rules:workbench.generate(req.body.ids,req.body.scenario,req.body.workflowId)})));
  router.post('/rules/generate/ai',handle(async(req,workbench)=>workbench.generateWithAgent({...req.body,...await projects.agentOptions(req.body.agent,req.body.model,req.body.effort)}),true));
  router.put('/rules',handle((req,workbench)=>{if(req.body.revision)workbench.assertRevision(req.body.revision);return workbench.setRules(req.body.rules,req.body.reviewTaskId);},true));
  router.post('/rules/preview',handle((req,workbench)=>workbench.previewBehavior(req.body),true));
  router.post('/runtime/sequence/reset',handle((req,workbench)=>{
    const rule=workbench.workspace.rules.find(r=>r.id===req.body.ruleId);if(!rule)throw new Error('行为不存在');return workbench.runtime.resetSequence(rule);
  },true));
  router.post('/rules/export',handle(async(req,workbench)=>{
    const artifact=exportMocks(req.body.rules??workbench.workspace.rules,req.body.format,workbench.workspace.project?.name,workbench.runtime.state.port,req.body.includeDisabled===true,workbench.workspace.workflows.flatMap(w=>w.dependencies));
    if(options.saveExport){const savedPath=await options.saveExport(artifact,client(req));return{savedPath,cancelled:!savedPath};}
    return artifact;
  }));
  router.post('/routes/preview',handle((req,workbench)=>workbench.setRoutes(req.body.routes||{},Number(req.body.launchPort||workbench.launcher.state.port))));
  router.post('/routes/apply',handle((req,workbench)=>workbench.applyRoutes(req.body.routes||{}),true));
  router.post('/runtime/start',handle(async(req,workbench)=>{await projects.start(String(req.params.projectId),'mock',Number(req.body.port||workbench.runtime.state.port));},true));
  router.post('/runtime/stop',handle((_req,workbench)=>workbench.runtime.stop(),true));
  router.get('/requests',handle(async(_req,workbench)=>({requests:await workbench.runtime.requests()})));
  router.post('/requests/template',handle((req,workbench)=>workbench.requestTemplate(String(req.body.entryId||''))));
  router.post('/requests/test',handle((req,workbench)=>workbench.testRequest(req.body)));
  router.post('/launch/start',handle((req,workbench)=>projects.start(String(req.params.projectId),'launch',Number(req.body.port||workbench.launcher.state.port)),true));
  router.post('/launch/stop',handle((_req,workbench)=>workbench.launcher.stop(),true));
  router.post('/agents/run',handle(async(req,workbench)=>{const options=req.body.agent==='local'?{model:undefined,effort:undefined}:await projects.agentOptions(req.body.agent,req.body.model,req.body.effort);return workbench.chat(req.body.agent,req.body.prompt,options.model,req.body.workflowId,options.effort);},true));
  router.post('/agents/rule-edit',handle(async(req,workbench)=>{const options=await projects.agentOptions(req.body.agent,req.body.model,req.body.effort);return workbench.editRule({...req.body,...options});},true));
  router.post('/agents/cancel',handle((req,workbench)=>workbench.agentManager.cancel(req.body.id)));
  router.post('/agents/review',handle((req,workbench)=>workbench.reviewTask(req.body.id)));
  router.post('/agents/approve',handle((req,workbench)=>workbench.approveTask(req.body.id),true));
  router.post('/terminal',handle((req,workbench)=>workbench.terminalCommand(req.body.command),true));
  app.use('/api/projects/:projectId',router);
  app.use('/api',(_req,res)=>res.status(404).json({error:'API 不存在'}));
  const renderer=path.join(options.root,'dist/renderer');
  app.use(express.static(renderer));app.get('/{*path}',(_req,res)=>res.sendFile(path.join(renderer,'index.html')));
  const server=await new Promise<Server>((resolve,reject)=>{const s=app.listen(port,'127.0.0.1',()=>resolve(s));s.on('error',reject);});
  const address=server.address();if(address&&typeof address!=='string')actualPort=address.port;
  const close=async()=>{await projects.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});};
  return{server,projects,port:actualPort,close};
}
