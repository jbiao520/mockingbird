import { useMemo } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, type NodeProps, type Node } from '@xyflow/react';
import { Globe2, GitBranch, Braces, ArrowUpRight } from 'lucide-react';
import type { Dependency, Workflow } from '../shared/types';
interface FlowData extends Record<string,unknown>{title:string;subtitle:string;kind:'entry'|'method'|'http';method?:string;client?:string;route?:string;unresolved?:boolean;selected?:boolean}
function FlowNode({data}:NodeProps<Node<FlowData>>){
  const Icon=data.kind==='http'?Globe2:data.kind==='entry'?Braces:GitBranch;
  return <div className={`flow-node ${data.kind} ${data.selected?'picked':''}`}>
    {data.kind!=='entry'&&<Handle type="target" position={Position.Top}/>}
    <div className="node-top"><span className="node-symbol"><Icon size={15}/></span><span>{data.kind==='entry'?'API ENTRY':data.kind==='http'?'HTTP DEPENDENCY':'BUSINESS LOGIC'}</span>{data.kind==='http'&&<span className={`badge ${data.unresolved?'warning':data.route==='mock'?'purple':'green'}`}>{data.unresolved?'待确认':data.route==='mock'?'Mock':'Real'}</span>}</div>
    <strong>{data.title}</strong><div className="node-sub"><span>{data.method&&<b className={`http-method ${data.method.toLowerCase()}`}>{data.method}</b>} {data.subtitle}</span></div>
    <div className="node-bottom"><span>{data.client||'Java · 调用位置'}</span><ArrowUpRight size={12}/></div>
    {data.kind!=='http'&&<Handle type="source" position={Position.Bottom}/>}
  </div>;
}
const nodeTypes={card:FlowNode};
export default function Flow({workflow,selected,onPick,onSource}:{workflow:Workflow;selected:string[];onPick:(d:Dependency,multi:boolean)=>void;onSource:(file:string,line:number)=>void}){
  const {nodes,edges}=useMemo(()=>{
    const visible=workflow.methods;
    const visibleIds=new Set(visible.map(m=>m.id));
    const columns=workflow.dependencies.length>4?3:2;
    const nodes:Node<FlowData>[]=[...visible.map((m,i)=>({id:m.id,type:'card',position:{x:columns===2?150:310,y:i*142},data:{title:m.className,subtitle:m.id===workflow.entry.methodId?workflow.entry.path:`${m.name}()`,method:m.id===workflow.entry.methodId?workflow.entry.method:undefined,kind:m.id===workflow.entry.methodId?'entry' as const:'method' as const}})),...workflow.dependencies.map((d,i)=>({id:d.id,type:'card',position:{x:(i%columns)*300,y:visible.length*142+30+Math.floor(i/columns)*200},data:{title:d.name,subtitle:d.path,kind:'http' as const,method:d.method,client:d.client,route:d.route,unresolved:d.status==='unresolved',selected:selected.includes(d.id)}}))];
    const edges=workflow.edges.filter(e=>visibleIds.has(e.source)&&visibleIds.has(e.target)).map(e=>({id:e.source+e.target,source:e.source,target:e.target,type:'smoothstep',markerEnd:{type:MarkerType.ArrowClosed,color:'#a6b3c9'},style:{stroke:'#a6b3c9',strokeWidth:1.4}}));
    for(const d of workflow.dependencies){const parent=d.sourceMethod||workflow.entry.methodId;edges.push({id:'http-'+d.id,source:visibleIds.has(parent)?parent:visible.at(-1)!.id,target:d.id,type:'smoothstep',markerEnd:{type:MarkerType.ArrowClosed,color:d.route==='mock'?'#8b7bdd':'#a6b3c9'},style:{stroke:d.route==='mock'?'#a69add':'#a6b3c9',strokeWidth:1.4}});}
    return{nodes,edges};
  },[workflow,selected]);
  return <ReactFlow key={`${workflow.id}:${workflow.dependencies.length}:${workflow.methods.length}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{padding:0.18,maxZoom:0.95}} minZoom={0.2} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} onNodeClick={(event,node)=>{const dep=workflow.dependencies.find(d=>d.id===node.id);if(dep)onPick(dep,event.metaKey||event.ctrlKey||event.shiftKey);else{const m=workflow.methods.find(m=>m.id===node.id);if(m)onSource(m.file,m.line);}}} proOptions={{hideAttribution:true}}><Background color="#dce3ed" gap={22} size={1}/><Controls showInteractive={false}/></ReactFlow>;
}
