export type SourceType = 'media' | 'live'
export type Provider = {
  id: string
  name: string
  kind: 'm3u' | 'json' | 'cricfy'
  url: string
  createdAt: string
}
export type ProviderChannel = { key: string; name: string; group: string; logo: string | null }
export type Profile = 'h264' | 'mpeg4' | 'mpeg2' | 'copy'
export type Status = 'stopped' | 'starting' | 'streaming' | 'stopping' | 'recovering' | 'error'
export type Media = {
  id: string
  name: string
  origin: 'upload' | 'import'
  bytes: number
  duration: number | null
  videoCodec: string | null
  audioCodec: string | null
  width: number | null
  height: number | null
  createdAt: string
}
export type ChannelForm = {
  name: string
  description: string
  sourceType: SourceType
  mediaId: string | null
  providerId: string | null
  providerChannelKey: string | null
  streamUrl: string | null
  groupIp: string
  port: number
  profile: Profile
  videoBitrateKbps: number
  audioBitrateKbps: number
  width: number
  height: number
  fps: number
  ttl: number
  autoStart: boolean
  autoRecover: boolean
  serviceId: number
}
export type Channel = ChannelForm & {
  id: string
  media: Media | null
  sourceLabel: string | null
  status: Status
  pid: number | null
  startedAt: string | null
  progress: {
    frame?: number
    fps?: number
    bitrate?: string
    speed?: string
    outTime?: string
    updatedAt?: string
  }
  restarts: number
  lastError: string | null
  bufferState: 'filling' | 'broadcasting' | null
  bufferWindowSeconds: number | null
  createdAt: string
  updatedAt: string
}
export type SystemInfo = {
  management: { interface: string; address: string; port: number }
  streaming: {
    interface: string
    address: string
    range: string
    ttl: number
    verifyEgressRoute: boolean
  }
  interfaces: Array<{ name: string; address: string; internal: boolean }>
  channels: number
  streamingCount: number
  host: {
    uptimeSeconds: number
    memoryTotal: number
    memoryFree: number
    loadAverage: number[]
    cpuCount: number
  }
}
export type RouteCheck = { ok: boolean; dev: string | null; source: string; message: string }

export type ProviderChannelsResponse = {
  data: ProviderChannel[]
  groups: string[]
  catalogTotal: number
  pagination: { page: number; limit: number; total: number; totalPages: number }
}
