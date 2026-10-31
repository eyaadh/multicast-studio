export class ApiError extends Error {constructor(message:string,public status:number){super(message)}}
export async function api<T>(path:string,options:RequestInit={}):Promise<T>{
  const response=await fetch(`/api${path}`,{
    credentials:'same-origin',...options,
    headers:{...(options.body && typeof options.body === 'string'?{'Content-Type':'application/json'}:{}),...options.headers}
  })
  const data=await response.json().catch(()=>({error:`HTTP ${response.status}`})) as T & {error?:string}
  if(!response.ok)throw new ApiError(data.error||`HTTP ${response.status}`,response.status)
  return data
}
export const jsonBody=(data:unknown)=>JSON.stringify(data)
export function uploadRaw(file:File,onProgress:(pct:number)=>void):Promise<void>{
  return new Promise((resolve,reject)=>{
    const req=new XMLHttpRequest()
    req.open('POST','/api/media/upload')
    req.withCredentials=true
    req.setRequestHeader('X-Filename',encodeURIComponent(file.name))
    req.setRequestHeader('Content-Type','application/octet-stream')
    req.upload.onprogress=(event)=>{if(event.lengthComputable)onProgress(Math.round(event.loaded/event.total*100))}
    req.onload=()=>{
      if(req.status>=200&&req.status<300)resolve()
      else {let error='Upload failed';try{error=JSON.parse(req.responseText).error||error}catch{}reject(new Error(error))}
    }
    req.onerror=()=>reject(new Error('Network error while uploading'))
    req.send(file)
  })
}
