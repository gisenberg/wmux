# Screen Streaming

wmux has one view-only pixel-streaming path and one separate Moonlight-native path.

## Transport decision

View-only browser streaming keeps MediaMTX as the transport.
The native wmux agent supervises `wmux-stream-agent`, which polls the existing lease endpoint and starts FFmpeg only while at least one browser holds a lease.
The worker publishes RTSP to the private MediaMTX service, and MediaMTX provides WebRTC playback to the browser.
This keeps capture credentials and platform APIs on the captured machine, reuses the established bounded lease protocol, and avoids adding a second WebRTC implementation to the native agent.

The Moonlight gateway remains available only for the Moonlight/Sunshine interactive use case.
It is not a second implementation of the view-only capture path.

## Server setup

Install MediaMTX once on the wmux server:

```bash
scripts/install-stream-service.sh
```

Keep RTSP and WebRTC bound to the exact Tailscale or private interface.
Keep the MediaMTX API on loopback.

## Shared machine configuration

The captured machine needs owner-only `~/.wmux/stream-agent.json`.
Static-machine bootstraps create defaults automatically, while dynamically registered hosts need a separately provisioned helper credential before their lease polling can authenticate.

```json
{
  "machine": "linux-box",
  "wmuxUrl": "http://100.64.0.10:3478",
  "rtspUrl": "rtsp://100.64.0.10:8554/wmux-linux-box",
  "onDemand": true,
  "pollInterval": 2,
  "backend": "auto",
  "framerate": 15,
  "maxWidth": 1920,
  "bitrate": "3500k"
}
```

Store the helper credential in owner-only `~/.wmux/helper-token`.
Do not put it in the JSON document.

## Linux

Install FFmpeg, configure the native POSIX session agent, and run the single agent installer:

```bash
scripts/install-session-agent-service.sh
systemctl --user status wmux-session-agent.service
```

Set `display` or an explicit FFmpeg input in `stream-agent.json` when the systemd user manager does not inherit the graphical session's `DISPLAY`.
Wayland capture remains unsupported unless an explicit compatible input is configured.

## macOS

Install FFmpeg, configure the native POSIX session agent, and run:

```bash
scripts/install-session-agent-service.sh
launchctl print "gui/$(id -u)/io.wmux.session-agent"
```

The installer prepares `~/.wmux/WmuxStreamAgent.app` as the capture identity and removes the legacy standalone stream LaunchAgent.
Grant that app Screen Recording permission in System Settings.
The native agent launches and supervises the app only as a worker, so there is still one owning service.

## Windows

Install FFmpeg and Python, ensure the helper bootstrap has created `~\.wmux\stream-agent.json`, and run:

```powershell
wmux-windows-setup install-agent
wmux-windows-setup agent-status
```

The installer removes the legacy `wmux-stream-agent` Scheduled Task.
The base `wmux-windows-agent` task owns capture supervision, while adjacent rollout generations have `streamOwner: false` so only one process polls leases or publishes pixels.
Use the `Interactive` task logon type for capture.
S4U and Password task modes run without an interactive desktop. Password mode
adds the user's network credentials, not a desktop session; S4U, Password,
locked, and logged-out desktop capture remains platform-dependent and is not
claimed as supported.

`wmux-windows-setup install-stream` remains a compatibility alias for `install-agent`.

## Reconnect supervision

The native agent reports capture supervision in its `/health` response.
If the worker exits, the agent restarts it with bounded exponential backoff.
The worker independently backs off while the wmux lease endpoint is unreachable and resumes polling when wmux returns.
Closing the final viewer lease stops FFmpeg without stopping the worker or native agent.

## Moonlight-native streaming

Use [MOONLIGHT_GATEWAY.md](MOONLIGHT_GATEWAY.md) only when interactive Moonlight/Sunshine input and application streaming are required.
The gateway does not supervise the MediaMTX capture worker.
