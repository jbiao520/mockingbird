export type Api=<T=any>(url:string,data?:unknown,method?:string)=>Promise<T>;
export function createApi(prefix='/api',clientId?:string,signal?:AbortSignal):Api{
  return async<T=any>(url:string,data?:unknown,method=data===undefined?'GET':'POST'):Promise<T>=>{
    const response=await fetch(prefix+url,{method,signal,headers:{'Content-Type':'application/json',...(clientId?{'X-Mockingbird-Client':clientId}:{})},body:data===undefined?undefined:JSON.stringify(data)});
    const content=await response.json();if(!response.ok)throw new Error(content.error||`HTTP ${response.status}`);
    signal?.throwIfAborted();return content;
  };
}
export const api=createApi();
