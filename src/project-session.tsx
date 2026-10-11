import { createContext, useContext, useCallback, useSyncExternalStore, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import type { ProjectView } from '../shared/types';
import { createApi, type Api } from './api';

export class ProjectViewStore {
  readonly values:Record<string,unknown>;
  private listeners=new Set<()=>void>();
  private version=0;
  private savedVersion=0;
  private tail:Promise<void>=Promise.resolve();
  private timer?:ReturnType<typeof setTimeout>;
  private disposed=false;
  constructor(view:ProjectView,private api:Api|undefined,private onError:(error:string)=>void){this.values={...view.values};}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  get<T>(key:string,initial:T|(()=>T)):T{
    if(!Object.hasOwn(this.values,key))this.values[key]=typeof initial==='function'?(initial as ()=>T)():initial;
    return this.values[key] as T;
  }
  set<T>(key:string,next:SetStateAction<T>,initial:T|(()=>T)){
    const old=this.get(key,initial),value=typeof next==='function'?(next as (value:T)=>T)(old):next;
    if(Object.is(value,old)||this.disposed)return;
    this.values[key]=value;this.version++;for(const fn of this.listeners)fn();
    clearTimeout(this.timer);this.timer=setTimeout(()=>{void this.flush().catch(e=>this.onError('草稿保存失败：'+(e as Error).message));},400);
  }
  reset(prefix:string){
    for(const key of Object.keys(this.values))if(key.startsWith(prefix))delete this.values[key];
    this.version++;for(const fn of this.listeners)fn();
    clearTimeout(this.timer);this.timer=setTimeout(()=>{void this.flush().catch(e=>this.onError('草稿保存失败：'+(e as Error).message));},400);
  }
  flush(){
    clearTimeout(this.timer);
    const run=this.tail.catch(()=>{}).then(async()=>{
      if(this.version===this.savedVersion||this.disposed||!this.api)return;
      const version=this.version,view=JSON.parse(JSON.stringify({schemaVersion:1,values:this.values}));
      await this.api('/view',view,'PUT');this.savedVersion=version;
    });this.tail=run;return run;
  }
  dispose(){this.disposed=true;clearTimeout(this.timer);}
}
export interface ProjectSession { projectId:string|null;clientId:string;store:ProjectViewStore;api:Api;globalApi:Api;active:boolean }
const Context=createContext<ProjectSession|null>(null);
const Prefix=createContext('');
export function ProjectSessionProvider({session,children}:{session:ProjectSession;children:ReactNode}){return <Context.Provider value={session}>{children}</Context.Provider>;}
export function ViewScope({name,children}:{name:string;children:ReactNode}){const prefix=useContext(Prefix);return <Prefix.Provider value={prefix+name+':'}>{children}</Prefix.Provider>;}
export function useProjectSession(){const session=useContext(Context);if(!session)throw new Error('缺少项目会话');return session;}
export function useProjectApi(){return useProjectSession().api;}
export function useViewState<T>(key:string,initial:T|(()=>T)):[T,Dispatch<SetStateAction<T>>]{
  const {store}=useProjectSession(),prefix=useContext(Prefix),id=prefix+key;
  const get=()=>store.get(id,initial);
  const value=useSyncExternalStore(store.subscribe,get,get);
  const set=useCallback((next:SetStateAction<T>)=>store.set(id,next,initial),[store,id]);
  return[value,set];
}
export function projectApi(projectId:string,clientId:string,signal:AbortSignal,store:ProjectViewStore):Api{
  const request=createApi('/api/projects/'+encodeURIComponent(projectId),clientId,signal);
  return (url,data,method)=>request(url,url==='/rules'&&method==='PUT'?{...(data as object),revision:store.values.draftRevision}:data,method);
}
