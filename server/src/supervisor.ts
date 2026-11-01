import { access } from 'node:fs/promises'
import { getChannel, getMedia, getProvider, listChannels, mediaPublic } from './db.js'
import { launchFFmpeg, launchLiveIngest, parseProgressBlock } from './ffmpeg.js'
import { resolveLiveSource } from './providers.js'
import { checkRoute } from './network.js'
import { config } from './config.js'
import {
  bufferedSeconds,
  liveBufferDirectory,
  liveBufferPlaylist,
  LIVE_PREBUFFER_SECONDS,
  prepareLiveBuffer,
  removeLiveBuffer,
} from './liveBuffer.js'
import type { Channel, ChannelSnapshot, ChannelStatus, Progress } from './types.js'
import type { ProviderChannel } from './providers.js'

type FFmpegProcess = ReturnType<typeof launchFFmpeg>
interface RunningState {
  status: ChannelStatus
  process: FFmpegProcess | null
  ingest: FFmpegProcess | null
  pid: number | null
  startedAt: string | null
  lastProgressAt: number
  lastIngestProgressAt: number
  progress: Progress
  restarts: number
  failures: number
  lastError: string | null
  stopRequested: boolean
  retryTimer: ReturnType<typeof setTimeout> | null
  outputRetryTimer: ReturnType<typeof setTimeout> | null
  outputFailures: number
  outputStartedAt: number
  outputStopping: boolean
  bufferTimer: ReturnType<typeof setInterval> | null
  bufferWindowSeconds: number
  cleanupPromise: Promise<void> | null
  bufferStartedAt: number
  stderr: string
  ingestStderr: string
  runId: number
  terminationReason: string | null
  terminationTimer: ReturnType<typeof setTimeout> | null
}
const states = new Map<string, RunningState>()
let isShuttingDown = false
// FFmpeg stderr can contain tokens and Authorization headers. Never log it verbatim.
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
export function outputStallTimeout(channel: Channel, status: ChannelStatus): number {
  if (channel.sourceType === 'live') return status === 'starting' ? 150000 : 90000
  return status === 'starting' ? 60000 : 35000
}
function stateFor(id: string): RunningState {
  let s = states.get(id)
  if (!s) {
    s = {
      status: 'stopped',
      process: null,
      ingest: null,
      pid: null,
      startedAt: null,
      lastProgressAt: 0,
      lastIngestProgressAt: 0,
      progress: {},
      restarts: 0,
      failures: 0,
      lastError: null,
      stopRequested: false,
      retryTimer: null,
      outputRetryTimer: null,
      outputFailures: 0,
      outputStartedAt: 0,
      outputStopping: false,
      bufferTimer: null,
      bufferWindowSeconds: 0,
      cleanupPromise: null,
      bufferStartedAt: 0,
      stderr: '',
      ingestStderr: '',
      runId: 0,
      terminationReason: null,
      terminationTimer: null,
    }
    states.set(id, s)
  }
  return s
}
function clearRetry(s: RunningState) {
  if (s.retryTimer) clearTimeout(s.retryTimer)
  s.retryTimer = null
}
function clearOutputRetry(s: RunningState) {
  if (s.outputRetryTimer) clearTimeout(s.outputRetryTimer)
  s.outputRetryTimer = null
}
function clearBufferTimer(s: RunningState) {
  if (s.bufferTimer) clearInterval(s.bufferTimer)
  s.bufferTimer = null
}
function clearTermination(s: RunningState) {
  if (s.terminationTimer) clearTimeout(s.terminationTimer)
  s.terminationTimer = null
}
function stopProcess(child: FFmpegProcess | null, graceMs = 5000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
    timer.unref()
    child.once('exit', done)
    child.once('error', done)
    child.kill('SIGTERM')
  })
}
function terminateStalledProcess(id: string, s: RunningState, reason: string) {
  if (s.terminationReason || (!s.process && !s.ingest)) return
  s.terminationReason = reason
  s.lastError = reason
  console.error(
    `[channel ${id}] ${reason}; output speed=${s.progress.speed ?? 'unknown'}; restarting pipeline`,
  )
  // The ingest and broadcast processes must restart together, otherwise the
  // broadcaster could consume stale segments from an abandoned ingest.
  const processes = [s.process, s.ingest].filter((p): p is FFmpegProcess => !!p)
  for (const child of processes) child.kill('SIGTERM')
  s.terminationTimer = setTimeout(() => {
    for (const child of processes)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 8000)
  s.terminationTimer.unref()
}
/** A failed live HLS reader must not tear down the still-healthy downloader/buffer. */
function terminateLiveOutput(id: string, s: RunningState, reason: string) {
  if (!s.process || !s.ingest || s.outputStopping) return
  s.outputStopping = true
  s.lastError = reason
  console.error(`[channel ${id}] ${reason}; restarting broadcaster only`)
  const child = s.process
  child.kill('SIGTERM')
  clearTermination(s)
  s.terminationTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 8000)
  s.terminationTimer.unref()
}
const watchdog = setInterval(() => {
  if (isShuttingDown) return
  for (const [id, s] of states) {
    if (s.ingest && !s.stopRequested) {
      const runId = s.runId
      void bufferedSeconds(id)
        .then((seconds) => {
          if (s.runId === runId) s.bufferWindowSeconds = seconds
        })
        .catch(() => {})
    }
    if (s.stopRequested || s.terminationReason || (!s.process && !s.ingest)) continue
    const channel = getChannel(id)
    if (!channel) continue
    const now = Date.now()
    if (s.ingest && !s.process && now - s.bufferStartedAt > 180000) {
      terminateStalledProcess(id, s, 'Live startup buffer did not fill within 180 seconds')
    } else if (s.ingest && now - s.lastIngestProgressAt > outputStallTimeout(channel, 'starting')) {
      terminateStalledProcess(id, s, 'Live downloader stopped producing segments')
    } else if (s.process && now - s.lastProgressAt > outputStallTimeout(channel, s.status)) {
      if (channel.sourceType === 'live' && s.ingest)
        terminateLiveOutput(id, s, 'FFmpeg multicast output stalled')
      else terminateStalledProcess(id, s, 'FFmpeg multicast output stalled')
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
        terminateStalledProcess(ch.id, s, `Multicast egress route changed: ${route.message}`)
      }
    }
  } catch (error) {
    console.error('[egress guard]', error)
  } finally {
    checkingEgress = false
  }
}, 15000)
egressGuard.unref()

