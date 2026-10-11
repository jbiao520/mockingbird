import type { DiagnosisClause, DiagnosisDimension, RequestLog, UnmatchedDiagnosis } from '../shared/types';
import { Plus } from 'lucide-react';

const rows: Array<{id:DiagnosisDimension;label:string}> = [
  {id:'method',label:'method'},
  {id:'path',label:'path'},
  {id:'header',label:'header'},
  {id:'query',label:'query'},
  {id:'body',label:'body'},
  {id:'enabled',label:'启用'},
  {id:'sequence',label:'调用步骤'}
];
const statusText = {match:'符合',mismatch:'不符',unconstrained:'未限制',skipped:'未比较'};

function visible(clauses:DiagnosisClause[],dimension:DiagnosisDimension){
  return clauses.filter(clause=>clause.dimension===dimension&&!clause.optional);
}
function combined(clauses:DiagnosisClause[]){
  if(clauses.some(clause=>clause.status==='mismatch'))return 'mismatch' as const;
  if(clauses.some(clause=>clause.status==='skipped'))return 'skipped' as const;
  if(clauses.some(clause=>clause.status==='match'))return 'match' as const;
  return 'unconstrained' as const;
}

export function RequestLogDialog({log,diagnosis,error,candidateId,checked,busy,onCandidate,onToggle,onAdopt,onReset,onSample,onClose}:{log:RequestLog;diagnosis:UnmatchedDiagnosis|null;error:string;candidateId:string;checked:string[];busy:boolean;onCandidate:(id:string)=>void;onToggle:(id:string,on:boolean)=>void;onAdopt:()=>void;onReset:(ruleId:string)=>void;onSample:()=>void;onClose:()=>void}){
  return <>
    <div className="modal-body">
      <div className="request-summary"><b className={`http-method ${log.method.toLowerCase()}`}>{log.method}</b><code>{log.url}</code><span className="badge">{log.fault?'传输失败':log.status}</span></div>
      <p>{log.matched?log.rule:'没有匹配的规则'} · {log.duration||0} ms</p>
      <div className="section-label">REQUEST</div>
      <pre className="config-preview">{log.body||'(empty)'}</pre>
      <div className="section-label">RESPONSE</div>
      <pre className="config-preview">{log.fault||log.response||'(empty)'}</pre>
      {!log.matched&&<RequestDiagnosis diagnosis={diagnosis} error={error} loading={!diagnosis&&!error} candidateId={candidateId} checked={checked} onCandidate={onCandidate} onToggle={onToggle} onAdopt={onAdopt} onReset={onReset} busy={busy}/>}
    </div>
    <div className="modal-footer"><button disabled={!log.ruleId} onClick={onSample}><Plus size={13}/>保存为请求样例</button><button onClick={onClose}>关闭</button></div>
  </>;
}
export default function RequestDiagnosis({diagnosis,error,loading,candidateId,checked,onCandidate,onToggle,onAdopt,onReset,busy}:{diagnosis:UnmatchedDiagnosis|null;error:string;loading:boolean;candidateId:string;checked:string[];onCandidate:(id:string)=>void;onToggle:(id:string,on:boolean)=>void;onAdopt:()=>void;onReset:(ruleId:string)=>void;busy:boolean}){
  if(loading)return <p className="diagnosis-status">正在对照已发布的规则…</p>;
  if(error)return <p className="error-text">{error}</p>;
  if(!diagnosis)return null;
  const candidate=diagnosis.candidates.find(item=>item.id===candidateId)||diagnosis.candidates[0];
  const identity=!!candidate&&candidate.pathMatched&&candidate.methodMatched;
  const proposals=candidate?.clauses.filter(clause=>clause.proposal)||[];
  const sequence=candidate?.clauses.find(clause=>clause.id==='sequence'&&clause.status==='mismatch');
  return <section className="diagnosis" aria-label="未匹配诊断">
    <div className="section-label">最接近的规则</div>
    <p>{diagnosis.message} 对照的是已经保存并发布的规则。</p>
    {!!diagnosis.candidates.length&&candidate&&<>
      <div className="diagnosis-candidates" role="radiogroup" aria-label="最接近的规则">{diagnosis.candidates.map(item=><label key={item.id} className={item.id===candidate.id?'selected':''}><input type="radio" name="nearest-rule" checked={item.id===candidate.id} onChange={()=>onCandidate(item.id)}/><span><strong>{item.name}</strong><small>{item.scenario} · {item.variantLabel}{item.enabled?'':' · 未启用'}</small></span></label>)}</div>
      <table className="diagnosis-table"><tbody>{rows.map(row=>{
        const clauses=visible(candidate.clauses,row.id);
        if(!clauses.length)return null;
        const status=combined(clauses);
        return <tr key={row.id}><th>{row.label}</th><td className={status==='mismatch'?'error-text':status==='match'?'text-green':''}>{statusText[status]}</td><td>{clauses.map(clause=>clause.summary).join(' ')}</td></tr>;
      })}</tbody></table>
      {identity&&!!proposals.length&&<div className="diagnosis-options">{proposals.map(clause=><label className="switch-label" key={clause.id}><input type="checkbox" checked={checked.includes(clause.id)} onChange={event=>onToggle(clause.id,event.target.checked)}/>{clause.proposal!.label}</label>)}</div>}
      <p className="diagnosis-note">{identity?'勾选的条件会写入草稿，不会立即发布。':'method 或 path 不同，会按这次请求生成一条关闭的新规则，不改原来的接口。'}</p>
    </>}
    <div className="button-row">
      {!!candidate&&<button className="primary" disabled={busy||(identity&&!checked.length)} onClick={onAdopt}>{identity?'加入待审核草稿':'生成新规则草稿'}</button>}
      {sequence&&candidate&&<button disabled={busy} onClick={()=>onReset(candidate.ruleId)}>重置调用步骤</button>}
    </div>
  </section>;
}
