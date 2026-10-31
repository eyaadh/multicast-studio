import { createWriteStream } from 'node:fs'
import { readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { extname, basename, join, sep, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { addMedia } from './db.js'
import { config, mediaDirectory, importDirectory } from './config.js'
import { probeVideo } from './ffmpeg.js'

const allowedExt = new Set(['.mp4','.m4v','.mkv','.mov','.ts','.avi','.mpeg','.mpg','.webm'])
export function cleanName(filename: string) {
  const name = basename(filename.replaceAll('\\','/')).trim().slice(0,180)
  if (!name || name === '.' || name === '..' || !allowedExt.has(extname(name).toLowerCase())) throw new Error('Unsupported file extension; use MP4, MKV, MOV, TS, AVI, MPEG or WebM')
  return name
}
export async function uploadVideo(body: ReadableStream<Uint8Array> | null, filename: string, advertisedSize?: number) {
  if (!body) throw new Error('No upload data supplied')
  const name = cleanName(filename)
  const maxBytes = config.storage.maxUploadGB * 1024**3
  if (advertisedSize && advertisedSize > maxBytes) throw new Error('Upload exceeds the maximum permitted size')
  const tmp = join(mediaDirectory,`${randomUUID()}.uploading`)
  const target = join(mediaDirectory,`${randomUUID()}${extname(name).toLowerCase()}`)
  let total = 0
  const limiter = new Transform({transform(chunk: Buffer, _encoding, callback) {
    total += chunk.length
    if (total > maxBytes) callback(new Error('Upload exceeds the maximum permitted size'))
    else callback(null,chunk)
  }})
  try {
    await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),limiter,createWriteStream(tmp,{flags:'wx',mode:0o600}))
    if (!total) throw new Error('Uploaded file is empty')
    const metadata = await probeVideo(tmp)
    await rename(tmp,target)
    try { return addMedia({name,storedPath:target,origin:'upload',bytes:total,...metadata}) }
    catch (error) { await rm(target,{force:true});throw error }
  } catch (error) { await rm(tmp,{force:true});throw error }
}
export async function importCandidates() {
  const items = await readdir(importDirectory,{withFileTypes:true})
  return items.filter(item => item.isFile() && allowedExt.has(extname(item.name).toLowerCase())).map(item => item.name).sort()
}
export async function registerImport(filename: string) {
  const name = cleanName(filename)
  // Only files under an explicitly configured import directory, never arbitrary paths.
  if (name !== filename) throw new Error('Supply a filename from the import folder, not a filesystem path')
  const root = await realpath(importDirectory)
  const path = await realpath(resolve(importDirectory,name))
  if (!path.startsWith(root+sep)) throw new Error('Import path is outside the configured import directory')
  const info = await stat(path)
  if (!info.isFile()) throw new Error('Import source is not a regular file')
  const metadata = await probeVideo(path)
  return addMedia({name,storedPath:path,origin:'import',bytes:info.size,...metadata})
}