export function snapshot(ch: Channel): ChannelSnapshot {
  const s = stateFor(ch.id)
  const media = ch.mediaId ? getMedia(ch.mediaId) : null
  return {
    ...ch,
    media: media ? mediaPublic(media) : null,
    sourceLabel:
      ch.sourceType === 'live'
        ? ch.providerId
          ? `${getProvider(ch.providerId)?.name || 'Provider'} · Live`
          : 'Direct live stream'
        : (media?.name ?? null),
    status: s.status,
    pid: s.pid,
    startedAt: s.startedAt,
    progress: s.progress,
    restarts: s.restarts,
    lastError: s.lastError,
    bufferState:
      ch.sourceType === 'live' && s.ingest
        ? s.process
          ? 'broadcasting'
          : s.outputFailures > 0
            ? 'recovering'
            : 'filling'
        : null,
    bufferWindowSeconds: ch.sourceType === 'live' && s.ingest ? s.bufferWindowSeconds : null,
  }
}
export function snapshots() {
  return listChannels().map(snapshot)
}
export function running(id: string) {
  const s = states.get(id)
  return (
    !!s &&
    (!!s.process ||
      !!s.ingest ||
      !!s.retryTimer ||
      !!s.outputRetryTimer ||
      s.status === 'starting' ||
      s.status === 'recovering')
  )
}
function queueRecovery(id: string, channel: Channel, s: RunningState): void {
  if (s.stopRequested || isShuttingDown || !channel.autoRecover) {
    s.status = 'error'
    return
  }
  if (channel.sourceType === 'media' && s.failures >= 6) {
    s.status = 'error'
    return
  }
  const delay = Math.min(60000, 2000 * 2 ** Math.min(s.failures, 5))
  s.failures++
  s.restarts++
  s.status = 'recovering'
  clearRetry(s)
  s.retryTimer = setTimeout(() => {
    s.retryTimer = null
    startChannel(id, true).catch((error) =>
      console.error(`[channel ${id}] retry:`, error instanceof Error ? error.message : error),
    )
  }, delay)
  s.retryTimer.unref()
}

