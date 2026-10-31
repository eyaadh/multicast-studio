import { serve } from '@hono/node-server'
import type { HttpBindings } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { createReadStream, existsSync } from 'node:fs'
import { stat, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join, extname } from 'node:path'
import { cpus, freemem, totalmem, uptime, loadavg } from 'node:os'
import { config, managementIP, streamingIP, mediaDirectory } from './config.js'
import { checkRoute, assertMulticast, listInterfaces } from './network.js'
import { getMedia, listMedia, mediaPublic, mediaInUse, deleteMedia, saveChannel, getChannel, listChannels, deleteChannel } from './db.js'
import { startChannel, stopChannel, restartChannel, startAutostartChannels, snapshots, snapshot, running, forgetChannel, shutdown } from './supervisor.js'
import { cleanName, importCandidates, registerImport, uploadVideo } from './media.js'
import { isAuthenticated, verifyCredentials, makeSession, logout, loginAllowed, loginFailed, clearFailures } from './auth.js'
import type { ChannelValues } from './db.js'

const app = new Hono<{Bindings: HttpBindings}>()
app.use('*',secureHeaders())
app.onError((error,c) => {
  const msg = error instanceof Error ? error.message : 'Unexpected error'
  console.error('[API]',error)
  const conflict = /UNIQUE constraint|FOREIGN KEY constraint/.test(msg)
  const publicMessage = conflict ? 'This multicast destination, service ID, or media reference is already in use' : msg
  return c.json({error:publicMessage},conflict?409:500)
})
app.get('/api/healthz',c=>c.json({ok:true}))
app.get('/api/auth/session',c=>c.json({authenticated:isAuthenticated(c)}))
app.post('/api/auth/login', async c => {
  const ip = c.env.incoming.socket.remoteAddress || 'unknown'
  if (!loginAllowed(ip)) return c.json({error:'Too many attempts. Retry in 15 minutes.'},429)
  const parsed = z.object({username:z.string(),password:z.string()}).safeParse(await c.req.json().catch(()=>null))
  if (!parsed.success || !verifyCredentials(parsed.data.username,parsed.data.password)) {
    loginFailed(ip)
    return c.json({error:'Invalid username or password'},401)
  }
  clearFailures(ip)
  makeSession(c)
  return c.json({authenticated:true})
})
app.use('/api/*',async(c,next) => {
  if (!isAuthenticated(c)) return c.json({error:'Authentication required'},401)
  if (!['GET','HEAD','OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin')
    const host = c.req.header('host')
    if (origin && host) {
      try {if (new URL(origin).hostname !== host.split(':')[0]) return c.json({error:'Cross-origin write rejected'},403)}
      catch {return c.json({error:'Invalid Origin header'},403)}
    }
  }
  await next()
})
app.post('/api/auth/logout',c=>{logout(c);return c.json({ok:true})})

