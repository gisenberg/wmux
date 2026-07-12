# wmux Moonlight Gateway

`wmux-moonlight-gateway` is a small browser-facing wrapper for a Moonlight Web/Sunshine remote-control stack. It gives wmux a stable health endpoint and iframe URL while keeping the actual Moonlight protocol implementation in an external process.

The intended host layout is:

- Sunshine runs on the machine being controlled.
- A browser-native Moonlight bridge such as Moonlight Web Stream runs near that Sunshine host.
- `wmux-moonlight-gateway` binds to loopback, Tailscale, or RFC1918/internal IP and proxies HTTP plus WebSocket traffic to the Moonlight bridge.
- wmux embeds the gateway URL from the Stream button for machines configured with `stream.provider: "moonlight-gateway"`.

This avoids copying GPL Moonlight Web Stream code into wmux. The gateway is a process and HTTP boundary; replacing the upstream bridge later should not change the wmux UI contract.

## Run

Point the gateway at an existing Moonlight Web Stream server:

```bash
WMUX_MOONLIGHT_WEB_URL=http://127.0.0.1:8080 \
  scripts/wmux-moonlight-gateway --host 100.x.y.z --port 3490
```

Or let the gateway launch a bridge executable and still proxy to its HTTP endpoint:

```bash
WMUX_MOONLIGHT_WEB_URL=http://127.0.0.1:8080 \
  scripts/wmux-moonlight-gateway \
    --host 100.x.y.z \
    --port 3490 \
    --bin /path/to/web-server
```

The gateway refuses public bind addresses. Use loopback, Tailscale `100.64.0.0/10`, or RFC1918/internal addresses.

To make Moonlight Web a browser secure context, serve both wmux and the gateway over HTTPS with certificates for the hostnames users open. An HTTPS gateway embedded in an HTTP wmux page still inherits the insecure ancestor context in browsers and can fall back to MediaSource decoding.

```bash
tailscale cert \
  --cert-file ~/.wmux/certs/wmux-host.tailnet.ts.net.crt \
  --key-file ~/.wmux/certs/wmux-host.tailnet.ts.net.key \
  wmux-host.tailnet.ts.net

WMUX_MOONLIGHT_WEB_URL=http://127.0.0.1:8080 \
WMUX_MOONLIGHT_GATEWAY_CERT_FILE=~/.wmux/certs/wmux-host.tailnet.ts.net.crt \
WMUX_MOONLIGHT_GATEWAY_KEY_FILE=~/.wmux/certs/wmux-host.tailnet.ts.net.key \
  scripts/wmux-moonlight-gateway --host 100.x.y.z --port 3490
```

Health and status endpoints:

```bash
curl https://wmux-host.tailnet.ts.net:3490/api/wmux/health
curl https://wmux-host.tailnet.ts.net:3490/api/wmux/sessions
curl https://wmux-host.tailnet.ts.net:3490/api/wmux/config
```

## Automated Pairing

The gateway can drive the Moonlight Web pair flow and submit the generated PIN to Sunshine. This uses supported APIs on both sides: Moonlight Web generates and stores the client identity, and Sunshine receives the PIN through `/api/pin`.

Configure the gateway with credentials:

```bash
export WMUX_MOONLIGHT_WEB_USER=wmux
export WMUX_MOONLIGHT_WEB_PASSWORD='...'
export WMUX_SUNSHINE_URL=https://127.0.0.1:47990
export WMUX_SUNSHINE_USER=wmux
export WMUX_SUNSHINE_PASSWORD='...'
export WMUX_MOONLIGHT_HOST=127.0.0.1
export WMUX_MOONLIGHT_HOST_HTTP_PORT=47989
export WMUX_MOONLIGHT_PAIR_DEVICE_NAME=roth
export WMUX_SUNSHINE_PIN_DELAY_MS=3500
```

Moonlight Web Stream v2.10.0 hardcodes its pair device name to `roth` in the actual pair request. The gateway submits that same name to Sunshine's PIN API by default. Override `WMUX_MOONLIGHT_PAIR_DEVICE_NAME` only when the upstream bridge changes its pair-device-name behavior.

Then call:

```bash
curl -fsS -X POST \
  -H 'content-type: application/json' \
  http://100.x.y.z:3490/api/wmux/setup/pair
```

You can also pass the same values in the request body:

```json
{
  "moonlight": {
    "user": "wmux",
    "password": "...",
    "host": "127.0.0.1",
    "httpPort": 47989,
    "pairDeviceName": "roth"
  },
  "sunshine": {
    "url": "https://127.0.0.1:47990",
    "user": "wmux",
    "password": "...",
    "pinDelayMs": 3500,
    "insecure": true
  }
}
```

For local Sunshine URLs, the gateway allows the self-signed Sunshine certificate by default. For remote HTTPS URLs, set `"insecure": true` or `WMUX_SUNSHINE_INSECURE=1` only when the URL is on the trusted internal network.

Check setup readiness:

```bash
curl http://100.x.y.z:3490/api/wmux/setup/status
```