/** Progress reports can repeat without any output advancement. */
function trackProgress(
  child: FFmpegProcess,
  runId: number,
  s: RunningState,
  kind: 'ingest' | 'output',
) {
  let buffered = ''
  child.stdout.on('data', (chunk: Buffer) => {
    if (runId !== s.runId) return
    buffered += chunk.toString('utf8')
    if (buffered.length > 16384) buffered = buffered.slice(-8192)
    let i: number
    while ((i = buffered.indexOf('\nprogress=')) !== -1) {
      const end = buffered.indexOf('\n', i + 1)
      if (end === -1) break
      const block = buffered.slice(0, end + 1)
      buffered = buffered.slice(end + 1)
      const next = parseProgressBlock(block)
      const previous = kind === 'ingest' ? (ingestProgress.get(child) ?? {}) : s.progress
      const advanced =
        (next.outTime && next.outTime !== previous.outTime) ||
        (next.totalSize !== undefined && next.totalSize > (previous.totalSize ?? -1)) ||
        (next.frame !== undefined && next.frame > (previous.frame ?? -1))
      if (kind === 'ingest') {
        ingestProgress.set(child, next)
        if (advanced) s.lastIngestProgressAt = Date.now()
      } else {
        s.progress = next
        if (advanced) {
          s.lastProgressAt = Date.now()
          if (kind === 'output' && s.outputStartedAt && Date.now() - s.outputStartedAt > 120000)
            s.outputFailures = 0
          s.lastError = null
          if (s.status === 'starting' || s.status === 'recovering') s.status = 'streaming'
          if (Date.now() - new Date(s.startedAt || 0).getTime() > 120000) s.failures = 0
        }
      }
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (runId !== s.runId) return
    if (kind === 'ingest') s.ingestStderr = (s.ingestStderr + chunk.toString('utf8')).slice(-2400)
    else s.stderr = (s.stderr + chunk.toString('utf8')).slice(-2400)
  })
}
const ingestProgress = new WeakMap<FFmpegProcess, Progress>()

export async function startChannel(id: string, recovering = false): Promise<ChannelSnapshot> {
  if (isShuttingDown) throw new Error('The application is shutting down')
  const channel = getChannel(id)
  if (!channel) throw new Error('Channel not found')
  const s = stateFor(id)
  if (s.cleanupPromise) await s.cleanupPromise
  if (s.process || s.ingest || s.status === 'stopping' || s.status === 'starting')
    throw new Error('Channel is already starting, running or stopping')
  if (s.retryTimer && !recovering)
    throw new Error('Channel is recovering; stop it before restarting manually')
  clearRetry(s)
  s.stopRequested = false
  s.status = recovering ? 'recovering' : 'starting'
  const runId = ++s.runId
  s.lastProgressAt = Date.now()
  clearOutputRetry(s)
  s.outputFailures = 0
  s.outputStopping = false
  let failureHandled = false
  const fail = (
    kind: 'ingest' | 'output',
    code: number | null,
    signal: string | null,
    error?: Error,
  ) => {
    if (failureHandled || runId !== s.runId || s.stopRequested || isShuttingDown) return
    failureHandled = true
    clearBufferTimer(s)
    clearOutputRetry(s)
    clearTermination(s)
    const diagnostic = summarizeFFmpegError(kind === 'ingest' ? s.ingestStderr : s.stderr)
    s.lastError =
      s.terminationReason ||
      (error ? `FFmpeg ${kind} failed` : null) ||
      `FFmpeg ${kind} exited (${signal ?? code ?? 'unknown'})${diagnostic ? `: ${diagnostic}` : ''}`
    s.terminationReason = null
    console.error(`[channel ${id}] ${s.lastError}`)
    const ingest = s.ingest,
      output = s.process
    s.ingest = null
    s.process = null
    s.pid = null
    s.bufferWindowSeconds = 0
    s.outputStopping = false
    s.status = 'recovering'
    // Serialize cleanup with manual stop/start so old cleanup cannot delete new segments.
    s.cleanupPromise = (async () => {
      await Promise.all([stopProcess(ingest), stopProcess(output)])
      if (channel.sourceType === 'live') await removeLiveBuffer(id)
    })()
      .catch((e) => console.error(`[channel ${id}] pipeline cleanup:`, e))
      .then(() => {
        s.cleanupPromise = null
        if (runId === s.runId && !s.stopRequested) queueRecovery(id, channel, s)
      })
  }
  try {
    let source
    if (channel.sourceType === 'live') source = await resolveLiveSource(channel, recovering)
    else {
      if (!channel.mediaId) throw new Error('No local video is configured')
      source = getMedia(channel.mediaId)
      if (!source) throw new Error('Selected media no longer exists')
      await access(source.storedPath)
    }
    if (s.stopRequested || runId !== s.runId) throw new Error('Start cancelled')
    const check = await checkRoute(channel.groupIp)
    if (config.streaming.verifyEgressRoute && !check.ok) throw new Error(check.message)
    if (s.stopRequested || runId !== s.runId) throw new Error('Start cancelled')
    s.startedAt = new Date().toISOString()
    s.progress = {}
    s.stderr = ''
    s.ingestStderr = ''
    s.terminationReason = null
    s.bufferWindowSeconds = 0
    clearTermination(s)
    if (channel.sourceType === 'media') {
      const child = launchFFmpeg(channel, source)
      s.process = child
      s.pid = child.pid ?? null
      s.status = 'starting'
      s.lastProgressAt = Date.now()
      trackProgress(child, runId, s, 'output')
      child.on('error', (e) => fail('output', null, null, e))
      child.on('exit', (code, signal) => fail('output', code, signal))
    } else {
      await prepareLiveBuffer(id)
      if (s.stopRequested || runId !== s.runId) {
        await removeLiveBuffer(id)
        return snapshot(channel)
      }
      const ingest = launchLiveIngest(source as ProviderChannel, liveBufferDirectory(id))
      s.ingest = ingest
      s.pid = ingest.pid ?? null
      s.status = 'starting'
      s.lastIngestProgressAt = Date.now()
      s.bufferStartedAt = Date.now()
      trackProgress(ingest, runId, s, 'ingest')
      ingest.on('error', (e) => fail('ingest', null, null, e))
      ingest.on('exit', (code, signal) => fail('ingest', code, signal))
      // Start/restart the broadcaster independently. A clean HLS EOF can occur
      // when the local rolling manifest is temporarily unchanged. Restarting
      // ingest as well would discard the prebuffer and produce a long UDP gap.
      const scheduleOutput = (delayMs: number) => {
        if (runId !== s.runId || s.stopRequested || failureHandled || !s.ingest) return
        clearOutputRetry(s)
        s.outputRetryTimer = setTimeout(() => {
          s.outputRetryTimer = null
          void attemptOutput()
        }, delayMs)
        s.outputRetryTimer.unref()
      }
      const outputExited = (code: number | null, signal: string | null, error?: Error) => {
        if (runId !== s.runId || s.stopRequested || failureHandled || isShuttingDown) return
        if (s.terminationReason || !s.ingest || !channel.autoRecover) {
          fail('output', code, signal, error)
          return
        }
        clearTermination(s)
        s.outputStopping = false
        s.process = null
        s.pid = s.ingest.pid ?? null
        s.progress = {}
        s.status = 'recovering'
        s.bufferStartedAt = Date.now()
        // A reader that played for a while is not a rapid crash loop. Resume
        // promptly so receivers see the shortest possible transport gap.
        if (Date.now() - s.outputStartedAt >= 15000) s.outputFailures = 0
        s.outputFailures++
        s.restarts++
        const diagnostic = summarizeFFmpegError(s.stderr)
        s.lastError = `Multicast broadcaster exited (${signal ?? code ?? 'unknown'})${diagnostic ? `: ${diagnostic}` : ''}`
        console.error(`[channel ${id}] ${s.lastError}; downloader retained; restarting broadcaster`)
        // Avoid rapid respawn loops if a source is genuinely unplayable.
        scheduleOutput(Math.min(15000, 1000 * 2 ** Math.min(s.outputFailures - 1, 4)))
      }
      let outputAttempting = false
      const attemptOutput = async () => {
        if (
          outputAttempting ||
          runId !== s.runId ||
          s.stopRequested ||
          failureHandled ||
          s.process ||
          !s.ingest
        )
          return
        outputAttempting = true
        try {
          const seconds = await bufferedSeconds(id)
          if (runId !== s.runId || s.stopRequested || failureHandled || !s.ingest) return
          s.bufferWindowSeconds = seconds
          if (seconds < LIVE_PREBUFFER_SECONDS) {
            scheduleOutput(1000)
            return
          }
          clearBufferTimer(s)
          const output = launchFFmpeg(channel, source, liveBufferPlaylist(id))
          s.process = output
          s.pid = output.pid ?? null
          s.lastProgressAt = Date.now()
          s.outputStartedAt = Date.now()
          s.stderr = ''
          console.info(`[channel ${id}] buffered ${seconds}s; multicast broadcast starting`)
          trackProgress(output, runId, s, 'output')
          let outputEnded = false
          const onOutputEnd = (code: number | null, signal: string | null, error?: Error) => {
            if (outputEnded) return
            outputEnded = true
            outputExited(code, signal, error)
          }
          output.once('error', (e) => onOutputEnd(null, null, e))
          output.once('exit', (code, signal) => onOutputEnd(code, signal))
        } catch (error) {
          console.error(
            `[channel ${id}] buffer monitor failed:`,
            error instanceof Error ? error.message : 'unknown error',
          )
          fail(
            'ingest',
            null,
            null,
            error instanceof Error ? error : new Error('Buffer monitor failed'),
          )
        } finally {
          outputAttempting = false
        }
      }
      // The initial prebuffer is polled until it is ready; later output-only
      // restarts reuse the same ingest and disk segments.
      s.bufferTimer = setInterval(() => {
        if (s.process || s.outputRetryTimer || runId !== s.runId || s.stopRequested) return
        void attemptOutput()
      }, 1000)
      s.bufferTimer.unref()
    }
    return snapshot(channel)
  } catch (error) {
    if (s.stopRequested || runId !== s.runId) return snapshot(channel)
    s.lastError = error instanceof Error ? error.message : String(error)
    console.error(`[channel ${id}] start failed: ${s.lastError}`)
    clearBufferTimer(s)
    queueRecovery(id, channel, s)
    if (!recovering) throw error
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
  clearOutputRetry(s)
  clearBufferTimer(s)
  clearTermination(s)
  s.outputStopping = false
  s.failures = 0
  s.terminationReason = null
  const output = s.process,
    ingest = s.ingest
  s.status = 'stopping'
  await Promise.all([stopProcess(output), stopProcess(ingest)])
  if (s.cleanupPromise) await s.cleanupPromise
  s.process = null
  s.ingest = null
  s.pid = null
  s.bufferWindowSeconds = 0
  if (channel.sourceType === 'live') await removeLiveBuffer(id)
  s.status = 'stopped'
  return snapshot(channel)
}
export async function restartChannel(id: string) {
  await stopChannel(id)
  return startChannel(id)
}
export async function startAutostartChannels() {
  for (const ch of listChannels().filter((c) => c.autoStart)) {
    try {
      await startChannel(ch.id)
    } catch (e) {
      console.error(`[autostart] ${ch.name}:`, e)
    }
  }
}
export async function shutdown() {
  if (isShuttingDown) return
  isShuttingDown = true
  clearInterval(watchdog)
  clearInterval(egressGuard)
  await Promise.all(
    listChannels()
      .filter((c) => running(c.id))
      .map((c) => stopChannel(c.id).catch(console.error)),
  )
}
export function forgetChannel(id: string) {
  const s = states.get(id)
  if (s) {
    clearRetry(s)
    clearOutputRetry(s)
    clearBufferTimer(s)
    clearTermination(s)
  }
  states.delete(id)
}
