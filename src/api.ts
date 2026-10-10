export async function api<T=any>(url:string,data?:unknown,method=data===undefined?'GET':'POST'):Promise<T>{
  const response=await fetch('/api'+url,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  const content=await response.json();if(!response.ok)throw new Error(content.error||`HTTP ${response.status}`);return content;
}
