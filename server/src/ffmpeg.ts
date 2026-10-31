import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Channel, Media, Progress } from './types.js'
import { config, streamingIP } from './config.js'

const execFileAsync = promisify(execFile)
export async function probeVideo(path: string) {
  const {stdout} = await execFileAsync(config.tools.ffprobe,
    ['-v','error','-show_entries','format=duration:stream=codec_name,codec_type,width,height','-of','json',path],
    {timeout: 30000, maxBuffer: 2_000_000})
  const response = JSON.parse(stdout) as {format?: {duration?: string}; streams?: Array<{codec_name?:string;codec_type?:string;width?:number;height?:number}>}
  const video = response.streams?.find(s => s.codec_type === 'video')
  if (!video) throw new Error('No video stream was detected in this file')
  const audio = response.streams?.find(s => s.codec_type === 'audio')
  return {
    duration: Number.isFinite(Number(response.format?.duration)) ? Number(response.format?.duration) : null,
    videoCodec: video.codec_name || null, audioCodec: audio?.codec_name || null,
    width: video.width || null, height:video.height || null
  }
}
export function ffmpegArguments(ch: Channel, media: Media): string[] {
  const base = ['-hide_banner','-nostdin','-loglevel','warning','-stats_period','2',
    '-progress','pipe:1','-re','-stream_loop','-1','-i',media.storedPath,
    '-map','0:v:0','-map','0:a:0?','-sn','-dn']
  let codecArgs: string[]
  if (ch.profile === 'copy') {
    codecArgs = ['-c','copy']
  } else {
    const codec = ch.profile === 'h264' ? 'libx264' : ch.profile === 'mpeg4' ? 'mpeg4' : 'mpeg2video'
    const audio = ch.profile === 'h264' ? 'aac' : 'mp2'
    const vf = `scale=${ch.width}:${ch.height}:force_original_aspect_ratio=decrease,pad=${ch.width}:${ch.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${ch.fps},format=yuv420p`
    codecArgs = ['-vf',vf,'-c:v',codec,
      ...(ch.profile === 'h264' ? ['-preset','veryfast','-tune','zerolatency'] : []),
      '-b:v',`${ch.videoBitrateKbps}k`,'-maxrate',`${ch.videoBitrateKbps}k`,
      '-bufsize',`${ch.videoBitrateKbps * 2}k`,'-g',String(ch.fps * 2),
      '-c:a',audio,'-b:a',`${ch.audioBitrateKbps}k`,'-ar','48000','-ac','2']
  }
  const url = `udp://${ch.groupIp}:${ch.port}?pkt_size=${config.streaming.packetSize}&ttl=${ch.ttl}&localaddr=${streamingIP}`
  return [...base,...codecArgs,'-metadata',`service_name=${ch.name}`,'-metadata','service_provider=Multicast Studio',
    '-mpegts_service_id',String(ch.serviceId),'-mpegts_transport_stream_id','1',
    '-mpegts_original_network_id','1','-f','mpegts','-flush_packets','1',url]
}
export function parseProgressBlock(block: string): Progress {
  const raw: Record<string,string> = {}
  for (const line of block.split(/\r?\n/)) {
    const p = line.indexOf('=')
    if (p > 0) raw[line.slice(0,p)] = line.slice(p+1)
  }
  const safeNumber = (v?: string) => v && Number.isFinite(Number(v)) ? Number(v) : undefined
  return {
    frame:safeNumber(raw.frame),fps:safeNumber(raw.fps),
    bitrate:raw.bitrate, speed:raw.speed,outTime:raw.out_time,
    totalSize:safeNumber(raw.total_size),updatedAt:new Date().toISOString()
  }
}
export function launchFFmpeg(ch: Channel, media: Media) {
  return spawn(config.tools.ffmpeg, ffmpegArguments(ch, media), {stdio:['ignore','pipe','pipe'] as const})
}
