import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseM3u, parseJsonCatalog, pageProviderChannels } from '../src/providers.ts'

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

test('M3U channel selection stays stable after playlist reorder and token rotation',()=>{
  const before=parseM3u('#EXTM3U\n#EXTINF:-1 tvg-id="test.id" group-title="Sports",Test One\nhttps://media.example/live/index.m3u8?token=old', 'https://example.org/all.m3u')
  const after=parseM3u('#EXTM3U\n#EXTINF:-1,Unrelated\nhttps://other.example/video.m3u8\n#EXTINF:-1 tvg-id="test.id" group-title="Sports",Test One\nhttps://media.example/live/index.m3u8?token=new', 'https://example.org/all.m3u')
  assert.equal(before[0]?.key,after[1]?.key)
})
test('large M3U lists are indexed past the old 3000-channel limit and paginated',()=>{
  const text=['#EXTM3U',...Array.from({length:5100},(_,i)=>`#EXTINF:-1 group-title="Group ${i%4}",Channel ${i}\nhttps://example.org/live/${i}/master.m3u8`)].join('\n')
  const all=parseM3u(text,'https://example.org/all.m3u')
  assert.equal(all.length,5100)
  const page=pageProviderChannels(all,{page:2,limit:50,search:'Channel',group:'Group 1'})
  assert.equal(page.pagination.total,1275)
  assert.equal(page.data.length,50)
  assert.equal(page.data[0]?.name,'Channel 201')
  assert.equal(page.catalogTotal,5100)
})
test('DRM-marked channels are skipped, while ordinary HLS source entries are retained',()=>{
  const list=parseM3u('#EXTM3U\n#EXTINF:-1,DRM\n#KODIPROP:inputstream.adaptive.license_key=https://x.example/key\nhttps://example.org/protected.mpd\n#EXTINF:-1 group-title="News",News\nhttps://example.org/news/index.m3u8','https://example.org/list.m3u')
  assert.deepEqual(list.map(ch=>ch.name),['News'])
})

test('Hilay-style M3U catalog survives unrelated HLS directives and keeps live URL headers',()=>{
  const playlist = [
    '#EXTM3U url-tvg="https://epg.pw/xmltv/epg.xml"',
    '# Hilay TV secondary EPG merged into playlist header',
    '#EXT-X-VERSION:3',
    '#EXTINF:-1 tvg-chno="1" tvg-name="Hilay TV Info" group-title="info",Hilay TV Info',
    'https://embed.example/live.m3u8',
    '#EXTINF:-1 tvg-id="TVMaldives.mv" group-title="HilayTV | Dhivehi",Television Maldives (PSM)',
    'https://lana.psm.mv/live/tvm.m3u8|User-Agent=Mozilla%2F5.0&Referer=https%3A%2F%2Fpsm.mv%2F',
  ].join('\n')
  const channels = parseM3u(playlist,'https://hilaytv.xyz/play.m3u')
  assert.equal(channels.length,2)
  assert.equal(channels[0]?.name,'Hilay TV Info')
  assert.equal(channels[1]?.group,'HilayTV | Dhivehi')
  assert.equal(channels[1]?.url,'https://lana.psm.mv/live/tvm.m3u8')
  assert.equal(channels[1]?.userAgent,'Mozilla/5.0')
  assert.equal(channels[1]?.referer,'https://psm.mv/')
})

test('HLS master manifest must not be imported as an IPTV catalog',()=>{
  const manifest='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nhttps://example.org/video/720p.m3u8'
  assert.throws(()=>parseM3u(manifest,'https://example.org/master.m3u8'),/HLS manifest/)
})
