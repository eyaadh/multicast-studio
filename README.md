# Multicast Studio

A lightweight, self-hosted **IPTV multicast playout / headend** for Ubuntu Server 24.04. Run 1–5 independent 24/7 video channels from a Vue 3 dashboard, using FFmpeg as the actual broadcast engine.

- **Backend:** Node.js 22+ / TypeScript / Hono / SQLite / FFmpeg
- **Frontend:** Vue 3 / `<script setup lang="ts">` / Tailwind CSS 4 / Vite
- **Output:** MPEG-TS over UDP multicast (one continuous transport stream per channel)
- **Profiles:** MPEG-2 Video + MP2, MPEG-4 Part 2 + MP2, H.264 + AAC, or remux/copy
- **Reliability:** supervised FFmpeg subprocesses, progress watchdog, restart with exponential backoff, automatic boot startup via systemd
- **Management:** local administrator login, upload and import media, channel CRUD, status, source preview, M3U playlist, NIC and route diagnostics

> **Note on legacy receivers:** “MPEG-4” may mean MPEG-4 Part 2, H.264 / MPEG-4 Part 10, or even an MPEG-2-only legacy device. Verify your specific STB's supported video/audio codecs, profile levels, TS packet/service settings, and maximum bitrate. This project does **not** implement multicast routing, IPTV middleware, video-on-demand, or perfectly gapless looping.

## 1. Ubuntu prerequisites

