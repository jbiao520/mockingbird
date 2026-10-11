import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import type { ApplicationState } from '../shared/types';
import TabContextMenu from './TabContextMenu';

export default function ProjectTabs({projects,activeId,busy,onSwitch,onClose,onCloseMany,onOpen}:{
  projects:ApplicationState['projects'];activeId:string;busy:boolean;
  onSwitch:(id:string)=>void;onClose:(id:string)=>void;onCloseMany:(ids:string[])=>void;onOpen:()=>void;
}){
  const list=useRef<HTMLDivElement>(null),focusOnSwitch=useRef(false);
  const [menu,setMenu]=useState<{id:string;x:number;y:number}|null>(null);
  const openMenu=(event:MouseEvent<HTMLDivElement>,id:string)=>{
    event.preventDefault();
    const rect=event.currentTarget.getBoundingClientRect();
    setMenu({id,x:event.clientX||rect.left,y:event.clientY||rect.bottom});
  };
  const target=projects.find(project=>project.id===menu?.id);
  const openIds=projects.filter(project=>!project.closing).map(project=>project.id);
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
      {projects.map((project,index)=><div className={`project-tab ${project.id===activeId?'active':''}`} key={project.id} role="presentation" onContextMenu={event=>openMenu(event,project.id)}>
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
    {target&&<TabContextMenu x={menu!.x} y={menu!.y} label="项目标签菜单" onClose={()=>setMenu(null)} items={[
      {id:'close',label:'关闭',disabled:busy||target.closing,title:'关闭此项目。先保存编辑草稿，再停止它的服务和任务',onSelect:()=>onClose(target.id)},
      {id:'keep',label:'仅保留当前',disabled:busy||target.closing||openIds.length<2,title:'关闭其他项目，只留下这个。每个项目都会先保存草稿',onSelect:()=>onCloseMany(openIds.filter(id=>id!==target.id))},
      {id:'all',label:'关闭所有',disabled:busy||!openIds.length,title:'关闭此窗口中的全部项目。每个项目都会先保存草稿',onSelect:()=>onCloseMany(openIds)},
    ]}/>}
  </nav>;
}
