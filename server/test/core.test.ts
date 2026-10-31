import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inCIDR, assertMulticast } from '../src/network.ts'
import { ffmpegArguments, parseProgressBlock } from '../src/ffmpeg.ts'
import { cleanName } from '../src/media.ts'
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
const channel:Channel={id:'1',name:'Info Channel',description:'',mediaId:'m1',groupIp:'239.80.0.1',port:5000,
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
