import { useState, useEffect } from 'react';
import type { DependencyDraft, FileNode, HttpMethod } from '../shared/types';
import { api } from './api';

export function javaFiles(nodes:FileNode[]):string[]{return nodes.flatMap(n=>n.directory?javaFiles(n.children||[]):n.path.endsWith('.java')?[n.path]:[]);}
export default function DependencyEditor({initial,files,onSave,onCancel}:{initial:DependencyDraft;files:string[];onSave:(draft:DependencyDraft)=>Promise<void>;onCancel:()=>void}){
  const [draft,setDraft]=useState(initial),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const [source,setSource]=useState('');
  useEffect(()=>{
    let cancelled=false;setSource('');
    if(files.includes(draft.file))void api<{source:string}>('/source?path='+encodeURIComponent(draft.file)).then(result=>{if(!cancelled)setSource(result.source);}).catch(()=>{});
    return()=>{cancelled=true;};
  },[draft.file]);
  const update=(patch:Partial<DependencyDraft>)=>setDraft(old=>({...old,...patch}));
  return <form onSubmit={async e=>{e.preventDefault();setSaving(true);setError('');try{await onSave(draft);}catch(e){setError((e as Error).message);}finally{setSaving(false);}}}>
    <div className="modal-body dependency-form">
      <p>确认请求方法和路径后加入 Flow。基础地址与配置键可稍后补充；自定义封装也可以作为 HTTP 依赖。</p>
      <div className="form-grid"><label className="field grow">依赖名称<input aria-label="依赖名称" required value={draft.name} onChange={e=>update({name:e.target.value})}/></label><label className="field grow">Client / 自定义封装<input aria-label="依赖 Client" required list="dependency-clients" value={draft.client} onChange={e=>update({client:e.target.value})}/><datalist id="dependency-clients">{['Feign','RestTemplate','WebClient','OkHttp','Custom HTTP'].map(c=><option key={c} value={c}/>)}</datalist></label></div>
      <div className="form-grid"><label className="field">请求方法<select aria-label="依赖请求方法" value={draft.method} onChange={e=>update({method:e.target.value as HttpMethod})}>{['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map(m=><option key={m}>{m}</option>)}</select></label><label className="field grow">请求路径<input aria-label="依赖请求路径" placeholder="/orders/{id}" required value={draft.path} onChange={e=>update({path:e.target.value})}/></label></div>
      <label className="field">基础地址（可选）<input aria-label="依赖基础地址" placeholder="https://api.example.com" value={draft.originalBase} onChange={e=>update({originalBase:e.target.value})}/></label>
      <div className="form-grid"><label className="field grow">URL 配置键（可选）<input aria-label="依赖配置键" placeholder="services.order.url" value={draft.configKey} onChange={e=>update({configKey:e.target.value})}/></label><label className="field grow">响应类型（可选）<input aria-label="依赖响应类型" placeholder="OrderResponse" value={draft.responseType} onChange={e=>update({responseType:e.target.value})}/></label></div>
      <small>配置键用于切换 Real / Mock，保存时会从项目配置读取真实地址。</small>
      <div className="form-grid"><label className="field grow">源码位置（可选）<input aria-label="依赖源码文件" list="dependency-files" value={draft.file} onChange={e=>update({file:e.target.value,callChain:[]})}/><datalist id="dependency-files">{files.map(file=><option key={file} value={file}/>)}</datalist></label><label className="field">行号<input aria-label="依赖源码行号" type="number" min="1" required value={draft.line} onChange={e=>update({line:Number(e.target.value),callChain:[]})}/></label></div>
      {source&&<pre className="dependency-evidence">{source.split('\n').slice(Math.max(0,draft.line-2),draft.line+3).map((line,i)=>`${Math.max(1,draft.line-1)+i}  ${line}`).join('\n')}</pre>}
      <label className="field">发现依据 / 待核对说明<textarea aria-label="依赖发现依据" rows={3} value={draft.note} onChange={e=>update({note:e.target.value})}/></label>
      {error&&<p className="editor-error" role="alert">{error}</p>}
    </div>
    <div className="modal-footer"><button type="button" disabled={saving} onClick={onCancel}>取消</button><button className="primary" disabled={saving} type="submit">{saving?'保存中…':'确认并保存依赖'}</button></div>
  </form>;
}
