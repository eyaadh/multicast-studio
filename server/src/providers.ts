/** Public/authorized, unencrypted M3U or JSON provider catalogs. No DRM or Kodi runtime. */
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { managementIP, config } from './config.js'
import { getProvider } from './db.js'

const execFileAsync = promisify(execFile)
export type Provider = {id:string;name:string;kind:'m3u'|'json';url:string;createdAt:string}
export type ProviderChannel = {key:string;name:string;group:string;logo:string|null;url:string;userAgent?:string;referer?:string}
export type PublicProviderChannel = Omit<ProviderChannel,'url'|'userAgent'|'referer'>

export function validateHttpUrl(text: string): URL {
  let url: URL
  try {url=new URL(text)}catch{throw new Error('A valid HTTP(S) URL is required')}
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || !url.hostname || url.href.length > 4096)
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported')
  return url
}
function privateIPv4(ip:string): boolean {
  const [a,b,c]=ip.split('.').map(Number)
  return a===0 || a===10 || a===127 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) ||
    (a===192&&b===168) || (a===100&&b>=64&&b<=127) || (a===192&&b===0&&c===0) ||
    (a===192&&b===0&&c===2) || (a===198&&[18,19,51].includes(b)) || (a===203&&b===0&&c===113) ||
    a>=224
}
export async function verifyOfficeInput(text:string): Promise<{url:URL;ip:string}> {
  const url=validateHttpUrl(text)
  // Disallow fetching local services, link-local metadata endpoints, and IPTV NIC addresses.
  const addresses = isIP(url.hostname) ? [{address:url.hostname,family:isIP(url.hostname)}] :
    await lookup(url.hostname,{all:true,verbatim:true})
  const ipv4=addresses.filter(v=>v.family===4)
  if (!ipv4.length || ipv4.some(v=>privateIPv4(v.address)))
    throw new Error('Upstream must resolve to public IPv4 address(es); private addresses are blocked')
  const ip=ipv4[0]!.address
  if (process.platform==='linux') {
    // ip route get with the source address is advisory; localAddress below binds HTTP requests.
    const {stdout}=await execFileAsync('ip',['-j','route','get',ip,'from',managementIP],{timeout:4000})
    const routes=JSON.parse(stdout) as Array<{dev?:string;src?:string}>
    if (routes[0]?.dev!==config.management.interface)
      throw new Error(`Upstream route uses ${routes[0]?.dev ?? 'unknown'} instead of office NIC ${config.management.interface}`)
  }
  return {url,ip}
}

