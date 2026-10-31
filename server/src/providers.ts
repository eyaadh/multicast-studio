/** Public/authorized, unencrypted M3U or JSON provider catalogs. No DRM or Kodi runtime. */
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import { isIP } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { managementIP, config } from './config.js'
import { getProvider } from './db.js'

const execFileAsync = promisify(execFile)
export type Provider = {id:string;name:string;kind:'m3u'|'json'|'cricfy';url:string;createdAt:string}
export type ProviderChannel = {key:string;legacyKey?:string;name:string;group:string;logo:string|null;url:string;userAgent?:string;referer?:string;cookie?:string;headers?:Record<string,string>}
export type PublicProviderChannel = Pick<ProviderChannel,'key'|'name'|'group'|'logo'>

export function validateHttpUrl(text: string): URL {
  let url: URL
  try {url=new URL(text)}catch{throw new Error('A valid HTTP(S) URL is required')}
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || !url.hostname || url.href.length > 4096)
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported')
  return url
}
function privateIPv4(ip:string): boolean {
  const octets = ip.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const [a = 0, b = 0, c = 0] = octets
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

/** Larger IPTV indexes can be tens of megabytes; enforce a decompressed limit. */
export const MAX_CATALOG_BYTES = 60 * 1024 * 1024
const CATALOG_CACHE_MS = 3 * 60 * 1000
const catalogCache = new Map<string,{expires:number;channels:ProviderChannel[]}>()
const catalogPending = new Map<string,Promise<ProviderChannel[]>>()

export async function fetchCatalogText(text:string, hops=0):Promise<string> {
  if(hops>4)throw new Error('Too many catalog redirects')
  const {url,ip}=await verifyOfficeInput(text)
  return new Promise<string>((resolve,reject)=>{
    const fn=url.protocol==='https:'?httpsRequest:httpRequest
    const req=fn(url,{method:'GET',localAddress:managementIP,
      lookup:(_hostname,_opts,cb)=>cb(null,ip,4),
      headers:{'user-agent':'MulticastStudio/1.2','accept':'application/x-mpegurl, audio/x-mpegurl, application/octet-stream, text/plain, application/json, */*',
        'accept-encoding':'gzip, deflate, br'},timeout:45000},res=>{
      const status=res.statusCode??0
      if([301,302,303,307,308].includes(status)&&res.headers.location){
        res.resume()
        fetchCatalogText(new URL(res.headers.location,url).href,hops+1).then(resolve,reject)
        return
      }
      if(status!==200){res.resume();reject(new Error(`Playlist returned HTTP ${status}`));return}
      const encoding=String(res.headers['content-encoding']||'').trim().toLowerCase()
      const decoded=encoding==='gzip'?res.pipe(createGunzip()) :
        encoding==='deflate'?res.pipe(createInflate()) :
        encoding==='br'?res.pipe(createBrotliDecompress()) :res
      if(encoding && !['gzip','deflate','br','identity'].includes(encoding)){
        res.resume();reject(new Error(`Unsupported playlist compression: ${encoding}`));return
      }
      let size=0;const chunks:Buffer[]=[]
      let settled=false
      const fail=(error:Error)=>{
        if(settled)return
        settled=true;req.destroy();decoded.destroy();reject(error)
      }
      res.on('error',fail)
      decoded.on('error',fail)
      decoded.on('data',(chunk:Buffer)=>{
        size+=chunk.length
        if(size>MAX_CATALOG_BYTES){fail(new Error('Playlist exceeds 60 MB decompressed size limit'));return}
        chunks.push(chunk)
      })
      decoded.on('end',()=>{if(!settled){settled=true;resolve(Buffer.concat(chunks).toString('utf8'))}})
    })
    req.on('timeout',()=>req.destroy(new Error('Playlist request timed out')))
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
  if(!lines[0]?.trim().startsWith('#EXTM3U'))throw new Error('This URL did not return an extended M3U channel list')
  // A provider catalog can contain stray HLS directives. Distinguish the playlist
  // by its IPTV channel records rather than rejecting on any #EXT-X- line.
  // HLS media/variant manifests do not use negative EXTINF channel durations.
  const hasIptvEntries = lines.some(line => /^#EXTINF:\s*-\d+(?=[\s,])/i.test(line.trim()))
  if (!hasIptvEntries && lines.some(line => line.trimStart().startsWith('#EXT-X-')))
    throw new Error('This is an HLS manifest, not a provider catalog. Add it as a direct live channel instead.')
  const entries:ProviderChannel[]=[]
  const seen=new Set<string>()
  const duplicateNames=new Map<string,number>()
  let attrs:Record<string,string>={},name='',groupHint='',agent='',referer='',cookie='',extras:Record<string,string>={},drm=false
  const reset=()=>{attrs={};name='';groupHint='';agent='';referer='';cookie='';extras={};drm=false}
  const headerValue=(value:string)=>value.replace(/[\r\n\0]/g,'').slice(0,1000)
  for(const line of lines.slice(1)){
    const value=line.trim()
    if(value.startsWith('#EXTINF:')){
      const pendingDrm: boolean = drm && !name
      reset()
      drm=pendingDrm
      for(const [,key,v] of value.matchAll(/([\w-]+)=(?:"([^"]*)"|([^,\s]+))/g))attrs[key!]=v||''
      name=cleanText(value.slice(value.lastIndexOf(',')+1))||cleanText(attrs['tvg-name']||'')
    } else if(value.startsWith('#EXTGRP:'))groupHint=cleanText(value.slice('#EXTGRP:'.length),80)
    else if(value.startsWith('#EXTVLCOPT:http-user-agent='))agent=headerValue(value.slice('#EXTVLCOPT:http-user-agent='.length))
    else if(value.startsWith('#EXTVLCOPT:http-referrer='))referer=headerValue(value.slice('#EXTVLCOPT:http-referrer='.length))
    else if(value.startsWith('#EXTHTTP:')){
      try {
        const info:unknown=JSON.parse(value.slice('#EXTHTTP:'.length))
        if(info && typeof info==='object' && !Array.isArray(info)){
          const data=info as Record<string,unknown>
          for(const [key,entry] of Object.entries(data)){
            if(typeof entry!=='string')continue
            if(key.toLowerCase()==='cookie')cookie=headerValue(entry)
            else if(key.toLowerCase()==='user-agent')agent=headerValue(entry)
            else if(key.toLowerCase()==='referer')referer=headerValue(entry)
          }
        }
      }catch{/* Ignore malformed optional metadata */}
    } else if(value.startsWith('#KODIPROP:inputstream.adaptive.license_key=') ||
      value.startsWith('#KODIPROP:inputstream.adaptive.drm') || value.startsWith('#EXT-X-KEY:'))drm=true
    else if(value && !value.startsWith('#')){
      if(name && !drm && entries.length<100000){
        try{
          const divider=value.indexOf('|')
          const rawUrl=divider===-1?value:value.slice(0,divider)
          const url=validateHttpUrl(new URL(rawUrl,baseUrl).href).href
          if(divider!==-1){
            const params=new URLSearchParams(value.slice(divider+1))
            for(const [key,entry] of params){
              const val=headerValue(entry)
              if(key.toLowerCase()==='user-agent')agent=val
              else if(key.toLowerCase()==='referer' || key.toLowerCase()==='referrer')referer=val
              else if(key.toLowerCase()==='cookie')cookie=val
              else if(/^[a-z0-9-]{1,40}$/i.test(key))extras[key]=val
            }
          }
          const group=cleanText(attrs['group-title']||groupHint||'General',80)
          // Use the station, group and URL origin/path (not transient query tokens).
          // This remains stable as playlists are reordered or signed URLs rotate.
          const parsed=new URL(url)
          const identity=`${group.toLowerCase()}\0${name.toLowerCase()}\0${parsed.origin}${parsed.pathname}`
          const key=stableKey(identity)
          const legacyIdentity=`${group.toLowerCase()}\0${name.toLowerCase()}`
          const legacyIndex=duplicateNames.get(legacyIdentity)||0
          duplicateNames.set(legacyIdentity,legacyIndex+1)
          const legacyKey=channelKey(attrs['tvg-id']||'',legacyIndex,name,group)
          if(!seen.has(key)){
            seen.add(key)
            entries.push({key,legacyKey,name,group,
              logo:attrs['tvg-logo']?.slice(0,500)||null,url,
              ...(agent?{userAgent:agent}:{}),...(referer?{referer}: {}),
              ...(cookie?{cookie}:{}),...(Object.keys(extras).length?{headers:extras}:{})})
          }
        }catch{/* Ignore unsupported/malformed playlist entries */}
      }
      reset()
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
/** Cached catalogs protect the Ubuntu VM and upstreams from repeated huge downloads. */
export async function getProviderChannels(provider:Provider,forceRefresh=false):Promise<ProviderChannel[]> {
  if(provider.kind==='cricfy')throw new Error('Cricfy discovery has been retired. Add an M3U playlist instead.')
  const cached=catalogCache.get(provider.id)
  if(cached && Date.now()<cached.expires && (!forceRefresh || Date.now()<cached.expires-CATALOG_CACHE_MS+30000))return cached.channels
  const inflight=catalogPending.get(provider.id)
  if(inflight)return inflight
  const pending=(async()=>{
    const text=await fetchCatalogText(provider.url)
    const channels=provider.kind==='json'?parseJsonCatalog(text,provider.url):parseM3u(text,provider.url)
    catalogCache.set(provider.id,{expires:Date.now()+CATALOG_CACHE_MS,channels})
    return channels
  })()
  catalogPending.set(provider.id,pending)
  try{return await pending}finally{catalogPending.delete(provider.id)}
}
export function invalidateProviderCache(id:string):void {catalogCache.delete(id)}
export async function resolveLiveSource(source:{providerId:string|null;providerChannelKey:string|null;streamUrl:string|null},forceRefresh=false):Promise<ProviderChannel> {
  if(source.providerId && source.providerChannelKey){
    const provider=getProvider(source.providerId)
    if(!provider)throw new Error('Live provider no longer exists')
    const channels=await getProviderChannels(provider,forceRefresh)
    const matched=channels.find(c=>c.key===source.providerChannelKey || c.legacyKey===source.providerChannelKey)
    if(!matched)throw new Error('Channel is no longer present in the playlist; refresh its provider')
    await verifyOfficeInput(matched.url)
    return matched
  }
  if(!source.streamUrl)throw new Error('Live channel has no input source')
  await verifyOfficeInput(source.streamUrl)
  return {key:'direct',name:'Direct live stream',group:'',logo:null,url:source.streamUrl}
}
export function pageProviderChannels(
  all:ProviderChannel[],options:{page:number;limit:number;search:string;group:string}
):{data:PublicProviderChannel[];groups:string[];pagination:{page:number;limit:number;total:number;totalPages:number};catalogTotal:number} {
  const page=Math.max(1,Math.trunc(options.page)||1)
  const limit=Math.min(100,Math.max(1,Math.trunc(options.limit)||50))
  const search=options.search.trim().toLowerCase().slice(0,200)
  const group=options.group.trim()
  const groups=[...new Set(all.map(ch=>ch.group))].sort((a,b)=>a.localeCompare(b))
  const filtered=all.filter(ch=>(!group||ch.group===group) &&
    (!search||`${ch.name} ${ch.group}`.toLowerCase().includes(search)))
  return {data:filtered.slice((page-1)*limit,page*limit).map(publicChannel),groups,
    pagination:{page,limit,total:filtered.length,totalPages:Math.ceil(filtered.length/limit)},
    catalogTotal:all.length}
}
export function publicChannel(ch:ProviderChannel):PublicProviderChannel {
  return {key:ch.key,name:ch.name,group:ch.group,logo:ch.logo}
}