### Browser Login

When `WMUX_MOONLIGHT_WEB_USER` and `WMUX_MOONLIGHT_WEB_PASSWORD` are set in the gateway environment, wmux opens Moonlight gateway streams through:

```text
/api/wmux/open
```

That endpoint logs into Moonlight Web server-side, resolves the configured `WMUX_MOONLIGHT_HOST`, picks the configured `WMUX_MOONLIGHT_APP_TITLE` or `Desktop`, patches Moonlight Web's browser settings, and opens Moonlight Web's `stream.html` for that host/app. The gateway also injects a server-owned Moonlight session cookie into proxied HTTP and WebSocket requests, so browsers that block iframe cookie storage can still use the UI. Keep the credentials in a mode-600 environment file or service environment; do not place raw credentials in `wmux.config.json`.

Set `WMUX_MOONLIGHT_APP_TITLE` or `WMUX_MOONLIGHT_APP_ID` on the gateway service to default to something other than `Desktop`.
Set `WMUX_MOONLIGHT_DATA_TRANSPORT` to `auto`, `webrtc`, or `websocket`; the default is `auto`.
The launch settings patch also accepts `WMUX_MOONLIGHT_BITRATE_KBPS`, `WMUX_MOONLIGHT_FPS`, `WMUX_MOONLIGHT_VIDEO_SIZE`, `WMUX_MOONLIGHT_VIDEO_WIDTH`, `WMUX_MOONLIGHT_VIDEO_HEIGHT`, `WMUX_MOONLIGHT_VIDEO_CODEC`, `WMUX_MOONLIGHT_VIDEO_FRAME_QUEUE_SIZE`, `WMUX_MOONLIGHT_AUDIO_SAMPLE_QUEUE_SIZE`, `WMUX_MOONLIGHT_CANVAS_RENDERER`, `WMUX_MOONLIGHT_CANVAS_VSYNC`, `WMUX_MOONLIGHT_FORCE_VIDEO_ELEMENT_RENDERER`, `WMUX_MOONLIGHT_PLAY_AUDIO_LOCAL`, or a JSON object in `WMUX_MOONLIGHT_SETTINGS_JSON`.
Set both `WMUX_MOONLIGHT_HOST_ID` and `WMUX_MOONLIGHT_APP_ID` when the gateway owns one fixed host/app. That lets `/api/wmux/open` skip live host/app discovery and immediately launch the known stream target.

If the gateway is served over plain HTTP on a Tailscale/internal IP, Chromium does not expose WebCodecs to the Moonlight Web iframe. In that mode, leave `WMUX_MOONLIGHT_CANVAS_RENDERER=0` so Moonlight Web can at least use its MediaSource fallback, and keep bitrate/FPS conservative to reduce browser `QuotaExceededError` pressure. The preferred path is HTTPS with H.264 plus the canvas renderer, because the secure context enables WebCodecs and avoids the MediaSource append-buffer path.

If a secure WebSocket stream logs repeated `DataError` failures from `AudioDecoder.decode`, set `WMUX_MOONLIGHT_DISABLE_AUDIO_DECODER=1` on the gateway. The gateway will inject a small compatibility shim into proxied `stream.html` so Moonlight Web skips the native WebCodecs audio decoder and uses its bundled Opus decoder fallback instead.

### Spinner Troubleshooting

If `/api/wmux/open` loads but the stream page stays on its spinner, first check whether Moonlight Web can query the paired Sunshine host:

```bash
curl http://100.x.y.z:3490/api/host?host_id=1446783110
curl http://100.x.y.z:3490/api/apps?host_id=1446783110
```

The gateway health endpoint also runs a bounded version of this target check and reports it under `target`. wmux treats `target.ok: false` as an offline Moonlight stream so the stream modal shows the host/app failure instead of embedding a spinner. The default target health timeout is 5 seconds; set `WMUX_MOONLIGHT_TARGET_HEALTH_TIMEOUT_MS` on the gateway service if Sunshine is reachable but slow during session startup.

If those hang, check Sunshine's GameStream HTTPS port from the wmux server:

```bash
curl -vk 'https://SUNSHINE_HOST:47984/serverinfo?uniqueid=0123456789abcdef&uuid=0123456789abcdef'
```

An unpaired curl client should complete TLS and then fail with a client-certificate-required alert. If the TCP connection opens but TLS never gets a ServerHello, Sunshine is wedged; restart the host-side Sunshine service, for example `wmux-sunshine-setup start-sunshine` on macOS.

On macOS, `wmux-sunshine-setup sunshine-status` reports `permissions.screenRecording`. If it is `missing` or `denied`, grant Screen Recording to the reported `Sunshine.app`, unlock the GUI session, and restart Sunshine.

### Linux Host Setup

For a headless Linux wmux host, Sunshine still needs a graphical session to capture. The validated path on Ubuntu 24.04 is:

- Install the official LizardByte Ubuntu 24.04 amd64 Sunshine `.deb`. Prefer the latest release if pairing reaches the PIN API but Moonlight times out afterward.
- Run a real Xorg display, preferably on the GPU Sunshine will capture, plus XFCE. Run Sunshine in the same user service environment with `DISPLAY=:99`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, and `PULSE_SERVER` set. A validated headless setup can use a root-owned Xorg server on `:99` with an NVIDIA config under `~/.wmux`, then start the XFCE and Sunshine user services against that display.
- Avoid using `Xvfb` as the long-term Sunshine desktop for interactive Moonlight streams. Sunshine's Linux input path creates `/dev/uinput` devices; a real Xorg server can pick those up through libinput, but Xvfb does not. Xvfb can also leave Sunshine auto-selecting KMS capture from a different framebuffer, which shows up as a black stream with repeated `GL ... graphics.cpp:664` errors.
- Grant the Sunshine user durable membership in `video`, `render`, and `input`. For the current login session, ACLs may still be needed on `/dev/dri/card*`, `/dev/dri/renderD*`, `/dev/uinput`, and `/dev/uhid`; restart Sunshine after applying them so virtual keyboard/mouse initialize.
- Point `WMUX_MOONLIGHT_HOST` at the host's Tailscale or internal IP, not `127.0.0.1`, so Moonlight Web pairs and later streams against the same network identity.
- If Sunshine accepts the PIN only after the GameStream pair request is pending, set `WMUX_SUNSHINE_PIN_DELAY_MS=8000`. After pairing, set `WMUX_MOONLIGHT_HOST_ID` and `WMUX_MOONLIGHT_APP_ID` in the gateway environment.

### macOS Host Setup

Inside a wmux SSH pane on a macOS host:

```bash
wmux-sunshine-setup install-sunshine
export WMUX_SUNSHINE_USER=wmux
export WMUX_SUNSHINE_PASSWORD='...'
wmux-sunshine-setup configure-sunshine
wmux-sunshine-setup start-sunshine
wmux-sunshine-setup sunshine-status
```

The default installer downloads the official macOS DMG and installs `Sunshine.app` into `~/Applications`. Set `WMUX_SUNSHINE_INSTALL_METHOD=brew` to use the official LizardByte Homebrew tap. macOS may still require user approval for Screen Recording, Accessibility/Input Monitoring, and Local Network permissions before Sunshine can capture and accept input.

### Windows Host Setup

Inside a wmux Windows pane:

```powershell
wmux-windows-setup install-sunshine
$env:WMUX_SUNSHINE_USER = 'wmux'
$env:WMUX_SUNSHINE_PASSWORD = '...'
wmux-windows-setup configure-sunshine
wmux-windows-setup start-sunshine
wmux-windows-setup sunshine-status
```

`install-sunshine` uses `winget` to install `LizardByte.Sunshine` when missing. `configure-sunshine` runs Sunshine's `--creds` command with the credentials supplied through environment variables, avoiding secrets in shell history. `start-sunshine` starts Sunshine for the current logged-in user.
If Sunshine was already running before `configure-sunshine`, restart the Sunshine process before pairing; otherwise the web API can continue serving the first-run welcome flow and reject PIN submissions.

## Configure A Machine

Set a machine stream provider in `wmux.config.json` or `~/.wmux/config.json`:

```json
{
  "machines": [
    {
      "id": "windows-box",
      "name": "Windows Box",
      "kind": "powershell-ssh",
      "host": "windows-box",
      "user": "operator",
      "stream": {
        "provider": "moonlight-gateway",
        "gatewayUrl": "http://100.x.y.z:3490"
      }
    }
  ]
}
```

`gatewayOpenUrl` can override the exact URL wmux opens or embeds if the gateway needs a subpath.

## Big Rocks From Moonlight Web Stream

- The project is GPL-3.0-or-later, so wmux should not vendor or copy its implementation unless the project intentionally accepts that license impact.
- Pairing is real state. The browser bridge needs a durable Moonlight identity and certificate material paired with Sunshine before launching streams.
- WebRTC needs network planning. LAN and Tailnet use is simpler, but restrictive networks may need fixed UDP ranges, STUN/TURN, or a WebSocket fallback.
- Browser APIs change the UX. Gamepad, Keyboard Lock, WebCodecs, clipboard, fullscreen, and audio autoplay behave better in secure contexts.
- Input is a major part of the bridge, not just video. Pointer lock, absolute/relative mouse, touch, keyboard translation, paste, and gamepad channels all need browser handling.
- Codec fallback matters. H.264 is the safest baseline; HEVC/AV1 and WebCodecs support vary by browser and platform.
- Session lifecycle needs policy. Sunshine generally expects one active stream per host/app, while wmux can have multiple browser viewers.

## Current Limits

The gateway does not implement the native Moonlight/GameStream protocol itself. It proxies a browser-native Moonlight bridge, reports health to wmux, and provides a stable URL for the stream modal. It can now automate pairing when given Moonlight Web and Sunshine credentials, but app launch, stream settings, and broader Sunshine lifecycle control are still delegated to the upstream bridge UI.
