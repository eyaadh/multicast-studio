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
  terminationReason: string | null; terminationTimer: ReturnType<typeof setTimeout> | null;
}
const states = new Map<string, RunningState>()
let isShuttingDown = false
// Do not copy FFmpeg stderr into logs verbatim: it may contain upstream tokens.
export function summarizeFFmpegError(stderr: string): string | null {
  const known = [
    /HTTP error (\d{3})/i,
    /Server returned (\d{3})/i,
    /Connection timed out/i,
    /Connection refused/i,
    /End of file/i,
    /Invalid data found when processing input/i,
    /Error opening input/i,
    /Error while decoding stream/i,
    /Conversion failed/i,
    /No such file or directory/i,
  ]
  for (const pattern of known) {
    const match = stderr.match(pattern)
    if (match) return match[0]
  }
  return null
}
// HLS sources may pause while fetching the next segment or establishing a connection.
// Do not treat a 35-second pause as proof that a live feed has failed.
export function outputStallTimeout(channel: Channel, status: ChannelStatus): number {
  if (channel.sourceType === 'live') return status === 'starting' ? 150000 : 90000
  return status === 'starting' ? 60000 : 35000
}
function terminateStalledProcess(id: string, s: RunningState, reason: string) {
  const child = s.process
  if (!child || s.terminationReason) return // Avoid repeatedly killing the same process.
  s.terminationReason = reason
  s.lastError = reason
  console.error(`[channel ${id}] ${reason}; last output speed=${s.progress.speed ?? 'unknown'}, fps=${s.progress.fps ?? 'unknown'}; requesting a graceful FFmpeg exit`)
  child.kill('SIGTERM')
  // FFmpeg occasionally gets stuck in a network read. Force-stop only if necessary.
  s.terminationTimer = setTimeout(() => {
    if (s.process === child) {
      console.error(`[channel ${id}] FFmpeg did not terminate after SIGTERM; forcing SIGKILL`)
      child.kill('SIGKILL')
    }
  }, 8000)
  s.terminationTimer.unref()
}
const watchdog = setInterval(() => {
  if (isShuttingDown) return
  for (const [id, state] of states) {
    if (!state.process || state.stopRequested || state.terminationReason) continue
    const channel = getChannel(id)
    if (!channel) continue
    const timeout = outputStallTimeout(channel, state.status)
    if (Date.now() - state.lastProgressAt > timeout) {
      terminateStalledProcess(id, state,
        `FFmpeg output stalled for ${Math.round(timeout / 1000)} seconds (${channel.sourceType} source)`)
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
        s.terminationReason = `Multicast egress route changed: ${route.message}`
        console.error(`[channel ${ch.id}] Route guard: ${route.message}; terminating FFmpeg immediately`)
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
      progress:{},restarts:0,failures:0,lastError:null,stopRequested:false,retryTimer:null,stderr:'',runId:0,terminationReason:null,terminationTimer:null}
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
    // Preserve a failure reason until the new process produces actual output.
    s.stderr=''
    s.terminationReason=null
    if (s.terminationTimer) clearTimeout(s.terminationTimer)
    s.terminationTimer=null
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
          s.lastError=null
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
      if (s.terminationTimer) clearTimeout(s.terminationTimer)
      s.terminationTimer=null
      const reason=s.terminationReason
      s.terminationReason=null
      if(s.stopRequested||isShuttingDown){s.status='stopped';return}
      // FFmpeg may print signed source URLs and authorization headers to stderr.
      // Summarize only safe, recognizable conditions rather than logging raw output.
      const diagnostic=summarizeFFmpegError(s.stderr)
      s.lastError=reason || error?.message ||
        `FFmpeg exited (${signal ?? code ?? 'unknown'})${diagnostic ? `: ${diagnostic}` : ''}`
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
  if (s.terminationTimer) clearTimeout(s.terminationTimer)
  s.terminationTimer=null
  s.terminationReason=null
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
export function forgetChannel(id: string) {
  const s = states.get(id)
  if (s) {
    clearRetry(s)
    if (s.terminationTimer) clearTimeout(s.terminationTimer)
  }
  states.delete(id)
}
