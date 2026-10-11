import { useEffect, useRef, type KeyboardEvent } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import type { ApplicationState } from '../shared/types';

export default function ProjectTabs({projects,activeId,busy,onSwitch,onClose,onOpen}:{
  projects:ApplicationState['projects'];activeId:string;busy:boolean;
  onSwitch:(id:string)=>void;onClose:(id:string)=>void;onOpen:()=>void;
}){
  const list=useRef<HTMLDivElement>(null),focusOnSwitch=useRef(false);
  useEffect(()=>{
    const selected=list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    selected?.parentElement?.scrollIntoView({block:'nearest',inline:'nearest'});
    if(focusOnSwitch.current&&!busy){selected?.focus({preventScroll:true});focusOnSwitch.current=false;}
  },[activeId,busy]);
  const navigate=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
    const available=projects.filter(project=>!project.closing);
    const current=available.findIndex(project=>project.id===projects[index].id);
    let target;
    if(event.key==='ArrowRight')target=available[(current+1)%available.length];
    else if(event.key==='ArrowLeft')target=available[(current-1+available.length)%available.length];
    else if(event.key==='Home')target=available[0];
    else if(event.key==='End')target=available.at(-1);
    else return;
    event.preventDefault();
    if(target&&!busy&&target.id!==activeId){focusOnSwitch.current=true;onSwitch(target.id);}
  };
  return <nav className="project-tab-bar" aria-label="项目导航">
    <div className="project-tabs" role="tablist" aria-label="已打开项目" ref={list}>
      {projects.map((project,index)=><div className={`project-tab ${project.id===activeId?'active':''}`} key={project.id} role="presentation">
        <button id={'project-tab-'+project.id} role="tab" aria-label={project.name} aria-selected={project.id===activeId} aria-controls={'project-panel-'+project.id}
          tabIndex={project.id===activeId||activeId==='welcome'&&index===0?0:-1} disabled={busy||project.closing} title={project.path}
          onClick={()=>onSwitch(project.id)} onKeyDown={event=>navigate(event,index)}>
          <FolderOpen size={14}/><span>{project.name}</span>
          {(project.runtime.status==='running'||project.launch.status==='running'||project.runningTasks>0)&&<span className="status-dot green" aria-label="项目有运行中的服务或任务"/>}
        </button>
        <button className="project-tab-close" aria-label={'关闭项目 '+project.name} title={'关闭项目（停止该项目的服务和任务）\n'+project.path} disabled={busy||project.closing} onClick={()=>onClose(project.id)}><X size={12}/></button>
      </div>)}
    </div>
    <button className="project-tab-add" aria-label="打开新项目" title="打开项目到新 Tab" disabled={busy} onClick={onOpen}><Plus size={16}/></button>
  </nav>;
}
