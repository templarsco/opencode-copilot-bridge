# OpenCode Release Watcher — Cloudflare Worker

Monitors OpenCode releases every **60 seconds** and automatically triggers
the patched build pipeline when a new version is detected.

## How It Works

```
                                  ┌─────────────────────┐
                         poll     │  GitHub Releases API │
                 ┌───────────────►│  anomalyco/opencode  │
                 │   every 60s    │  anomalyco/opencode- │
                 │                │  beta                │
┌────────────┐   │                └──────────┬──────────┘
│ Cloudflare │───┤                           │
│   Worker   │   │ compare with              │ new tag?
│ (cron)     │───┤ stored version            │
└────────────┘   │                           ▼
                 │                ┌──────────────────────┐
                 │   KV Store     │  workflow_dispatch    │
                 └───────────────►│  templarsco/opencode- │
                     update       │  copilot-bridge      │
                     version      └──────────────────────┘
```

1. **Cron trigger** fires every 60 seconds
2. Worker fetches latest release tag from both repos (stable + beta) in parallel
3. Compares against last-seen tags stored in Cloudflare KV
4. If a new tag is found → triggers the `build.yml` workflow via GitHub API
5. Updates KV with the new tag only after successful trigger

## Prerequisites

- **Cloudflare Workers Paid plan** ($5/month) — required for 1-minute cron triggers
- **GitHub PAT** with `repo` scope (or fine-grained with Actions write permission)
- **Node.js** 18+ and `npm` (for wrangler CLI)

## Setup

### 1. Install dependencies

```bash
cd worker
npm install
```

### 2. Authenticate with Cloudflare

```bash
npx wrangler login
```

### 3. Create KV namespace

```bash
npx wrangler kv namespace create VERSIONS
```

Copy the `id` from the output and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "VERSIONS"
id = "YOUR_KV_NAMESPACE_ID"
```

### 4. Set GitHub token secret

```bash
npx wrangler secret put GITHUB_TOKEN
```

Paste your GitHub PAT when prompted. The token needs:
- **Classic PAT**: `repo` scope
- **Fine-grained PAT**: Repository access to `templarsco/opencode-copilot-bridge` with Actions (write) permission

### 5. Deploy

```bash
npm run deploy
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET /` | Status | Returns currently tracked versions and system health |
| `POST /trigger?channel=stable\|beta` | Manual trigger | Manually dispatches a build (requires `Authorization: Bearer <GITHUB_TOKEN>`) |

## Monitoring

### View real-time logs

```bash
npx wrangler tail
```

### Check status

```bash
curl https://opencode-release-watcher.<your-subdomain>.workers.dev/
```

### Manual trigger

```bash
curl -X POST \
  "https://opencode-release-watcher.<your-subdomain>.workers.dev/trigger?channel=beta" \
  -H "Authorization: Bearer YOUR_GITHUB_TOKEN"
```

## Local Development

```bash
npm run dev
```

This starts a local dev server. Cron triggers can be tested via:

```bash
curl http://localhost:8787/__scheduled
```

## Cost

- **Workers Paid plan**: $5/month
- **KV reads**: ~1,440/day (1 per minute × 2 keys) — well within free tier (100K/day)
- **KV writes**: ~10/day average (only on new releases) — well within free tier (1K/day)
- **GitHub API**: ~120 requests/hour (2 repos × 60/hr) — well within 5,000/hr limit
