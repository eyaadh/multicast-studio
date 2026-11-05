<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import {
  Activity,
  ArrowDownToLine,
  Check,
  CircleAlert,
  Clapperboard,
  Cpu,
  Database,
  Film,
  HardDrive,
  Info,
  Layers3,
  LogOut,
  MonitorCog,
  Network,
  Pencil,
  Play,
  Plus,
  Radio,
  ChevronRight,
  RefreshCcw,
  ArrowLeftRight,
  RotateCw,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  UploadCloud,
  Wifi,
  X,
  Sun,
  Moon,
} from 'lucide-vue-next'
import { api, ApiError, jsonBody, uploadRaw } from './api'
import SearchCombobox from './SearchCombobox.vue'
import type Hls from 'hls.js'
import type {
  Channel,
  ChannelForm,
  Media,
  Profile,
  RouteCheck,
  SystemInfo,
  Provider,
  ProviderChannel,
  ProviderChannelsResponse,
} from './types'

type ChoiceValue = string | number | null
type Tab = 'channels' | 'providers' | 'media' | 'system'
// Theme is initialized before Vue mounts to avoid a light/dark flash.
const theme = ref<'light' | 'dark'>(
  document.documentElement.classList.contains('dark') ? 'dark' : 'light',
)
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.classList.toggle('dark', theme.value === 'dark')
  localStorage.setItem('multicast-studio-theme', theme.value)
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme.value === 'dark' ? '#09090b' : '#fafafa')
}
const activeTab = ref<Tab>('channels')
const sessionLoading = ref(true),
  authenticated = ref(false),
  loginBusy = ref(false)
const username = ref('admin'),
  password = ref('')
const channels = ref<Channel[]>([]),
  media = ref<Media[]>([]),
  system = ref<SystemInfo | null>(null)
const providers = ref<Provider[]>([]),
  providerChannels = ref<ProviderChannel[]>([])
const selectedProviderId = ref(''),
  providerLoading = ref(false),
  providerSaving = ref(false)
const providerName = ref(''),
  providerKind = ref<'m3u' | 'json'>('m3u'),
  providerUrl = ref('')
const channelSearch = ref(''),
  providerGroup = ref('')
const providerGroups = ref<string[]>([])
const providerPage = ref(1),
  providerPageCount = ref(0),
  providerTotal = ref(0),
  catalogTotal = ref(0)
const playlistPresets = [
  { name: 'Hilay TV', url: 'https://hilaytv.xyz/play.m3u' },
  { name: 'IPTV-org (Global)', url: 'https://iptv-org.github.io/iptv/index.m3u' },
] as const
const missingPresets = computed(() =>
  playlistPresets.filter((item) => !providers.value.some((p) => p.url === item.url)),
)
let providerRequest = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null
const candidates = ref<string[]>([]),
  importName = ref(''),
  uploading = ref(false),
  uploadPercent = ref(0)
const modalOpen = ref(false),
  editingId = ref<string | null>(null),
  saving = ref(false),
  busyIds = ref<string[]>([])
const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null)
const live = ref(false),
  routeChecks = ref<Record<string, RouteCheck>>({}),
  routeLoading = ref(false)
const previewMedia = ref<Media | null>(null)
type StreamPreview = { name: string; group: string; url: string; requiresHeaders: boolean }
const previewStream = ref<StreamPreview | null>(null)
const previewVideo = ref<HTMLVideoElement | null>(null)
const previewLoading = ref(false),
  previewError = ref('')
let previewPlayer: Hls | null = null
let previewRequest = 0
const providerKindOptions = [
  { value: 'm3u', label: 'Extended M3U' },
  { value: 'json', label: 'JSON channel catalog' },
]
const sourceTypeOptions = [
  { value: 'media', label: 'Local video (loop)' },
  { value: 'live', label: 'Live internet stream' },
]
const profileOptions = Object.entries({
  h264: 'H.264 / AAC',
  mpeg4: 'MPEG-4 Part 2 / MP2',
  mpeg2: 'MPEG-2 / MP2',
  copy: 'Direct copy',
}).map(([value, label]) => ({ value, label }))
const resolutionOptions = [
  { value: '720x576', label: '720 × 576 (SD PAL)' },
  { value: '1280x720', label: '1280 × 720 (HD)' },
  { value: '1920x1080', label: '1920 × 1080 (FHD)' },
]
const frameRateOptions = [25, 30, 50, 60].map((value) => ({ value, label: `${value} fps` }))
const mediaOptions = computed(() => [
  { value: null, label: 'Select a video', disabled: true },
  ...media.value.map((item) => ({ value: item.id, label: item.name })),
])
const importOptions = computed(() => [
  { value: '', label: 'Select video from import directory' },
  ...candidates.value.map((value) => ({ value, label: value })),
])
const groupOptions = computed(() => [
  { value: '', label: 'All groups' },
  ...providerGroups.value.map((value) => ({ value, label: value })),
])
const resolution = computed({
  get: () => `${currentForm.value.width}x${currentForm.value.height}`,
  set: (value: string) => {
    const [width, height] = value.split('x').map(Number)
    currentForm.value.width = width || 1280
    currentForm.value.height = height || 720
  },
})
function setSourceType(value: ChoiceValue) {
  if (value !== 'media' && value !== 'live') return
  currentForm.value.sourceType = value
  switchSourceType()
}
function setProfile(value: ChoiceValue) {
  if (value !== 'h264' && value !== 'mpeg4' && value !== 'mpeg2' && value !== 'copy') return
  currentForm.value.profile = value
  onProfileChange()
}
function closeStreamPreview() {
  previewRequest++
  previewPlayer?.destroy()
  previewPlayer = null
  if (previewVideo.value) {
    previewVideo.value.pause()
    previewVideo.value.removeAttribute('src')
    previewVideo.value.load()
  }
  previewStream.value = null
  previewError.value = ''
  previewLoading.value = false
}
async function playStreamPreview(url: string, requestId: number) {
  await nextTick()
  if (requestId !== previewRequest) return
  const video = previewVideo.value
  if (!video) return
  try {
    const { default: HlsPlayer } = await import('hls.js')
    if (requestId !== previewRequest) return
    const isHls = /\.m3u8(?:$|[?#])/i.test(url) || !/\.(?:mp4|webm|m4v)(?:$|[?#])/i.test(url)
    if (isHls && HlsPlayer.isSupported()) {
      const player = new HlsPlayer({ enableWorker: true, lowLatencyMode: false })
      previewPlayer = player
      player.on(HlsPlayer.Events.ERROR, (_event, data) => {
        if (data.fatal && requestId === previewRequest)
          previewError.value =
            'Browser playback failed. The source may be offline, restricted, or blocked by CORS.'
      })
      player.loadSource(url)
      player.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl') || !isHls) {
      video.src = url
    } else {
      previewError.value = 'This browser does not support HLS preview.'
    }
  } catch {
    if (requestId === previewRequest)
      previewError.value = 'Unable to initialize the browser video player.'
  } finally {
    if (requestId === previewRequest) previewLoading.value = false
  }
}
async function previewProviderChannel(entry: ProviderChannel) {
  closeStreamPreview()
  const requestId = previewRequest
  previewStream.value = { name: entry.name, group: entry.group, url: '', requiresHeaders: false }
  previewLoading.value = true
  try {
    const response = await api<{ url: string; requiresHeaders: boolean }>(
      `/providers/${selectedProviderId.value}/channels/${encodeURIComponent(entry.key)}/preview`,
    )
    if (requestId !== previewRequest) return
    previewStream.value = { ...previewStream.value!, ...response }
    if (response.requiresHeaders) {
      previewError.value =
        'This stream requires custom HTTP headers. Browser preview is unavailable, but FFmpeg may still broadcast it.'
      previewLoading.value = false
      return
    }
    await playStreamPreview(response.url, requestId)
  } catch (error) {
    if (requestId === previewRequest) {
      previewError.value = error instanceof Error ? error.message : String(error)
      previewLoading.value = false
    }
  }
}
function clearProviderSelection() {
  currentForm.value.providerId = null
  currentForm.value.providerChannelKey = null
}
function previewDirectStream() {
  const url = currentForm.value.streamUrl?.trim()
  if (!url) {
    notice('Enter a live stream URL first', 'error')
    return
  }
  try {
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol)) throw Error()
    closeStreamPreview()
    const requestId = previewRequest
    previewStream.value = {
      name: currentForm.value.name || 'Direct live stream',
      group: 'Direct URL',
      url,
      requiresHeaders: false,
    }
    previewLoading.value = true
    void playStreamPreview(url, requestId)
  } catch {
    notice('Enter a valid HTTP(S) stream URL', 'error')
  }
}

