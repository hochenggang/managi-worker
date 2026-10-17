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

### 2. Set an access password

If the deploy page shows a `MANAGI_AUTH` field, fill it in there. If you miss it or want to change it later, go to the Cloudflare dashboard → your Worker → **Settings → Variables and Secrets** → add:

| Name | Type | Value |
| --- | --- | --- |
| `MANAGI_AUTH` | Secret (recommended) | `username:password`, e.g. `ops:my-long-password` |

It takes effect immediately — no redeploy needed.

> ⚠️ **Without this variable, anyone who knows your Worker URL can use it to reach your machines.** The server only logs a warning; it will not stop them for you.
>
> If the value has no colon, the whole string is treated as the password and the username falls back to `admin` (same as the Go version).

### 3. Open the page

Visit `https://<your-worker>.workers.dev`. The browser will prompt for credentials — enter the password from step 2. Then fill in host, port, username and password (or a private key) in the node list on the left, and you have terminals and file management.

## Run it locally

```bash
npm install
npm run dev      # http://localhost:8787
```

Without `MANAGI_AUTH` there is no auth (a warning is logged). To exercise the auth path:

```bash
npx wrangler dev --var MANAGI_AUTH:ops:s3cret
```

Scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Local dev server (builds the frontend first) |
| `npm run deploy` | Deploy to Cloudflare |
| `npm test` | Unit tests (450+ specs, ~5s, no network needed) |
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

Two implementation-level differences: host keys live in KV (TOFU) instead of `~/.managi/known_hosts`, and a batch command on a single node runs for at most 15 minutes before the connection is closed to kill the remote command — but the frontend's own HTTP timeout is 30 seconds, so anything that really runs for minutes will surface as a timeout in the UI first.

## Security boundaries

- **Credentials are never persisted** — node passwords and private keys appear only in the `open` frame and the two `POST` bodies. They are wiped from memory once authentication completes; they go neither into KV nor into Durable Object storage.
- **Credentials never travel in URLs** — downloads and batch commands use `POST` with a body, so nothing lands in browser history or access logs.
- **Host key verification (TOFU)** — this is the only thing standing between you and a man-in-the-middle. Credentials are supplied per request, so connecting to an impostor means handing over your password. Defaults to `tofu`; set `HOST_KEY_MODE=off` to disable, which is only advisable while debugging.
- **The access password has two lanes** — besides HTTP Basic Auth, a successful first authentication issues an HttpOnly signed cookie. The reason is practical: browsers do not reliably attach cached Basic credentials to a WebSocket handshake, and a 401 on `/ws` leaves a page that looks fine but can never open a terminal. The cookie value is `expiry-timestamp.HMAC(timestamp)`, keyed off `MANAGI_AUTH` — **changing the password invalidates every issued cookie**, with no revocation table required.
- **Cross-site WebSocket hijacking is blocked** — `/ws` requires `Origin` to match its own.
- **CSRF is blocked** — both `POST` endpoints require `Sec-Fetch-Site` to be `same-origin` or `none` (absent = non-browser client, allowed through).

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The credential prompt keeps coming back and nothing works | `MANAGI_AUTH` is wrong. It is a Secret, so give it a few seconds; the value must be `username:password`. |
| The page loads but terminals never connect, logs say "WebSocket not connected" | `/ws` failed auth. Hard-refresh the page so the browser re-runs Basic auth and picks up the session cookie. |
| "Private/reserved address rejected as SSH target" | Working as intended. To reach an internal machine, expose it publicly (with a firewall) or open a reverse tunnel on that server. |
| "Host key does not match the recorded one" | If the server genuinely rotated its key (reinstall, new provider), go to **Storage & Databases → KV** and delete `hostkey:example.com:22`; the next connection records it again. If you are not sure, check your network first — don't just delete it. |
| "SSH handshake timed out" | Port closed, firewall blocking, or an SSH server too old to support curve25519 / ecdh-nistp256. |
| "Unsupported SFTP version" | The sshd SFTP subsystem is not v3; switch `Subsystem sftp` to `internal-sftp`. |
| A `xxx.part` file is left behind after a large upload | That is a resumable-upload fragment. Resuming with the same identity (same name, size and mtime) picks it up; delete it if you no longer need it. |
| The batch-command page times out | The frontend gives those requests 30 seconds. Use a terminal tab for long-running commands. |

