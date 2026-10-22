# ZTab deploy runbook

One VPS, five containers, one public origin: `https://<your-domain>` serves the PWA and `/api/*`. Testnet only. Everything below is copy-paste; replace `<ip>` and the example domain.

## What runs where

| Service | Image | Ports | State |
|---|---|---|---|
| `caddy` | `caddy:2.11` | 80, 443 published | volume `caddy_data` (Let's Encrypt certificates) |
| `pwa` | `ghcr.io/vitalikcholan/ztab-pwa:<tag>`, one-shot: copies `dist/` into `pwa_dist` and exits | none | volume `pwa_dist` |
| `api` | `ghcr.io/vitalikcholan/ztab-api:<tag>` | 3000, internal | none |
| `watcher` | `ghcr.io/vitalikcholan/ztab-watcher:<tag>` | 8787, internal | volume `watcher_data` |
| `postgres` | `postgres:16-alpine` | 5432, internal | volume `pgdata` |

Only 22 (SSH), 80 and 443 are open. The watcher talks to the public lightwalletd `https://testnet.zec.rocks:443`; there is no own Zcash node. Config lives in `deploy/.env` (mode 600, never committed): `DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD`, `WATCHER_TOKEN`, `IMAGE_TAG`. The scripts generate the secrets and never print them.

## Prerequisites

- A domain you can edit DNS for (Porkbun or Cloudflare Registrar).
- A Hetzner Cloud account and an SSH key.
- The repository on GitHub with CI green on `main` (the Images workflow publishes the containers the server pulls).
- On your laptop: `ssh`, and a checkout of this repo.

## Steps

Do them in this order. (The numbers 0-6 follow the infra spec; the repo/GHCR step is done before the server setup so the first clone and pull cannot fail.)

### 0. Buy the domain first

Porkbun or Cloudflare Registrar. If the DNS is on Cloudflare, set every record to **DNS only (grey cloud)**. With the orange cloud there are two proxies in front of the API and its rate limit (which counts exactly one `X-Forwarded-For`) breaks.

### 1. DNS

Add an `A` record `@` pointing at the server IP (and `www` as a `CNAME` to `@` if you want it). You get the IP in step 2; add the record right after, and check it resolves before step 4:

```bash
dig +short example.org
```

### 2. Create the server

Hetzner Cloud: CX23 (2 vCPU, 4 GB), Ubuntu 24.04, Nuremberg or Helsinki, add your SSH key. Check you can log in:

```bash
ssh root@<ip> 'lsb_release -ds'
```

### 3. Make the code and images reachable (repo public, GHCR public)

The server clones the repo and pulls the three images without credentials, so both must be public. (The repo has to be public at submission anyway.)

1. GitHub, repo `VitalikCholan/ZTab`, Settings, General, Danger Zone: **Change visibility** to Public.
2. Make sure the work is on `main` (merge the `infra` PR) and that the **CI** workflow and then the **Images** workflow are green for that commit (Actions tab). This publishes `ghcr.io/vitalikcholan/ztab-{api,watcher,pwa}:main` and `:sha-<short>`.
3. For each of the three packages (`ztab-api`, `ztab-watcher`, `ztab-pwa`): GitHub profile, Packages, the package, Package settings, **Change visibility** to Public. Do it once; it persists.

Keeping things private instead: for the repo pass credentials in the clone URL (`REPO_URL=https://<user>:<token>@github.com/VitalikCholan/ZTab`, it is stored in `/opt/ztab/.git/config`), and for images run `docker login ghcr.io` as the `ztab` user on the server (`runuser -u ztab -- docker login ghcr.io`).

### 4. Run the server setup (once)

From your laptop, in the repo root:

```bash
ssh root@<ip> "DOMAIN=example.org ACME_EMAIL=you@example.org bash -s" < deploy/server-setup.sh
```

It installs Docker Engine (official apt repo), `ufw` (22, 80, 443), `fail2ban` and unattended upgrades, creates the `ztab` user, clones the repo to `/opt/ztab`, writes `/opt/ztab/deploy/.env` (random secrets, mode 600), installs the `ztab.service` systemd unit (the stack starts on boot) and runs the first `update.sh`, which ends with the smoke test. It is safe to re-run; an existing `.env` is kept, so the watcher token never changes under a running stack. It prints `smoke OK` on success.

### 5. Check it in a browser, then do one real run

Caddy gets the Let's Encrypt certificate by itself (about a minute). Open `https://example.org` and go through create, pay, withdraw with a real testnet wallet (Vizor Testnet on desktop; TAZ from the faucet at fauzec.com). Write the result down in `pwa/README.md`, "Manual testnet run", and in the root README.

### 6. Uptime monitors

Two free UptimeRobot "HTTP(s)" monitors, every 1 minute, alerts to your email:

1. `https://example.org/api/healthz` (alive).
2. `https://example.org/api/status` with "Keyword exists" `"watcher":"ok"` (alive is not the same as synced: this one fires when the watcher is `stale`).

## Update and rollback

Update to the latest `main` (only after its Images workflow is green; otherwise the script says `images for sha-<x> not published yet (check the Images workflow)`, touches nothing and exits non-zero):

```bash
ssh root@<ip> 'cd /opt/ztab/deploy && runuser -u ztab -- bash ./update.sh'
```

`update.sh` does `git pull --ff-only`, pins `IMAGE_TAG=sha-<short HEAD>` in `.env`, `docker compose pull`, `up -d --remove-orphans`, then `smoke.sh`. The `watcher_data` wallet and the database survive updates. Never run `docker compose down -v`: it deletes the volumes.

Roll back to an older build (find the sha in the Actions tab or `git log --oneline`):

```bash
ssh root@<ip>
cd /opt/ztab/deploy
runuser -u ztab -- sed -i.bak 's/^IMAGE_TAG=.*/IMAGE_TAG=sha-<old>/' .env
runuser -u ztab -- rm -f .env.bak
runuser -u ztab -- docker compose up -d
```

The edit is made as `ztab` so `.env` keeps its owner and mode 600. A one-off `IMAGE_TAG=sha-<old> docker compose up -d` also works, but `.env` is what the next reboot uses, so prefer editing it. The next `update.sh` moves forward again.

## Logs

```bash
cd /opt/ztab/deploy
docker compose ps
docker compose logs --tail 100 api
docker compose logs -f watcher
```

Each service rotates its own log (10 MB x 3). Privacy by design: Caddy has **no access log**; its error log drops the request URI, headers and client IP. The watcher logs never contain addresses or amounts. Do not paste logs publicly without reading them first.

## Smoke tests

- On the server (read-only, safe against production): `cd /opt/ztab/deploy && bash ./smoke.sh` checks `/api/healthz`, `/api/status` (network `test`), the CSP header on a deep link and the http to https redirect. It prints `smoke OK`.
- `bash deploy/rehearsal.sh [--keep]` is the **local** rehearsal (Docker Desktop, Node 24, pnpm): it builds the images, starts the stack on `https://localhost` with a local CA and runs the Playwright smoke. That smoke **stops and restarts the API** - never run it against production. Without `--keep` it removes its containers and volumes.
- `bash deploy/test/scripts.test.sh` tests the scripts here and runs `shellcheck`.

## Troubleshooting

- **Let's Encrypt rate limit** (five certificates per domain per week): do not delete the `caddy_data` volume and avoid recreating the server in a loop; Caddy reuses the stored certificate. If you are already limited, wait out the window (Let's Encrypt tells you when it ends in `docker compose logs caddy`).
- **No certificate / smoke fails right after setup**: `dig +short example.org` must return the server IP, the Cloudflare cloud must be grey, and ports 80/443 must be open (`ufw status`). Then `docker compose logs caddy`.
- **`docker compose pull` fails with 401/denied**: the GHCR packages are still private (step 3).
- **`git clone` fails in server-setup**: the repo is still private (step 3).
- **Port 3000/80/443 busy locally during the rehearsal**: stop whatever uses it (`lsof -iTCP:443 -sTCP:LISTEN`), for example a dev API on 3000 or another local web server.
- **`/api/status` shows the watcher `stale`**: it cannot reach the lightwalletd. `docker compose logs --tail 50 watcher`; if `testnet.zec.rocks` is down, change `ZTAB_LIGHTWALLETD_URL` in `deploy/docker-compose.yml` to another public testnet lightwalletd, commit it to `main` and run `update.sh` (a local edit on the server would block `git pull`).
- **Reboot test**: `ssh root@<ip> reboot`, wait a minute, `bash ./smoke.sh` again. `systemctl status ztab.service` shows the unit.
