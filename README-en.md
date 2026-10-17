# managi-worker

**Your own web SSH workbench, running on Cloudflare Workers.**

The browser speaks SSH straight to your servers; the Worker is only a relay. Credentials ride along with a single request and are dropped as soon as authentication finishes — nothing is persisted, and you don't need to keep a jump host around.

> A Cloudflare Workers port of [managi-v3](https://github.com/hochenggang/managi-v3) (Go backend + Vue 3 frontend). The SSH protocol stack is based on [EdgeSSH](https://github.com/aozorae/EdgeSSH) and is actively improved for this project (see `src/ssh/VENDOR.md`). The frontend is unchanged down to the byte; only the backend transport layer was rewritten.
>
> [中文](README.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hochenggang/managi-worker)

## Three steps to get running

### 1. Deploy

Just click the button above. It clones the repo into your account, creates the KV namespace and injects its ID into the config, and wires up the Durable Object through the migration declared in `wrangler.toml` — you never have to fill in an ID by hand.

Prefer the CLI?

```bash
npm install
npx wrangler login
npm run deploy
```

### 2. Set an access password (**change the default right after deploying**)

**It works without one.** When `MANAGI_AUTH` is unset (or empty) it falls back to the default **`admin` / `admin`** — open the page after deploying, type those two into the browser prompt, and you are in. A first deployment no longer looks broken.

> ⚠️ **That default is public — anyone who has seen this project knows it.** It connects to your servers, so change it soon: Cloudflare dashboard → your Worker → **Settings → Variables and Secrets** → add
>
> | Name | Type | Value |
> | --- | --- | --- |
> | `MANAGI_AUTH` | Secret (recommended) | `username:password`, e.g. `ops:my-long-password` |
>
> It takes effect immediately — no redeploy needed. Changing it also invalidates every session cookie already issued.
>
> If you genuinely want public access (an intranet deployment, say), set it to `off` (or `none`) — that should be a decision someone types out on purpose.
>
> If the value has no colon, the whole string is treated as the password and the username falls back to `admin` (same as the Go version).

### 3. Open the page

Visit `https://<your-worker>.workers.dev`. The browser will prompt for credentials — enter `admin` / `admin` (or the password you changed it to). Then fill in host, port, username and password (or a private key) in the node list on the left, and you have terminals and file management.

## Run it locally

```bash
npm install
npm run dev      # http://localhost:8787
```

Locally the default is the same `admin` / `admin`. To use something else, copy `.dev.vars.example` to `.dev.vars` and edit it, or pass one inline:

```bash
npx wrangler dev --var MANAGI_AUTH:ops:s3cret
```

To run without auth locally, set it to `off` (never leave it unset).

Scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Local dev server (builds the frontend first) |
| `npm run deploy` | Deploy to Cloudflare |
| `npm test` | Unit tests (459 specs, ~6s, no network needed) |
| `npm run test:coverage` | Tests plus a coverage report (`coverage/index.html`) |
| `npm run test:live` | One full handshake against a **real** SSH server (needs `LIVE_SSH_*`; skipped by default) |
| `npm run typecheck` | TypeScript checks for both the source and the test config |
| `npm run check` | Typecheck + tests + a dry-run bundle |

## Differences from the Go version

The port optimizes for "stable and simple", so a few mechanisms that exist for long-running servers were dropped. Four things you need to know:

| Difference | Details |
| --- | --- |
| **No connection reuse** | The Go version keeps a per-node connection pool and shares one SSH connection across tabs on the same host. Here it is one connection per channel — close the channel and the connection closes. Upside: a wedged channel can never drag other tabs down. Downside: several tabs on the same host each perform a handshake. |
| **No session restore** | Closing the WebSocket tears down every channel. Reconnecting gives you a fresh shell; whatever was running in the old terminal is gone after a page refresh. |
| **Public addresses only** | Every resolved address is checked and private / loopback / reserved ranges are rejected (SSRF defence), and the connection is opened against the resolved IP directly (DNS-rebinding defence). `10.x`, `192.168.x`, `127.0.0.1` and friends are unreachable. |
| **Unencrypted OpenSSH keys only** | Only passphrase-less keys starting with `-----BEGIN OPENSSH PRIVATE KEY-----` (Ed25519 / RSA / ECDSA) are accepted. Strip the passphrase first with `ssh-keygen -p -m OPENSSH -f <key-file>`. |

One implementation-level difference: host keys live in KV (TOFU) instead of `~/.managi/known_hosts`.

## Security boundaries

- **Credentials are never persisted** — node passwords and private keys appear only in the `open` frame. They are wiped from memory once authentication completes; they go neither into KV nor into Durable Object storage.
- **Credentials never travel in URLs** — terminals and file transfers share one `/ws` connection, and credentials appear once in the `open` frame, so nothing lands in browser history or access logs.
- **Host key verification (TOFU)** — this is the only thing standing between you and a man-in-the-middle. Credentials are supplied per request, so connecting to an impostor means handing over your password. Defaults to `tofu`; set `HOST_KEY_MODE=off` to disable, which is only advisable while debugging.
- **The access password has two lanes** — besides HTTP Basic Auth, a successful first authentication issues an HttpOnly signed cookie. The reason is practical: browsers do not reliably attach cached Basic credentials to a WebSocket handshake, and a 401 on `/ws` leaves a page that looks fine but can never open a terminal. The cookie value is `expiry-timestamp.HMAC(timestamp)`, keyed off `MANAGI_AUTH` — **changing the password invalidates every issued cookie**, with no revocation table required.
- **Cross-site WebSocket hijacking is blocked** — `/ws` requires `Origin` to match its own.
- **Default credential, meant to be changed** — with no `MANAGI_AUTH` it falls back to `admin:admin` so a first deploy just works instead of answering 503. That default is public: the log warns once and step 2 above says so up front. Public access still requires an explicit `off`.
- **First trust is visible** — on the first connection the recorded host-key fingerprint rides back in the `open` response and is surfaced once in the UI. It used to happen silently, which is exactly where a MITM wants to sit.
- **File transfers have exactly one path** — uploads and downloads both use the `/ws` data plane, sharing the same authenticated connection as the terminal. There is no second HTTP channel, and therefore no second set of auth, timeout and Range semantics to keep correct.
- **Hard limits** — 16 channels per WebSocket, 10,000 directory entries (truncation is reported, not hidden), 10,000 entries when reading a directory for recursive delete or stale-part cleanup (exceeding it is an error, never a partial list), recursive delete capped at 64 levels, **10 MB per upload and per download**, 1 MB per data frame. These are not about speed: they stop one file from eating the isolate's memory or the browser tab's.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| You fixed something, redeployed, and nothing changed | Hit `/api/version` (auth required) and check `deploy.timestamp`. If it still shows the old time, the change never went live — this separates "the fix is wrong" from "the fix was not deployed" without guessing. |
| The credential prompt keeps coming back and nothing works | `MANAGI_AUTH` is wrong. It is a Secret, so give it a few seconds; the value must be `username:password`. |
| The page loads but terminals never connect, logs say "WebSocket not connected" | `/ws` failed auth. Hard-refresh the page so the browser re-runs Basic auth and picks up the session cookie. |
| "Private/reserved address rejected as SSH target" | Working as intended. To reach an internal machine, expose it publicly (with a firewall) or open a reverse tunnel on that server. |
| "Host key does not match the recorded one" | If the server genuinely rotated its key (reinstall, new provider), go to **Storage & Databases → KV** and delete `hostkey:example.com:22`; the next connection records it again. If you are not sure, check your network first — don't just delete it. |
| The page prompts for credentials and you have no idea what to type | With no `MANAGI_AUTH` the default is `admin` / `admin`. Getting in means you are still on that default — **change it soon**. |
| "First connection recorded host fingerprint …" | TOFU just pinned this host's key. Compare it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server. |
| "SSH handshake timed out" | Port closed, firewall blocking, or an SSH server too old to support curve25519 / ecdh-nistp256. |
| "Unsupported SFTP version" | The sshd SFTP subsystem is not v3; switch `Subsystem sftp` to `internal-sftp`. |
| "File is 12.4MB, over the 10MB download limit" | The per-file limit is 10 MB for both directions. Move bigger files with `scp` / `rsync` from a terminal — the Worker orchestrates, it is not a large-file relay. |
| A `xxx.part` file is left behind after a large upload | That is a resumable-upload fragment. Resuming with the same identity (same name, size and mtime) picks it up; delete it if you no longer need it. |

Logs: Cloudflare dashboard → your Worker → **Logs** (live), or the terminal output of `npm run dev`.

## Layout

```
managi-worker/
├── src/
│   ├── worker.ts          # Entry: auth gate + /ws + /api/version + asset fallback
│   ├── durable-object.ts  # One WebSocket = one DO: channel table, dispatch, per-channel serialization
│   ├── session.ts         # SSH transport: handshake, auth, channel lifecycle, public API
│   ├── handlers.ts        # The two channel handlers: PTY / SFTP
│   ├── outbound.ts        # Serial queue for writing bytes into a channel (shared)
│   ├── log.ts             # Structured event log (one event per line, JSON)
│   ├── dial.ts            # Dialing: the only module in the project touching cloudflare:sockets
│   ├── auth.ts            # Access password: Basic Auth + self-signed session cookie
│   ├── node.ts            # Node validation and config conversion
│   ├── security.ts        # SSRF defence: reject private/reserved ranges after DNS resolution
│   ├── host-keys.ts       # TOFU host keys, persisted in KV
│   ├── protocol.ts        # Frontend/backend protocol (control frames + binary frames)
│   ├── file-meta.ts       # Directory-entry value mapping and upload fragment naming
│   ├── util.ts            # Shared pure helpers
│   ├── types.ts           # SSH constants, connection config, Env
│   └── ssh/               # SSH protocol stack (based on EdgeSSH, see VENDOR.md)
├── tests/                 # Unit tests (run on Node, no workerd)
│   └── live/              # interop checks against a real server / local paramiko (skipped by default)
├── frontend/              # Frontend, byte-identical to managi-v3/frontend (only vite.config.ts differs)
├── scripts/build-web.mjs  # Builds the single-file frontend bundle into ./dist
├── wrangler.toml
└── package.json
```

## Developer notes

- **Tests run on Node, not in workerd** — so they need no network access and no reachable sshd. What is exercised is the orchestration logic: `cloudflare:sockets` is aliased to a stub (its only consumer is `dial.ts`), and `SSHConnection` plus the two channel handlers are swapped out wholesale with `vi.mock`. `src/ssh/**` (the protocol stack baseline) is excluded from the coverage denominator — it only means anything against a real server.
- **The protocol is fixed** — zero frontend changes is a hard constraint, so don't invent fields. Control plane (text frames) is `{type, data, seq}`: `seq > 0` is request/response, `seq = 0` expects no reply or is a server push. Verbs: `open` / `close` / `resize` / `ping` / `pong` / `error` / `ack` / `ls` / `mkdir` / `rm` / `upload` / `upload_end` / `download`. Data plane (binary frames) is `[chan: u32 BE][flags: u16 BE][raw bytes]`, with `FLAG_END = 0x0001` ending the stream.
- **`src/ssh/` is a baseline, not a no-go zone** — the stack starts from EdgeSSH but keeps being improved for this project: extra algorithm names, Encrypt-then-MAC, named parameters where positional ones were error-prone. What changed, why, and which test pins it all live in [`src/ssh/VENDOR.md`](src/ssh/VENDOR.md); read that before syncing upstream.
  - The one non-negotiable part is **byte layout and message numbering**: get those wrong and the connection simply fails, so they stay byte-for-byte with the spec.
  - Most valuable rule to remember: the packet parser's callbacks run inside the packet loop, so a callback must **never await something that needs the next inbound bytes** — those bytes are waiting for that very loop to consume them. This is what made SFTP hang for 30 seconds on every open.
- **How the protocol stack gets verified** — the connection object that unit tests `vi.mock` away is exactly the part most likely to be wrong, so the critical paths have to go through a real handshake. Two routes:
  - `npm run test:live` talks to a **real server** (`LIVE_SSH_HOST` / `LIVE_SSH_PORT` / `LIVE_SSH_USER` / `LIVE_SSH_KEY` pointing at a private key file): full handshake, public-key auth, and a command typed into a terminal. Unset those and it skips itself, so `npm test` never needs the network.
  - `tests/live/etm_server.py` starts a paramiko server with ciphers pinned to `aes128-ctr` and MACs pinned to `hmac-sha2-256-etm@openssh.com` — the only setup that can exercise ETM. On an AEAD cipher the MAC is always `none`, so ETM never runs, and virtually every modern server offers AES-GCM. paramiko is used because it is an **independent implementation**; a round-trip test against ourselves proves nothing about interop.
- **Syncing the upstream frontend** — overwrite all of `frontend/`, then restore the one `vite.config.ts` change that writes the bundle to `./dist` at the repo root.
