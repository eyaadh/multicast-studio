/** Bounded, disk-backed live ingest. The downloader never sends multicast packets. */
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDirectory } from './config.js'

export const LIVE_PREBUFFER_SECONDS = 20
export const LIVE_SEGMENT_SECONDS = 2
// Segment count bounds disk use; actual time window varies with source keyframes.
export const LIVE_WINDOW_SEGMENTS = 24
export const LIVE_DELETE_THRESHOLD = 8

export function liveBufferDirectory(id: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid channel ID for live buffer')
  return join(dataDirectory, 'live-buffer', id)
}
export function liveBufferPlaylist(id: string): string {
  return join(liveBufferDirectory(id), 'index.m3u8')
}
export async function prepareLiveBuffer(id: string): Promise<void> {
  const directory = liveBufferDirectory(id)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true, mode: 0o700 })
}
export async function removeLiveBuffer(id: string): Promise<void> {
  await rm(liveBufferDirectory(id), { recursive: true, force: true })
}
/** Only completed EXTINF segments in the published playlist count as prebuffer. */
export function parseBufferedSeconds(text: string): number {
  if (!text.startsWith('#EXTM3U')) return 0
  let seconds = 0
  for (const line of text.split(/\r?\n/)) {
    const match = /^#EXTINF:([\d.]+),/.exec(line.trim())
    if (match) {
      const value = Number(match[1])
      if (Number.isFinite(value) && value > 0 && value < 3600) seconds += value
    }
  }
  return Math.round(seconds * 10) / 10
}
export async function bufferedSeconds(id: string): Promise<number> {
  try { return parseBufferedSeconds(await readFile(liveBufferPlaylist(id), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}
