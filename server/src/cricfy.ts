/**
 * Cricfy Kodi add-on interoperability adapter.
 * Configuration is loaded from an official published add-on release archive;
 * no credentials or channel lists are bundled with Multicast Studio.
 * This adapter deliberately excludes DRM playback and license handling.
 *
 * The source integration follows the published add-on's discovery protocol.
 * See THIRD_PARTY_NOTICES.md for upstream GPL-3.0 attribution.
 */
import { createDecipheriv, createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { managementIP, dataDirectory } from './config.js'
import { fetchCatalogText, parseM3u, verifyOfficeInput, validateHttpUrl } from './providers.js'
import type { ProviderChannel } from './providers.js'

const execFileAsync = promisify(execFile)
const configPath = join(dataDirectory, 'cricfy-addon-config.json')
const githubReleaseApi = 'https://api.github.com/repos/itsyourap/cricfy-kodi-plugin/releases/latest'
const resourcePrefix = 'plugin.video.cricfy/resources/'
let directoryCache: {expires:number; providers:DirectoryProvider[]}|null=null
const kodiHeaders = {'user-agent':'Mozilla/5.0 (Windows NT 10.0; rv:78.0) Gecko/20100101 Firefox/78.0',
  'cache-control':'no-cache, no-store'}

type AddonProperties = {
  cricfy_firebase_api_key: string
  cricfy_firebase_app_id: string
  cricfy_package_name: string
}
type AddonConfig = {
  release: string
  installedAt: string
  properties: AddonProperties
  secrets: string[]
}
export type DirectoryProvider = {key:string;name:string;image:string|null;url:string}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function isRecord(input:unknown):input is Record<string,unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
}
async function officeRequest(rawUrl:string, method:'GET'|'POST'='GET', payload?:string, redirects=0, limit=5_000_000):Promise<Buffer> {
  if (redirects>5)throw new Error('Too many redirects while connecting to Cricfy')
  const {url,ip}=await verifyOfficeInput(rawUrl)
  return await new Promise<Buffer>((resolve,reject)=>{
    const fn=url.protocol==='https:'?httpsRequest:httpRequest
    const req=fn(url,{method,localAddress:managementIP,
      lookup:(_hostname,_opts,callback)=>callback(null,ip,4),
      timeout:20000,
      headers:{'User-Agent':'MulticastStudio/1.2 (Cricfy Kodi integration)',
        'Accept':'application/json, application/zip, text/plain, */*',
        ...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})}},res=>{
      const status=res.statusCode??0
      if([301,302,303,307,308].includes(status)&&res.headers.location){
        res.resume()
        officeRequest(new URL(res.headers.location,url).href,method==='POST'&&[307,308].includes(status)?'POST':'GET',
          method==='POST'&&[307,308].includes(status)?payload:undefined,redirects+1,limit).then(resolve,reject)
        return
      }
      if(status!==200){res.resume();reject(new Error(`Remote service returned HTTP ${status}`));return}
      let size=0
      const buffers:Buffer[]=[]
      res.on('data',(block:Buffer)=>{
        size+=block.length
        if(size>limit)req.destroy(new Error('Response exceeds the maximum allowed size'))
        else buffers.push(block)
      })
      res.on('end',()=>resolve(Buffer.concat(buffers)))
      res.on('error',reject)
    })
    req.on('timeout',()=>req.destroy(new Error('Remote service request timed out')))
    req.on('error',reject)
    req.end(payload)
  })
}

