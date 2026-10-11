import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, FolderOpen, Loader2, Search, X } from 'lucide-react';
import type { ApplicationState, ProjectView } from '../shared/types';
import { createApi } from './api';
import ProjectWorkbench from './ProjectWorkbench';
import ProjectTabs from './ProjectTabs';
import { ProjectSessionProvider, ProjectViewStore, projectApi, type ProjectSession } from './project-session';

declare global {interface Window {mockingbirdFlush?:()=>Promise<void>}}
type Session=Omit<ProjectSession,'active'>&{controller:AbortController};
function clientIdentity(){
  const supplied=new URL(location.href).searchParams.get('client');
  const remembered=sessionStorage.getItem('mockingbird.client');
  // A copied browser URL (or cloned sessionStorage) must not become a second editor
  // for the same client. Native windows receive their identity from the main process.
  const id=/Electron\//.test(navigator.userAgent)?supplied||remembered||crypto.randomUUID():remembered&&window.name==='mockingbird:'+remembered?remembered:crypto.randomUUID();
  sessionStorage.setItem('mockingbird.client',id);window.name='mockingbird:'+id;
  const url=new URL(location.href);url.searchParams.set('client',id);history.replaceState(null,'',url);return id;
}
export default function App(){
  const [clientId]=useState(clientIdentity),[globalApi]=useState(()=>createApi('/api',clientId));
  const [application,setApplication]=useState<ApplicationState>(),[activeId,setActiveId]=useState('welcome');
  const [ids,setIds]=useState<string[]>([]),[menu,setMenu]=useState(false),[search,setSearch]=useState('');
  const [busy,setBusy]=useState(''),[error,setError]=useState('');
  const sessions=useRef(new Map<string,Session>()),transition=useRef(false),booted=useRef(false);
  const [restoredIds]=useState<string[]>(()=>JSON.parse(sessionStorage.getItem('mockingbird.projects')||'[]'));
  const refreshVersion=useRef(0);
  const applicationRef=useRef(application);applicationRef.current=application;
  const refresh=useCallback(async()=>{const version=++refreshVersion.current,next=await globalApi<ApplicationState>('/state');if(version===refreshVersion.current)setApplication(next);return next;},[globalApi]);
  const changeActive=(id:string)=>{
    setActiveId(id);setMenu(false);const url=new URL(location.href);url.searchParams.set('client',clientId);
    if(id==='welcome')url.searchParams.delete('project');else url.searchParams.set('project',id);
    history.replaceState(null,'',url);
  };
  const detach=(id:string)=>{
    const order=[...sessions.current.keys()].filter(key=>key!=='welcome'),index=order.indexOf(id);
    const session=sessions.current.get(id);session?.store.dispose();session?.controller.abort();sessions.current.delete(id);
    setIds([...sessions.current.keys()].filter(key=>key!=='welcome'));
    if(activeId===id){
      const candidates=[...order.slice(index+1),...order.slice(0,index).reverse()];
      const next=candidates.find(key=>sessions.current.has(key)&&applicationRef.current?.projects.some(p=>p.id===key&&(!p.ownerId||p.ownerId===clientId)&&!p.closing));
      changeActive(next||'welcome');
    }
  };
  const mount=async(id:string)=>{
    if(sessions.current.has(id))return;
    const request=createApi('/api/projects/'+encodeURIComponent(id),clientId);
    const view=await request<ProjectView>('/view'),controller=new AbortController();
    const store=new ProjectViewStore(view,request,setError);
    sessions.current.set(id,{projectId:id,clientId,store,api:projectApi(id,clientId,controller.signal,store),globalApi,controller});
    setIds([...sessions.current.keys()].filter(key=>key!=='welcome'));
  };
  const activate=async(id:string)=>{
    const result=await globalApi<{focused:boolean}>('/projects/'+id+'/activate',{clientId});
    if(result.focused){setMenu(false);return false;}
    await mount(id);changeActive(id);return true;
  };
  const perform=async(label:string,action:()=>Promise<void>)=>{
    if(transition.current)return;transition.current=true;setBusy(label);setError('');
    try{await action();await refresh();}catch(e){setError((e as Error).message);}finally{transition.current=false;setBusy('');}
  };
  const switchProject=(id:string)=>void perform('切换项目',async()=>{await sessions.current.get(activeId)?.store.flush();await activate(id);});
  const moveToWindow=async(id:string)=>{
    const activated=await globalApi<{focused:boolean}>('/projects/'+id+'/activate',{clientId});if(activated.focused)return;
    await sessions.current.get(id)?.store.flush();await globalApi('/projects/'+id+'/window',{clientId});
    detach(id);setMenu(false);
  };
  const open=async(path:string,newWindow=false)=>{
    if(transition.current)throw new Error('项目操作正在进行，请稍后重试');
    transition.current=true;setBusy('打开并索引项目');setError('');
    try{
      await sessions.current.get(activeId)?.store.flush();
      const result=await globalApi<{projectId:string}>('/projects/open',{path});
      if(newWindow)await moveToWindow(result.projectId);else await activate(result.projectId);
      await refresh();
    }finally{transition.current=false;setBusy('');}
  };
  const closeProject=(id:string)=>void perform('关闭项目',async()=>{
    await sessions.current.get(id)?.store.flush();await globalApi('/projects/'+id+'/close',{});
    detach(id);setMenu(false);
  });
  useEffect(()=>{
    let live=true;
    const initialize=async()=>{
      const next=await refresh();await globalApi('/session',{clientId});if(!live||booted.current)return;booted.current=true;
      const controller=new AbortController(),store=new ProjectViewStore({schemaVersion:1,values:{}},undefined,setError);
      sessions.current.set('welcome',{projectId:null,clientId,controller,store,api:globalApi,globalApi});
      const requested=new URL(location.href).searchParams.get('project');
      for(const id of restoredIds){if(next.projects.some(p=>p.id===id&&p.ownerId===clientId))await mount(id);}
      if(requested&&next.projects.some(p=>p.id===requested))await activate(requested);
      else changeActive('welcome');setIds([...sessions.current.keys()].filter(key=>key!=='welcome'));
    };
    void initialize().catch(e=>setError((e as Error).message));
    const timer=setInterval(()=>{void globalApi('/session',{clientId}).then(()=>refresh()).catch(e=>setError('无法连接本地服务：'+(e as Error).message));},1500);
    return()=>{live=false;clearInterval(timer);};
  },[globalApi,clientId,refresh]);
  useEffect(()=>{sessionStorage.setItem('mockingbird.projects',JSON.stringify(ids));},[ids]);
  useEffect(()=>{
    document.title=activeId==='welcome'?'Mockingbird':(application?.projects.find(p=>p.id===activeId)?.name||'项目')+' — Mockingbird';
    if(transition.current||!application)return;
    for(const id of sessions.current.keys()){
      if(id==='welcome')continue;
      const project=application.projects.find(p=>p.id===id);
      if(!project||(project.ownerId&&project.ownerId!==clientId))detach(id);
    }
  },[application,activeId,clientId]);
  useEffect(()=>{
    const flush=async()=>{await Promise.all([...sessions.current.values()].map(s=>s.store.flush()));};
    window.mockingbirdFlush=flush;
    const save=()=>{void flush().catch(()=>{});};
    window.addEventListener('pagehide',save);return()=>{delete window.mockingbirdFlush;window.removeEventListener('pagehide',save);};
  },[]);
  const updateModels=(models:Record<string,string>)=>{const changes=Object.fromEntries(Object.entries(models).filter(([id,value])=>applicationRef.current?.selectedModels[id]!==value));setApplication(old=>old?{...old,selectedModels:{...old.selectedModels,...changes}}:old);void globalApi('/settings/models',{models:changes},'PATCH').catch(e=>setError((e as Error).message));};
  if(!application||!sessions.current.has('welcome'))return <div className="boot-screen"><h1>Mockingbird</h1><p>{error||'正在连接本地工作台…'}</p><Loader2 className="spin"/></div>;
  const project=application.projects.find(p=>p.id===activeId),filter=search.toLowerCase();
  const projectMenu=<div className="project-switcher"><button aria-label="切换项目" aria-expanded={menu} onClick={()=>setMenu(value=>!value)}><span>{project?.name||'选择项目'}</span><ChevronDown size={13}/></button>{menu&&<>
    <button className="project-menu-backdrop" aria-label="关闭项目菜单" onClick={()=>setMenu(false)}/>
    <div className="project-menu" role="dialog" aria-label="项目切换器">
      <label className="project-search"><Search size={14}/><input autoFocus aria-label="搜索项目" value={search} placeholder="搜索项目名称或路径" onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Escape')setMenu(false);}}/></label>
      <div className="project-menu-label">已打开项目</div>
      {application.projects.filter(p=>(p.name+' '+p.path).toLowerCase().includes(filter)).map(p=><div className="project-menu-row" key={p.id}>
        <button disabled={!!busy||p.closing} onClick={()=>switchProject(p.id)} title={p.path}><span className="project-current">{p.id===activeId?<Check size={14}/>:<FolderOpen size={14}/>}</span><span><strong>{p.name}</strong><small>{p.path}</small><em>{p.ownerId&&p.ownerId!==clientId?'另一窗口 · ':''}{p.runtime.status==='running'?`Mock :${p.runtime.port} · `:''}{p.launch.status==='running'?`Java :${p.launch.port} · `:''}{p.runningTasks?`${p.runningTasks} 个 AI 任务`:p.runtime.status!=='running'&&p.launch.status!=='running'?'就绪':''}</em></span></button>
        {application.desktop&&<button aria-label={'在新窗口打开 '+p.name} disabled={!!busy} onClick={()=>void perform('在新窗口打开',()=>moveToWindow(p.id))}><ArrowUpRight size={15}/></button>}
        {(!p.ownerId||p.ownerId===clientId)&&<button aria-label={'关闭项目 '+p.name} disabled={!!busy} onClick={()=>closeProject(p.id)}><X size={14}/></button>}
      </div>)}
      {!application.projects.length&&<p className="project-menu-empty">尚未打开项目</p>}
      <div className="project-menu-label">最近项目</div>
      {application.recent.filter(p=>!application.projects.some(o=>o.path===p.path)&&(p.name+' '+p.path).toLowerCase().includes(filter)).map(p=><div className="project-menu-row" key={p.path}><button disabled={!!busy} onClick={()=>void perform('打开最近项目',async()=>{await sessions.current.get(activeId)?.store.flush();const result=await globalApi<{projectId:string}>('/projects/open',{path:p.path});await activate(result.projectId);})}><FolderOpen size={14}/><span><strong>{p.name}</strong><small>{p.path}</small></span></button></div>)}
      <button className="project-menu-open" disabled={!!busy} onClick={()=>{setMenu(false);window.dispatchEvent(new CustomEvent('mockingbird:open-project'));}}><FolderOpen size={14}/>打开 Java 项目…</button>
    </div>
  </>}</div>;
  const tabProjects=ids.flatMap(id=>{const p=application.projects.find(p=>p.id===id&&(!p.ownerId||p.ownerId===clientId));return p?[p]:[];});
  return <div className="application-shell">
    <ProjectTabs projects={tabProjects} activeId={activeId} busy={!!busy} onSwitch={switchProject} onClose={closeProject} onOpen={()=>window.dispatchEvent(new CustomEvent('mockingbird:open-project'))}/>
    {[...sessions.current].map(([id,session])=><div key={id} id={'project-panel-'+id} role={id==='welcome'?undefined:'tabpanel'} aria-labelledby={id==='welcome'?undefined:'project-tab-'+id} className="project-container" hidden={id!==activeId}><ProjectSessionProvider session={{...session,active:id===activeId}}><ProjectWorkbench application={application} onOpen={open} onModels={updateModels} projectMenu={projectMenu}/></ProjectSessionProvider></div>)}
    {busy&&<div className="project-operation" role="status"><Loader2 size={14} className="spin"/>{busy}</div>}
    {error&&<div className="toast error" role="alert"><span>{error}</span><button aria-label="关闭错误提示" onClick={()=>setError('')}><X size={14}/></button></div>}
  </div>;
}
