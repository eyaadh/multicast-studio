<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { Activity, ArrowDownToLine, Check, CircleAlert, Clapperboard, Cpu, Database, Film,
  HardDrive, Info, Layers3, LogOut, MonitorCog, Network, Pencil, Play, Plus, Radio,
  RefreshCcw, RotateCw, Settings2, ShieldCheck, Square, Trash2, UploadCloud, Wifi, X } from 'lucide-vue-next'
import { api, ApiError, jsonBody, uploadRaw } from './api'
import type { Channel, ChannelForm, Media, Profile, RouteCheck, SystemInfo, Provider, ProviderChannel } from './types'

type Tab='channels'|'providers'|'media'|'system'
const activeTab=ref<Tab>('channels')
const sessionLoading=ref(true),authenticated=ref(false),loginBusy=ref(false)
const username=ref('admin'),password=ref('')
const channels=ref<Channel[]>([]),media=ref<Media[]>([]),system=ref<SystemInfo|null>(null)
const providers=ref<Provider[]>([]),providerChannels=ref<ProviderChannel[]>([])
const selectedProviderId=ref(''),providerLoading=ref(false),providerSaving=ref(false)
const providerName=ref(''),providerKind=ref<'m3u'|'json'>('m3u'),providerUrl=ref('')
const channelSearch=ref('')
const filteredProviderChannels=computed(()=>providerChannels.value.filter(ch=>
  `${ch.name} ${ch.group}`.toLowerCase().includes(channelSearch.value.trim().toLowerCase())))
