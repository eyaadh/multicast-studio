import { access } from 'node:fs/promises'
import { getChannel, getMedia, getProvider, listChannels, mediaPublic } from './db.js'
import { launchFFmpeg, parseProgressBlock } from './ffmpeg.js'
import { resolveLiveSource } from './providers.js'
import { checkRoute } from './network.js'
import { config } from './config.js'
import type { Channel, ChannelSnapshot, ChannelStatus, Progress } from './types.js'

interface RunningState {
  status: ChannelStatus; process: ReturnType<typeof launchFFmpeg> | null; pid: number | null;
  startedAt: string | null; lastProgressAt: number; progress: Progress; restarts: number;
  failures: number; lastError: string | null; stopRequested: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null; stderr: string; runId: number;
}
const states = new Map<string, RunningState>()
let isShuttingDown = false
const watchdog = setInterval(() => {
  if (isShuttingDown) return
  for (const [id, state] of states) {
    if (!state.process || state.stopRequested) continue
    const timeout = state.status === 'starting' ? 60000 : 35000
    if (Date.now() - state.lastProgressAt > timeout) {
      state.lastError = `FFmpeg stopped reporting progress for ${Math.round(timeout / 1000)} seconds`
      state.process.kill('SIGKILL')
      console.error(`[channel ${id}] ${state.lastError}`)
    }
  }
}, 5000)
watchdog.unref()
let checkingEgress = false
const egressGuard = setInterval(async () => {
  if (isShuttingDown || checkingEgress || !config.streaming.verifyEgressRoute) return
  checkingEgress = true
  try {
    for (const ch of listChannels()) {
      const s = states.get(ch.id)
      if (!s?.process || s.stopRequested) continue
      const route = await checkRoute(ch.groupIp)
      if (!route.ok && s.process && !s.stopRequested) {
        s.lastError = route.message
        console.error(`[channel ${ch.id}] Route guard: ${route.message}; terminating FFmpeg`)
        s.process.kill('SIGKILL')
      }
    }
  } catch (error) {console.error('[egress guard]',error)}
  finally {checkingEgress = false}
},15000)
egressGuard.unref()
function stateFor(id: string): RunningState {
  let s = states.get(id)
  if (!s) {
    s = {status:'stopped',process:null,pid:null,startedAt:null,lastProgressAt:0,
      progress:{},restarts:0,failures:0,lastError:null,stopRequested:false,retryTimer:null,stderr:'',runId:0}
    states.set(id,s)
  }
  return s
}
export function snapshot(ch: Channel): ChannelSnapshot {
  const s = stateFor(ch.id)
  const media = ch.mediaId ? getMedia(ch.mediaId) : null
  return {...ch, media:media ? mediaPublic(media) : null,
    sourceLabel:ch.sourceType==='live' ? (ch.providerId ? `${getProvider(ch.providerId)?.name||'Provider'} · Live` : 'Direct live stream') : media?.name ?? null,
    status:s.status,pid:s.pid,
    startedAt:s.startedAt,progress:s.progress,restarts:s.restarts,lastError:s.lastError}
}
export function snapshots() { return listChannels().map(snapshot) }
export function running(id: string) {
  const s = states.get(id)
  return !!s && (s.process !== null || s.retryTimer !== null || s.status === 'starting' || s.status === 'recovering')
}
function clearRetry(s: RunningState) { if (s.retryTimer) clearTimeout(s.retryTimer); s.retryTimer = null }
function queueRecovery(id:string,channel:Channel,s:RunningState):void {
  if(s.stopRequested || isShuttingDown || !channel.autoRecover){s.status='error';return}
  // Live upstreams can go offline for hours. Keep retrying at a capped interval;
  // local files retain the original conservative six-retry behavior.
  if(channel.sourceType==='media' && s.failures>=6){s.status='error';return}
  const delay=Math.min(60000,2000 * 2 ** Math.min(s.failures,5))
  s.failures++
  s.restarts++
  s.status='recovering'
  clearRetry(s)
  s.retryTimer=setTimeout(()=>{
    s.retryTimer=null
    startChannel(id,true).catch(error=>console.error(`[channel ${id}] retry:`,error instanceof Error?error.message:error))
  },delay)
  s.retryTimer.unref()
}
export async function startChannel(id: string, recovering = false): Promise<ChannelSnapshot> {
  if (isShuttingDown) throw new Error('The application is shutting down')
  const channel = getChannel(id)
  if (!channel) throw new Error('Channel not found')
  const s = stateFor(id)
  if (s.process || s.status === 'stopping' || s.status === 'starting') throw new Error('Channel is already starting, running or stopping')
  if (s.retryTimer && !recovering) throw new Error('Channel is recovering; stop it before restarting manually')
  clearRetry(s)
  s.stopRequested = false
  s.status = recovering ? 'recovering' : 'starting'
  const runId=++s.runId
  s.lastProgressAt=Date.now()
  try {
    // Resolve the provider on EVERY launch, not just when the channel is created.
    // Signed/rotated URLs are therefore refreshed after a source interruption.
    let source
    if(channel.sourceType==='live')source=await resolveLiveSource(channel,recovering)
    else {
      if(!channel.mediaId)throw new Error('No local video is configured')
      source=getMedia(channel.mediaId)
      if (!source) throw new Error('Selected media no longer exists')
      await access(source.storedPath)
    }
    if(s.stopRequested || runId!==s.runId)throw new Error('Start cancelled')
    const check = await checkRoute(channel.groupIp)
    if (config.streaming.verifyEgressRoute && !check.ok) throw new Error(check.message)
    if(s.stopRequested || runId!==s.runId)throw new Error('Start cancelled')
    const child = launchFFmpeg(channel,source)
    s.process=child
    s.pid=child.pid??null
    s.status='starting'
    s.startedAt=new Date().toISOString()
    s.lastProgressAt=Date.now()
    s.progress={}
    s.lastError=null
    s.stderr=''
    let buffered=''
    child.stdout.on('data',(chunk:Buffer)=>{
      if(runId!==s.runId)return
      buffered+=chunk.toString('utf8')
      if(buffered.length>16384)buffered=buffered.slice(-8192)
      let i:number
      while((i=buffered.indexOf('\nprogress='))!==-1){
        const end=buffered.indexOf('\n',i+1)
        if(end===-1)break
        const block=buffered.slice(0,end+1)
        buffered=buffered.slice(end+1)
        const next=parseProgressBlock(block)
        const advanced=(next.outTime && next.outTime!==s.progress.outTime) ||
          (next.totalSize!==undefined && next.totalSize>(s.progress.totalSize??-1)) ||
          (next.frame!==undefined && next.frame>(s.progress.frame??-1))
        s.progress=next
        // FFmpeg can report progress=continue indefinitely while an HLS input is stalled.
        // Only advancing output counts as a healthy broadcast.
        if(advanced){
          s.lastProgressAt=Date.now()
          if(s.status==='starting'||s.status==='recovering')s.status='streaming'
          if(Date.now()-new Date(s.startedAt||0).getTime()>120000)s.failures=0
        }
      }
    })
    child.stderr.on('data',(chunk:Buffer)=>{s.stderr=(s.stderr+chunk.toString('utf8')).slice(-2400)})
    let handled=false
    const exit=(code:number|null,signal:string|null,error?:Error)=>{
      if(handled || runId!==s.runId)return
      handled=true;s.process=null;s.pid=null
      if(s.stopRequested||isShuttingDown){s.status='stopped';return}
      const tail=s.stderr.trim()
      // FFmpeg logs may contain signed upstream URLs; do not expose the log tail.
      s.lastError=error?.message || `FFmpeg exited (${code??signal??'unknown'})${tail?' — inspect server logs for details':''}`
      console.error(`[channel ${id}] ${s.lastError}`)
      queueRecovery(id,channel,s)
    }
    child.on('error',e=>exit(null,null,e))
    child.on('exit',(code,signal)=>exit(code,signal))
    return snapshot(channel)
  }catch(error){
    if(s.stopRequested || runId!==s.runId)return snapshot(channel)
    s.lastError=error instanceof Error?error.message:String(error)
    console.error(`[channel ${id}] start failed: ${s.lastError}`)
    queueRecovery(id,channel,s)
    if(!recovering)throw error
    return snapshot(channel)
  }
}
export async function stopChannel(id: string): Promise<ChannelSnapshot> {
  const channel = getChannel(id)
  if (!channel) throw new Error('Channel not found')
  const s = stateFor(id)
  s.stopRequested = true
  ++s.runId
  clearRetry(s)
  s.failures = 0
  const child = s.process
  if (!child) { s.status = 'stopped'; s.pid=null;return snapshot(channel) }
  s.status = 'stopping'
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { if (s.process === child) child.kill('SIGKILL') }, 5000)
    const finish = () => { clearTimeout(timeout); resolve() }
    if (child.exitCode !== null) {finish();return}
    child.once('exit', finish)
    child.once('error', finish)
    child.kill('SIGTERM')
  })
  s.process = null
  s.pid = null
  s.status = 'stopped'
  return snapshot(channel)
}
export async function restartChannel(id: string) {
  await stopChannel(id)
  return startChannel(id)
}
export async function startAutostartChannels() {
  for (const ch of listChannels().filter(c => c.autoStart)) {
    try { await startChannel(ch.id) } catch (e) { console.error(`[autostart] ${ch.name}:`,e) }
  }
}
export async function shutdown() {
  if (isShuttingDown) return
  isShuttingDown = true
  clearInterval(watchdog)
  clearInterval(egressGuard)
  await Promise.all(listChannels().filter(c => running(c.id)).map(c => stopChannel(c.id).catch(console.error)))
}
export function forgetChannel(id: string) { const s = states.get(id); if (s) clearRetry(s); states.delete(id) }
