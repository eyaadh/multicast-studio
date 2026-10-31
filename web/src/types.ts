export type Profile = 'h264'|'mpeg4'|'mpeg2'|'copy'
export type Status = 'stopped'|'starting'|'streaming'|'stopping'|'recovering'|'error'
export type Media = {id:string;name:string;origin:'upload'|'import';bytes:number;duration:number|null;
 videoCodec:string|null;audioCodec:string|null;width:number|null;height:number|null;createdAt:string}
export type ChannelForm = {name:string;description:string;mediaId:string;groupIp:string;port:number;profile:Profile;
 videoBitrateKbps:number;audioBitrateKbps:number;width:number;height:number;fps:number;ttl:number;
 autoStart:boolean;autoRecover:boolean;serviceId:number}
export type Channel = ChannelForm & {id:string;media:Media|null;status:Status;pid:number|null;
 startedAt:string|null;progress:{frame?:number;fps?:number;bitrate?:string;speed?:string;outTime?:string;updatedAt?:string};
 restarts:number;lastError:string|null;createdAt:string;updatedAt:string}
export type SystemInfo = {
 management:{interface:string;address:string;port:number};streaming:{interface:string;address:string;range:string;ttl:number;verifyEgressRoute:boolean};
 interfaces:Array<{name:string;address:string;internal:boolean}>;channels:number;streamingCount:number;
 host:{uptimeSeconds:number;memoryTotal:number;memoryFree:number;loadAverage:number[];cpuCount:number}
}
export type RouteCheck = {ok:boolean;dev:string|null;source:string;message:string}
