import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inCIDR, assertMulticast } from '../src/network.ts'
import { ffmpegArguments, parseProgressBlock } from '../src/ffmpeg.ts'
import { cleanName } from '../src/media.ts'
import { outputStallTimeout, summarizeFFmpegError } from '../src/supervisor.ts'
import { parseM3u, parseJsonCatalog, validateHttpUrl } from '../src/providers.ts'
import type { Channel, Media } from '../src/types.ts'

test('accept only allowed 239.x multicast range',()=>{
  assert.equal(inCIDR('239.80.0.1','239.80.0.0/16'),true)
  assert.equal(inCIDR('239.81.0.1','239.80.0.0/16'),false)
  assert.throws(()=>assertMulticast('224.0.0.1','224.0.0.0/4'))
  assert.throws(()=>assertMulticast('239.81.0.1','239.80.0.0/16'))
  assert.doesNotThrow(()=>assertMulticast('239.80.0.1','239.80.0.0/16'))
})
test('reject unsafe import filenames',()=>{
  assert.equal(cleanName('welcome.mp4'),'welcome.mp4')
  assert.throws(()=>cleanName('dangerous.exe'))
})
const channel:Channel={id:'1',name:'Info Channel',description:'',sourceType:'media',mediaId:'m1',providerId:null,providerChannelKey:null,streamUrl:null,groupIp:'239.80.0.1',port:5000,
  profile:'mpeg4',videoBitrateKbps:2500,audioBitrateKbps:128,width:1280,height:720,fps:25,ttl:1,
  autoStart:true,autoRecover:true,serviceId:101,createdAt:'',updatedAt:''}
const media:Media={id:'m1',name:'welcome.mp4',storedPath:'/tmp/welcome.mp4',origin:'upload',bytes:1024,
  duration:30,videoCodec:'h264',audioCodec:'aac',width:1280,height:720,createdAt:''}
test('legacy MPEG-4 command binds multicast to chosen local source IP',()=>{
  const args=ffmpegArguments(channel,media)
  assert.equal(args[args.indexOf('-c:v')+1],'mpeg4')
  assert.equal(args[args.indexOf('-c:a')+1],'mp2')
  assert.equal(args[args.indexOf('-stream_loop')+1],'-1')
  assert.match(args.at(-1)||'',/udp:\/\/239\.80\.0\.1:5000\?pkt_size=1316&ttl=1&localaddr=/)
})
test('direct copy avoids transcoding',()=>{
  const args=ffmpegArguments({...channel,profile:'copy'},media)
  assert.deepEqual(args.slice(args.indexOf('-c'),args.indexOf('-c')+2),['-c','copy'])
  assert.equal(args.includes('-vf'),false)
})
test('FFmpeg progress parsing',()=>{
  const data=parseProgressBlock('frame=124\nfps=25.0\nbitrate=2511.0kbits/s\nout_time=00:00:04.960000\nspeed=1.00x\nprogress=continue\n')
  assert.equal(data.frame,124)
  assert.equal(data.fps,25)
  assert.equal(data.speed,'1.00x')
})

test('live HLS inputs do not loop or use file inputs; MPEG-TS output is still multicast',()=>{
  const live={...channel,sourceType:'live' as const,mediaId:null,providerId:'p1',providerChannelKey:'c1',streamUrl:null}
  const args=ffmpegArguments(live,{key:'c1',name:'Live',group:'',logo:null,url:'https://example.org/live.m3u8'})
  assert.equal(args.includes('-stream_loop'),false)
  assert.equal(args.includes('-re'),false)
  assert.equal(args[args.indexOf('-i')+1],'https://example.org/live.m3u8')
  assert.ok(args.includes('-rw_timeout'))
  assert.match(args.at(-1)||'',/udp:\/\/239\.80\.0\.1:5000/)
})
test('M3U channel identity survives signed-url refresh and changes elsewhere in playlist',()=>{
  const first=parseM3u('#EXTM3U\n#EXTINF:-1 tvg-id="channel-1" group-title="Sports",Sports 1\nhttps://example.org/abc.m3u8?token=one\n','https://example.org/list.m3u')
  const second=parseM3u('#EXTM3U\n#EXTINF:-1,Unrelated\nhttps://example.org/unrelated.m3u8\n#EXTINF:-1 tvg-id="channel-1" group-title="Sports",Sports 1\nhttps://example.org/abc.m3u8?token=two\n','https://example.org/list.m3u')
  assert.equal(first.length,1)
  assert.equal(first[0]?.key,second[1]?.key)
  assert.notEqual(first[0]?.url,second[1]?.url)
})
test('JSON provider channel directory parsing and URL safeguards',()=>{
  const items=parseJsonCatalog(JSON.stringify([{id:'station-x',name:'Station X',url:'/live.m3u8'}]),'https://example.org/channels.json')
  assert.equal(items[0]?.url,'https://example.org/live.m3u8')
  assert.throws(()=>validateHttpUrl('file:///etc/passwd'))
  assert.throws(()=>validateHttpUrl('https://password:secret@example.org/live.m3u8'))
})