async function archiveEntry(path:string, name:string):Promise<string|null> {
  try {
    const {stdout}=await execFileAsync('unzip',['-p',path,resourcePrefix+name],{
      timeout:10000,maxBuffer:64_000,encoding:'utf8'
    })
    return stdout.trim()
  }catch{return null}
}
function parseKey(raw:string):{key:Buffer;iv:Buffer}|null {
  const match=/^([0-9a-fA-F]+):([0-9a-fA-F]+)$/.exec(raw.trim())
  if(!match)return null
  const key=Buffer.from(match[1]!, 'hex')
  const iv=Buffer.from(match[2]!, 'hex')
  if (![16,24,32].includes(key.length)||iv.length!==16)return null
  return {key,iv}
}
async function saveAddonArchive(bytes:Buffer, release:string):Promise<{release:string;installedAt:string}> {
  if(bytes.length<200 || bytes.length>20_000_000 || bytes.subarray(0,2).toString()!=='PK')
    throw new Error('The selected file is not a valid, supported Kodi add-on ZIP (maximum 20MB)')
  const temporary=await mkdtemp(join(tmpdir(),'multicast-cricfy-'))
  const filename=join(temporary,'addon.zip')
  try {
    await writeFile(filename,bytes,{mode:0o600})
    const raw=await archiveEntry(filename,'cricfy_properties.json')
    if(!raw)throw new Error('Missing generated cricfy_properties.json. Use the built add-on ZIP from GitHub Releases, not the repository source ZIP.')
    let properties:unknown
    try { properties=JSON.parse(raw) } catch { throw new Error('Invalid Cricfy add-on properties') }
    if(!isRecord(properties) || !['cricfy_firebase_api_key','cricfy_firebase_app_id','cricfy_package_name']
      .every(k=>typeof properties[k]==='string' && (properties[k] as string).length>0))
      throw new Error('Required properties were not present in the add-on archive')
    const prop=properties as AddonProperties
    if(!/^1:\d+:[a-zA-Z0-9]+$/.test(prop.cricfy_firebase_app_id))throw new Error('Invalid Firebase application ID in archive')
    const rawSecrets=await Promise.all(['secret1.txt','secret2.txt'].map(name=>archiveEntry(filename,name)))
    const secrets=rawSecrets.filter((v):v is string=>!!v && parseKey(v)!==null)
    if(!secrets.length)throw new Error('Missing add-on keys. Use an official built Kodi release archive, not source code')
    const config:AddonConfig={release:release.slice(0,100),installedAt:new Date().toISOString(),properties:prop,secrets}
    await mkdir(dataDirectory,{recursive:true})
    await writeFile(configPath,JSON.stringify(config),{mode:0o600})
    directoryCache=null
    return {release:config.release,installedAt:config.installedAt}
  } finally {await rm(temporary,{force:true,recursive:true})}
}
export async function importAddonArchive(bytes:Uint8Array):Promise<{release:string;installedAt:string}> {
  return saveAddonArchive(Buffer.from(bytes),'Uploaded Kodi add-on')
}
export async function connectOfficialRelease():Promise<{release:string;installedAt:string}> {
  const metadata=JSON.parse((await officeRequest(githubReleaseApi)).toString('utf8')) as unknown
  if(!isRecord(metadata) || !Array.isArray(metadata.assets))throw new Error('GitHub release metadata is missing assets')
  const asset=metadata.assets.find(item=>isRecord(item) && typeof item.name==='string' &&
    /^plugin\.video\.cricfy-.*\.zip$/.test(item.name) && typeof item.browser_download_url==='string') as Record<string,unknown>|undefined
  if(!asset)throw new Error('The latest Cricfy release does not contain a built Kodi add-on ZIP')
  const url=String(asset.browser_download_url)
  const parsed=validateHttpUrl(url)
  if(parsed.hostname!=='github.com' || !parsed.pathname.startsWith('/itsyourap/cricfy-kodi-plugin/releases/download/'))
    throw new Error('Unexpected release download URL')
  const bytes=await officeRequest(parsed.href,'GET',undefined,0,20_000_000)
  return saveAddonArchive(bytes,String(metadata.tag_name||'Latest GitHub release'))
}
async function readConfig():Promise<AddonConfig> {
  try {
    const config=JSON.parse(await readFile(configPath,'utf8')) as AddonConfig
    if(!config?.properties?.cricfy_firebase_app_id || !Array.isArray(config.secrets) || !config.secrets.length)
      throw new Error('Invalid stored configuration')
    return config
  }catch(error){
    if(isRecord(error) && error.code==='ENOENT')throw new Error('Cricfy is not connected. Install the official Kodi add-on release first.')
    throw error
  }
}
export async function cricfyStatus():Promise<{connected:boolean;release:string|null;installedAt:string|null}> {
  try {const conf=await readConfig();return {connected:true,release:conf.release,installedAt:conf.installedAt}}
  catch {return {connected:false,release:null,installedAt:null}}
}

