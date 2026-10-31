import { access } from 'node:fs/promises'
import { getChannel, getMedia, listChannels, mediaPublic } from './db.js'
import { launchFFmpeg, parseProgressBlock } from './ffmpeg.js'
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
  const media = getMedia(ch.mediaId)
  return {...ch, media:media ? mediaPublic(media) : null,status:s.status,pid:s.pid,
    startedAt:s.startedAt,progress:s.progress,restarts:s.restarts,lastError:s.lastError}
}
export function snapshots() { return listChannels().map(snapshot) }
export function running(id: string) {
  const s = states.get(id)
  return !!s && (s.process !== null || s.retryTimer !== null || s.status === 'starting')
}
function clearRetry(s: RunningState) { if (s.retryTimer) clearTimeout(s.retryTimer); s.retryTimer = null }
export async function startChannel(id: string, recovering = false): Promise<ChannelSnapshot> {
  if (isShuttingDown) throw new Error('The application is shutting down')
  const channel = getChannel(id)
  if (!channel) throw new Error('Channel not found')
  const s = stateFor(id)
  if (s.process || s.status === 'stopping') throw new Error('Channel is already running or stopping')
  clearRetry(s)
  s.stopRequested = false
  s.status = recovering ? 'recovering' : 'starting'
  try {
    const media = getMedia(channel.mediaId)
    if (!media) throw new Error('Selected media no longer exists')
    await access(media.storedPath)
    const check = await checkRoute(channel.groupIp)
    if (config.streaming.verifyEgressRoute && !check.ok) throw new Error(check.message)
    const child = launchFFmpeg(channel, media)
    const runId = ++s.runId
    s.process = child
    s.pid = child.pid ?? null
    s.status = 'starting'
    s.startedAt = new Date().toISOString()
    s.lastProgressAt = Date.now()
    s.progress = {}
    s.lastError = null
    s.stderr = ''
    let buffered = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (runId !== s.runId) return
      buffered += chunk.toString('utf8')
      if (buffered.length > 16384) buffered = buffered.slice(-8192)
      let i: number
      while ((i = buffered.indexOf('\nprogress=')) !== -1) {
        const end = buffered.indexOf('\n',i+1)
        if (end === -1) break
        const block = buffered.slice(0,end+1)
        buffered = buffered.slice(end+1)
        s.progress = parseProgressBlock(block)
        s.lastProgressAt = Date.now()
        if (s.status === 'starting' || s.status === 'recovering') s.status = 'streaming'
        if (Date.now() - new Date(s.startedAt || 0).getTime() > 120000) s.failures = 0
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { s.stderr = (s.stderr + chunk.toString('utf8')).slice(-2400) })
    let handled = false
    const exit = (code: number | null, signal: string | null, error?: Error) => {
      if (handled || runId !== s.runId) return
      handled = true
      s.process = null
      s.pid = null
      if (s.stopRequested || isShuttingDown) { s.status='stopped'; return }
      const tail = s.stderr.trim()
      s.lastError = (signal === 'SIGKILL' && s.lastError)
        ? s.lastError
        : (error?.message || `FFmpeg exited (${code ?? signal ?? 'unknown'})${tail ? ': ' + tail.slice(-600) : ''}`)
      s.status = 'error'
      console.error(`[channel ${id}] ${s.lastError}`)
      if (channel.autoRecover && s.failures < 6) {
        const delay = Math.min(60000, 2000 * Math.pow(2, s.failures++))
        s.restarts++
        s.status = 'recovering'
        s.retryTimer = setTimeout(() => {
          s.retryTimer = null
          startChannel(id,true).catch(e => {
            s.status='error'
            s.lastError = e instanceof Error ? e.message : String(e)
            console.error(`[channel ${id}] recovery failed: ${s.lastError}`)
          })
        },delay)
      }
    }
    child.on('error', (e) => exit(null,null,e))
    child.on('exit', (code, signal) => exit(code,signal))
    return snapshot(channel)
  } catch (error) {
    s.status = 'error'
    s.lastError = error instanceof Error ? error.message : String(error)
    throw error
  }
}
export async function stopChannel(id: string): Promise<ChannelSnapshot> {
  const channel = getChannel(id)
  if (!channel) throw new Error('Channel not found')
  const s = stateFor(id)
  s.stopRequested = true
  clearRetry(s)
  s.failures = 0
  const child = s.process
  if (!child) { s.status = 'stopped'; return snapshot(channel) }
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