test('live channel watchdog tolerates HLS buffering more than local files',()=>{
  assert.equal(outputStallTimeout({...channel,sourceType:'live'},'starting'),150000)
  assert.equal(outputStallTimeout({...channel,sourceType:'live'},'streaming'),90000)
  assert.equal(outputStallTimeout(channel,'streaming'),35000)
})
test('safe FFmpeg errors do not leak signed URLs or request credentials',()=>{
  const error='https://stream.example/index.m3u8?token=private: Server returned 403 Forbidden\nAuthorization: Bearer secret-token'
  assert.equal(summarizeFFmpegError(error),'Server returned 403')
  assert.equal(summarizeFFmpegError('Unexpected request error for https://x.example/a?token=private'),null)
})
test('live MPEG-2 uses bounded encoding threads and SD-compatible settings',()=>{
  const live={...channel,sourceType:'live' as const,mediaId:null,profile:'mpeg2' as const,
    width:720,height:576,fps:25,videoBitrateKbps:3500,audioBitrateKbps:192}
  const args=ffmpegArguments(live,{key:'one',name:'Live',group:'',logo:null,url:'https://example.org/live.m3u8'})
  assert.equal(args[args.indexOf('-filter_threads')+1],'1')
  assert.equal(args[args.indexOf('-threads')+1],'2')
  assert.equal(args[args.indexOf('-bf')+1],'0')
  assert.equal(args[args.indexOf('-c:v')+1],'mpeg2video')
  assert.equal(args[args.indexOf('-b:v')+1],'3500k')
})

test('buffered live output reads disk playlist with real-time pacing, without HTTP request headers',()=>{
  const live={...channel,sourceType:'live' as const,mediaId:null,profile:'copy' as const}
  const source={key:'one',name:'Live',group:'',logo:null,url:'https://example.org/live.m3u8',
    userAgent:'CustomUserAgent',referer:'https://example.org'}
  const args=ffmpegArguments(live,source,'/tmp/buffer/index.m3u8')
  assert.equal(args[args.indexOf('-i')+1],'/tmp/buffer/index.m3u8')
  assert.equal(args.includes('-re'),true)
  assert.equal(args.includes('-live_start_index'),true)
  assert.equal(args.includes('-user_agent'),false)
  assert.equal(args.includes('-referer'),false)
  assert.equal(args.includes('-rw_timeout'),false)
  assert.equal(args[args.indexOf('-c')+1],'copy')
})
test('live downloader copies codecs into bounded HLS segments before multicast',async()=>{
  const {liveIngestArguments}=await import('../src/ffmpeg.ts')
  const args=liveIngestArguments({key:'a',name:'TV',group:'',logo:null,url:'https://example.org/a.m3u8'},'/tmp/buffer')
  assert.equal(args[args.indexOf('-c')+1],'copy')
  assert.equal(args[args.indexOf('-hls_time')+1],'2')
  assert.equal(args[args.indexOf('-hls_list_size')+1],'24')
  assert.equal(args.includes('-vf'),false)
  assert.equal(args.includes('udp://'),false)
  assert.equal(args[args.indexOf('-i')+1],'https://example.org/a.m3u8')
})
test('buffer readiness counts completed segments, not just the manifest target duration',async()=>{
  const {parseBufferedSeconds,liveBufferDirectory}=await import('../src/liveBuffer.ts')
  assert.equal(parseBufferedSeconds('#EXTM3U\n#EXT-X-TARGETDURATION:6\n'),0)
  assert.equal(parseBufferedSeconds('#EXTM3U\n#EXTINF:5.5,\nsegment0.ts\n#EXTINF:6.0,\nsegment1.ts\n'),11.5)
  assert.throws(()=>liveBufferDirectory('../../escape'))
})