const candidates=ref<string[]>([]),importName=ref(''),uploading=ref(false),uploadPercent=ref(0)
const modalOpen=ref(false),editingId=ref<string|null>(null),saving=ref(false),busyIds=ref<string[]>([])
const toast=ref<{kind:'success'|'error';message:string}|null>(null)
const live=ref(false),routeChecks=ref<Record<string,RouteCheck>>({}),routeLoading=ref(false)
const previewMedia=ref<Media|null>(null)
let events:EventSource|null=null
let interval:ReturnType<typeof setInterval>|null=null
let toastTimer:ReturnType<typeof setTimeout>|null=null
const fmtBytes=(v:number)=>v>1024**3?`${(v/1024**3).toFixed(2)} GB`:v>1024**2?`${(v/1024**2).toFixed(1)} MB`:`${Math.round(v/1024)} KB`
const fmtDuration=(v:number|null)=>v===null?'Unknown':`${Math.floor(v/3600)?`${Math.floor(v/3600)}:`:''}${String(Math.floor(v/60)%60).padStart(2,'0')}:${String(Math.floor(v%60)).padStart(2,'0')}`
const fmtUptime=(date:string|null)=>date?`${Math.floor((Date.now()-Date.parse(date))/3600000)}h ${Math.floor(((Date.now()-Date.parse(date))/60000)%60)}m`:'—'
const statusLabel=(status:string)=>status.charAt(0).toUpperCase()+status.slice(1)
const activeCount=computed(()=>channels.value.filter(c=>c.status==='streaming').length)
const errorCount=computed(()=>channels.value.filter(c=>c.status==='error').length)
const memoryUsed=computed(()=>system.value?Math.round((1-system.value.host.memoryFree/system.value.host.memoryTotal)*100):0)
const profileNames:Record<Profile,string>={h264:'H.264 / AAC',mpeg4:'MPEG-4 Part 2 / MP2',mpeg2:'MPEG-2 / MP2',copy:'Direct copy'}
const currentForm=ref<ChannelForm>(defaultForm())
function defaultForm():ChannelForm {
  return {name:'',description:'',sourceType:'media',mediaId:null,providerId:null,providerChannelKey:null,streamUrl:null,groupIp:'239.80.0.1',port:5000,profile:'mpeg4',
    videoBitrateKbps:2500,audioBitrateKbps:128,width:1280,height:720,fps:25,ttl:1,
    autoStart:true,autoRecover:true,serviceId:101}
}
function notice(message:string,kind:'success'|'error'='success') {
  toast.value={message,kind}
  if(toastTimer)clearTimeout(toastTimer)
  toastTimer=setTimeout(()=>{toast.value=null},6000)
}
function showError(error:unknown){notice(error instanceof Error?error.message:String(error),'error')}
async function refresh(){
  if(!authenticated.value)return
  try {
    const [ch,med,sys,prov]=await Promise.all([api<Channel[]>('/channels'),api<Media[]>('/media'),api<SystemInfo>('/system'),api<Provider[]>('/providers')])
    channels.value=ch;media.value=med;system.value=sys;providers.value=prov
  } catch(error){ if(error instanceof ApiError && error.status===401){authenticated.value=false;stopEvents()}else showError(error) }
}
function startEvents(){
  stopEvents()
  events=new EventSource('/api/events')
  events.addEventListener('snapshot',event=>{
    const data=JSON.parse((event as MessageEvent).data) as {channels:Channel[];system:SystemInfo}
    channels.value=data.channels;system.value=data.system;live.value=true
  })
  events.onerror=()=>{live.value=false}
  interval=setInterval(()=>{if(!live.value)refresh()},10000)
}
function stopEvents(){events?.close();events=null;if(interval)clearInterval(interval);interval=null;live.value=false}
async function login(){
  loginBusy.value=true
  try {await api('/auth/login',{method:'POST',body:jsonBody({username:username.value,password:password.value})})
    authenticated.value=true;password.value='';await refresh();startEvents()
  }catch(error){showError(error)}finally{loginBusy.value=false}
}
async function logout(){try{await api('/auth/logout',{method:'POST'})}catch{}stopEvents();authenticated.value=false;channels.value=[];media.value=[]}
async function action(channel:Channel,type:'start'|'stop'|'restart'){
  busyIds.value.push(channel.id)
  try{await api(`/channels/${channel.id}/${type}`,{method:'POST'});notice(`${channel.name}: ${type} requested`);await refresh()}
  catch(error){showError(error);await refresh()}finally{busyIds.value=busyIds.value.filter(id=>id!==channel.id)}
}
function newChannel(){
  editingId.value=null
  const next=defaultForm()
  next.mediaId=media.value[0]?.id||null
  if(!next.mediaId)next.sourceType='live'
  const address=system.value?.streaming.range.split('/')[0]||'239.80.0.0'
  const prefix=address.split('.').slice(0,3).join('.')
  let index=1
  while(channels.value.some(ch=>ch.groupIp===`${prefix}.${index}`))index++
  if(index<255)next.groupIp=`${prefix}.${index}`
  while(channels.value.some(ch=>ch.serviceId===next.serviceId))next.serviceId++
  currentForm.value=next;modalOpen.value=true
}
function editChannel(channel:Channel){
  if(['streaming','starting','stopping','recovering'].includes(channel.status)){
    notice('Stop the channel before editing its configuration','error');return
  }
  editingId.value=channel.id
  const {name,description,sourceType,mediaId,providerId,providerChannelKey,streamUrl,groupIp,port,profile,videoBitrateKbps,audioBitrateKbps,width,height,fps,ttl,autoStart,autoRecover,serviceId}=channel
  currentForm.value={name,description,sourceType,mediaId,providerId,providerChannelKey,streamUrl,groupIp,port,profile,videoBitrateKbps,audioBitrateKbps,width,height,fps,ttl,autoStart,autoRecover,serviceId}
  modalOpen.value=true
}
async function saveChannel(){
  saving.value=true
  try{
    await api(editingId.value?`/channels/${editingId.value}`:'/channels',{
      method:editingId.value?'PATCH':'POST',body:jsonBody(currentForm.value)})
    notice(editingId.value?'Channel updated':'Channel created');modalOpen.value=false;await refresh()
  }catch(error){showError(error)}finally{saving.value=false}
}
async function removeChannel(channel:Channel){
  if(!window.confirm(`Delete channel "${channel.name}"?`))return
  try{await api(`/channels/${channel.id}`,{method:'DELETE'});notice('Channel deleted');await refresh()}
  catch(error){showError(error)}
}
function onFileSelected(event:Event){
  const input=event.target as HTMLInputElement
  const file=input.files?.[0]
  if(file)void upload(file)
  input.value=''
}
function onResolutionChange(event:Event){
  const value=(event.target as HTMLSelectElement).value
  const [width,height]=value.split('x').map(Number)
  currentForm.value.width=width||1280
  currentForm.value.height=height||720
}
async function upload(file?:File){
  if(!file)return
  uploading.value=true;uploadPercent.value=0
  try{await uploadRaw(file,pct=>uploadPercent.value=pct);notice(`${file.name} uploaded`);await refresh()}
  catch(error){showError(error)}finally{uploading.value=false}
}
async function refreshCandidates(){try{candidates.value=await api('/media/import-candidates')}catch(error){showError(error)}}
async function importVideo(){
  if(!importName.value)return
  try{await api('/media/import',{method:'POST',body:jsonBody({filename:importName.value})});notice('Video registered');importName.value='';await Promise.all([refresh(),refreshCandidates()])}
  catch(error){showError(error)}
}
async function removeMedia(item:Media){
  if(!window.confirm(`Remove "${item.name}" from the library? Uploaded files will be deleted from disk.`))return
  try{await api(`/media/${item.id}`,{method:'DELETE'});notice('Video removed');await refresh()}
  catch(error){showError(error)}
}
async function checkRoutes(){
  routeLoading.value=true
  const result:Record<string,RouteCheck>={}
  try {
    for(const channel of channels.value){
      result[channel.id]=await api<RouteCheck>(`/network/check/${channel.groupIp}`)
    }
    routeChecks.value=result
    if(!channels.value.length)notice('Create a channel to verify its multicast egress route')
  }catch(error){showError(error)}finally{routeLoading.value=false}
}
async function browseProvider(id:string){
  selectedProviderId.value=id;providerChannels.value=[];providerLoading.value=true
  try{providerChannels.value=await api<ProviderChannel[]>(`/providers/${id}/channels`)}
  catch(error){showError(error)}finally{providerLoading.value=false}
}
async function addProvider(){
  providerSaving.value=true
  try{
    const result=await api<Provider>('/providers',{method:'POST',body:jsonBody({name:providerName.value,kind:providerKind.value,url:providerUrl.value})})
    providerName.value='';providerUrl.value='';notice('Provider saved');await refresh();await browseProvider(result.id)
  }catch(error){showError(error)}finally{providerSaving.value=false}
}
async function removeProvider(provider:Provider){
  if(!window.confirm(`Remove provider "${provider.name}"?`))return
  try{
    await api(`/providers/${provider.id}`,{method:'DELETE'})
    if(selectedProviderId.value===provider.id){selectedProviderId.value='';providerChannels.value=[]}
    notice('Provider removed');await refresh()
  }catch(error){showError(error)}
}
function addProviderChannel(ch:ProviderChannel){
  newChannel()
  currentForm.value.sourceType='live'
  currentForm.value.mediaId=null
  currentForm.value.providerId=selectedProviderId.value
  currentForm.value.providerChannelKey=ch.key
  currentForm.value.streamUrl=null
  currentForm.value.name=ch.name.slice(0,100)
  currentForm.value.description=`Live feed · ${ch.group}`.slice(0,300)
  activeTab.value='channels'
}
function switchSourceType(){
  currentForm.value.providerId=null;currentForm.value.providerChannelKey=null;currentForm.value.streamUrl=null
  currentForm.value.mediaId=currentForm.value.sourceType==='media'?media.value[0]?.id||null:null
}
watch(activeTab, tab=>{if(tab==='media' && authenticated.value)void refreshCandidates()})
onMounted(async()=>{
  try{const state=await api<{authenticated:boolean}>('/auth/session');authenticated.value=state.authenticated
    if(authenticated.value){await refresh();startEvents()}}
  catch(error){showError(error)}finally{sessionLoading.value=false}
})
onUnmounted(()=>{stopEvents();if(toastTimer)clearTimeout(toastTimer)})
</script>

