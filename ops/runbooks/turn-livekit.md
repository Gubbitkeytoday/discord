# Runbook: voice/video problems (TURN, LiveKit)

**Alerts:** `AntigravitySocketsDropped`; mostly user reports: "stuck on
Connecting…", "Can't connect", one-way audio, audio drops every few minutes.

Voice runs peer-to-peer (full mesh, `VOICE_MESH_LIMIT`) with a TURN relay
(coturn, compose profile `turn`) for users behind strict NAT. If an SFU
(LiveKit) backend is enabled in your deployment, media goes through it instead
and TURN is used only to reach LiveKit. Signalling (offers/answers/ICE) always
goes over the app's Socket.IO connection.

## Triage: who is affected?

| Symptom | Likely layer |
| --- | --- |
| Everyone, including text chat is "reconnecting" | Socket.IO / proxy — not voice. Check `/api/live`, Caddy logs, sockets panel. |
| Only some users, always the same networks (mobile, office, hotel) | TURN missing or unreachable |
| Everyone's calls fail after a deploy/cert renewal | TURN credentials/secret, TLS on 5349, or LiveKit keys |
| Works 1:1, fails with many people | room size / upstream bandwidth (mesh) |
| Audio cuts out after ~10 min | NAT/firewall UDP timeouts; TURN over TCP/TLS helps |

## TURN (coturn)

1. **Is it running?** `docker compose --profile turn ps coturn`,
   `docker compose logs --tail 50 coturn`. `TURN_SECRET is not set` → set it in `.env`.
2. **Does the app hand out TURN?** As a logged-in user:
   `curl -s -H "Authorization: Bearer <token>" https://<host>/api/voice/ice-servers | jq`
   → a `turn:` URL with `username`/`credential`. No `turn:` entry → `TURN_URLS`/`TURN_SECRET` unset in the app's environment.
3. **Is it reachable from outside?** From a machine on another network:
   <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/> with those
   credentials → a `relay` candidate must appear. None:
   - firewall / cloud security group: `3478/udp`, `3478/tcp`, `5349/tcp`, relay range `49160-49200/udp`;
   - cloud VM behind 1:1 NAT: `TURN_EXTERNAL_IP=<public>/<private>`;
   - `TURN_SECRET` differs between app and coturn (401 in coturn logs: `check_integrity`).
4. **Relay range exhausted?** coturn logs `Cannot allocate` → widen `--min-port/--max-port` and the firewall range.
5. Prove the relay path end to end: set `ICE_TRANSPORT_POLICY=relay`, restart the app, make a call, then set it back.

## LiveKit (if enabled)

1. `docker compose logs --tail 100 livekit` (or your LiveKit host): look for
   `failed to start`, port binding errors, or `invalid token`.
2. Token errors → the API key/secret the app signs with differs from LiveKit's
   `keys:`; after rotating, restart both.
3. Media ports: LiveKit needs its UDP range (default `50000-60000/udp`) and
   `7881/tcp` open, and `rtc.use_external_ip: true` (or the node IP) on cloud VMs.
4. LiveKit also uses TURN for restrictive networks: check its built-in TURN
   (`turn.enabled`, TLS cert/domain) or point it at coturn.
5. Health: `curl -s http://<livekit>:7880/` answers `OK`.

## Client-side checks (ask the reporter)

- `chrome://webrtc-internals` → the selected candidate pair: `relay` means TURN
  worked; nothing selected means ICE failed.
- Microphone permission denied or the wrong input device — the app shows a
  permission prompt; headsets switching Bluetooth profiles cause drops.
- Site not on HTTPS → browsers refuse microphone access entirely.

## After

Record which networks were affected and whether TURN was involved. If TURN
usage is routinely high, size the relay (bandwidth ≈ participants × bitrate
both ways) or move to an SFU.