const channelSchema = z.object({
  name:z.string().trim().min(1).max(100), description:z.string().max(300).default(''),
  mediaId:z.string().uuid(), groupIp:z.string().min(7), port:z.number().int().min(1024).max(65535),
  profile:z.enum(['h264','mpeg4','mpeg2','copy']),
  videoBitrateKbps:z.number().int().min(250).max(40000),
  audioBitrateKbps:z.number().int().min(32).max(512),
  width:z.number().int().min(320).max(3840),height:z.number().int().min(240).max(2160),
  fps:z.number().int().min(15).max(60),ttl:z.number().int().min(1).max(255),
  autoStart:z.boolean(),autoRecover:z.boolean(),serviceId:z.number().int().min(1).max(65535)
}).refine(v=>v.width%2===0 && v.height%2===0,{message:'Resolution width and height must be even'})
const validateChannel = (input: unknown) => {
  const parsed = channelSchema.safeParse(input)
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error))
  assertMulticast(parsed.data.groupIp,config.streaming.multicastCIDR)
  if (!getMedia(parsed.data.mediaId)) throw new Error('Selected video does not exist')
  return parsed.data satisfies ChannelValues
}
app.get('/api/channels',c=>c.json(snapshots()))
app.post('/api/channels',async c=>{
  try {const values = validateChannel(await c.req.json().catch(()=>null));return c.json(snapshot(saveChannel(values)),201)}
  catch(e){return c.json({error:e instanceof Error?e.message:String(e)},400)}
})
app.patch('/api/channels/:id',async c=>{
  if (!getChannel(c.req.param('id'))) return c.json({error:'Channel not found'},404)
  if (running(c.req.param('id'))) return c.json({error:'Stop the channel before changing its configuration'},409)
  try {const values=validateChannel(await c.req.json().catch(()=>null));return c.json(snapshot(saveChannel(values,c.req.param('id'))))}
  catch(e){return c.json({error:e instanceof Error?e.message:String(e)},400)}
})
app.delete('/api/channels/:id',c=>{
  const id=c.req.param('id')
  if (!getChannel(id)) return c.json({error:'Channel not found'},404)
  if (running(id)) return c.json({error:'Stop the channel before deleting it'},409)
  deleteChannel(id); forgetChannel(id);return c.json({ok:true})
})
for (const action of ['start','stop','restart'] as const) {
  app.post(`/api/channels/:id/${action}`,async c=>{
    const id=c.req.param('id')
    if (!getChannel(id)) return c.json({error:'Channel not found'},404)
    try {const result=action==='start'?await startChannel(id):action==='stop'?await stopChannel(id):await restartChannel(id);return c.json(result)}
    catch(e){return c.json({error:e instanceof Error?e.message:String(e)},409)}
  })
}
app.get('/api/channels/playlist.m3u',c=>{
  const lines=['#EXTM3U',...listChannels().flatMap(ch=>[`#EXTINF:-1,${ch.name.replace(/[\r\n,]/g,' ')}`,`udp://@${ch.groupIp}:${ch.port}`])]
  c.header('content-type','audio/x-mpegurl; charset=utf-8')
  c.header('content-disposition','attachment; filename="channels.m3u"')
  return c.body(lines.join('\n')+'\n')
})
app.get('/api/media',c=>c.json(listMedia().map(mediaPublic)))
app.get('/api/media/import-candidates',async c=>c.json(await importCandidates()))
app.post('/api/media/import',async c=>{
  const parsed=z.object({filename:z.string()}).safeParse(await c.req.json().catch(()=>null))
  if(!parsed.success)return c.json({error:'A filename is required'},400)
  try {return c.json(mediaPublic(await registerImport(parsed.data.filename)),201)}
  catch(e){return c.json({error:e instanceof Error?e.message:String(e)},400)}
})
app.post('/api/media/upload',async c=>{
  const header=c.req.header('x-filename')
  if (!header) return c.json({error:'X-Filename header is required'},400)
  const advertisedSize=Number(c.req.header('content-length')||'0')
  try {const filename=decodeURIComponent(header);cleanName(filename)
    const item=await uploadVideo(c.req.raw.body,filename,advertisedSize)
    return c.json(mediaPublic(item),201)
  } catch(e) {return c.json({error:e instanceof Error?e.message:String(e)},400)}
})
app.delete('/api/media/:id',async c=>{
  const item=getMedia(c.req.param('id'))
  if(!item) return c.json({error:'Media not found'},404)
  if(mediaInUse(item.id)) return c.json({error:'Media is used by a channel'},409)
  deleteMedia(item.id)
  if(item.origin==='upload') await rm(item.storedPath,{force:true}).catch(console.error)
  return c.json({ok:true})
})
app.get('/api/media/:id/preview',async c=>{
  const item=getMedia(c.req.param('id'))
  if(!item)return c.json({error:'Media not found'},404)
  let size:number
  try{size=(await stat(item.storedPath)).size}catch{return c.json({error:'File not found on disk'},404)}
  const range=c.req.header('range')
  let start=0,end=Math.max(0,size-1)
  if(range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range)
    if(!match)return c.body(null,416,{'Content-Range':`bytes */${size}`})
    if(match[1]){start=Number(match[1]);end=match[2]?Number(match[2]):end}
    else if(match[2]){const length=Number(match[2]);start=Math.max(0,size-length)}
    if(start>end || end>=size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end))return c.body(null,416,{'Content-Range':`bytes */${size}`})
  }
  const ext=extname(item.name).toLowerCase()
  const mime:Record<string,string>={'.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.ts':'video/mp2t','.mpeg':'video/mpeg','.mpg':'video/mpeg'}
  const headers:Record<string,string>={'Content-Type':mime[ext]||'application/octet-stream','Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}
  if(range) headers['Content-Range']=`bytes ${start}-${end}/${size}`
  const nodeStream=createReadStream(item.storedPath,{start,end})
  return new Response(Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,{status:range?206:200,headers})
})
const systemSnapshot = () => ({
  management:{interface:config.management.interface,address:managementIP,port:config.management.port},
  streaming:{interface:config.streaming.interface,address:streamingIP,range:config.streaming.multicastCIDR,
    ttl:config.streaming.defaultTTL,verifyEgressRoute:config.streaming.verifyEgressRoute},
  interfaces:listInterfaces(),channels:snapshots().length,streamingCount:snapshots().filter(c=>c.status==='streaming').length,
  host:{uptimeSeconds:uptime(),memoryTotal:totalmem(),memoryFree:freemem(),loadAverage:loadavg(),cpuCount:cpus().length}
})
app.get('/api/system',c=>c.json(systemSnapshot()))
app.get('/api/network/check/:group',async c=>{
  try {assertMulticast(c.req.param('group'),config.streaming.multicastCIDR)}catch(e){return c.json({error:String(e)},400)}
  return c.json(await checkRoute(c.req.param('group')))
})
app.get('/api/events',c=>streamSSE(c,async(stream)=>{
  while(!stream.aborted){
    await stream.writeSSE({event:'snapshot',data:JSON.stringify({channels:snapshots(),system:systemSnapshot()})})
    await stream.sleep(3000)
  }
}))

const distRoot='./web/dist'
if(existsSync(join(distRoot,'index.html'))){
  app.use('/*',serveStatic({root:distRoot}))
  app.get('*',serveStatic({path:join(distRoot,'index.html')}))
}
const server=serve({fetch:app.fetch,port:config.management.port,hostname:managementIP},info=>{
  console.log(`Multicast Studio: http://${info.address}:${info.port}`)
  console.log(`IPTV egress interface ${config.streaming.interface}: ${streamingIP}`)
})
startAutostartChannels().catch(console.error)
let closing=false
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{
  if(closing)return
  closing=true
  console.log(`Received ${signal}, stopping channels...`)
  await shutdown()
  server.close(()=>process.exit(0))
  setTimeout(()=>process.exit(1),8000).unref()
})