<template>
  <div class="min-h-screen text-slate-100">
    <div v-if="sessionLoading" class="min-h-screen grid place-items-center"><div class="flex items-center gap-3 text-indigo-300"><Radio :size="24" class="animate-pulse"/> Connecting to Multicast Studio…</div></div>
    <div v-else-if="!authenticated" class="min-h-screen grid place-items-center px-4">
      <div class="w-full max-w-md panel p-8 shadow-2xl shadow-black/50">
        <div class="flex items-center gap-3 mb-8"><div class="rounded-2xl bg-indigo-500/15 p-3 border border-indigo-400/20"><Radio class="text-indigo-300" :size="28"/></div><div><h1 class="text-2xl font-bold tracking-tight">Multicast Studio</h1><p class="text-sm muted">IPTV multicast management</p></div></div>
        <p class="text-sm muted mb-6">Sign in to manage your continuously broadcasting IPTV channels.</p>
        <form class="space-y-5" @submit.prevent="login">
          <div><label class="field-label">Username</label><input v-model="username" class="field" autocomplete="username" required/></div>
          <div><label class="field-label">Password</label><input v-model="password" class="field" type="password" autocomplete="current-password" required/></div>
          <button class="btn btn-primary w-full py-3" :disabled="loginBusy">{{loginBusy?'Signing in…':'Sign in to dashboard'}}</button>
        </form><p class="text-xs muted mt-8 text-center">Credentials are configured in the server's .env file.</p>
      </div>
    </div>
    <template v-else>
      <aside class="fixed inset-y-0 left-0 w-64 bg-[#0c1020] border-r border-[#262f49] hidden lg:flex flex-col z-10">
        <div class="flex items-center gap-3 px-6 py-7"><div class="bg-indigo-500/20 rounded-xl p-2.5"><Radio class="text-indigo-300" :size="22"/></div><div><h1 class="font-bold text-[17px] tracking-tight">Multicast Studio</h1><p class="text-[11px] muted tracking-widest uppercase">IPTV Control Center</p></div></div>
        <div class="px-4 pt-6 space-y-1">
          <button v-for="tab in ([{id:'channels',label:'Channels',icon:Layers3},{id:'providers',label:'Live Providers',icon:Wifi},{id:'media',label:'Media Library',icon:Film},{id:'system',label:'System & Network',icon:Settings2}] as const)" :key="tab.id" class="w-full flex items-center gap-3 px-4 py-3 text-sm rounded-xl transition-colors" :class="activeTab===tab.id?'text-indigo-200 bg-indigo-500/15 border border-indigo-400/20':'muted hover:bg-white/5 hover:text-white border border-transparent'" @click="activeTab=tab.id"><component :is="tab.icon" :size="17"/> {{tab.label}}</button>
        </div>
        <div class="mt-auto p-5 border-t border-[#252d42] space-y-4"><div class="flex gap-3 items-center"><div class="h-9 w-9 rounded-full bg-slate-700/70 grid place-items-center text-sm font-semibold">A</div><div class="min-w-0"><p class="text-sm font-semibold">Administrator</p><p class="text-xs muted">Local management</p></div></div><button class="btn w-full" @click="logout"><LogOut :size="15"/> Sign out</button></div>
      </aside>
      <div class="lg:ml-64">
        <header class="border-b border-[#222c46] bg-[#0b0f1e]/90 sticky top-0 z-10 backdrop-blur-xl">
          <div class="max-w-[1500px] mx-auto px-5 sm:px-9 py-4 flex flex-wrap items-center justify-between gap-4">
            <div><p class="text-xs font-semibold tracking-widest uppercase text-indigo-300 mb-1">Broadcast Operations</p><h2 class="text-lg font-semibold">{{activeTab==='channels'?'Channel Dashboard':activeTab==='providers'?'Live Stream Providers':activeTab==='media'?'Media Library':'System & Network'}}</h2></div>
            <div class="flex items-center gap-3"><span class="hidden sm:inline-flex items-center gap-2 text-xs muted"><span class="w-2 h-2 rounded-full" :class="live?'bg-emerald-400':'bg-amber-400'"/>{{live?'Live monitoring':'Reconnecting'}}</span><button class="btn btn-icon" title="Refresh" @click="refresh"><RefreshCcw :size="16"/></button><button v-if="activeTab==='channels'" class="btn btn-primary" @click="newChannel"><Plus :size="16"/> New channel</button></div>
          </div>
          <div class="lg:hidden px-5 pb-3 flex gap-2 overflow-auto"><button v-for="tab in ([{id:'channels',label:'Channels'},{id:'providers',label:'Providers'},{id:'media',label:'Media'},{id:'system',label:'System'}] as const)" :key="tab.id" class="btn" :class="activeTab===tab.id?'btn-primary':''" @click="activeTab=tab.id">{{tab.label}}</button><button class="btn ml-auto" @click="logout"><LogOut :size="16"/></button></div>
        </header>
        <main class="max-w-[1500px] mx-auto px-5 sm:px-9 py-8 space-y-7">
          <template v-if="activeTab==='channels'">
            <div class="flex flex-col md:flex-row md:justify-between md:items-end gap-3"><div><h2 class="text-2xl font-semibold tracking-tight">Channel overview</h2><p class="text-sm muted mt-1">Independent, continuous multicast broadcasts with automatic recovery.</p></div><a class="btn self-start" href="/api/channels/playlist.m3u" download="channels.m3u"><ArrowDownToLine :size="16"/> Download M3U</a></div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div class="panel p-5"><div class="flex items-center justify-between"><p class="text-xs uppercase tracking-wider muted font-semibold">Total channels</p><Layers3 :size="18" class="text-indigo-300"/></div><p class="text-3xl font-semibold mt-3">{{channels.length}}</p><p class="text-xs muted mt-1">Configured broadcast destinations</p></div>
              <div class="panel p-5"><div class="flex items-center justify-between"><p class="text-xs uppercase tracking-wider muted font-semibold">On air</p><Radio :size="18" class="text-emerald-400"/></div><p class="text-3xl font-semibold mt-3">{{activeCount}} <span class="text-sm text-slate-500 font-normal">/ {{channels.length}}</span></p><p class="text-xs text-emerald-300/80 mt-1">Streams actively reporting progress</p></div>
              <div class="panel p-5"><div class="flex items-center justify-between"><p class="text-xs uppercase tracking-wider muted font-semibold">Health alerts</p><ShieldCheck :size="18" :class="errorCount?'text-rose-400':'text-indigo-300'"/></div><p class="text-3xl font-semibold mt-3">{{errorCount}}</p><p class="text-xs muted mt-1">Channels requiring attention</p></div>
            </div>
            <div v-if="!channels.length" class="panel p-12 text-center"><Clapperboard :size="38" class="mx-auto text-indigo-300 mb-4"/><h3 class="text-lg font-semibold">Your first channel starts here</h3><p class="muted text-sm max-w-md mx-auto mt-2">Upload a video, create a multicast channel, and start broadcasting to your IPTV network.</p><div class="flex gap-3 justify-center mt-6"><button class="btn" @click="activeTab='media'"><UploadCloud :size="16"/> Add video</button><button class="btn btn-primary" @click="newChannel"><Plus :size="16"/> New channel</button></div></div>
            <div v-else class="grid grid-cols-1 xl:grid-cols-2 gap-5">
              <article v-for="ch in channels" :key="ch.id" class="panel p-5 sm:p-6 min-w-0">
                <div class="flex justify-between items-start gap-3"><div class="min-w-0"><p class="text-[11px] text-indigo-300 uppercase tracking-widest font-semibold mb-2">Service {{ch.serviceId}}</p><h3 class="text-lg font-semibold truncate">{{ch.name}}</h3><p class="text-xs muted mt-1 truncate">{{ch.description||ch.sourceLabel||ch.media?.name||'No description'}}</p></div><span class="pill shrink-0" :class="`pill-${ch.status}`"><span class="w-1.5 h-1.5 rounded-full bg-current"/>{{statusLabel(ch.status)}}</span></div>
                <div class="mt-5 bg-[#090e1c] rounded-xl border border-[#25304a] px-4 py-3 flex flex-wrap items-center justify-between gap-3"><div><p class="text-[10px] muted tracking-wide uppercase mb-1">UDP Multicast</p><code class="text-indigo-200 text-sm">{{ch.groupIp}}:{{ch.port}}</code></div><p class="text-xs text-slate-400">{{profileNames[ch.profile]}}</p></div>
                <div class="grid grid-cols-3 gap-3 mt-5 text-sm"><div><p class="muted text-xs mb-1">Playback</p><p class="font-medium">{{ch.progress.speed||'—'}}</p></div><div><p class="muted text-xs mb-1">Output rate</p><p class="font-medium">{{ch.progress.bitrate||'—'}}</p></div><div><p class="muted text-xs mb-1">Uptime</p><p class="font-medium">{{ch.status==='streaming'?fmtUptime(ch.startedAt):'—'}}</p></div></div>
                <p v-if="ch.lastError && ['error','recovering'].includes(ch.status)" class="mt-4 text-xs text-rose-300 break-words bg-rose-500/10 p-3 rounded-lg border border-rose-500/15">{{ch.lastError}}</p>
                <div class="flex items-center gap-2 flex-wrap mt-5 pt-5 border-t rule"><button v-if="!['streaming','starting','stopping','recovering'].includes(ch.status)" class="btn btn-primary" :disabled="busyIds.includes(ch.id)" @click="action(ch,'start')"><Play :size="14"/> Start</button><button v-else class="btn" :disabled="busyIds.includes(ch.id)||ch.status==='stopping'" @click="action(ch,'stop')"><Square :size="13"/> Stop</button><button class="btn btn-icon" title="Restart" :disabled="busyIds.includes(ch.id)||ch.status==='stopping'" @click="action(ch,'restart')"><RotateCw :size="15"/></button><div class="flex-1"/><button class="btn btn-icon" title="Edit" :disabled="['streaming','starting','stopping','recovering'].includes(ch.status)" @click="editChannel(ch)"><Pencil :size="15"/></button><button class="btn btn-icon" title="Delete" :disabled="['streaming','starting','stopping','recovering'].includes(ch.status)" @click="removeChannel(ch)"><Trash2 :size="15"/></button></div>
              </article>
            </div>
            <div class="flex items-start gap-3 text-xs muted bg-indigo-500/5 border border-indigo-400/15 rounded-xl p-4"><Info :size="16" class="shrink-0 text-indigo-300"/><p>Channels broadcast continuously whether receivers are connected or not. Video previews display the source file—not a verification of actual multicast reception. Playback starts at the current broadcast position for new viewers.</p></div>
          </template>
          <template v-else-if="activeTab==='providers'">
            <div><h2 class="text-2xl font-semibold">Live stream providers</h2><p class="text-sm muted mt-2">Register an authorized M3U or JSON catalog, browse channels, and assign them to multicast output. Feeds are resolved again whenever a channel reconnects.</p></div>
            <div class="grid grid-cols-1 xl:grid-cols-[340px_1fr] gap-5 items-start">
              <div class="space-y-5">
                <form class="panel p-5 space-y-4" @submit.prevent="addProvider">
                  <h3 class="font-semibold">Add a provider</h3>
                  <div><label class="field-label">Provider name</label><input v-model="providerName" class="field" maxlength="100" placeholder="My live channels" required/></div>
                  <div><label class="field-label">Catalog format</label><select v-model="providerKind" class="field"><option value="m3u">Extended M3U</option><option value="json">JSON channel catalog</option></select></div>
                  <div><label class="field-label">Catalog URL (HTTP / HTTPS)</label><input v-model="providerUrl" class="field" type="url" placeholder="https://example.org/playlist.m3u" required/></div>
                  <button class="btn btn-primary w-full" :disabled="providerSaving"><Plus :size="16"/> {{providerSaving?'Saving…':'Add provider'}}</button>
                </form>
                <div class="panel p-5 space-y-3"><h3 class="font-semibold">Configured providers</h3><p v-if="!providers.length" class="text-xs muted">No providers added yet.</p>
                  <div v-for="provider in providers" :key="provider.id" class="rounded-lg border border-[#2d3a54] p-3 flex gap-2 items-center">
                    <button class="flex-1 min-w-0 text-left" @click="browseProvider(provider.id)"><p class="font-medium text-sm truncate" :class="selectedProviderId===provider.id?'text-indigo-300':''">{{provider.name}}</p><p class="text-xs muted">{{provider.kind.toUpperCase()}}</p></button>
                    <button class="btn btn-icon" title="Browse / refresh" @click="browseProvider(provider.id)"><RefreshCcw :size="15"/></button><button class="btn btn-icon" title="Remove provider" @click="removeProvider(provider)"><Trash2 :size="15"/></button>
                  </div>
                </div>
              </div>
              <div class="panel p-5 min-h-[360px]">
                <div class="flex flex-wrap gap-3 justify-between items-center mb-5"><div><h3 class="font-semibold">Available live channels</h3><p class="text-xs muted mt-1">{{providerLoading?'Loading catalog…':`${providerChannels.length} channels`}}</p></div><input v-model="channelSearch" class="field max-w-xs" placeholder="Search by name or group"/></div>
                <div v-if="!selectedProviderId" class="muted text-sm p-8 text-center">Select a provider to browse its channel catalog.</div>
                <div v-else-if="providerLoading" class="muted text-sm p-8 text-center">Fetching channel directory through the office network…</div>
                <div v-else-if="!filteredProviderChannels.length" class="muted text-sm p-8 text-center">No compatible HTTP(S) channels found.</div>
                <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[650px] overflow-y-auto pr-1">
                  <div v-for="entry in filteredProviderChannels" :key="entry.key" class="border border-[#2d3a54] rounded-xl p-3 flex items-center gap-3">
                    <div class="h-10 w-10 shrink-0 rounded-lg bg-indigo-500/10 grid place-items-center"><Radio :size="19" class="text-indigo-300"/></div>
                    <div class="min-w-0 flex-1"><p class="font-medium text-sm truncate" :title="entry.name">{{entry.name}}</p><p class="muted text-xs truncate">{{entry.group}}</p></div>
                    <button class="btn btn-primary shrink-0" title="Add as multicast channel" @click="addProviderChannel(entry)"><Plus :size="15"/> Add</button>
                  </div>
                </div>
              </div>
            </div>
            <p class="text-xs muted">Catalog entries and source URLs must be accessible without DRM or unauthorized access. Cricfy's encrypted remote directory is not bundled; add a usable authorized M3U/JSON catalog here.</p>
          </template>
          <template v-else-if="activeTab==='media'">
            <div><h2 class="text-2xl font-semibold tracking-tight">Video sources</h2><p class="text-sm muted mt-1">Upload videos or register existing files from the server's configured import directory.</p></div>
            <div class="grid grid-cols-1 xl:grid-cols-2 gap-5">
              <div class="panel p-6"><div class="flex gap-3 items-start"><div class="p-3 bg-indigo-500/15 rounded-xl text-indigo-300"><UploadCloud :size="22"/></div><div><h3 class="font-semibold">Upload video</h3><p class="text-xs muted mt-1">MP4, MKV, MOV, TS, MPEG, AVI and WebM. Files are analyzed by FFprobe.</p></div></div><label class="mt-5 border border-dashed border-[#455176] rounded-xl p-6 flex flex-col items-center gap-2 text-center cursor-pointer hover:bg-white/5 transition-colors"><UploadCloud :size="22" class="text-indigo-300"/><span class="text-sm font-semibold">{{uploading?`Uploading ${uploadPercent}%`:'Choose a video file'}}</span><span class="text-xs muted">Maximum size configured on the server</span><input class="hidden" type="file" accept="video/*,.ts,.mkv,.mpeg,.mpg" :disabled="uploading" @change="onFileSelected"/></label><div v-if="uploading" class="mt-4 h-2 bg-slate-800 rounded-full overflow-hidden"><div class="bg-indigo-400 h-full transition-all" :style="{width:`${uploadPercent}%`}"/></div></div>
              <div class="panel p-6"><div class="flex gap-3 items-start"><div class="p-3 bg-indigo-500/15 rounded-xl text-indigo-300"><HardDrive :size="22"/></div><div><h3 class="font-semibold">Import from server</h3><p class="text-xs muted mt-1">Register a file already placed in the configured import folder, without copying it.</p></div></div><div class="mt-5 flex gap-2"><select v-model="importName" class="field flex-1"><option value="">Select video from import directory</option><option v-for="name in candidates" :key="name" :value="name">{{name}}</option></select><button class="btn" @click="refreshCandidates"><RefreshCcw :size="15"/></button></div><button class="btn btn-primary mt-3" :disabled="!importName" @click="importVideo"><Plus :size="15"/> Register file</button></div>
            </div>
            <div class="panel overflow-hidden"><div class="px-6 py-5 flex justify-between border-b rule"><h3 class="font-semibold">Library <span class="muted font-normal">({{media.length}} files)</span></h3><span class="text-xs muted">{{fmtBytes(media.reduce((a,b)=>a+b.bytes,0))}} total</span></div><div v-if="!media.length" class="p-12 text-center muted text-sm">No video files yet. Upload a file or import one from your Ubuntu server.</div><div v-else class="divide-y divide-[#252d44]"><div v-for="item in media" :key="item.id" class="flex flex-wrap sm:flex-nowrap items-center gap-4 px-5 py-4"><div class="bg-[#202943] rounded-xl p-4 shrink-0"><Film :size="22" class="text-indigo-300"/></div><div class="flex-1 min-w-0"><h4 class="font-medium text-sm truncate">{{item.name}}</h4><p class="text-xs muted mt-1">{{fmtDuration(item.duration)}} <span class="px-1">·</span> {{item.width||'?'}}×{{item.height||'?'}} <span class="px-1">·</span> {{item.videoCodec||'?'}} / {{item.audioCodec||'no audio'}} <span class="px-1">·</span> {{fmtBytes(item.bytes)}}</p><p class="text-[11px] text-indigo-300 mt-1 uppercase">{{item.origin==='import'?'Registered file':'Uploaded file'}}</p></div><div class="flex gap-2"><button class="btn btn-icon" title="Preview source" @click="previewMedia=item"><Play :size="15"/></button><button class="btn btn-icon" title="Remove file" @click="removeMedia(item)"><Trash2 :size="15"/></button></div></div></div></div>
          </template>
          <template v-else-if="activeTab==='system'">
            <div><h2 class="text-2xl font-semibold tracking-tight">System & network</h2><p class="text-sm muted mt-1">Read-only runtime configuration. Edit config/streamer.json and restart the service to change NIC assignments.</p></div>
            <div v-if="system" class="grid grid-cols-1 xl:grid-cols-2 gap-5">
              <div class="panel p-6"><div class="flex items-center gap-3 mb-5"><MonitorCog class="text-indigo-300" :size="20"/><h3 class="font-semibold">Management network</h3></div><dl class="space-y-4 text-sm"><div class="flex justify-between gap-4"><dt class="muted">Interface</dt><dd class="font-mono">{{system.management.interface}}</dd></div><div class="flex justify-between gap-4"><dt class="muted">Bind address</dt><dd class="font-mono">{{system.management.address}}</dd></div><div class="flex justify-between gap-4"><dt class="muted">HTTP port</dt><dd>{{system.management.port}}</dd></div></dl><p class="text-xs muted mt-5">This interface serves the management dashboard and API.</p></div>
              <div class="panel p-6"><div class="flex items-center gap-3 mb-5"><Network class="text-indigo-300" :size="20"/><h3 class="font-semibold">IPTV distribution network</h3></div><dl class="space-y-4 text-sm"><div class="flex justify-between gap-4"><dt class="muted">Interface</dt><dd class="font-mono">{{system.streaming.interface}}</dd></div><div class="flex justify-between gap-4"><dt class="muted">Source IP</dt><dd class="font-mono">{{system.streaming.address}}</dd></div><div class="flex justify-between gap-4"><dt class="muted">Allowed multicast range</dt><dd class="font-mono">{{system.streaming.range}}</dd></div><div class="flex justify-between gap-4"><dt class="muted">Route enforcement</dt><dd :class="system.streaming.verifyEgressRoute?'text-emerald-300':'text-amber-300'">{{system.streaming.verifyEgressRoute?'Enabled':'Disabled'}}</dd></div></dl></div>
              <div class="panel p-6"><div class="flex items-center gap-3 mb-5"><Cpu :size="20" class="text-indigo-300"/><h3 class="font-semibold">Ubuntu host</h3></div><dl class="space-y-4 text-sm"><div class="flex justify-between"><dt class="muted">Logical CPU cores</dt><dd>{{system.host.cpuCount}}</dd></div><div class="flex justify-between"><dt class="muted">System memory</dt><dd>{{fmtBytes(system.host.memoryTotal)}}</dd></div><div><div class="flex justify-between mb-2"><dt class="muted">Memory used</dt><dd>{{memoryUsed}}%</dd></div><div class="h-2 bg-slate-800 rounded-full"><div class="bg-indigo-400 h-full rounded-full" :style="{width:`${memoryUsed}%`}"/></div></div><div class="flex justify-between"><dt class="muted">Load average (1 min)</dt><dd>{{system.host.loadAverage[0]?.toFixed(2)||'0.00'}}</dd></div></dl></div>
              <div class="panel p-6"><div class="flex items-center gap-3 mb-5"><Wifi class="text-indigo-300" :size="20"/><h3 class="font-semibold">Detected IPv4 interfaces</h3></div><div class="space-y-2"><div v-for="entry in system.interfaces" :key="`${entry.name}:${entry.address}`" class="rounded-lg bg-[#0a1020] p-3 flex justify-between gap-3 text-xs"><span class="font-mono text-indigo-200">{{entry.name}}</span><span class="font-mono muted">{{entry.address}}</span></div></div></div>
            </div>
            <div class="panel p-6"><div class="flex items-center justify-between gap-3 flex-wrap"><div><h3 class="font-semibold">Multicast egress verification</h3><p class="text-xs muted mt-1">Validate that each configured group routes through the selected IPTV NIC, before broadcasting.</p></div><button class="btn btn-primary" :disabled="routeLoading" @click="checkRoutes"><Activity :size="16"/>{{routeLoading?'Checking…':'Check routes'}}</button></div><div v-if="Object.keys(routeChecks).length" class="mt-5 space-y-3"><div v-for="ch in channels" :key="ch.id" class="flex gap-3 items-start text-sm p-3 rounded-lg bg-[#0a1020]"><component :is="routeChecks[ch.id]?.ok?Check:CircleAlert" :size="17" :class="routeChecks[ch.id]?.ok?'text-emerald-300':'text-rose-300'"/><div><p class="font-semibold">{{ch.name}} <span class="muted font-normal text-xs">{{ch.groupIp}}</span></p><p class="text-xs muted mt-1">{{routeChecks[ch.id]?.message||'Not checked'}}</p></div></div></div></div>
            <div class="flex items-start gap-3 bg-amber-400/5 border border-amber-400/20 p-4 rounded-xl text-sm"><Info :size="19" class="text-amber-300 shrink-0"/><p class="muted">Gateway and DNS settings are owned by Ubuntu Netplan—not the application. For your dual-NIC deployment, keep the default route on the office NIC and add a specific route for your multicast group range through the IPTV NIC. Do not configure two competing default gateways.</p></div>
          </template>
        </main>
        <footer class="max-w-[1500px] mx-auto px-5 sm:px-9 pb-8 text-[11px] text-slate-600 flex items-center justify-between"><p>Multicast Studio · Self-hosted IPTV playout</p><p>FFmpeg + Hono + Vue 3</p></footer>
      </div>
    </template>
    <div v-if="toast" class="fixed bottom-6 right-6 left-6 sm:left-auto z-50 max-w-[540px] rounded-xl border shadow-2xl px-5 py-4 flex gap-3 items-start bg-[#1b253c]" :class="toast.kind==='error'?'border-rose-500/50':'border-indigo-400/40'"><component :is="toast.kind==='error'?CircleAlert:Check" :size="18" :class="toast.kind==='error'?'text-rose-300':'text-emerald-300'"/><p class="text-sm flex-1 whitespace-pre-line break-words">{{toast.message}}</p><button @click="toast=null"><X :size="16"/></button></div>
    <div v-if="modalOpen" class="modal-shade" @click.self="modalOpen=false"><div class="modal-card"><div class="sticky top-0 bg-[#121a2e] border-b border-[#303b56] z-10 px-6 py-5 flex items-center justify-between"><div><h3 class="font-semibold text-lg">{{editingId?'Edit channel':'Create multicast channel'}}</h3><p class="text-xs muted mt-1">Choose a source, output profile, and multicast destination.</p></div><button class="btn btn-icon" @click="modalOpen=false"><X :size="17"/></button></div><form @submit.prevent="saveChannel" class="p-6 space-y-6">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4"><div><label class="field-label">Channel name</label><input v-model="currentForm.name" class="field" placeholder="Resort information" maxlength="100" required/></div><div><label class="field-label">Source type</label><select v-model="currentForm.sourceType" class="field" @change="switchSourceType"><option value="media">Local video (loop)</option><option value="live">Live internet stream</option></select></div>
        <div v-if="currentForm.sourceType==='media'"><label class="field-label">Source video</label><select v-model="currentForm.mediaId" class="field" required><option :value="null" disabled>Select a video</option><option v-for="item in media" :key="item.id" :value="item.id">{{item.name}}</option></select></div>
        <div v-else class="sm:col-span-2 space-y-2"><label class="field-label">Live input</label>
          <p v-if="currentForm.providerId" class="text-xs text-indigo-300">Selected provider channel. The server will resolve a fresh URL whenever the broadcast restarts.</p>
          <input v-else v-model="currentForm.streamUrl" type="url" class="field" placeholder="https://example.org/live/index.m3u8" required/>
          <button v-if="currentForm.providerId" type="button" class="btn" @click="currentForm.providerId=null;currentForm.providerChannelKey=null">Switch to direct URL</button>
          <p class="text-xs muted">Internet input uses the office NIC. Multicast output remains on the IPTV NIC.</p>
        </div><div class="sm:col-span-2"><label class="field-label">Description (optional)</label><input v-model="currentForm.description" class="field" maxlength="300" placeholder="Continuous resort information channel"/></div></div>
      <div><p class="text-sm font-semibold mb-3 flex gap-2 items-center"><Network :size="16" class="text-indigo-300"/> Multicast destination</p><div class="grid grid-cols-2 sm:grid-cols-4 gap-3"><div class="col-span-2"><label class="field-label">Group IP</label><input v-model="currentForm.groupIp" class="field font-mono" required/></div><div><label class="field-label">UDP port</label><input v-model.number="currentForm.port" class="field" type="number" min="1024" max="65535" required/></div><div><label class="field-label">TTL</label><input v-model.number="currentForm.ttl" class="field" type="number" min="1" max="255" required/></div></div><p class="text-xs muted mt-2">Allowed range: {{system?.streaming.range||'Configured on server'}}. Interface: {{system?.streaming.interface||'—'}}</p></div>
      <div><p class="text-sm font-semibold mb-3 flex gap-2 items-center"><Clapperboard :size="16" class="text-indigo-300"/> Encoding</p><div class="grid grid-cols-1 sm:grid-cols-2 gap-4"><div class="sm:col-span-2"><label class="field-label">Encoding profile</label><select v-model="currentForm.profile" class="field"><option v-for="(label,key) in profileNames" :key="key" :value="key">{{label}}</option></select><p v-if="currentForm.profile==='copy'" class="text-xs text-amber-300 mt-2">Direct copy requires the original codecs to be supported by the MPEG-TS muxer and every receiver.</p></div><template v-if="currentForm.profile!=='copy'"><div><label class="field-label">Resolution</label><select class="field" :value="`${currentForm.width}x${currentForm.height}`" @change="onResolutionChange"><option value="720x576">720 × 576 (SD PAL)</option><option value="1280x720">1280 × 720 (HD)</option><option value="1920x1080">1920 × 1080 (FHD)</option></select></div><div><label class="field-label">Frame rate</label><select v-model.number="currentForm.fps" class="field"><option :value="25">25 fps</option><option :value="30">30 fps</option><option :value="50">50 fps</option><option :value="60">60 fps</option></select></div><div><label class="field-label">Video bitrate (kbps)</label><input v-model.number="currentForm.videoBitrateKbps" class="field" type="number" min="250" max="40000" required/></div><div><label class="field-label">Audio bitrate (kbps)</label><input v-model.number="currentForm.audioBitrateKbps" class="field" type="number" min="32" max="512" required/></div></template><div><label class="field-label">MPEG-TS Service ID</label><input v-model.number="currentForm.serviceId" class="field" type="number" min="1" max="65535" required/></div></div></div>
      <div class="flex flex-wrap gap-6"><label class="inline-flex items-center gap-2 text-sm cursor-pointer"><input v-model="currentForm.autoStart" type="checkbox" class="accent-indigo-500 w-4 h-4"/> Auto-start on boot</label><label class="inline-flex items-center gap-2 text-sm cursor-pointer"><input v-model="currentForm.autoRecover" type="checkbox" class="accent-indigo-500 w-4 h-4"/> Auto-recover crashes</label></div>
      <div class="flex justify-end gap-3 border-t rule pt-5"><button class="btn" type="button" @click="modalOpen=false">Cancel</button><button class="btn btn-primary" :disabled="saving"><Check :size="16"/>{{saving?'Saving…':editingId?'Save changes':'Create channel'}}</button></div>
    </form></div></div>
    <div v-if="previewMedia" class="modal-shade" @click.self="previewMedia=null"><div class="modal-card"><div class="p-5 flex justify-between items-center"><h3 class="font-semibold truncate">{{previewMedia.name}}</h3><button class="btn btn-icon" @click="previewMedia=null"><X :size="17"/></button></div><video :key="previewMedia.id" class="bg-black w-full max-h-[60vh]" :src="`/api/media/${previewMedia.id}/preview`" controls preload="metadata"/><p class="p-5 text-xs muted">Source-file preview only. Your browser may not decode some legacy codecs; VLC or your IPTV receiver can still support them.</p></div></div>
  </div>
</template>
