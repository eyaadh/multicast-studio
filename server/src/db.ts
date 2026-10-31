import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { dataDirectory, mediaDirectory, importDirectory } from './config.js'
import type { Channel, Media, PublicMedia } from './types.js'

for (const dir of [dataDirectory, mediaDirectory, importDirectory]) mkdirSync(dir, {recursive: true})
const db = new Database(join(dataDirectory, 'streamer.sqlite'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(`
CREATE TABLE IF NOT EXISTS media (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, stored_path TEXT NOT NULL UNIQUE,
 origin TEXT NOT NULL, bytes INTEGER NOT NULL, duration REAL, video_codec TEXT,
 audio_codec TEXT, width INTEGER, height INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 media_id TEXT NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
 group_ip TEXT NOT NULL, port INTEGER NOT NULL, profile TEXT NOT NULL,
 video_bitrate_kbps INTEGER NOT NULL, audio_bitrate_kbps INTEGER NOT NULL,
 width INTEGER NOT NULL, height INTEGER NOT NULL, fps INTEGER NOT NULL,
 ttl INTEGER NOT NULL, auto_start INTEGER NOT NULL, auto_recover INTEGER NOT NULL,
 service_id INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(group_ip, port), UNIQUE(service_id)
);
`)

type MediaRow = {
  id: string; name: string; stored_path: string; origin: 'upload' | 'import'; bytes: number;
  duration: number | null; video_codec: string | null; audio_codec: string | null;
  width: number | null; height: number | null; created_at: string;
}
type ChannelRow = {
  id: string; name: string; description: string; media_id: string; group_ip: string; port: number;
  profile: Channel['profile']; video_bitrate_kbps: number; audio_bitrate_kbps: number;
  width: number; height: number; fps: number; ttl: number; auto_start: number; auto_recover: number;
  service_id: number; created_at: string; updated_at: string;
}
const mapMedia = (r: MediaRow): Media => ({id:r.id, name:r.name, storedPath:r.stored_path, origin:r.origin,
  bytes:r.bytes, duration:r.duration, videoCodec:r.video_codec, audioCodec:r.audio_codec,
  width:r.width, height:r.height, createdAt:r.created_at})
const mapChannel = (r: ChannelRow): Channel => ({id:r.id, name:r.name, description:r.description, mediaId:r.media_id,
  groupIp:r.group_ip, port:r.port, profile:r.profile, videoBitrateKbps:r.video_bitrate_kbps,
  audioBitrateKbps:r.audio_bitrate_kbps, width:r.width, height:r.height, fps:r.fps, ttl:r.ttl,
  autoStart:!!r.auto_start, autoRecover:!!r.auto_recover, serviceId:r.service_id,
  createdAt:r.created_at, updatedAt:r.updated_at})
export function listMedia(): Media[] { return (db.prepare('SELECT * FROM media ORDER BY created_at DESC').all() as MediaRow[]).map(mapMedia) }
export function getMedia(id: string): Media | null { const row = db.prepare('SELECT * FROM media WHERE id=?').get(id) as MediaRow | undefined; return row ? mapMedia(row) : null }
export function addMedia(data: Omit<Media,'id'|'createdAt'>): Media {
  const item: Media = {id:randomUUID(), createdAt:new Date().toISOString(), ...data}
  db.prepare(`INSERT INTO media (id,name,stored_path,origin,bytes,duration,video_codec,audio_codec,width,height,created_at)
    VALUES (@id,@name,@storedPath,@origin,@bytes,@duration,@videoCodec,@audioCodec,@width,@height,@createdAt)`).run(item)
  return item
}
export function deleteMedia(id: string): void { db.prepare('DELETE FROM media WHERE id=?').run(id) }
export function listChannels(): Channel[] { return (db.prepare('SELECT * FROM channels ORDER BY created_at').all() as ChannelRow[]).map(mapChannel) }
export function getChannel(id: string): Channel | null { const row = db.prepare('SELECT * FROM channels WHERE id=?').get(id) as ChannelRow | undefined; return row ? mapChannel(row) : null }
export type ChannelValues = Omit<Channel,'id'|'createdAt'|'updatedAt'>
export function saveChannel(data: ChannelValues, id?: string): Channel {
  const existing = id ? getChannel(id) : null
  const now = new Date().toISOString()
  const channel: Channel = {id: existing?.id || randomUUID(), ...data, createdAt:existing?.createdAt || now, updatedAt:now}
  db.prepare(`INSERT INTO channels (id,name,description,media_id,group_ip,port,profile,video_bitrate_kbps,audio_bitrate_kbps,
    width,height,fps,ttl,auto_start,auto_recover,service_id,created_at,updated_at)
    VALUES (@id,@name,@description,@mediaId,@groupIp,@port,@profile,@videoBitrateKbps,@audioBitrateKbps,
    @width,@height,@fps,@ttl,@autoStart,@autoRecover,@serviceId,@createdAt,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,media_id=excluded.media_id,
    group_ip=excluded.group_ip,port=excluded.port,profile=excluded.profile,
    video_bitrate_kbps=excluded.video_bitrate_kbps,audio_bitrate_kbps=excluded.audio_bitrate_kbps,
    width=excluded.width,height=excluded.height,fps=excluded.fps,ttl=excluded.ttl,
    auto_start=excluded.auto_start,auto_recover=excluded.auto_recover,
    service_id=excluded.service_id,updated_at=excluded.updated_at`).run({...channel, autoStart:+channel.autoStart, autoRecover:+channel.autoRecover})
  return channel
}
export function deleteChannel(id: string): void { db.prepare('DELETE FROM channels WHERE id=?').run(id) }
export function mediaPublic(media: Media): PublicMedia { const {storedPath: _path, ...rest} = media; return rest }
export function mediaInUse(id: string): boolean { return !!db.prepare('SELECT 1 FROM channels WHERE media_id=? LIMIT 1').get(id) }