export async function fetchCatalogText(text:string, hops=0):Promise<string> {
  if(hops>3)throw new Error('Too many catalog redirects')
  const {url,ip}=await verifyOfficeInput(text)
  return new Promise<string>((resolve,reject)=>{
    const fn=url.protocol==='https:'?httpsRequest:httpRequest
    const req=fn(url,{method:'GET',localAddress:managementIP,
      lookup:(_hostname,_opts,cb)=>cb(null,ip,4),
      headers:{'user-agent':'MulticastStudio/1.1','accept':'application/json, application/x-mpegurl, text/plain, */*'},
      timeout:10000},res=>{
      const status=res.statusCode??0
      if([301,302,303,307,308].includes(status)&&res.headers.location){
        res.resume()
        fetchCatalogText(new URL(res.headers.location,url).href,hops+1).then(resolve,reject)
        return
      }
      if(status!==200){res.resume();reject(new Error(`Provider returned HTTP ${status}`));return}
      let size=0;const chunks:Buffer[]=[]
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2_000_000){req.destroy(new Error('Catalog exceeds 2MB'))}else chunks.push(chunk)})
      res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error',reject)
    })
    req.on('timeout',()=>req.destroy(new Error('Catalog request timed out')))
    req.on('error',reject)
    req.end()
  })
}
function stableKey(id:string):string {return createHash('sha256').update(id).digest('hex').slice(0,24)}
const cleanText=(text:string,max=200)=>text.trim().slice(0,max)
function channelKey(id:string,index:number,name:string,group:string):string {
  return stableKey(id || `${group.toLowerCase()}\0${name.toLowerCase()}\0${index}`)
}
export function parseM3u(text:string, baseUrl:string): ProviderChannel[] {
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/)
  if(!lines[0]?.trim().startsWith('#EXTM3U'))throw new Error('This provider did not return a valid extended M3U playlist')
  if(lines.some(line=>line.startsWith('#EXT-X-')))throw new Error('This is an HLS manifest, not a provider catalog. Add it as a direct live channel instead.')
  const entries:ProviderChannel[]=[]
  const duplicateNames=new Map<string,number>()
  let attrs:Record<string,string>={},name='',agent='',referer=''
  for(const line of lines.slice(1)){
    const value=line.trim()
    if(value.startsWith('#EXTINF:')){
      attrs={}
      for(const [,key,v] of value.matchAll(/([\w-]+)="([^"]*)"/g))attrs[key!]=v!
      name=cleanText(value.slice(value.lastIndexOf(',')+1))||cleanText(attrs['tvg-name']||'')
      agent='';referer=''
    } else if(value.startsWith('#EXTVLCOPT:http-user-agent='))agent=cleanText(value.slice('#EXTVLCOPT:http-user-agent='.length),300).replace(/[\r\n]/g,'')
    else if(value.startsWith('#EXTVLCOPT:http-referrer='))referer=cleanText(value.slice('#EXTVLCOPT:http-referrer='.length),500).replace(/[\r\n]/g,'')
    else if(value && !value.startsWith('#')){
      if(name && entries.length<3000){
        try{
          const url=validateHttpUrl(new URL(value,baseUrl).href).href
          const group=cleanText(attrs['group-title']||'General',80)
          const identity=`${group.toLowerCase()}\0${name.toLowerCase()}`
          const duplicate=duplicateNames.get(identity)||0
          duplicateNames.set(identity,duplicate+1)
          entries.push({key:channelKey(attrs['tvg-id']||'',duplicate,name,group),name,group,
            logo:attrs['tvg-logo']?.slice(0,500)||null,url,
            ...(agent?{userAgent:agent}:{}),...(referer?{referer}: {})})
        }catch{/* Ignore unsupported/malformed playlist entries */}
      }
      attrs={};name='';agent='';referer=''
    }
  }
  return entries
}
export function parseJsonCatalog(text:string,baseUrl:string):ProviderChannel[]{
  const doc:unknown=JSON.parse(text)
  if(!Array.isArray(doc))throw new Error('JSON catalog must be an array of channels')
  return doc.slice(0,3000).flatMap((entry,i):ProviderChannel[]=>{
    if(!entry || typeof entry!=='object')return []
    const r=entry as Record<string,unknown>
    const name=cleanText(String(r.name||r.title||''))
    if(!name || typeof r.url!=='string')return []
    try{
      const url=validateHttpUrl(new URL(r.url,baseUrl).href).href
      const group=cleanText(String(r.group||r.category||'General'),80)
      return [{key:channelKey(String(r.id||''),i,name,group),name,group,
        logo:typeof r.icon==='string'?r.icon.slice(0,500):null,url}]
    }catch{return []}
  })
}
export async function getProviderChannels(provider:Provider):Promise<ProviderChannel[]> {
  const text=await fetchCatalogText(provider.url)
  return provider.kind==='json'?parseJsonCatalog(text,provider.url):parseM3u(text,provider.url)
}
export async function resolveLiveSource(source:{providerId:string|null;providerChannelKey:string|null;streamUrl:string|null}):Promise<ProviderChannel> {
  if(source.providerId && source.providerChannelKey){
    const provider=getProvider(source.providerId)
    if(!provider)throw new Error('Live provider no longer exists')
    const channels=await getProviderChannels(provider)
    const matched=channels.find(c=>c.key===source.providerChannelKey)
    if(!matched)throw new Error('Channel is no longer present in the provider catalog')
    await verifyOfficeInput(matched.url)
    return matched
  }
  if(!source.streamUrl)throw new Error('Live channel has no input source')
  await verifyOfficeInput(source.streamUrl)
  return {key:'direct',name:'Direct live stream',group:'',logo:null,url:source.streamUrl}
}
export function publicChannel(ch:ProviderChannel):PublicProviderChannel {
  return {key:ch.key,name:ch.name,group:ch.group,logo:ch.logo}
}
