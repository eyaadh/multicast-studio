import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Channel, Media, Progress } from './types.js'
import type { ProviderChannel } from './providers.js'
import { config, streamingIP } from './config.js'
import { join } from 'node:path'
import { LIVE_SEGMENT_SECONDS, LIVE_WINDOW_SEGMENTS, LIVE_DELETE_THRESHOLD } from './liveBuffer.js'

const execFileAsync = promisify(execFile)
export async function probeVideo(path: string) {
  const { stdout } = await execFileAsync(
    config.tools.ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_name,codec_type,width,height',
      '-of',
      'json',
      path,
    ],
    { timeout: 30000, maxBuffer: 2_000_000 },
  )
  const response = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: Array<{ codec_name?: string; codec_type?: string; width?: number; height?: number }>
  }
  const video = response.streams?.find((s) => s.codec_type === 'video')
  if (!video) throw new Error('No video stream was detected in this file')
  const audio = response.streams?.find((s) => s.codec_type === 'audio')
  return {
    duration: Number.isFinite(Number(response.format?.duration))
      ? Number(response.format?.duration)
      : null,
    videoCodec: video.codec_name || null,
    audioCodec: audio?.codec_name || null,
    width: video.width || null,
    height: video.height || null,
  }
}
export function ffmpegArguments(
  ch: Channel,
  source: Media | ProviderChannel,
  bufferedPlaylist?: string,
): string[] {
  const isLive = ch.sourceType === 'live'
  const inputArgs = bufferedPlaylist
    ? [
        '-re',
        '-live_start_index',
        '-10',
        // Keep waiting for fresh local segments instead of treating a temporarily
        // unchanged rolling HLS playlist as end-of-stream.
        '-max_reload',
        '100000',
        '-m3u8_hold_counters',
        '100000',
        '-seg_max_retry',
        '3',
        '-i',
        bufferedPlaylist,
      ]
    : isLive
      ? [...(ch.directLive ? ['-fflags', '+genpts+discardcorrupt'] : []), ...ffmpegLiveInput(source as ProviderChannel)]
      : ['-re', '-stream_loop', '-1', '-i', (source as Media).storedPath]
  const base = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'warning',
    '-stats_period',
    '2',
    // Limit video filter parallelism when converting a live feed on a small VM.
    ...(isLive && ch.profile === 'mpeg2' ? ['-filter_threads', '1'] : []),
    '-progress',
    'pipe:1',
    ...inputArgs,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-sn',
    '-dn',
  ]
  let codecArgs: string[]
  if (ch.profile === 'copy') {
    codecArgs = ['-c', 'copy']
  } else {
    const codec =
      ch.profile === 'h264' ? 'libx264' : ch.profile === 'mpeg4' ? 'mpeg4' : 'mpeg2video'
    const audio = ch.profile === 'h264' ? 'aac' : 'mp2'
    const vf = ch.directLive && isLive
      ? `fps=${ch.fps}`
      : `scale=${ch.width}:${ch.height}:force_original_aspect_ratio=decrease,pad=${ch.width}:${ch.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${ch.fps},format=yuv420p`
    codecArgs = [
      '-vf',
      vf,
      '-c:v',
      codec,
      ...(ch.profile === 'mpeg2' ? ['-threads', '2', '-bf', '0'] : []),
      ...(ch.profile === 'h264' ? ['-preset', 'veryfast', '-tune', 'zerolatency'] : []),
      '-b:v',
      `${ch.videoBitrateKbps}k`,
      '-maxrate',
      `${ch.videoBitrateKbps}k`,
      '-bufsize',
      `${ch.videoBitrateKbps * 2}k`,
      '-g',
      String(ch.fps * 2),
      '-c:a',
      audio,
      '-b:a',
      `${ch.audioBitrateKbps}k`,
      '-ar',
      '48000',
      '-ac',
      '2',
    ]
  }
  const url = `udp://${ch.groupIp}:${ch.port}?pkt_size=${config.streaming.packetSize}&ttl=${ch.ttl}&localaddr=${streamingIP}`
  return [
    ...base,
    ...codecArgs,
    '-metadata',
    `service_name=${ch.name}`,
    '-metadata',
    'service_provider=Multicast Studio',
    '-mpegts_service_id',
    String(ch.serviceId),
    '-mpegts_transport_stream_id',
    '1',
    '-mpegts_original_network_id',
    '1',
    // Signal a transport discontinuity after a live broadcaster restart so
    // receivers can re-lock instead of interpreting reset continuity counters
    // as packet corruption. Does not change local video playout.
    ...(isLive ? ['-mpegts_flags', '+initial_discontinuity'] : []),
    '-f',
    'mpegts',
    '-flush_packets',
    '1',
    url,
  ]
}
export function parseProgressBlock(block: string): Progress {
  const raw: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const p = line.indexOf('=')
    if (p > 0) raw[line.slice(0, p)] = line.slice(p + 1)
  }
  const safeNumber = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined)
  return {
    frame: safeNumber(raw.frame),
    fps: safeNumber(raw.fps),
    bitrate: raw.bitrate,
    speed: raw.speed,
    outTime: raw.out_time,
    totalSize: safeNumber(raw.total_size),
    updatedAt: new Date().toISOString(),
  }
}
/** Download/remux internet video to a bounded rolling HLS directory; no encoding here. */
export function liveIngestArguments(source: ProviderChannel, directory: string): string[] {
  const input = ffmpegLiveInput(source)
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'warning',
    '-stats_period',
    '2',
    '-progress',
    'pipe:1',
    ...input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-sn',
    '-dn',
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_segment_type',
    'mpegts',
    '-hls_time',
    String(LIVE_SEGMENT_SECONDS),
    '-hls_list_size',
    String(LIVE_WINDOW_SEGMENTS),
    '-hls_delete_threshold',
    String(LIVE_DELETE_THRESHOLD),
    '-hls_flags',
    'delete_segments+temp_file+omit_endlist',
    '-hls_segment_filename',
    join(directory, 'segment_%08d.ts'),
    join(directory, 'index.m3u8'),
  ]
}
function ffmpegLiveInput(source: ProviderChannel): string[] {
  return [
    '-protocol_whitelist',
    'http,https,tcp,tls,crypto,data',
    '-rw_timeout',
    '15000000',
    ...(source.userAgent ? ['-user_agent', source.userAgent] : []),
    ...(source.referer ? ['-referer', source.referer] : []),
    ...(source.cookie || (source.headers && Object.keys(source.headers).length)
      ? [
          '-headers',
          [
            ...(source.cookie ? [`Cookie: ${source.cookie}\r\n`] : []),
            ...Object.entries(source.headers || {})
              .filter(([key]) => /^[a-z0-9-]{1,40}$/i.test(key))
              .map(([key, value]) => `${key}: ${value.replace(/[\r\n]/g, '')}\r\n`),
          ].join(''),
        ]
      : []),
    '-i',
    source.url.trim(),
  ]
}
export function launchLiveIngest(source: ProviderChannel, directory: string) {
  console.log('[Live Ingest] Starting:', {
    url: source.url,
    userAgent: source.userAgent,
    referer: source.referer,
    hasCookies: Boolean(source.cookie),
    headerNames: Object.keys(source.headers || {}),
    directory,
  })

  return spawn(config.tools.ffmpeg, liveIngestArguments(source, directory), {
    stdio: ['ignore', 'pipe', 'pipe'] as const,
  })
}
export function launchFFmpeg(
  ch: Channel,
  source: Media | ProviderChannel,
  bufferedPlaylist?: string,
) {
  return spawn(config.tools.ffmpeg, ffmpegArguments(ch, source, bufferedPlaylist), {
    stdio: ['ignore', 'pipe', 'pipe'] as const,
  })
}
