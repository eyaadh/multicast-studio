export type SourceType = 'media' | 'live'
export type Profile = 'h264' | 'mpeg4' | 'mpeg2' | 'copy'
export type ChannelStatus =
  'stopped' | 'starting' | 'streaming' | 'stopping' | 'recovering' | 'error'
export type Media = {
  id: string
  name: string
  storedPath: string
  origin: 'upload' | 'import'
  bytes: number
  duration: number | null
  videoCodec: string | null
  audioCodec: string | null
  width: number | null
  height: number | null
  createdAt: string
}
export type PublicMedia = Omit<Media, 'storedPath'>
export type Channel = {
  id: string
  name: string
  description: string
  mediaId: string | null
  sourceType: SourceType
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
  createdAt: string
  updatedAt: string
}
export type Progress = {
  frame?: number
  fps?: number
  bitrate?: string
  speed?: string
  outTime?: string
  totalSize?: number
  updatedAt?: string
}
export type ChannelSnapshot = Channel & {
  media: PublicMedia | null
  sourceLabel: string | null
  status: ChannelStatus
  pid: number | null
  startedAt: string | null
  progress: Progress
  restarts: number
  lastError: string | null
  bufferState: 'filling' | 'broadcasting' | 'recovering' | null
  bufferWindowSeconds: number | null
}