Install Node.js **22 or newer** (the OS repository's version might be older), FFmpeg, `iproute2`, and build tools for the SQLite native module:

```bash
sudo apt update
sudo apt install -y ffmpeg iproute2 build-essential python3
node --version  # require >= 22.12
ffmpeg -version
ffprobe -version
ip -br -4 addr
```

Place the project somewhere stable, e.g. `/opt/multicast-studio`.

```bash
cd /opt/multicast-studio
cp .env.example .env
cp config/streamer.example.json config/streamer.json
```

Edit `.env` and set `ADMIN_USER`, a unique `ADMIN_PASSWORD` (12+ characters), and `SESSION_SECRET` (32+ random characters):

```bash
openssl rand -hex 32
nano .env
chmod 600 .env
```

Edit `config/streamer.json` and set the **actual NIC names**, as reported by `ip -br -4 addr`:

```json
{
  "management": {"interface":"ens18", "port":3000},
  "streaming": {"interface":"ens19", "multicastCIDR":"239.80.0.0/16", "defaultTTL":1,
    "packetSize":1316, "verifyEgressRoute":true},
  "storage": {"dataDirectory":"./data", "importDirectory":"./imports", "maxUploadGB":8},
  "tools": {"ffmpeg":"ffmpeg", "ffprobe":"ffprobe"}
}
```

The HTTP server binds **only** to the selected management NIC IPv4 address. FFmpeg sets `localaddr` to the selected IPTV NIC IPv4 address. On Linux, source binding alone is not enough, so each channel also performs a **fail-closed egress-route check** when `verifyEgressRoute=true`.

**Do not disable route verification to bypass an incorrectly configured multicast route.**

## 2. Configure your two networks

Your environment uses these subnets:

| Purpose | VLAN subnet | Gateway | DNS | Example server IP | Example NIC |
|---|---|---|---|---|---|
| Office/management | `10.50.0.0/24` | `10.50.0.2` | `10.50.0.3` | `10.50.0.50` | `ens18` |
| IPTV/VOD | `192.168.80.0/24` | `192.168.80.2` | optional | `192.168.80.50` | `ens19` |

**Example IPs and interface names are placeholders, not known assigned addresses.**

Recommended routing for a directly connected IPTV VLAN:

- **Default route** through office NIC / `10.50.0.2`.
- VOD NIC has `192.168.80.x/24`, **without a second default route**.
- A **specific multicast route** for `239.80.0.0/16` through the VOD NIC, with link scope.
- Gateway `192.168.80.2` remains the VOD router address; it does not need to be configured as a default route on this VM. If the network must route multicast across VLANs, your network team must configure the router/IGMP/PIM and the TTL to suit that topology. Merely adding a unicast gateway does not make multicast routing work.

`deploy/00-multicast-studio.example.yaml` provides a **reference Netplan example**, but do not apply it blindly. Safest procedure: use the VM hypervisor console, edit existing Netplan carefully, then test with `sudo netplan try` before applying permanently. Applying a wrong Netplan remotely can lock you out.

Once routing is configured, verify:

```bash
ip -br -4 addr
ip -4 route
ip -j route get 239.80.0.1 from 192.168.80.50
```

The `ip route get` output should show your **IPTV NIC**, not the office NIC. If it does not, the app will refuse to start the channel.

Make sure your VM uses the correct VLAN-backed bridge/vNIC and that switches have suitable IGMP snooping and an IGMP querier. Use PIM or an appropriate multicast router for receivers in other VLANs. Set TTL greater than 1 **only** when needed for routed multicast.

## 3. Install and run

```bash
npm install
npm run build
npm start
```

Open `http://<your-office-interface-ip>:3000` from the office VLAN and sign in with your `.env` credentials.

> In production, HTTPS is recommended to protect the admin password and session cookie. Use a trusted reverse proxy if exposing beyond a controlled management segment; keep access restricted to your management VLAN. With HTTPS, set `COOKIE_SECURE=true` and restart the service. This is designed for a trusted, private network—not direct public Internet exposure.

### Development on Ubuntu

```bash
# For localhost development, use loopback NIC; no real IPTV route is configured by default.
cp config/development.json config/streamer.json
npm run dev
```

`npm run dev` starts Vite on `http://127.0.0.1:5173` with an API proxy to `http://127.0.0.1:3000`. The production build runs the Hono API and serves Vue from one process on port 3000. For real multicast testing, configure the correct NIC and route first.

## 4. Set up systemd (recommended)

```bash
sudo useradd --system --home /opt/multicast-studio --shell /usr/sbin/nologin multicast
sudo chown -R multicast:multicast /opt/multicast-studio
sudo chmod 600 /opt/multicast-studio/.env
sudo cp deploy/multicast-studio.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now multicast-studio
sudo systemctl status multicast-studio
sudo journalctl -u multicast-studio -f
```

The service file assumes the Node executable is `/usr/bin/node` and the project is in `/opt/multicast-studio`. Change it if your paths differ. Keep `KillMode=control-group`: systemd should reap FFmpeg subprocesses if the parent Node process fails.

## 5. Using the dashboard

1. Upload an MP4/MKV/video on **Media Library**, or copy a large source file into `imports/`, then select **Refresh** and **Register file**. Imported files are referenced in place; don't move/delete them while streaming.
2. Under **Channels**, create a channel, choose a source and a profile. For old equipment, start with **MPEG-4 Part 2 / MP2** (or MPEG-2 / MP2 if required). Specify group/port and service ID.
3. Go to **System & Network → Check routes**. The group route must resolve to the configured VOD interface.
4. Start the channel. Progress changes from **Starting** to **Streaming** once FFmpeg reports real output progress.
5. Open a receiver's channel URL, e.g. `udp://@239.80.0.1:5000` in VLC on the VOD network, or download the **M3U** playlist.
6. Check receiver compatibility, video stability, sound and looping at the actual STBs.

Channels configured with **Auto-start on boot** start when the server launches. **Auto-recover crashes** restarts unexpected FFmpeg failures with backoff, up to six consecutive attempts. Manually stopped channels stay stopped until started again, but auto-start-enabled channels will run after the next server reboot.

### Monitor from Ubuntu

```bash
sudo ss -uanp | grep ffmpeg
sudo tcpdump -ni ens19 'udp and dst host 239.80.0.1 and dst port 5000'
sudo tcpdump -ni ens18 'udp and dst host 239.80.0.1 and dst port 5000'
```

`tcpdump` may require `sudo apt install tcpdump`. The first capture should see packets; the office interface should **not**. `ip -j route get ... from ...` is checked prior to every channel start as a guardrail, but packet capture verifies the real path.

## 6. Media and codec notes

- FFmpeg reads input at approximately native speed and loops the entire source with `-stream_loop -1`.
- Transcoding applies a letterboxed output at the selected resolution/framerate. `Direct copy` preserves codecs without transcoding but depends on receiver and MPEG-TS compatibility.
- FFmpeg `-progress` is used for live status; this confirms output progress, **not actual packet reception**. Use VLC/STB and packet capture for end-to-end validation.
- MPEG-TS timestamp handling **at loop boundaries** varies by codec/container and receiver. This first release provides indefinite looping, **not a guarantee of seamless broadcast-grade transitions**; test a complete loop cycle on your oldest STB before production. A gapless playout/normalization pipeline can be a subsequent enhancement.
- Routes and encoding profiles may need adjustment to specific set-top boxes. Some equipment requires constant bitrate MPEG-TS, PCR timing, particular audio settings or SD-only video. This initial release does not implement explicit CBR transport stream padding or custom PID configuration.
- This app streams video files, not encrypted content, DRM, or RTSP/HLS/VOD.
- Source preview works for formats supported by your browser; VLC may play files your browser cannot.

## 7. Storage and security

- SQLite database: `data/streamer.sqlite` (WAL mode; back up the database and its `-wal`/`-shm` files consistently using SQLite's backup API or while the service is stopped).
- Uploaded media: `data/media/`; registered source files remain in `imports/`.
- Importing is restricted to files inside the configured directory (symlink escapes rejected). Media deletion cannot remove media referenced by channels.
- Admin sessions are HMAC-signed, HTTP-only SameSite cookies expiring after 12 hours. Bad login attempts are rate limited in process memory.
- API writes check request origin, file uploads have a size cap, and paths are never accepted directly by the upload endpoint.
- Back up `.env` and `config/streamer.json` securely as they contain credentials and deployment settings.
- The app does not modify Ubuntu network settings, routes, DNS or gateways; you own them through Netplan and the hypervisor.

## 8. API summary

All endpoints except health and login/session require the authenticated session cookie.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/healthz` | Basic service check |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/channels` | Channels and runtime status |
| POST | `/api/channels` | Create channel |
| PATCH | `/api/channels/:id` | Edit stopped channel |
| DELETE | `/api/channels/:id` | Delete stopped channel |
| POST | `/api/channels/:id/start` | Start channel |
| POST | `/api/channels/:id/stop` | Stop channel |
| POST | `/api/channels/:id/restart` | Restart channel |
| GET | `/api/channels/playlist.m3u` | Download VLC/IPTV playlist |
| GET | `/api/media` | List media |
| POST | `/api/media/upload` | Stream raw file with `X-Filename` header |
| GET | `/api/media/import-candidates` | List import-directory files |
| POST | `/api/media/import` | Register existing file by filename |
| GET | `/api/media/:id/preview` | Range-capable source preview |
| DELETE | `/api/media/:id` | Remove unreferenced source |
| GET | `/api/system` | Read-only config and host statistics |
| GET | `/api/network/check/:group` | Verify egress NIC |
| GET | `/api/events` | Live Server-Sent Events |

## 9. Verification

```bash
npm test
npm run typecheck
npm run build
```

### Troubleshooting

| Symptom | Check |
|---|---|
| API fails immediately | Check interface names (`ip -br -4 addr`), `.env`, JSON config, Node 22 |
| Channel error: unsafe route | `ip -j route get <group> from <VOD-ip>`; add persistent multicast route via VOD NIC |
| No picture on STB | `tcpdump` egress, IGMP snooping/querier, group/port, decoder compatibility |
| VLC receives but STB does not | Test MPEG-2 vs MPEG-4 Part 2, lower bitrate/SD, audio MP2, MPEG-TS options |
| Channel restarts repeatedly | Read card error and `journalctl -u multicast-studio`, verify source file and FFmpeg |
| Channel source fails after imported file move | Restore registered file at its original absolute path |
| Browser source preview fails | Browser may lack that video's codecs/container; try VLC |

## Scope / next milestones

Playlist playout, source normalization, truly seamless loop continuity, configurable TS CBR/PIDs, receiver-side health probes, audit logs and multi-user accounts are **not** included in this initial version.

## Live internet channels and provider catalogs (v1.1)

The **Live Providers** screen adds discoverable channels from ordinary, authorized **Extended M3U** or **JSON** catalogs. The server fetches catalog data from the management (office) network, then FFmpeg reads the chosen live HTTP(S) source and transmits MPEG-TS over the separately configured IPTV interface. The original local video loop mode is unchanged.

1. Open **Live Providers** and add the HTTP(S) URL of an authorized provider playlist.
2. Select the provider, browse or search the available channels, and select **Add**.
3. Select the legacy MPEG-4, MPEG-2, H.264, or copy output profile for your receiving hardware.
4. Start the multicast channel and test with `udp://@239.80.0.1:5000` in VLC.

Alternatively, create a channel and select **Live internet stream** to enter a direct `.m3u8` or other compatible HTTP(S) URL. An HLS manifest is a *single live input*, not a provider directory.

An M3U provider must include `#EXTM3U` and `#EXTINF` entries:

```m3u
#EXTM3U
#EXTINF:-1 tvg-id="demo-channel" group-title="Test",Test Channel
https://your-authorized-cdn.example/live/index.m3u8
```

A JSON provider must be an array of `{id, name, url, group?, icon?}` entries:

```json
[
  {"id":"demo-channel","name":"Test Channel","group":"Test","url":"https://your-authorized-cdn.example/live/index.m3u8"}
]
```

Provider-backed channel records save a **provider ID and channel key**, not a potentially expiring URL. On every start/restart/retry the application fetches the provider playlist again, re-identifies the entry, and checks that the selected upstream's route uses the office NIC. The live FFmpeg process is monitored for exit or stalled progress. With **Auto-recover** enabled, live feeds retry indefinitely with exponential backoff capped at one minute (local video channels keep their original retry policy). When upstream transmission stops there will usually be a broadcast interruption while the source is reacquired; seamless standby/failover is **not implemented** in this release.

### Network separation

- **Office / internet ingress:** configured `management.interface` (e.g. `ens18`, `10.50.0.128/24`). The catalog HTTP client explicitly binds to this interface's source address. Linux egress routing is checked for provider and live input hostnames. **FFmpeg itself uses normal Ubuntu routing for HTTP(S) inputs**, so the VM must keep its default internet route via the office NIC; if strict isolation is required, enforce it with host firewall/policy routing.
- **IPTV multicast egress:** configured `streaming.interface` (e.g. `ens19`, `192.168.80.183/24`), the FFmpeg multicast output's `localaddr` and egress route are validated as in v1.0.0.
- Existing gateways and DNS servers remain Ubuntu/Netplan responsibilities. **Do not create a second default gateway** merely to enable internet input.

The input HTTP client disallows URLs resolving to private, loopback, link-local and multicast IPv4 ranges. IPv6-only upstreams and intranet-based streaming servers are not supported by this initial implementation. Only HTTP(S) stream sources are supported; DRM, credential harvesting, encrypted provider metadata, and proprietary Kodi playback plugins are **not** integrated.

**About the referenced Cricfy Kodi add-on:** It uses remotely configured and encrypted provider metadata. This patch implements the same **provider → channel → stream** workflow for unencrypted catalogs that you supply, but it does **not** automatically fetch or decrypt Cricfy's private provider directory. It does not include or redistribute Cricfy's source code or stream listings.

### Deployment and database migration

**Back up `data/streamer.sqlite` (and its `-wal`/`-shm` files if present) with the service stopped before upgrading.** On first run, the application rebuilds the original `channels` table in a transaction, preserving media channels while permitting new live channel source references. The new `providers` table is created automatically. Previous channel destinations, service IDs, media IDs, and autostart settings remain intact.

```bash
sudo systemctl stop multicast-studio
# Take a VM snapshot or copy the data directory while stopped.
npm install
npm run build
sudo systemctl start multicast-studio
sudo journalctl -u multicast-studio -f
```

If you use a different systemd service name or run the server manually, adjust those commands accordingly. Check CPU utilization when transcoding internet streams to legacy MPEG-4; direct copy should only be used if the receiver supports the input codecs.

## Cricfy Kodi provider discovery (optional)

This integration is an **opt-in** connector using the released Kodi add-on's provider discovery protocol. It does not require installing Kodi or Python. Existing local-video loops, generic M3U/JSON providers, and your office/IPTV network isolation are unchanged.

1. Install `unzip` on Ubuntu: `sudo apt install unzip`.
2. Sign in to Multicast Studio and open **Live Providers → Cricfy Kodi — Provider discovery**.
3. Click **Connect official Kodi release**. This retrieves the newest **built** add-on ZIP from the official GitHub repository; the GitHub *source* ZIP cannot be used because generated add-on properties are absent. Alternatively, download the built Kodi ZIP from [official Releases](https://github.com/itsyourap/cricfy-kodi-plugin/releases) and import it using **Import built add-on ZIP**.
4. Click **Discover providers** to load the directory from Cricfy's configured upstream endpoints.
5. Choose the provider groups you want, select **Import selected providers**, and then browse the channels as with any other configured provider.
6. Click **Add** next to a supported channel. It becomes a normal live-source multicast channel with auto-reconnect and refreshed upstream URL resolution. Existing local video channels are unaffected.

**No list of Cricfy streams is present in the source repository**, and the connector can only discover the live directory if Cricfy's own remote services and published release configuration continue to work. Live provider channels can disappear or change. DRM-protected entries are not eligible for FFmpeg multicast output.

The connector's HTTP calls are bound to the **management/office NIC** and require public IPv4 DNS routes through that NIC; MPEG-TS multicast is still transmitted through the configured VOD/IPTV NIC. Do not configure two competing default routes. The official build may contain authentication/configuration material: keep `data/cricfy-addon-config.json` private; do not commit it to Git or expose it through your reverse proxy. See `THIRD_PARTY_NOTICES.md` for upstream license details.
