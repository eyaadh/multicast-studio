import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { decodeCricfyPlaylist } from '../src/cricfy.ts'
import { parseM3u } from '../src/providers.ts'

test('decode clear and wrapped Cricfy M3U channel lists',()=>{
  const raw='#EXTM3U\n#EXTINF:-1,Test Channel\nhttps://example.org/live.m3u8\n'
  assert.equal(decodeCricfyPlaylist(raw),raw.trim())
  const key=randomBytes(32),iv=randomBytes(16)
  const cipher=createCipheriv('aes-256-cbc',key,iv)
  const encoded=Buffer.concat([cipher.update(raw),cipher.final()]).toString('base64')
  const wrapped=encoded.slice(0,10)+iv.toString('base64')+encoded.slice(10,-10)+key.toString('base64')+encoded.slice(-10)
  assert.equal(decodeCricfyPlaylist(wrapped),raw)
})
test('Kodi headers are preserved but DRM-marked channels are excluded',()=>{
  const m3u=`#EXTM3U
#EXTINF:-1 group-title="Sports",Sample stream
#EXTVLCOPT:http-user-agent=Test UA
#EXTHTTP:{"cookie":"session=abc"}
https://example.org/live.m3u8|Referer=https%3A%2F%2Fexample.org%2F
#EXTINF:-1,Protected stream
#KODIPROP:inputstream.adaptive.license_key=https://example.org/license
https://example.org/protected.mpd
`
  const channels=parseM3u(m3u,'https://example.org/playlist.m3u')
  assert.equal(channels.length,1)
  assert.equal(channels[0]?.userAgent,'Test UA')
  assert.equal(channels[0]?.cookie,'session=abc')
  assert.equal(channels[0]?.referer,'https://example.org/')
})
