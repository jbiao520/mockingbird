import { modelDisabled, isFastModel, effectiveModel } from '../shared/agent-options';
import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, Sparkles, Square, X } from 'lucide-react';
import type { AgentInfo, AgentModel, EntryDraft, HttpMethod, Task } from '../shared/types';

const methods:HttpMethod[]=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
const agentName=(id:string)=>({codex:'Codex',opencode:'OpenCode',grok:'Grok'}[id]||id);
const defaultPrompt='找出静态索引没有列出的 HTTP 入口。请检查继承的 Controller、接口映射、组合注解和自定义路由，只返回本服务对外的 API。';

export default function EntryDiscoveryDialog({agents,agent,onAgent,model,onModel,effort,effortSelect,optionsBlocked,models,modelsLoading,modelError,onReloadModels,busy,task,onClose,onStart,onCancel,onSubmit,onRescan}:{agents:AgentInfo[];agent:string;onAgent:(id:string)=>void;model:string;onModel:(id:string)=>void;effort:string;effortSelect:ReactNode;optionsBlocked:boolean;models:AgentModel[];modelsLoading:boolean;modelError?:string;onReloadModels:()=>void;busy:boolean;task?:Task;onClose:()=>void;onStart:(input:{prompt:string;agent:string;model?:string;effort?:string})=>void;onCancel:()=>void;onSubmit:(selected:{index:number;method:HttpMethod;path:string}[])=>void;onRescan:()=>void}){
  const [prompt,setPrompt]=useState(defaultPrompt);
  const [checked,setChecked]=useState<number[]>([]);
  const [edits,setEdits]=useState<Record<number,{method:HttpMethod;path:string}>>({});
  const installed=agents.filter(item=>item.installed);
  const review=task?.status==='completed'&&!task.approved&&!!task.entryProposal;
  const proposals=task?.entryProposal||[];
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose();};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[onClose]);
  useEffect(()=>{
    if(!review)return;
    setChecked([]);
    setEdits(Object.fromEntries(proposals.map((draft,index)=>[index,{method:draft.method,path:draft.path}])));
  },[task?.id,review]);
  const toggle=(index:number)=>setChecked(old=>old.includes(index)?old.filter(item=>item!==index):[...old,index]);
  const start=()=>{
    if(!prompt.trim()||busy||task?.status==='running'||optionsBlocked||!installed.some(item=>item.id===agent))return;
    onStart({prompt:prompt.trim(),agent,model:model||effectiveModel(models,'')?.id,effort:effort||undefined});
  };
  const submit=()=>{
    if(!checked.length||busy)return;
    onSubmit(checked.map(index=>{const draft=proposals[index],edit=edits[index]||{method:draft.method,path:draft.path};return{index,method:edit.method,path:edit.path.trim()};}));
  };
  return <div className="modal-overlay" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><div className="modal wide entry-discovery" role="dialog" aria-modal="true" aria-label="AI 发现入口"><header><h2>AI 发现入口</h2><button aria-label="关闭弹窗" onClick={onClose}><X size={17}/></button></header>
    {review?<div className="modal-body"><p>{task?.summary||'选择要加入项目的入口。方法和路径可以修改，类名和源码位置来自扫描结果。'}</p>
      {!!proposals.length&&<div className="section-label">候选入口 <button type="button" onClick={()=>setChecked(proposals.map((_,index)=>index))}>全选</button><button type="button" onClick={()=>setChecked([])}>全不选</button></div>}
      <div className="candidate-list">{proposals.map((draft,index)=><Candidate key={`${task?.id}:${index}`} draft={draft} checked={checked.includes(index)} edit={edits[index]||{method:draft.method,path:draft.path}} onToggle={()=>toggle(index)} onEdit={edit=>setEdits(old=>({...old,[index]:edit}))}/>)}{!proposals.length&&<small>这次没有可提交的新入口。可以改提示后重新扫描。</small>}</div>
    </div>:<div className="modal-body"><p>静态索引只认类上直接标注的 Controller。写一段提示，让 AI 只读扫描源码，找出继承、组合注解或自定义路由上的入口。勾选后才会出现在 API 列表里。</p>
      <label className="field">提示<textarea aria-label="发现入口提示" rows={4} maxLength={4000} value={prompt} onChange={event=>setPrompt(event.target.value)}/></label>
      <div className="generate-agent"><label className="field">CLI<select aria-label="发现入口 Agent" value={installed.some(item=>item.id===agent)?agent:''} onChange={event=>onAgent(event.target.value)}><option value="">选择已安装的 CLI</option>{agents.map(item=><option key={item.id} value={item.id} disabled={!item.installed}>{agentName(item.id)}{item.installed?'':' · 未安装'}</option>)}</select></label><label className="field">模型<select aria-label="发现入口模型" value={modelsLoading?'':(model||effectiveModel(models,'')?.id||'')} disabled={!agent||agent==='local'||modelsLoading} onChange={event=>onModel(event.target.value)}>{modelsLoading?<option value="">正在识别模型…</option>:!effectiveModel(models,'')&&<option value="">{modelError?'模型加载失败':'没有可用模型'}</option>}{model&&!models.some(item=>item.id===model)&&<option value={model} disabled={isFastModel({id:model,name:model})}>{model}（已保存）</option>}{models.map(item=><option key={item.id} value={item.id} disabled={modelDisabled(item)}>{item.name}{modelDisabled(item)?' · 已禁用':''}{item.isDefault?' · 默认':''}</option>)}</select></label>{effortSelect&&<label className="field">Effort{effortSelect}</label>}<button type="button" title="刷新模型列表" aria-label="刷新发现入口模型" disabled={!agent||agent==='local'||modelsLoading} onClick={onReloadModels}>刷新</button></div>
      {modelError&&<small className="error-text">{modelError}</small>}
      {!installed.length&&<div className="editor-error">没有已安装的 CLI。本地助手不能扫描源码。</div>}
      {task?.status==='running'&&<div className="agent-running"><Loader2 size={14} className="spin"/>正在扫描源码…<button onClick={onCancel}><Square size={11}/>取消</button></div>}
      {task&&task.status!=='running'&&task.error&&<div className="editor-error">{task.error}</div>}
      {task?.status==='cancelled'&&<div className="editor-error">发现已取消。</div>}
    </div>}
    <div className="modal-footer">{review&&<button onClick={onRescan}>重新扫描</button>}<span className="spacer"/><button onClick={onClose}>关闭</button>{review?<button className="primary" disabled={!checked.length||busy} onClick={submit}>提交所选入口</button>:<button className="primary" disabled={!prompt.trim()||busy||task?.status==='running'||optionsBlocked||!installed.some(item=>item.id===agent)} onClick={start}><Sparkles size={13}/>开始扫描</button>}</div>
  </div></div>;
}

function Candidate({draft,checked,edit,onToggle,onEdit}:{draft:EntryDraft;checked:boolean;edit:{method:HttpMethod;path:string};onToggle:()=>void;onEdit:(edit:{method:HttpMethod;path:string})=>void}){
  return <div className="candidate"><label><input type="checkbox" aria-label={`选择 ${draft.className}.${draft.name}`} checked={checked} onChange={onToggle}/></label><select aria-label={`${draft.name} 的方法`} value={edit.method} onChange={event=>onEdit({...edit,method:event.target.value as HttpMethod})}>{methods.map(method=><option key={method}>{method}</option>)}</select><input aria-label={`${draft.name} 的路径`} value={edit.path} onChange={event=>onEdit({...edit,path:event.target.value})}/><small>{draft.className}.{draft.name}() · {draft.file}:{draft.line}</small>{draft.note&&<p>{draft.note}</p>}</div>;
}
