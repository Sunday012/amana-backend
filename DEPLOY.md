# Deploying Amana

The backend needs two things from wherever it runs:

1. A **stable outbound IP** — Paga rejects API calls from unlisted addresses.
2. A **public HTTPS URL** — Paga and Chowdeck post webhooks to it.

Two routes below. **LiteHost** is the hackathon's free hosting (cPanel + Node.js app manager);
**Docker on a VPS** is the self-hosted route and what the compose file here is for. Pick one.

On Render, Railway or Fly a stable outbound IP is a paid add-on, and on Railway it is not
guaranteed to be dedicated — so those are a poor fit for the Paga whitelist.

---

# Route A — LiteHost (cPanel + Node.js app manager)

LiteHost runs Node apps under cPanel with SSH access; it does not currently offer Docker on the
shared tiers, so the compose stack in Route B does not apply. You need a tier that includes
**private PostgreSQL and Redis** (their Business tier and above) — check this first, because the
entry tier does not include them and the app will not start without both.

## A1. Create the app

In cPanel: **Setup Node.js App** → Node 22 → application root `amana`, application URL = your
subdomain, startup file `dist/main.js`. Create it, then note the virtualenv activation command it
shows you.

## A2. Get the code on and build it

```bash
ssh <user>@<server>
git clone <your repo> amana && cd amana/backend
source ~/nodevenv/amana/22/bin/activate   # the command cPanel showed you
npm install -g pnpm && pnpm install
pnpm prisma generate && pnpm build
```

## A3. Database and Redis

**If your plan includes private PostgreSQL and Redis** (Business tier and above), create them in
the panel and use those connection strings.

**On the Premium tier they are not included**, so use free hosted ones — the app does not care
where they live:

- **Postgres: [Neon](https://neon.tech)** — create a project, then copy *two* strings from the
  dashboard. The **pooled** one goes in `DATABASE_URL`; the **direct** (unpooled) one goes in
  `DIRECT_DATABASE_URL`. Prisma takes advisory locks during migrations and PgBouncer breaks them,
  so migrations must run on the direct connection. Keep `?sslmode=require` on both.
- **Redis: [Upstash](https://upstash.com)** — create a database and copy the `rediss://` URL into
  `REDIS_URL`. Note the **double s**: that is the TLS scheme, and the connection fails without it.

Then:

```bash
pnpm prisma migrate deploy
```

Two things to watch on free tiers:

- Neon **suspends an idle project**, so the first request after a quiet spell takes a few seconds
  while it wakes. Harmless for a demo; confusing if you do not expect it.
- Upstash bills **per command**, and BullMQ workers hold blocking reads open continuously. A
  single API process sits comfortably inside the free daily allowance, but do not run several
  worker processes against a free database.

## A4. Environment

Add every variable from `.env.production.example` in the Node.js app's **Environment variables**
panel (cPanel does not read `.env` for Passenger apps). `DATABASE_URL` and `REDIS_URL` point at
the cPanel-provisioned instances. **`OTP_DEBUG` must be `false`.**

## A5. Start it and register the URL

Restart the app from cPanel, then:

```bash
curl https://<your-subdomain>/health
curl https://ifconfig.me     # the outbound IP to whitelist with Paga
```

Shared hosting usually has a fixed server IP, so that address should be stable — confirm with
LiteHost support that it will not change.

## Caveat worth knowing before you rely on it

Passenger (what cPanel uses to run Node apps) **stops an idle app and restarts it on the next
request**. Amana runs its queue workers and cron jobs in-process, so while the app is asleep the
reconciler, auto-release and expiry jobs do not run. Webhooks still wake it, and a payment still
reaches `FUNDED` on the next request — but auto-release could fire late.

For the hackathon that is fine. If it becomes a problem, either set the app to never idle (if
LiteHost allows it) or hit `/health` on a cron every few minutes to keep it warm.

---

# Route B — Docker on a VPS

Anything with 2 GB RAM is plenty — Hetzner CX22, a DigitalOcean $6 droplet, whatever you prefer.
This is the route the `Dockerfile` and `docker-compose.prod.yml` in this folder implement.

## 1. Point a domain at the server

Create an `A` record for e.g. `api.amana.example` pointing at the server's IP. Do this first:
Caddy requests the TLS certificate on boot and needs DNS to already resolve.

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

## 3. Get the code onto the server

```bash
git clone <your repo> amana && cd amana/backend
```

## 4. Configure

```bash
cp .env.production.example .env.production
openssl rand -hex 24   # -> POSTGRES_PASSWORD
openssl rand -hex 32   # -> JWT_SECRET
openssl rand -hex 32   # -> INTERNAL_API_KEY
nano .env.production
```

Set `DOMAIN` and `PUBLIC_API_URL` to the hostname from step 1. **Leave `OTP_DEBUG=false`** — when
true, the login code is returned in the API response and anyone can sign in as any phone number.

Compose reads `DOMAIN` and `POSTGRES_PASSWORD` from the shell as well as the app, so:

```bash
set -a && source .env.production && set +a
```

## 5. Launch

```bash
docker compose -f docker-compose.prod.yml up -d --build
curl https://api.amana.example/health
```

Migrations run automatically on boot (`prisma migrate deploy`), so there is no separate step.

## 6. Register the server with the providers

```bash
curl https://ifconfig.me     # the IP to whitelist
```

- **Paga** → Developer Tools → IP Whitelist. Add this IP for **both** the Collect API and
  Business API channels. Then Developer Tools → Callback: `https://api.amana.example/webhooks/paga`
- **Chowdeck** → Settings → Developer Settings → webhook URL:
  `https://api.amana.example/webhooks/chowdeck`
- **GitHub** (milestone evidence) → repo webhook: `https://api.amana.example/webhooks/github`,
  content type JSON, secret = `GITHUB_WEBHOOK_SECRET`, events: `check_suite` and `workflow_run`.

## Updating

```bash
git pull && docker compose -f docker-compose.prod.yml up -d --build
```

## Logs

```bash
docker compose -f docker-compose.prod.yml logs -f api
```

## Notes

- Postgres and Redis are not published to the host; only Caddy's 80/443 are open. Keep it that
  way and the database is unreachable from the internet.
- The API container runs the queue workers and cron jobs in-process. If you scale to more than one
  API container, move the jobs to a dedicated worker first or the schedulers will double-fire.
- Back up the database volume before any demo you care about:
  `docker compose -f docker-compose.prod.yml exec postgres pg_dump -U amana amana > backup.sql`
