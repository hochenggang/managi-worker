# managi-worker

Your own web SSH workbench, running on Cloudflare Workers. Open a page, get a terminal and SFTP — no jump host to maintain, no client to install.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hochenggang/managi-worker)

## Deploy

Click the button. It forks the repo into your Cloudflare account and creates the KV namespace and Durable Object for you — there are no IDs to fill in.

Prefer the CLI? Three lines:

```bash
npm install
npx wrangler login
npm run deploy
```

## Open it

Go to `https://<your-worker>.workers.dev`. The browser asks for credentials — the username and password are both `admin`.

Then add a host on the left (address, port, username, password or private key) and you have terminals and file management.

## Now change that password

`admin` / `admin` exists so the first deploy works. Everyone knows it, and it reaches your servers, so replace it.

Cloudflare dashboard → your Worker → **Settings → Variables and Secrets** → add:

- Name: `MANAGI_AUTH`
- Value: `username:password`, e.g. `ops:my-long-password`

It takes effect on save, no redeploy needed. Changing it logs out every existing session.

If the machine really is safe to expose (an intranet box, say), set the value to `off`.

## Run locally

```bash
npm install
npm run dev      # http://localhost:8787
```

Local defaults to the same `admin` / `admin`. To use something else, copy `.dev.vars.example` to `.dev.vars` and edit it.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Run locally |
| `npm run deploy` | Deploy to Cloudflare |
| `npm test` | Unit tests, offline, a few seconds |
| `npm run check` | Typecheck + tests + dry-run bundle — run this before committing |
| `npm run test:live` | Full handshake against a real server; needs `LIVE_SSH_*` |

## What it won't do

- **No private networks.** `10.x`, `192.168.x`, `127.0.0.1` and friends are rejected. That's the SSRF guard, not a bug. Expose the box publicly or tunnel out from it.
- **10MB per file.** Upload and download alike. Use `scp` / `rsync` in the terminal for anything bigger.
- **Unencrypted OpenSSH keys only.** Run `ssh-keygen -p -m OPENSSH -f <keyfile>` to strip a passphrase first.
- **Several tabs to one host each do their own handshake.** There's no connection pooling — in exchange, one stuck tab can't drag the others down.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Redeployed, nothing changed | Open `/api/version` and check `deploy.timestamp`. Still the old time means the deploy didn't land. |
| The login prompt rejects everything | `MANAGI_AUTH` is malformed. It must be `username:password`; give it a few seconds after saving. |
| Page loads, terminal won't connect | Hard-refresh so the browser picks up a fresh session cookie. |
| "Private or reserved address rejected" | See the first bullet above. Working as designed. |
| "Host key does not match" | If the server really was reinstalled, delete the `hostkey:...` entry under **Storage & Databases → KV** and reconnect. If you're not sure, check the network first. |

Logs: Cloudflare dashboard → your Worker → **Logs**, or the `npm run dev` terminal.

## More

- **[design.md](design.md)** — how the protocol works, how sessions survive a reconnect, what changed in the SSH stack, where the security boundaries are. Written in Chinese.
- **[README.md](README.md)** — 中文.

This is the Cloudflare Workers port of [managi-v3](https://github.com/hochenggang/managi-v3) (Go backend). The frontend is the same source on both; what was rewritten is the backend transport layer. The SSH stack started from [EdgeSSH](https://github.com/aozorae/EdgeSSH) — changes are logged in [`src/ssh/VENDOR.md`](src/ssh/VENDOR.md).