let events: EventSource | null = null
let interval: ReturnType<typeof setInterval> | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null
const fmtBytes = (v: number) =>
  v > 1024 ** 3
    ? `${(v / 1024 ** 3).toFixed(2)} GB`
    : v > 1024 ** 2
      ? `${(v / 1024 ** 2).toFixed(1)} MB`
      : `${Math.round(v / 1024)} KB`
const fmtDuration = (v: number | null) =>
  v === null
    ? 'Unknown'
    : `${Math.floor(v / 3600) ? `${Math.floor(v / 3600)}:` : ''}${String(Math.floor(v / 60) % 60).padStart(2, '0')}:${String(Math.floor(v % 60)).padStart(2, '0')}`
const fmtUptime = (date: string | null) =>
  date
    ? `${Math.floor((Date.now() - Date.parse(date)) / 3600000)}h ${Math.floor(((Date.now() - Date.parse(date)) / 60000) % 60)}m`
    : '—'
const statusLabel = (status: string) => status.charAt(0).toUpperCase() + status.slice(1)
const activeCount = computed(() => channels.value.filter((c) => c.status === 'streaming').length)
const errorCount = computed(() => channels.value.filter((c) => c.status === 'error').length)
const memoryUsed = computed(() =>
  system.value
    ? Math.round((1 - system.value.host.memoryFree / system.value.host.memoryTotal) * 100)
    : 0,
)
const profileNames: Record<Profile, string> = {
  h264: 'H.264 / AAC',
  mpeg4: 'MPEG-4 Part 2 / MP2',
  mpeg2: 'MPEG-2 / MP2',
  copy: 'Direct copy',
}
const currentForm = ref<ChannelForm>(defaultForm())
function defaultForm(): ChannelForm {
  return {
    name: '',
    description: '',
    sourceType: 'media',
    mediaId: null,
    providerId: null,
    providerChannelKey: null,
    streamUrl: null,
    groupIp: '239.80.0.1',
    port: 5000,
    profile: 'mpeg4',
    videoBitrateKbps: 2500,
    audioBitrateKbps: 128,
    width: 1280,
    height: 720,
    fps: 25,
    ttl: 1,
    autoStart: true,
    autoRecover: true,
    serviceId: 101,
  }
}
function notice(message: string, kind: 'success' | 'error' = 'success') {
  toast.value = { message, kind }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 6000)
}
function showError(error: unknown) {
  notice(error instanceof Error ? error.message : String(error), 'error')
}
async function refresh() {
  if (!authenticated.value) return
  try {
    const [ch, med, sys, prov] = await Promise.all([
      api<Channel[]>('/channels'),
      api<Media[]>('/media'),
      api<SystemInfo>('/system'),
      api<Provider[]>('/providers'),
    ])
    channels.value = ch
    media.value = med
    system.value = sys
    providers.value = prov
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      authenticated.value = false
      stopEvents()
    } else showError(error)
  }
}
function startEvents() {
  stopEvents()
  events = new EventSource('/api/events')
  events.addEventListener('snapshot', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as {
      channels: Channel[]
      system: SystemInfo
    }
    channels.value = data.channels
    system.value = data.system
    live.value = true
  })
  events.onerror = () => {
    live.value = false
  }
  interval = setInterval(() => {
    if (!live.value) refresh()
  }, 10000)
}
function stopEvents() {
  events?.close()
  events = null
  if (interval) clearInterval(interval)
  interval = null
  live.value = false
}
async function login() {
  loginBusy.value = true
  try {
    await api('/auth/login', {
      method: 'POST',
      body: jsonBody({ username: username.value, password: password.value }),
    })
    authenticated.value = true
    password.value = ''
    await refresh()
    startEvents()
  } catch (error) {
    showError(error)
  } finally {
    loginBusy.value = false
  }
}
async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' })
  } catch {}
  stopEvents()
  authenticated.value = false
  channels.value = []
  media.value = []
}
async function action(channel: Channel, type: 'start' | 'stop' | 'restart') {
  busyIds.value.push(channel.id)
  try {
    await api(`/channels/${channel.id}/${type}`, { method: 'POST' })
    notice(`${channel.name}: ${type} requested`)
    await refresh()
  } catch (error) {
    showError(error)
    await refresh()
  } finally {
    busyIds.value = busyIds.value.filter((id) => id !== channel.id)
  }
}
const swapSource = ref<Channel | null>(null)
const swapTargetId = ref('')
const swapping = ref(false)
const swapTargetOptions = computed(() =>
  channels.value
    .filter((channel) => channel.id !== swapSource.value?.id)
    .map((channel) => ({
      value: channel.id,
      label: `${channel.name} · ${channel.groupIp}:${channel.port}`,
    })),
)
function openSwap(channel: Channel) {
  swapSource.value = channel
  swapTargetId.value = ''
  nextTick(() =>
    document
      .getElementById('channel-swap-panel')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
  )
}
async function confirmSwap() {
  if (!swapSource.value || !swapTargetId.value) return
  const target = channels.value.find((ch) => ch.id === swapTargetId.value)
  if (
    !target ||
    !window.confirm(
      `Exchange multicast destinations between "${swapSource.value.name}" and "${target.name}"? Active channels will briefly stop and restart.`,
    )
  )
    return
  swapping.value = true
  try {
    const result = await api<{ ok: boolean; warnings: string[] }>('/channels/swap-destinations', {
      method: 'POST',
      body: jsonBody({ firstId: swapSource.value.id, secondId: target.id }),
    })
    swapSource.value = null
    if (result.warnings.length)
      notice(`Destinations swapped; restart warnings: ${result.warnings.join('; ')}`, 'error')
    else notice('Multicast destinations swapped successfully')
    await refresh()
  } catch (error) {
    showError(error)
    await refresh()
  } finally {
    swapping.value = false
  }
}
function newChannel() {
  editingId.value = null
  const next = defaultForm()
  next.mediaId = media.value[0]?.id || null
  if (!next.mediaId) {
    next.sourceType = 'live'
    next.profile = 'copy'
  }
  const address = system.value?.streaming.range.split('/')[0] || '239.80.0.0'
  const prefix = address.split('.').slice(0, 3).join('.')
  let index = 1
  while (channels.value.some((ch) => ch.groupIp === `${prefix}.${index}`)) index++
  if (index < 255) next.groupIp = `${prefix}.${index}`
  while (channels.value.some((ch) => ch.serviceId === next.serviceId)) next.serviceId++
  currentForm.value = next
  modalOpen.value = true
}
function editChannel(channel: Channel) {
  if (['streaming', 'starting', 'stopping', 'recovering'].includes(channel.status)) {
    notice('Stop the channel before editing its configuration', 'error')
    return
  }
  editingId.value = channel.id
  const {
    name,
    description,
    sourceType,
    mediaId,
    providerId,
    providerChannelKey,
    streamUrl,
    groupIp,
    port,
    profile,
    videoBitrateKbps,
    audioBitrateKbps,
    width,
    height,
    fps,
    ttl,
    autoStart,
    autoRecover,
    serviceId,
  } = channel
  currentForm.value = {
    name,
    description,
    sourceType,
    mediaId,
    providerId,
    providerChannelKey,
    streamUrl,
    groupIp,
    port,
    profile,
    videoBitrateKbps,
    audioBitrateKbps,
    width,
    height,
    fps,
    ttl,
    autoStart,
    autoRecover,
    serviceId,
  }
  modalOpen.value = true
}
async function saveChannel() {
  saving.value = true
  try {
    await api(editingId.value ? `/channels/${editingId.value}` : '/channels', {
      method: editingId.value ? 'PATCH' : 'POST',
      body: jsonBody(currentForm.value),
    })
    notice(editingId.value ? 'Channel updated' : 'Channel created')
    modalOpen.value = false
    await refresh()
  } catch (error) {
    showError(error)
  } finally {
    saving.value = false
  }
}
async function removeChannel(channel: Channel) {
  if (!window.confirm(`Delete channel "${channel.name}"?`)) return
  try {
    await api(`/channels/${channel.id}`, { method: 'DELETE' })
    notice('Channel deleted')
    await refresh()
  } catch (error) {
    showError(error)
  }
}
function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) void upload(file)
  input.value = ''
}
function onProfileChange() {
  // Use a CPU-friendly PAL SD starting profile for legacy receivers; editable.
  // Do not change existing channels unless the administrator selects this profile.
  if (currentForm.value.profile === 'mpeg2') {
    currentForm.value.width = 720
    currentForm.value.height = 576
    currentForm.value.fps = 25
    currentForm.value.videoBitrateKbps = 3500
    currentForm.value.audioBitrateKbps = 192
  }
}
async function upload(file?: File) {
  if (!file) return
  uploading.value = true
  uploadPercent.value = 0
  try {
    await uploadRaw(file, (pct) => (uploadPercent.value = pct))
    notice(`${file.name} uploaded`)
    await refresh()
  } catch (error) {
    showError(error)
  } finally {
    uploading.value = false
  }
}
async function refreshCandidates() {
  try {
    candidates.value = await api('/media/import-candidates')
  } catch (error) {
    showError(error)
  }
}
async function importVideo() {
  if (!importName.value) return
  try {
    await api('/media/import', { method: 'POST', body: jsonBody({ filename: importName.value }) })
    notice('Video registered')
    importName.value = ''
    await Promise.all([refresh(), refreshCandidates()])
  } catch (error) {
    showError(error)
  }
}
async function removeMedia(item: Media) {
  if (
    !window.confirm(
      `Remove "${item.name}" from the library? Uploaded files will be deleted from disk.`,
    )
  )
    return
  try {
    await api(`/media/${item.id}`, { method: 'DELETE' })
    notice('Video removed')
    await refresh()
  } catch (error) {
    showError(error)
  }
}
async function checkRoutes() {
  routeLoading.value = true
  const result: Record<string, RouteCheck> = {}
  try {
    for (const channel of channels.value) {
      result[channel.id] = await api<RouteCheck>(`/network/check/${channel.groupIp}`)
    }
    routeChecks.value = result
    if (!channels.value.length) notice('Create a channel to verify its multicast egress route')
  } catch (error) {
    showError(error)
  } finally {
    routeLoading.value = false
  }
}
async function browseProvider(id: string, page = 1, forceRefresh = false) {
  if (selectedProviderId.value !== id) {
    selectedProviderId.value = id
    channelSearch.value = ''
    providerGroup.value = ''
    providerPage.value = 1
    providerGroups.value = []
    providerTotal.value = 0
    catalogTotal.value = 0
  }
  if (!id) return
  const requestId = ++providerRequest
  providerLoading.value = true
  try {
    const params = new URLSearchParams({ page: String(page), limit: '50' })
    if (channelSearch.value.trim()) params.set('search', channelSearch.value.trim())
    if (providerGroup.value) params.set('group', providerGroup.value)
    if (forceRefresh) params.set('refresh', 'true')
    const response = await api<ProviderChannelsResponse>(`/providers/${id}/channels?${params}`)
    if (requestId !== providerRequest) return
    providerChannels.value = response.data
    providerGroups.value = response.groups
    providerPage.value = response.pagination.page
    providerPageCount.value = response.pagination.totalPages
    providerTotal.value = response.pagination.total
    catalogTotal.value = response.catalogTotal
  } catch (error) {
    if (requestId === providerRequest) {
      providerChannels.value = []
      showError(error)
    }
  } finally {
    if (requestId === providerRequest) providerLoading.value = false
  }
}
async function addPreset(item: { name: string; url: string }) {
  if (providers.value.some((p) => p.url === item.url)) return
  providerSaving.value = true
  try {
    const result = await api<Provider>('/providers', {
      method: 'POST',
      body: jsonBody({ name: item.name, kind: 'm3u', url: item.url }),
    })
    notice(`${item.name} playlist added`)
    await refresh()
    await browseProvider(result.id)
  } catch (error) {
    showError(error)
  } finally {
    providerSaving.value = false
  }
}
async function addProvider() {
  providerSaving.value = true
  try {
    const result = await api<Provider>('/providers', {
      method: 'POST',
      body: jsonBody({
        name: providerName.value,
        kind: providerKind.value,
        url: providerUrl.value,
      }),
    })
    providerName.value = ''
    providerUrl.value = ''
    notice('Provider saved')
    await refresh()
    await browseProvider(result.id)
  } catch (error) {
    showError(error)
  } finally {
    providerSaving.value = false
  }
}
async function removeProvider(provider: Provider) {
  if (!window.confirm(`Remove provider "${provider.name}"?`)) return
  try {
    await api(`/providers/${provider.id}`, { method: 'DELETE' })
    if (selectedProviderId.value === provider.id) {
      selectedProviderId.value = ''
      providerChannels.value = []
      providerTotal.value = 0
      catalogTotal.value = 0
      providerGroups.value = []
    }
    notice('Provider removed')
    await refresh()
  } catch (error) {
    showError(error)
  }
}
function addProviderChannel(ch: ProviderChannel) {
  newChannel()
  currentForm.value.sourceType = 'live'
  currentForm.value.profile = 'copy'
  currentForm.value.mediaId = null
  currentForm.value.providerId = selectedProviderId.value
  currentForm.value.providerChannelKey = ch.key
  currentForm.value.streamUrl = null
  currentForm.value.name = ch.name.slice(0, 100)
  currentForm.value.description = `Live feed · ${ch.group}`.slice(0, 300)
  activeTab.value = 'channels'
}
function switchSourceType() {
  currentForm.value.providerId = null
  currentForm.value.providerChannelKey = null
  currentForm.value.streamUrl = null
  currentForm.value.mediaId =
    currentForm.value.sourceType === 'media' ? media.value[0]?.id || null : null
  if (currentForm.value.sourceType === 'live') currentForm.value.profile = 'copy'
}
watch(activeTab, (tab) => {
  if (tab === 'media' && authenticated.value) void refreshCandidates()
})
watch([channelSearch, providerGroup], () => {
  if (!selectedProviderId.value) return
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void browseProvider(selectedProviderId.value, 1), 300)
})
onMounted(async () => {
  try {
    const state = await api<{ authenticated: boolean }>('/auth/session')
    authenticated.value = state.authenticated
    if (authenticated.value) {
      await refresh()
      startEvents()
    }
  } catch (error) {
    showError(error)
  } finally {
    sessionLoading.value = false
  }
})
onUnmounted(() => {
  closeStreamPreview()
  stopEvents()
  if (toastTimer) clearTimeout(toastTimer)
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <div class="min-h-screen text-zinc-900 dark:text-zinc-100">
    <div v-if="sessionLoading" class="min-h-screen grid place-items-center">
      <div class="flex items-center gap-3 text-emerald-600 dark:text-emerald-400">
        <Radio :size="24" class="animate-pulse" /> Connecting to Multicast Studio…
      </div>
    </div>
    <div v-else-if="!authenticated" class="relative min-h-screen grid place-items-center px-4">
      <button
        type="button"
        class="btn btn-icon absolute right-5 top-5"
        :aria-label="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
        :title="theme === 'dark' ? 'Light mode' : 'Dark mode'"
        @click="toggleTheme"
      >
        <Sun v-if="theme === 'dark'" :size="18" /><Moon v-else :size="18" />
      </button>
      <div class="w-full max-w-md panel p-8 shadow-2xl shadow-zinc-900/10 dark:shadow-black/50">
        <div class="flex items-center gap-3 mb-8">
          <div
            class="rounded-2xl bg-emerald-500/10 dark:bg-emerald-400/10 p-3 border border-emerald-500/20 dark:border-emerald-400/20"
          >
            <Radio class="text-emerald-600 dark:text-emerald-400" :size="28" />
          </div>
          <div>
            <h1 class="text-2xl font-bold tracking-tight">Multicast Studio</h1>
            <p class="text-sm muted">IPTV multicast management</p>
          </div>
        </div>
        <p class="text-sm muted mb-6">
          Sign in to manage your continuously broadcasting IPTV channels.
        </p>
        <form class="space-y-5" @submit.prevent="login">
          <div>
            <label class="field-label">Username</label
            ><input v-model="username" class="field" autocomplete="username" required />
          </div>
          <div>
            <label class="field-label">Password</label
            ><input
              v-model="password"
              class="field"
              type="password"
              autocomplete="current-password"
              required
            />
          </div>
          <button class="btn btn-primary w-full py-3" :disabled="loginBusy">
            {{ loginBusy ? 'Signing in…' : 'Sign in to dashboard' }}
          </button>
        </form>
        <p class="text-xs muted mt-8 text-center">
          Credentials are configured in the server's .env file.
        </p>
      </div>
    </div>
    <template v-else>
      <aside
        class="fixed inset-y-0 left-0 w-72 bg-white dark:bg-zinc-950 border-r border-zinc-200 dark:border-white/10 hidden lg:flex flex-col z-10"
      >
        <div class="flex items-center gap-3 px-6 py-7">
          <div class="bg-emerald-500/10 dark:bg-emerald-400/10 rounded-xl p-2.5">
            <Radio class="text-emerald-600 dark:text-emerald-400" :size="22" />
          </div>
          <div>
            <h1 class="font-bold text-[17px] tracking-tight">Multicast Studio</h1>
            <p class="text-[11px] muted tracking-widest uppercase">IPTV Control Center</p>
          </div>
        </div>
        <div class="px-4 pt-6 space-y-1">
          <button
            v-for="tab in [
              { id: 'channels', label: 'Channels', icon: Layers3 },
              { id: 'providers', label: 'Live Providers', icon: Wifi },
              { id: 'media', label: 'Media Library', icon: Film },
              { id: 'system', label: 'System & Network', icon: Settings2 },
            ] as const"
            :key="tab.id"
            class="w-full flex items-center gap-3 px-4 py-3 text-sm rounded-xl transition-colors"
            :class="
              activeTab === tab.id
                ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-400/15'
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-white border border-transparent'
            "
            @click="activeTab = tab.id"
          >
            <component :is="tab.icon" :size="17" /> {{ tab.label }}
          </button>
        </div>
        <div class="mt-auto p-5 border-t border-zinc-200 dark:border-white/10 space-y-4">
          <div class="flex gap-3 items-center">
            <div
              class="h-9 w-9 rounded-full bg-zinc-100 dark:bg-zinc-800 grid place-items-center text-sm font-semibold"
            >
              A
            </div>
            <div class="min-w-0">
              <p class="text-sm font-semibold">Administrator</p>
              <p class="text-xs muted">Local management</p>
            </div>
          </div>
          <button class="btn w-full" @click="logout"><LogOut :size="15" /> Sign out</button>
        </div>
      </aside>
      <div class="lg:ml-72">
        <header
          class="border-b border-zinc-200 dark:border-white/10 bg-white/90 dark:bg-zinc-950/90 sticky top-0 z-10 backdrop-blur-xl"
        >
          <div
            class="max-w-[1500px] mx-auto px-5 sm:px-9 py-4 flex flex-wrap items-center justify-between gap-4"
          >
            <div>
              <p
                class="text-xs font-semibold tracking-widest uppercase text-emerald-600 dark:text-emerald-400 mb-1"
              >
                Broadcast Operations
              </p>
              <h2 class="text-lg font-semibold">
                {{
                  activeTab === 'channels'
                    ? 'Channel Dashboard'
                    : activeTab === 'providers'
                      ? 'Live Stream Providers'
                      : activeTab === 'media'
                        ? 'Media Library'
                        : 'System & Network'
                }}
              </h2>
            </div>
            <div class="flex items-center gap-3">
              <span class="hidden sm:inline-flex items-center gap-2 text-xs muted"
                ><span
                  class="w-2 h-2 rounded-full"
                  :class="live ? 'bg-emerald-400' : 'bg-amber-400'"
                />{{ live ? 'Live monitoring' : 'Reconnecting' }}</span
              ><button
                type="button"
                class="btn btn-icon"
                :aria-label="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
                :title="theme === 'dark' ? 'Light mode' : 'Dark mode'"
                @click="toggleTheme"
              >
                <Sun v-if="theme === 'dark'" :size="16" /><Moon v-else :size="16" /></button
              ><button class="btn btn-icon" title="Refresh" @click="refresh">
                <RefreshCcw :size="16" /></button
              ><button v-if="activeTab === 'channels'" class="btn btn-primary" @click="newChannel">
                <Plus :size="16" /> New channel
              </button>
            </div>
          </div>
          <div class="lg:hidden px-5 pb-3 flex gap-2 overflow-auto">
            <button
              v-for="tab in [
                { id: 'channels', label: 'Channels' },
                { id: 'providers', label: 'Providers' },
                { id: 'media', label: 'Media' },
                { id: 'system', label: 'System' },
              ] as const"
              :key="tab.id"
              class="btn"
              :class="activeTab === tab.id ? 'btn-primary' : ''"
              @click="activeTab = tab.id"
            >
              {{ tab.label }}</button
            ><button class="btn ml-auto" @click="logout"><LogOut :size="16" /></button>
          </div>
        </header>
        <main class="max-w-[1500px] mx-auto px-5 sm:px-9 py-8 space-y-7">
          <template v-if="activeTab === 'channels'">
            <div class="flex flex-col md:flex-row md:justify-between md:items-end gap-3">
              <div>
                <h2 class="text-2xl font-semibold tracking-tight">Channel overview</h2>
                <p class="text-sm muted mt-1">
                  Independent, continuous multicast broadcasts with automatic recovery.
                </p>
              </div>
              <a class="btn self-start" href="/api/channels/playlist.m3u" download="channels.m3u"
                ><ArrowDownToLine :size="16" /> Download M3U</a
              >
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div class="panel p-5">
                <div class="flex items-center justify-between">
                  <p class="text-xs uppercase tracking-wider muted font-semibold">Total channels</p>
                  <Layers3 :size="18" class="text-emerald-600 dark:text-emerald-400" />
                </div>
                <p class="text-3xl font-semibold mt-3">{{ channels.length }}</p>
                <p class="text-xs muted mt-1">Configured broadcast destinations</p>
              </div>
              <div class="panel p-5">
                <div class="flex items-center justify-between">
                  <p class="text-xs uppercase tracking-wider muted font-semibold">On air</p>
                  <Radio :size="18" class="text-emerald-400" />
                </div>
                <p class="text-3xl font-semibold mt-3">
                  {{ activeCount }}
                  <span class="text-sm text-zinc-500 font-normal">/ {{ channels.length }}</span>
                </p>
                <p class="text-xs text-emerald-700 dark:text-emerald-400 mt-1">
                  Streams actively reporting progress
                </p>
              </div>
              <div class="panel p-5">
                <div class="flex items-center justify-between">
                  <p class="text-xs uppercase tracking-wider muted font-semibold">Health alerts</p>
                  <ShieldCheck
                    :size="18"
                    :class="
                      errorCount
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-emerald-600 dark:text-emerald-400'
                    "
                  />
                </div>
                <p class="text-3xl font-semibold mt-3">{{ errorCount }}</p>
                <p class="text-xs muted mt-1">Channels requiring attention</p>
              </div>
            </div>
            <div v-if="swapSource" id="channel-swap-panel" class="panel p-5 space-y-3 mb-4">
              <div class="flex items-center justify-between gap-3">
                <h3 class="font-semibold text-sm">Swap multicast destinations</h3>
                <button class="btn btn-icon" title="Cancel" @click="swapSource = null">
                  <X :size="16" />
                </button>
              </div>
              <p class="text-sm muted">
                {{ swapSource.name }} · {{ swapSource.groupIp }}:{{ swapSource.port }}. Select the
                channel whose destination you want to exchange. Active channels will briefly
                restart.
              </p>
              <div class="flex flex-wrap gap-2 items-end">
                <div class="min-w-48 flex-1">
                  <SearchCombobox
                    :model-value="swapTargetId"
                    :options="swapTargetOptions"
                    label="Destination channel"
                    placeholder="Search channels…"
                    @update:model-value="(value) => (swapTargetId = String(value ?? ''))"
                  />
                </div>
                <button
                  class="btn btn-primary"
                  :disabled="!swapTargetId || swapping"
                  @click="confirmSwap"
                >
                  {{ swapping ? 'Swapping…' : 'Swap destinations' }}
                </button>
              </div>
            </div>
            <div v-if="!channels.length" class="panel p-12 text-center">
              <Clapperboard
                :size="38"
                class="mx-auto text-emerald-600 dark:text-emerald-400 mb-4"
              />
              <h3 class="text-lg font-semibold">Your first channel starts here</h3>
              <p class="muted text-sm max-w-md mx-auto mt-2">
                Upload a video, create a multicast channel, and start broadcasting to your IPTV
                network.
              </p>
              <div class="flex gap-3 justify-center mt-6">
                <button class="btn" @click="activeTab = 'media'">
                  <UploadCloud :size="16" /> Add video</button
                ><button class="btn btn-primary" @click="newChannel">
                  <Plus :size="16" /> New channel
                </button>
              </div>
            </div>
            <ul
              v-else
              role="list"
              class="overflow-hidden rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900/70 divide-y divide-zinc-100 dark:divide-white/10"
            >
              <li
                v-for="ch in channels"
                :key="ch.id"
                class="flex flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6 hover:bg-zinc-50 dark:hover:bg-white/[0.035]"
              >
                <div class="flex min-w-0 flex-1 items-center gap-4">
                  <div
                    class="size-12 shrink-0 rounded-xl bg-emerald-500/10 dark:bg-emerald-400/10 grid place-items-center"
                  >
                    <Radio :size="21" class="text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="font-semibold text-sm truncate">{{ ch.name }}</p>
                    <p class="mt-1 text-xs muted truncate">
                      {{ ch.description || ch.sourceLabel || ch.media?.name || 'No description' }}
                    </p>
                    <p class="mt-1 text-xs font-mono text-emerald-700 dark:text-emerald-300">
                      {{ ch.groupIp }}:{{ ch.port }}
                      <span class="text-zinc-500 font-sans">· Service {{ ch.serviceId }}</span>
                    </p>
                    <p
                      v-if="ch.sourceType === 'live' && ch.bufferState"
                      class="mt-1 text-xs text-emerald-700 dark:text-emerald-300"
                    >
                      {{
                        ch.bufferState === 'filling'
                          ? 'Buffering before broadcast'
                          : ch.bufferState === 'recovering'
                            ? 'Reconnecting multicast output'
                            : 'Buffered live broadcast'
                      }}
                      · {{ ch.bufferWindowSeconds?.toFixed(0) ?? '0' }}s cached
                    </p>
                    <p
                      v-if="ch.lastError && ['error', 'recovering'].includes(ch.status)"
                      class="mt-2 text-xs text-rose-700 dark:text-rose-300 break-words"
                    >
                      {{ ch.lastError }}
                    </p>
                  </div>
                </div>
                <div class="flex items-center gap-4 flex-wrap justify-end">
                  <div class="hidden md:flex flex-col items-end gap-1">
                    <span class="text-xs">{{ profileNames[ch.profile] }}</span
                    ><span class="text-xs muted"
                      >{{ ch.progress.speed || '—' }} · {{ ch.progress.bitrate || '—' }} ·
                      {{ ch.status === 'streaming' ? fmtUptime(ch.startedAt) : '—' }}</span
                    >
                  </div>
                  <span class="pill" :class="`pill-${ch.status}`"
                    ><span class="size-1.5 rounded-full bg-current" />{{
                      statusLabel(ch.status)
                    }}</span
                  >
                  <div class="flex items-center gap-1">
                    <button
                      v-if="
                        !['streaming', 'starting', 'stopping', 'recovering'].includes(ch.status)
                      "
                      class="btn btn-primary"
                      :disabled="busyIds.includes(ch.id)"
                      @click="action(ch, 'start')"
                    >
                      <Play :size="14" /> Start</button
                    ><button
                      v-else
                      class="btn"
                      :disabled="busyIds.includes(ch.id) || ch.status === 'stopping'"
                      @click="action(ch, 'stop')"
                    >
                      <Square :size="13" /> Stop</button
                    ><button
                      class="btn btn-icon"
                      title="Restart"
                      :disabled="busyIds.includes(ch.id) || ch.status === 'stopping'"
                      @click="action(ch, 'restart')"
                    >
                      <RotateCw :size="15" /></button
                    ><button
                      class="btn gap-1.5"
                      title="Exchange this channel's multicast IP and port with another channel"
                      :disabled="busyIds.includes(ch.id) || swapping || channels.length < 2"
                      @click="openSwap(ch)"
                    >
                      <ArrowLeftRight :size="15" /> <span>Swap IP</span></button
                    ><button
                      class="btn btn-icon"
                      title="Edit"
                      :disabled="
                        ['streaming', 'starting', 'stopping', 'recovering'].includes(ch.status)
                      "
                      @click="editChannel(ch)"
                    >
                      <Pencil :size="15" /></button
                    ><button
                      class="btn btn-icon"
                      title="Delete"
                      :disabled="
                        ['streaming', 'starting', 'stopping', 'recovering'].includes(ch.status)
                      "
                      @click="removeChannel(ch)"
                    >
                      <Trash2 :size="15" />
                    </button>
                  </div>
                </div>
              </li>
            </ul>
            <div
              class="flex items-start gap-3 text-xs muted bg-emerald-500/5 dark:bg-emerald-400/5 border border-emerald-500/20 dark:border-emerald-400/15 rounded-xl p-4"
            >
              <Info :size="16" class="shrink-0 text-emerald-600 dark:text-emerald-400" />
              <p>
                Channels broadcast continuously whether receivers are connected or not. Source
                previews show the original file or internet feed—not a verification of actual
                multicast reception. Playback starts at the current broadcast position for new
                viewers.
              </p>
            </div>
          </template>
          <template v-else-if="activeTab === 'providers'">
            <div class="panel p-5 space-y-3">
              <div>
                <h3 class="font-semibold">Add a public M3U channel playlist</h3>
                <p class="text-xs muted mt-1">
                  Start with one of these playlists or enter any accessible M3U URL below. These
                  contain live channel entries, not prerecorded videos.
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="item in missingPresets"
                  :key="item.url"
                  class="btn btn-primary"
                  :disabled="providerSaving"
                  @click="addPreset(item)"
                >
                  <Plus :size="15" /> Add {{ item.name }}
                </button>
                <span
                  v-if="!missingPresets.length"
                  class="text-xs text-emerald-700 dark:text-emerald-300"
                  >Both example playlists are already configured.</span
                >
              </div>
              <p class="text-xs muted">
                Catalogs are downloaded over the office NIC; only the selected live channel is
                forwarded by FFmpeg to the IPTV multicast NIC.
              </p>
            </div>
            <div>
              <h2 class="text-2xl font-semibold">Live stream providers</h2>
              <p class="text-sm muted mt-2">
                Browse M3U/JSON internet television directories, then select individual live streams
                for nonstop multicast transmission. Live inputs automatically retry after failures.
              </p>
            </div>
            <div class="grid grid-cols-1 xl:grid-cols-[340px_1fr] gap-5 items-start">
              <div class="space-y-5">
                <form class="panel p-5 space-y-4" @submit.prevent="addProvider">
                  <h3 class="font-semibold">Add a provider</h3>
                  <div>
                    <label class="field-label">Provider name</label
                    ><input
                      v-model="providerName"
                      class="field"
                      maxlength="100"
                      placeholder="My live channels"
                      required
                    />
                  </div>
                  <SearchCombobox
                    :model-value="providerKind"
                    :options="providerKindOptions"
                    label="Catalog format"
                    @update:model-value="
                      (value) => {
                        if (value === 'm3u' || value === 'json') providerKind = value
                      }
                    "
                  />
                  <div>
                    <label class="field-label">Catalog URL (HTTP / HTTPS)</label
                    ><input
                      v-model="providerUrl"
                      class="field"
                      type="url"
                      placeholder="https://example.org/playlist.m3u"
                      required
                    />
                  </div>
                  <button class="btn btn-primary w-full" :disabled="providerSaving">
                    <Plus :size="16" /> {{ providerSaving ? 'Saving…' : 'Add provider' }}
                  </button>
                </form>
                <div class="panel p-5 space-y-3">
                  <h3 class="font-semibold">Configured providers</h3>
                  <p v-if="!providers.length" class="text-xs muted">No providers added yet.</p>
                  <ul
                    v-else
                    role="list"
                    class="divide-y divide-zinc-100 dark:divide-white/10 overflow-hidden rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900/60"
                  >
                    <li
                      v-for="provider in providers"
                      :key="provider.id"
                      class="flex items-center gap-3 px-3 py-3 hover:bg-zinc-50 dark:hover:bg-white/[0.035]"
                      :class="
                        selectedProviderId === provider.id
                          ? 'bg-emerald-500/10 dark:bg-emerald-400/10'
                          : ''
                      "
                    >
                      <div
                        class="size-10 shrink-0 rounded-full bg-emerald-500/10 dark:bg-emerald-400/10 grid place-items-center"
                      >
                        <Wifi :size="18" class="text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <button class="min-w-0 flex-1 text-left" @click="browseProvider(provider.id)">
                        <p
                          class="font-semibold text-sm truncate"
                          :class="
                            selectedProviderId === provider.id
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : ''
                          "
                        >
                          {{ provider.name }}
                        </p>
                        <p class="text-xs muted mt-1">{{ provider.kind.toUpperCase() }} playlist</p>
                      </button>
                      <button
                        class="btn btn-icon"
                        title="Browse playlist"
                        @click="browseProvider(provider.id)"
                      >
                        <ChevronRight :size="16" /></button
                      ><button
                        class="btn btn-icon"
                        title="Remove provider"
                        @click="removeProvider(provider)"
                      >
                        <Trash2 :size="15" />
                      </button>
                    </li>
                  </ul>
                </div>
              </div>
              <div class="panel p-5 min-h-[360px]">
                <div class="flex flex-wrap gap-3 justify-between items-center mb-4">
                  <div>
                    <h3 class="font-semibold">Available live channels</h3>
                    <p class="text-xs muted mt-1">
                      {{
                        providerLoading
                          ? 'Loading playlist…'
                          : `${providerTotal.toLocaleString()} matching · ${catalogTotal.toLocaleString()} available`
                      }}
                    </p>
                  </div>
                  <div class="flex gap-2 items-center">
                    <button
                      class="btn btn-icon"
                      title="Fetch latest playlist"
                      :disabled="!selectedProviderId || providerLoading"
                      @click="browseProvider(selectedProviderId, 1, true)"
                    >
                      <RefreshCcw :size="16" /></button
                    ><input
                      v-model="channelSearch"
                      class="field max-w-xs"
                      placeholder="Search by name or group"
                    />
                  </div>
                </div>
                <div v-if="selectedProviderId" class="mb-4">
                  <SearchCombobox
                    :model-value="providerGroup"
                    @update:model-value="(value) => (providerGroup = String(value ?? ''))"
                    :options="groupOptions"
                    label="Channel group"
                    placeholder="Search channel groups…"
                  />
                </div>
                <div v-if="!selectedProviderId" class="muted text-sm p-8 text-center">
                  Choose a configured playlist or add one above to discover channels.
                </div>
                <div v-else-if="providerLoading" class="muted text-sm p-8 text-center">
                  Fetching and indexing the live channel playlist over the office network…
                </div>
                <div v-else-if="!providerChannels.length" class="muted text-sm p-8 text-center">
                  No matching HTTP(S) live channels. Try another search or group.
                </div>
                <ul
                  v-else
                  role="list"
                  class="divide-y divide-zinc-100 dark:divide-white/10 overflow-y-auto max-h-[650px] rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900/60"
                >
                  <li
                    v-for="entry in providerChannels"
                    :key="entry.key"
                    class="flex items-center gap-3 px-3 sm:px-4 py-3 hover:bg-zinc-50 dark:hover:bg-white/[0.035]"
                  >
                    <img
                      v-if="entry.logo"
                      :src="entry.logo"
                      :alt="`${entry.name} logo`"
                      class="size-11 shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 object-contain p-1"
                      loading="lazy"
                      referrerpolicy="no-referrer"
                      @error="($event.target as HTMLImageElement).style.display = 'none'"
                    />
                    <div
                      v-else
                      class="size-11 shrink-0 rounded-lg bg-emerald-500/10 dark:bg-emerald-400/10 grid place-items-center"
                    >
                      <Radio :size="19" class="text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div class="min-w-0 flex-1">
                      <p class="font-semibold text-sm truncate" :title="entry.name">
                        {{ entry.name }}
                      </p>
                      <p class="mt-1 text-xs muted truncate">{{ entry.group }}</p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <button
                        class="btn"
                        title="Preview original live stream"
                        @click="previewProviderChannel(entry)"
                      >
                        <Play :size="15" /><span class="hidden sm:inline">Preview</span></button
                      ><button
                        class="btn btn-primary"
                        title="Add as multicast channel"
                        @click="addProviderChannel(entry)"
                      >
                        <Plus :size="15" /><span class="hidden sm:inline">Add</span>
                      </button>
                    </div>
                  </li>
                </ul>
                <div
                  v-if="selectedProviderId && providerPageCount > 1 && !providerLoading"
                  class="flex items-center justify-between gap-3 pt-4 mt-4 border-t rule"
                >
                  <button
                    class="btn"
                    :disabled="providerPage <= 1"
                    @click="browseProvider(selectedProviderId, providerPage - 1)"
                  >
                    Previous
                  </button>
                  <span class="text-xs muted"
                    >Page {{ providerPage.toLocaleString() }} of
                    {{ providerPageCount.toLocaleString() }}</span
                  >
                  <button
                    class="btn"
                    :disabled="providerPage >= providerPageCount"
                    @click="browseProvider(selectedProviderId, providerPage + 1)"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
            <p class="text-xs muted">
              Catalogs may contain unavailable, geographically restricted or unsupported streams.
              Only HTTP(S) entries are listed; actual playback depends on the upstream source and
              permitted access. The CMS does not decrypt protected streams.
            </p>
          </template>
          <template v-else-if="activeTab === 'media'">
            <div>
              <h2 class="text-2xl font-semibold tracking-tight">Video sources</h2>
              <p class="text-sm muted mt-1">
                Upload videos or register existing files from the server's configured import
                directory.
              </p>
            </div>
            <div class="grid grid-cols-1 xl:grid-cols-2 gap-5">
              <div class="panel p-6">
                <div class="flex gap-3 items-start">
                  <div
                    class="p-3 bg-emerald-500/10 dark:bg-emerald-400/10 rounded-xl text-emerald-600 dark:text-emerald-400"
                  >
                    <UploadCloud :size="22" />
                  </div>
                  <div>
                    <h3 class="font-semibold">Upload video</h3>
                    <p class="text-xs muted mt-1">
                      MP4, MKV, MOV, TS, MPEG, AVI and WebM. Files are analyzed by FFprobe.
                    </p>
                  </div>
                </div>
                <label
                  class="mt-5 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-xl p-6 flex flex-col items-center gap-2 text-center cursor-pointer hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors"
                  ><UploadCloud :size="22" class="text-emerald-600 dark:text-emerald-400" /><span
                    class="text-sm font-semibold"
                    >{{ uploading ? `Uploading ${uploadPercent}%` : 'Choose a video file' }}</span
                  ><span class="text-xs muted">Maximum size configured on the server</span
                  ><input
                    class="hidden"
                    type="file"
                    accept="video/*,.ts,.mkv,.mpeg,.mpg"
                    :disabled="uploading"
                    @change="onFileSelected"
                /></label>
                <div
                  v-if="uploading"
                  class="mt-4 h-2 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden"
                >
                  <div
                    class="bg-emerald-500 dark:bg-emerald-400 h-full transition-all"
                    :style="{ width: `${uploadPercent}%` }"
                  />
                </div>
              </div>
              <div class="panel p-6">
                <div class="flex gap-3 items-start">
                  <div
                    class="p-3 bg-emerald-500/10 dark:bg-emerald-400/10 rounded-xl text-emerald-600 dark:text-emerald-400"
                  >
                    <HardDrive :size="22" />
                  </div>
                  <div>
                    <h3 class="font-semibold">Import from server</h3>
                    <p class="text-xs muted mt-1">
                      Register a file already placed in the configured import folder, without
                      copying it.
                    </p>
                  </div>
                </div>
                <div class="mt-5">
                  <SearchCombobox
                    :model-value="importName"
                    @update:model-value="(value) => (importName = String(value ?? ''))"
                    :options="importOptions"
                    label="Import file"
                    placeholder="Search server files…"
                  />
                </div>
                <div class="mt-3 flex flex-wrap items-center gap-2">
                  <button class="btn btn-primary" :disabled="!importName" @click="importVideo">
                    <Plus :size="15" /> Register file
                  </button>
                  <button
                    class="btn"
                    type="button"
                    title="Refresh import directory"
                    @click="refreshCandidates"
                  >
                    <RefreshCcw :size="15" /> Refresh files
                  </button>
                </div>
              </div>
            </div>
            <div class="panel overflow-hidden">
              <div class="px-6 py-5 flex justify-between border-b rule">
                <h3 class="font-semibold">
                  Library <span class="muted font-normal">({{ media.length }} files)</span>
                </h3>
                <span class="text-xs muted"
                  >{{ fmtBytes(media.reduce((a, b) => a + b.bytes, 0)) }} total</span
                >
              </div>
              <div v-if="!media.length" class="p-12 text-center muted text-sm">
                No video files yet. Upload a file or import one from your Ubuntu server.
              </div>
              <ul
                v-else
                role="list"
                class="divide-y divide-zinc-100 dark:divide-white/10 bg-white dark:bg-zinc-900/40"
              >
                <li
                  v-for="item in media"
                  :key="item.id"
                  class="flex items-center gap-4 px-5 py-4 hover:bg-zinc-50 dark:hover:bg-white/[0.035]"
                >
                  <div
                    class="size-12 rounded-full bg-emerald-500/10 dark:bg-emerald-400/10 grid place-items-center shrink-0"
                  >
                    <Film :size="22" class="text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <h4 class="font-semibold text-sm truncate">{{ item.name }}</h4>
                    <p class="text-xs muted mt-1">
                      {{ fmtDuration(item.duration) }} · {{ item.width || '?' }}×{{
                        item.height || '?'
                      }}
                      · {{ item.videoCodec || '?' }} / {{ item.audioCodec || 'no audio' }} ·
                      {{ fmtBytes(item.bytes) }}
                    </p>
                    <p class="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1 uppercase">
                      {{ item.origin === 'import' ? 'Registered file' : 'Uploaded file' }}
                    </p>
                  </div>
                  <div class="flex gap-2 shrink-0">
                    <button
                      class="btn btn-icon"
                      title="Preview source"
                      @click="previewMedia = item"
                    >
                      <Play :size="15" /></button
                    ><button class="btn btn-icon" title="Remove file" @click="removeMedia(item)">
                      <Trash2 :size="15" />
                    </button>
                  </div>
                </li>
              </ul>
            </div>
          </template>
          <template v-else-if="activeTab === 'system'">
            <div>
              <h2 class="text-2xl font-semibold tracking-tight">System & network</h2>
              <p class="text-sm muted mt-1">
                Read-only runtime configuration. Edit config/streamer.json and restart the service
                to change NIC assignments.
              </p>
            </div>
            <div v-if="system" class="grid grid-cols-1 xl:grid-cols-2 gap-5">
              <div class="panel p-6">
                <div class="flex items-center gap-3 mb-5">
                  <MonitorCog class="text-emerald-600 dark:text-emerald-400" :size="20" />
                  <h3 class="font-semibold">Management network</h3>
                </div>
                <dl class="space-y-4 text-sm">
                  <div class="flex justify-between gap-4">
                    <dt class="muted">Interface</dt>
                    <dd class="font-mono">{{ system.management.interface }}</dd>
                  </div>
                  <div class="flex justify-between gap-4">
                    <dt class="muted">Bind address</dt>
                    <dd class="font-mono">{{ system.management.address }}</dd>
                  </div>
                  <div class="flex justify-between gap-4">
                    <dt class="muted">HTTP port</dt>
                    <dd>{{ system.management.port }}</dd>
                  </div>
                </dl>
                <p class="text-xs muted mt-5">
                  This interface serves the management dashboard and API.
                </p>
              </div>
              <div class="panel p-6">
                <div class="flex items-center gap-3 mb-5">
                  <Network class="text-emerald-600 dark:text-emerald-400" :size="20" />
                  <h3 class="font-semibold">IPTV distribution network</h3>
                </div>
                <dl class="space-y-4 text-sm">
                  <div class="flex justify-between gap-4">
                    <dt class="muted">Interface</dt>
                    <dd class="font-mono">{{ system.streaming.interface }}</dd>
                  </div>
                  <div class="flex justify-between gap-4">
                    <dt class="muted">Source IP</dt>
                    <dd class="font-mono">{{ system.streaming.address }}</dd>
                  </div>
                  <div class="flex justify-between gap-4">
                    <dt class="muted">Allowed multicast range</dt>
                    <dd class="font-mono">{{ system.streaming.range }}</dd>
                  </div>
                  <div class="flex justify-between gap-4">
                    <dt class="muted">Route enforcement</dt>
                    <dd
                      :class="
                        system.streaming.verifyEgressRoute
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : 'text-amber-700 dark:text-amber-300'
                      "
                    >
                      {{ system.streaming.verifyEgressRoute ? 'Enabled' : 'Disabled' }}
                    </dd>
                  </div>
                </dl>
              </div>
              <div class="panel p-6">
                <div class="flex items-center gap-3 mb-5">
                  <Cpu :size="20" class="text-emerald-600 dark:text-emerald-400" />
                  <h3 class="font-semibold">Ubuntu host</h3>
                </div>
                <dl class="space-y-4 text-sm">
                  <div class="flex justify-between">
                    <dt class="muted">Logical CPU cores</dt>
                    <dd>{{ system.host.cpuCount }}</dd>
                  </div>
                  <div class="flex justify-between">
                    <dt class="muted">System memory</dt>
                    <dd>{{ fmtBytes(system.host.memoryTotal) }}</dd>
                  </div>
                  <div>
                    <div class="flex justify-between mb-2">
                      <dt class="muted">Memory used</dt>
                      <dd>{{ memoryUsed }}%</dd>
                    </div>
                    <div class="h-2 bg-zinc-200 dark:bg-zinc-800 rounded-full">
                      <div
                        class="bg-emerald-500 dark:bg-emerald-400 h-full rounded-full"
                        :style="{ width: `${memoryUsed}%` }"
                      />
                    </div>
                  </div>
                  <div class="flex justify-between">
                    <dt class="muted">Load average (1 min)</dt>
                    <dd>{{ system.host.loadAverage[0]?.toFixed(2) || '0.00' }}</dd>
                  </div>
                </dl>
              </div>
              <div class="panel p-6">
                <div class="flex items-center gap-3 mb-5">
                  <Wifi class="text-emerald-600 dark:text-emerald-400" :size="20" />
                  <h3 class="font-semibold">Detected IPv4 interfaces</h3>
                </div>
                <div class="space-y-2">
                  <div
                    v-for="entry in system.interfaces"
                    :key="`${entry.name}:${entry.address}`"
                    class="rounded-lg bg-zinc-50 dark:bg-zinc-950 p-3 flex justify-between gap-3 text-xs"
                  >
                    <span class="font-mono text-emerald-700 dark:text-emerald-300">{{
                      entry.name
                    }}</span
                    ><span class="font-mono muted">{{ entry.address }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="panel p-6">
              <div class="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h3 class="font-semibold">Multicast egress verification</h3>
                  <p class="text-xs muted mt-1">
                    Validate that each configured group routes through the selected IPTV NIC, before
                    broadcasting.
                  </p>
                </div>
                <button class="btn btn-primary" :disabled="routeLoading" @click="checkRoutes">
                  <Activity :size="16" />{{ routeLoading ? 'Checking…' : 'Check routes' }}
                </button>
              </div>
              <div v-if="Object.keys(routeChecks).length" class="mt-5 space-y-3">
                <div
                  v-for="ch in channels"
                  :key="ch.id"
                  class="flex gap-3 items-start text-sm p-3 rounded-lg bg-zinc-50 dark:bg-zinc-950"
                >
                  <component
                    :is="routeChecks[ch.id]?.ok ? Check : CircleAlert"
                    :size="17"
                    :class="
                      routeChecks[ch.id]?.ok
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : 'text-rose-700 dark:text-rose-300'
                    "
                  />
                  <div>
                    <p class="font-semibold">
                      {{ ch.name }} <span class="muted font-normal text-xs">{{ ch.groupIp }}</span>
                    </p>
                    <p class="text-xs muted mt-1">
                      {{ routeChecks[ch.id]?.message || 'Not checked' }}
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <div
              class="flex items-start gap-3 bg-amber-50 dark:bg-amber-400/5 border border-amber-200 dark:border-amber-400/20 p-4 rounded-xl text-sm"
            >
              <Info :size="19" class="text-amber-700 dark:text-amber-300 shrink-0" />
              <p class="muted">
                Gateway and DNS settings are owned by Ubuntu Netplan—not the application. For your
                dual-NIC deployment, keep the default route on the office NIC and add a specific
                route for your multicast group range through the IPTV NIC. Do not configure two
                competing default gateways.
              </p>
            </div>
          </template>
        </main>
        <footer
          class="max-w-[1500px] mx-auto px-5 sm:px-9 pb-8 text-[11px] text-zinc-500 dark:text-zinc-500 flex items-center justify-between"
        >
          <p>Multicast Studio · Self-hosted IPTV playout</p>
          <p>FFmpeg + Hono + Vue 3</p>
        </footer>
      </div>
    </template>
    <div
      v-if="toast"
      class="fixed bottom-6 right-6 left-6 sm:left-auto z-50 max-w-[540px] rounded-xl border shadow-2xl px-5 py-4 flex gap-3 items-start bg-white dark:bg-zinc-900"
      :class="
        toast.kind === 'error'
          ? 'border-rose-500/50'
          : 'border-emerald-500/40 dark:border-emerald-400/40'
      "
    >
      <component
        :is="toast.kind === 'error' ? CircleAlert : Check"
        :size="18"
        :class="
          toast.kind === 'error'
            ? 'text-rose-700 dark:text-rose-300'
            : 'text-emerald-700 dark:text-emerald-300'
        "
      />
      <p class="text-sm flex-1 whitespace-pre-line break-words">{{ toast.message }}</p>
      <button @click="toast = null"><X :size="16" /></button>
    </div>
    <div v-if="modalOpen" class="modal-shade" @click.self="modalOpen = false">
      <div class="modal-card">
        <div
          class="sticky top-0 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-white/10 z-10 px-6 py-5 flex items-center justify-between"
        >
          <div>
            <h3 class="font-semibold text-lg">
              {{ editingId ? 'Edit channel' : 'Create multicast channel' }}
            </h3>
            <p class="text-xs muted mt-1">
              Choose a source, output profile, and multicast destination.
            </p>
          </div>
          <button class="btn btn-icon" @click="modalOpen = false"><X :size="17" /></button>
        </div>
        <form @submit.prevent="saveChannel" class="p-6 space-y-6">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="field-label">Channel name</label
              ><input
                v-model="currentForm.name"
                class="field"
                placeholder="Resort information"
                maxlength="100"
                required
              />
            </div>
            <SearchCombobox
              :model-value="currentForm.sourceType"
              :options="sourceTypeOptions"
              label="Source type"
              @update:model-value="setSourceType"
            />
            <div v-if="currentForm.sourceType === 'media'">
              <SearchCombobox
                :model-value="currentForm.mediaId"
                @update:model-value="
                  (value) => (currentForm.mediaId = typeof value === 'string' ? value : null)
                "
                :options="mediaOptions"
                label="Source video"
                placeholder="Search uploaded videos…"
              />
            </div>
            <div v-else class="sm:col-span-2 space-y-2">
              <label class="field-label">Live input</label>
              <p
                v-if="currentForm.providerId"
                class="text-xs text-emerald-600 dark:text-emerald-400"
              >
                Selected provider channel. The server will resolve a fresh URL whenever the
                broadcast restarts.
              </p>
              <div v-else class="flex gap-2 items-center">
                <input
                  v-model="currentForm.streamUrl"
                  type="url"
                  class="field"
                  placeholder="https://example.org/live/index.m3u8"
                  required
                /><button
                  type="button"
                  class="btn"
                  title="Preview this URL in the browser"
                  @click="previewDirectStream"
                >
                  <Play :size="15" /> Preview
                </button>
              </div>
              <button
                v-if="currentForm.providerId"
                type="button"
                class="btn"
                @click="clearProviderSelection"
              >
                Switch to direct URL
              </button>
              <p class="text-xs muted">
                Internet input uses the management NIC. Live channels prebuffer at least 20 seconds
                on disk before multicasting through the IPTV NIC.
              </p>
            </div>
            <div class="sm:col-span-2">
              <label class="field-label">Description (optional)</label
              ><input
                v-model="currentForm.description"
                class="field"
                maxlength="300"
                placeholder="Continuous resort information channel"
              />
            </div>
          </div>
          <div>
            <p class="text-sm font-semibold mb-3 flex gap-2 items-center">
              <Network :size="16" class="text-emerald-600 dark:text-emerald-400" /> Multicast
              destination
            </p>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div class="col-span-2">
                <label class="field-label">Group IP</label
                ><input v-model="currentForm.groupIp" class="field font-mono" required />
              </div>
              <div>
                <label class="field-label">UDP port</label
                ><input
                  v-model.number="currentForm.port"
                  class="field"
                  type="number"
                  min="1024"
                  max="65535"
                  required
                />
              </div>
              <div>
                <label class="field-label">TTL</label
                ><input
                  v-model.number="currentForm.ttl"
                  class="field"
                  type="number"
                  min="1"
                  max="255"
                  required
                />
              </div>
            </div>
            <p class="text-xs muted mt-2">
              Allowed range: {{ system?.streaming.range || 'Configured on server' }}. Interface:
              {{ system?.streaming.interface || '—' }}
            </p>
          </div>
          <div>
            <p class="text-sm font-semibold mb-3 flex gap-2 items-center">
              <Clapperboard :size="16" class="text-emerald-600 dark:text-emerald-400" /> Encoding
            </p>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="sm:col-span-2">
                <SearchCombobox
                  :model-value="currentForm.profile"
                  :options="profileOptions"
                  label="Encoding profile"
                  @update:model-value="setProfile"
                />
                <p
                  v-if="currentForm.profile === 'copy'"
                  class="text-xs text-amber-700 dark:text-amber-300 mt-2"
                >
                  Direct copy requires the original codecs to be supported by the MPEG-TS muxer and
                  every receiver.
                </p>
                <p
                  v-if="currentForm.profile === 'mpeg2'"
                  class="text-xs text-amber-700 dark:text-amber-300 mt-2"
                >
                  For a 2-vCPU VM, start with SD PAL (720 × 576), 25 fps, 3500 kbps video and 192
                  kbps audio. Keep playback speed near 1.00x. MPEG-2 HD live transcoding may
                  overload the VM.
                </p>
              </div>
              <template v-if="currentForm.profile !== 'copy'"
                ><div>
                  <SearchCombobox
                    :model-value="resolution"
                    @update:model-value="(value) => (resolution = String(value ?? ''))"
                    :options="resolutionOptions"
                    label="Resolution"
                  />
                </div>
                <div>
                  <SearchCombobox
                    :model-value="currentForm.fps"
                    @update:model-value="(value) => (currentForm.fps = Number(value))"
                    :options="frameRateOptions"
                    label="Frame rate"
                  />
                </div>
                <div>
                  <label class="field-label">Video bitrate (kbps)</label
                  ><input
                    v-model.number="currentForm.videoBitrateKbps"
                    class="field"
                    type="number"
                    min="250"
                    max="40000"
                    required
                  />
                </div>
                <div>
                  <label class="field-label">Audio bitrate (kbps)</label
                  ><input
                    v-model.number="currentForm.audioBitrateKbps"
                    class="field"
                    type="number"
                    min="32"
                    max="512"
                    required
                  /></div
              ></template>
              <div>
                <label class="field-label">MPEG-TS Service ID</label
                ><input
                  v-model.number="currentForm.serviceId"
                  class="field"
                  type="number"
                  min="1"
                  max="65535"
                  required
                />
              </div>
            </div>
          </div>
          <div class="flex flex-wrap gap-6">
            <label class="inline-flex items-center gap-2 text-sm cursor-pointer"
              ><input
                v-model="currentForm.autoStart"
                type="checkbox"
                class="accent-emerald-500 w-4 h-4"
              />
              Auto-start on boot</label
            ><label class="inline-flex items-center gap-2 text-sm cursor-pointer"
              ><input
                v-model="currentForm.autoRecover"
                type="checkbox"
                class="accent-emerald-500 w-4 h-4"
              />
              Auto-recover crashes</label
            >
          </div>
          <div class="flex justify-end gap-3 border-t rule pt-5">
            <button class="btn" type="button" @click="modalOpen = false">Cancel</button
            ><button class="btn btn-primary" :disabled="saving">
              <Check :size="16" />{{
                saving ? 'Saving…' : editingId ? 'Save changes' : 'Create channel'
              }}
            </button>
          </div>
        </form>
      </div>
    </div>
    <div v-if="previewStream" class="modal-shade" @click.self="closeStreamPreview">
      <div class="modal-card">
        <div class="p-5 flex items-start justify-between gap-4 border-b rule">
          <div class="min-w-0">
            <h3 class="font-semibold truncate">{{ previewStream.name }}</h3>
            <p class="text-xs muted mt-1 truncate">
              {{ previewStream.group }} · Browser source preview
            </p>
          </div>
          <button class="btn btn-icon" title="Close preview" @click="closeStreamPreview">
            <X :size="17" />
          </button>
        </div>
        <div class="bg-black relative">
          <video
            ref="previewVideo"
            class="w-full max-h-[65vh] min-h-48 bg-black"
            controls
            playsinline
            preload="none"
            @error="previewError = previewError || 'Your browser cannot play this source.'"
          />
          <div
            v-if="previewLoading"
            class="absolute inset-0 grid place-items-center text-sm text-emerald-700 dark:text-emerald-300 bg-black/60"
          >
            Preparing live preview…
          </div>
        </div>
        <div class="p-5 space-y-2">
          <p v-if="previewError" class="text-sm text-amber-700 dark:text-amber-300">
            {{ previewError }}
          </p>
          <p class="text-xs muted">
            Preview plays the original internet feed in your browser, not the buffered multicast
            output. Some channels cannot be previewed due to CORS, custom headers, unsupported
            codecs or unavailable sources. You can still add them to Multicast Studio.
          </p>
        </div>
      </div>
    </div>
    <div v-if="previewMedia" class="modal-shade" @click.self="previewMedia = null">
      <div class="modal-card">
        <div class="p-5 flex justify-between items-center">
          <h3 class="font-semibold truncate">{{ previewMedia.name }}</h3>
          <button class="btn btn-icon" @click="previewMedia = null"><X :size="17" /></button>
        </div>
        <video
          :key="previewMedia.id"
          class="bg-black w-full max-h-[60vh]"
          :src="`/api/media/${previewMedia.id}/preview`"
          controls
          preload="metadata"
        />
        <p class="p-5 text-xs muted">
          Source-file preview only. Your browser may not decode some legacy codecs; VLC or your IPTV
          receiver can still support them.
        </p>
      </div>
    </div>
  </div>
</template>
