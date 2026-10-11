import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function TabContextMenu({x,y,label,items,onClose}:{
  x:number;y:number;label:string;onClose:()=>void;
  items:{id:string;label:string;disabled?:boolean;title?:string;onSelect:()=>void}[];
}){
  const menu=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
  const left=Math.max(8,Math.min(x,window.innerWidth-184)),top=Math.max(8,Math.min(y,window.innerHeight-140));
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close.current();}};
    window.addEventListener('keydown',onKey);
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
    return()=>window.removeEventListener('keydown',onKey);
  },[]);
  return createPortal(<>
    <button className="tab-context-backdrop" aria-label="关闭标签菜单" onClick={onClose} onContextMenu={event=>{event.preventDefault();onClose();}}/>
    <div ref={menu} className="tab-context-menu" role="menu" aria-label={label} style={{left,top}} onContextMenu={event=>event.preventDefault()}>
      {items.map(item=><button key={item.id} role="menuitem" type="button" title={item.title} disabled={item.disabled} onClick={()=>{if(item.disabled)return;item.onSelect();onClose();}}>{item.label}</button>)}
    </div>
  </>,document.body);
}
