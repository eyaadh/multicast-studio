import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { config, streamingIP } from './config.js'

const execFileAsync = promisify(execFile)
const ipv4Number = (ip: string) =>
  ip.split('.').reduce((acc, v) => (((acc << 8) >>> 0) | Number(v)) >>> 0, 0)
export function inCIDR(ip: string, cidr: string): boolean {
  if (isIP(ip) !== 4) return false
  const [base, sizeText, extra] = cidr.split('/')
  const size = Number(sizeText)
  if (
    extra !== undefined ||
    !base ||
    isIP(base) !== 4 ||
    !/^\d+$/.test(sizeText || '') ||
    size < 0 ||
    size > 32
  )
    return false
  const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0
  return (ipv4Number(ip) & mask) === (ipv4Number(base) & mask)
}
export function assertMulticast(ip: string, cidr: string): void {
  if (!inCIDR(ip, '239.0.0.0/8') || !inCIDR(ip, cidr)) {
    throw new Error(`Multicast group must be inside ${cidr}, within 239.0.0.0/8`)
  }
}
export async function checkRoute(
  groupIp: string,
): Promise<{ ok: boolean; dev: string | null; source: string; message: string }> {
  if (process.platform !== 'linux')
    return {
      ok: false,
      dev: null,
      source: streamingIP,
      message: 'Route verification requires Linux',
    }
  try {
    const { stdout } = await execFileAsync(
      'ip',
      ['-j', 'route', 'get', groupIp, 'from', streamingIP],
      { timeout: 4000 },
    )
    const route: Array<{ dev?: string; src?: string }> = JSON.parse(stdout)
    const dev = route[0]?.dev || null
    const ok =
      dev === config.streaming.interface && (!route[0]?.src || route[0].src === streamingIP)
    return {
      ok,
      dev,
      source: streamingIP,
      message: ok
        ? `Multicast egress verified on ${dev} (${streamingIP})`
        : `Unsafe route: ${groupIp} resolves via ${dev ?? 'unknown'}, expected ${config.streaming.interface}. Set a persistent multicast route in Netplan.`,
    }
  } catch (error) {
    return {
      ok: false,
      dev: null,
      source: streamingIP,
      message: `Cannot verify multicast route: ${error instanceof Error ? error.message : error}`,
    }
  }
}
export function listInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries || [])
      .filter((entry) => entry.family === 'IPv4')
      .map((entry) => ({ name, address: entry.address, internal: entry.internal })),
  )
}
