import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { networkInterfaces } from 'node:os'
import { z } from 'zod'

const schema = z.object({
  management: z.object({ interface: z.string().min(1), port: z.number().int().min(1).max(65535) }),
  streaming: z.object({
    interface: z.string().min(1),
    multicastCIDR: z.string().min(1),
    defaultTTL: z.number().int().min(1).max(255),
    packetSize: z.number().int().min(188).max(65507),
    verifyEgressRoute: z.boolean(),
  }),
  upstream: z
    .object({
      // Exact trusted HTTP origins (IPv4 literal + port); never a subnet wildcard.
      allowedPrivateOrigins: z.array(z.string().url()).default([]),
    })
    .default({ allowedPrivateOrigins: [] }),
  storage: z.object({
    dataDirectory: z.string().min(1),
    importDirectory: z.string().min(1),
    maxUploadGB: z.number().positive().max(100),
  }),
  tools: z.object({ ffmpeg: z.string().min(1), ffprobe: z.string().min(1) }),
})

const configPath = resolve(process.env.STREAMER_CONFIG || 'config/streamer.json')
export const config = schema.parse(JSON.parse(readFileSync(configPath, 'utf8')))
for (const origin of config.upstream.allowedPrivateOrigins) {
  const url = new URL(origin)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
    !url.port
  ) {
    throw new Error(
      `Invalid upstream.allowedPrivateOrigins entry: ${origin}. Use an exact IPv4 origin with explicit port.`,
    )
  }
}
export const projectRoot = process.cwd()
export const dataDirectory = resolve(config.storage.dataDirectory)
export const mediaDirectory = resolve(dataDirectory, 'media')
export const importDirectory = resolve(config.storage.importDirectory)

export function interfaceIPv4(name: string): string {
  const entries = networkInterfaces()[name] || []
  const found =
    entries.find((item) => item.family === 'IPv4' && !item.internal) ??
    entries.find((item) => item.family === 'IPv4')
  if (!found)
    throw new Error(
      `Interface '${name}' has no IPv4 address. Check config/streamer.json and ip -br addr.`,
    )
  return found.address
}
if (
  process.env.NODE_ENV === 'production' &&
  config.management.interface === config.streaming.interface
) {
  throw new Error('Production management and streaming must use different NICs')
}
export const managementIP = interfaceIPv4(config.management.interface)
export const streamingIP = interfaceIPv4(config.streaming.interface)

export const adminUser = process.env.ADMIN_USER || ''
export const adminPassword = process.env.ADMIN_PASSWORD || ''
export const sessionSecret = process.env.SESSION_SECRET || ''
if (
  !adminUser ||
  !adminPassword ||
  adminPassword === 'SET_A_LONG_UNIQUE_PASSWORD_HERE' ||
  adminPassword.length < 12
) {
  throw new Error('Set ADMIN_USER and a unique ADMIN_PASSWORD (12+ characters) in .env')
}
if (sessionSecret.length < 32 || sessionSecret === 'REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS') {
  throw new Error('Set a random SESSION_SECRET of at least 32 characters in .env')
}
