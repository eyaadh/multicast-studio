import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseM3u, parseJsonCatalog } from '../src/providers.ts'

test('provider is an extended M3U playlist, not an HLS manifest',()=>{
  assert.throws(()=>parseM3u('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nsegment.ts','https://example.org/index.m3u8'))
})
test('provider channel without tvg-id remains stable when another channel is inserted',()=>{
  const first=parseM3u('#EXTM3U\n#EXTINF:-1 group-title="News",News One\nhttps://example.org/first.m3u8?token=a','https://example.org/list.m3u')
  const second=parseM3u('#EXTM3U\n#EXTINF:-1 group-title="Other",Another\nhttps://example.org/other.m3u8\n#EXTINF:-1 group-title="News",News One\nhttps://example.org/first.m3u8?token=b','https://example.org/list.m3u')
  assert.equal(first[0]?.key,second[1]?.key)
})
test('relative JSON channel URLs resolve against catalog',()=>{
  const entries=parseJsonCatalog('[{"id":"demo","name":"Demo","url":"../live/index.m3u8"}]','https://example.org/playlists/all.json')
  assert.equal(entries[0]?.url,'https://example.org/live/index.m3u8')
})