Logs: Cloudflare dashboard → your Worker → **Logs** (live), or the terminal output of `npm run dev`.

## Layout

```
managi-worker/
├── src/
│   ├── worker.ts          # Entry: auth gate + /ws + two /api endpoints + asset fallback
│   ├── durable-object.ts  # One WebSocket = one DO: channel table, dispatch, per-channel serialization
│   ├── session.ts         # One SSH connection, three channel kinds: handshake + PTY / SFTP / exec
│   ├── dial.ts            # Dialing: the only module in the project touching cloudflare:sockets
│   ├── auth.ts            # Access password: Basic Auth + self-signed session cookie
│   ├── node.ts            # Node validation and config conversion (shared by three entry points)
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

- **Tests run on Node, not in workerd** — so they need no network access and no reachable sshd. What is exercised is the orchestration logic: `cloudflare:sockets` is aliased to a stub (its only consumer is `dial.ts`), and `SSHConnection` plus the three channel handlers are swapped out wholesale with `vi.mock`. `src/ssh/**` (the protocol stack baseline) is excluded from the coverage denominator — it only means anything against a real server.
- **The protocol is fixed** — zero frontend changes is a hard constraint, so don't invent fields. Control plane (text frames) is `{type, data, seq}`: `seq > 0` is request/response, `seq = 0` expects no reply or is a server push. Verbs: `open` / `close` / `resize` / `ping` / `pong` / `error` / `ack` / `ls` / `mkdir` / `rm` / `upload` / `upload_end` / `download`. Data plane (binary frames) is `[chan: u32 BE][flags: u16 BE][raw bytes]`, with `FLAG_END = 0x0001` ending the stream.
- **`src/ssh/` is a baseline, not a no-go zone** — the stack starts from EdgeSSH but keeps being improved for this project: extra algorithm names, Encrypt-then-MAC, named parameters where positional ones were error-prone. What changed, why, and which test pins it all live in [`src/ssh/VENDOR.md`](src/ssh/VENDOR.md); read that before syncing upstream.
  - The one non-negotiable part is **byte layout and message numbering**: get those wrong and the connection simply fails, so they stay byte-for-byte with the spec.
  - Most valuable rule to remember: the packet parser's callbacks run inside the packet loop, so a callback must **never await something that needs the next inbound bytes** — those bytes are waiting for that very loop to consume them. This is what made SFTP hang for 30 seconds on every open.
- **How the protocol stack gets verified** — the connection object that unit tests `vi.mock` away is exactly the part most likely to be wrong, so the critical paths have to go through a real handshake. Two routes:
  - `npm run test:live` talks to a **real server** (`LIVE_SSH_HOST` / `LIVE_SSH_PORT` / `LIVE_SSH_USER` / `LIVE_SSH_KEY` pointing at a private key file): full handshake, public-key auth, exec. Unset those and it skips itself, so `npm test` never needs the network.
  - `tests/live/etm_server.py` starts a paramiko server with ciphers pinned to `aes128-ctr` and MACs pinned to `hmac-sha2-256-etm@openssh.com` — the only setup that can exercise ETM. On an AEAD cipher the MAC is always `none`, so ETM never runs, and virtually every modern server offers AES-GCM. paramiko is used because it is an **independent implementation**; a round-trip test against ourselves proves nothing about interop.
- **Syncing the upstream frontend** — overwrite all of `frontend/`, then restore the one `vite.config.ts` change that writes the bundle to `./dist` at the repo root.