function decryptDirectory(encoded:string, secrets:string[]):string {
  const cleaned=encoded.replace(/\s/g,'')
  const encrypted=Buffer.from(cleaned,'base64')
  for(const secret of secrets){
    const parsed=parseKey(secret)
    if(!parsed)continue
    try {
      const decipher=createDecipheriv(`aes-${parsed.key.length*8}-cbc`,parsed.key,parsed.iv)
      const decrypted=Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8')
      if(decrypted.trim().startsWith('['))return decrypted
    }catch{/* Try the next configured key */}
  }
  throw new Error('Cricfy directory could not be decoded with the add-on release configuration')
}
// Playlist files produced by the published add-on may wrap the actual M3U
// with an AES-CBC envelope carrying its own per-file IV and key.
export function decodeCricfyPlaylist(raw:string):string {
  const text=raw.trim()
  if(/^#EXTM3U|^#EXTINF|^#KODIPROP/.test(text))return text
  if(text.length<79)throw new Error('Cricfy returned an empty or unsupported playlist')
  try {
    const iv=Buffer.from(text.slice(10,34),'base64')
    const key=Buffer.from(text.slice(-54,-10),'base64')
    const encrypted=Buffer.from(text.slice(0,10)+text.slice(34,-54)+text.slice(-10),'base64')
    if(iv.length!==16 || ![16,24,32].includes(key.length))throw new Error('Invalid playlist envelope')
    const decipher=createDecipheriv(`aes-${key.length*8}-cbc`,key,iv)
    const clear=Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8')
    if(!clear.startsWith('#EXTM3U') && !clear.startsWith('#EXTINF'))throw new Error('Not a recognizable playlist')
    return clear
  }catch(error){throw new Error(`Unable to decode Cricfy playlist: ${safeMessage(error)}`)}
}

async function remoteProviderBase(conf:AddonConfig):Promise<string> {
  const props=conf.properties
  const project=props.cricfy_firebase_app_id.split(':')[1]
  if(!project || !/^\d+$/.test(project))throw new Error('Invalid Cricfy Firebase project')
  const url=`https://firebaseremoteconfig.googleapis.com/v1/projects/${project}/namespaces/firebase:fetch`
  const payload=JSON.stringify({appInstanceId:randomUUID().replace(/-/g,''),appInstanceIdToken:'',
    appId:props.cricfy_firebase_app_id,countryCode:'US',languageCode:'en-US',platformVersion:'30',
    timeZone:'UTC',appVersion:'5.0',appBuild:'50',packageName:props.cricfy_package_name,
    sdkVersion:'22.1.0',analyticsUserProperties:{}})
  // Firebase credentials are sent only to Google's Remote Config API.
  const result=JSON.parse((await officeRequestWithHeaders(url,payload,{
    'X-Android-Package':props.cricfy_package_name,'X-Goog-Api-Key':props.cricfy_firebase_api_key,
    'X-Google-GFE-Can-Retry':'yes'})).toString('utf8')) as unknown
  if(!isRecord(result) || !isRecord(result.entries))throw new Error('Cricfy Remote Config returned no provider information')
  const base=result.entries.cric_api2 || result.entries.cric_api1
  if(typeof base!=='string')throw new Error('Cricfy Remote Config did not provide a directory URL')
  return validateHttpUrl(base).href.replace(/\/$/,'')
}

async function officeRequestWithHeaders(rawUrl:string,payload:string,headers:Record<string,string>):Promise<Buffer>{
  const {url,ip}=await verifyOfficeInput(rawUrl)
  return new Promise<Buffer>((resolve,reject)=>{
    const req=httpsRequest(url,{method:'POST',localAddress:managementIP,
      lookup:(_hostname,_opts,callback)=>callback(null,ip,4),timeout:20000,
      headers:{'Content-Type':'application/json','Accept':'application/json',
        'Content-Length':Buffer.byteLength(payload),...headers}},res=>{
      if(res.statusCode!==200){res.resume();reject(new Error(`Cricfy Remote Config returned HTTP ${res.statusCode}`));return}
      let size=0;const buffers:Buffer[]=[]
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>500000)req.destroy(new Error('Remote Config response too large'));else buffers.push(chunk)})
      res.on('end',()=>resolve(Buffer.concat(buffers)))
      res.on('error',reject)
    })
    req.on('timeout',()=>req.destroy(new Error('Remote Config timed out')))
    req.on('error',reject)
    req.end(payload)
  })
}

export async function discoverCricfyProviders(force=false):Promise<DirectoryProvider[]> {
  if(!force && directoryCache && directoryCache.expires>Date.now())return directoryCache.providers
  const conf=await readConfig()
  const base=await remoteProviderBase(conf)
  const encrypted=await fetchCatalogText(`${base}/cats.txt`,0,kodiHeaders)
  const clear=decryptDirectory(encrypted,conf.secrets)
  const data:unknown=JSON.parse(clear)
  if(!Array.isArray(data))throw new Error('Cricfy provider directory was not an array')
  const providers:DirectoryProvider[]=[]
  for(const item of data.slice(0,500)){
    if(!isRecord(item)||typeof item.catLink!=='string')continue
    try{
      const url=validateHttpUrl(item.catLink).href
      const name=typeof item.title==='string'?item.title.trim().slice(0,100):''
      if(!name)continue
      providers.push({key:createHash('sha256').update(url).digest('hex').slice(0,32),
        name,url,image:typeof item.image==='string'?item.image.slice(0,500):null})
    }catch{/* Skip malformed or unsupported entries */}
  }
  if(!providers.length)throw new Error('Cricfy directory returned no supported providers')
  directoryCache={expires:Date.now()+5*60*1000,providers}
  return providers
}
export async function loadCricfyChannels(providerUrl:string):Promise<ProviderChannel[]> {
  const encrypted=await fetchCatalogText(providerUrl,0,kodiHeaders)
  const decoded=decodeCricfyPlaylist(encrypted)
  const normalized=decoded.startsWith('#EXTM3U')?decoded:`#EXTM3U\n${decoded}`
  return parseM3u(normalized,providerUrl)
}
