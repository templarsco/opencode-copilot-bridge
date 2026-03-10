/**
 * OpenCode Release Watcher — Cloudflare Worker
 *
 * Polls GitHub releases for anomalyco/opencode (stable) and
 * anomalyco/opencode-beta every 60 seconds. When a new release tag
 * is detected, triggers the Build Patched OpenCode workflow on
 * templarsco/opencode-copilot-bridge via workflow_dispatch.
 *
 * Secrets (set via `wrangler secret put`):
 *   GITHUB_TOKEN — GitHub PAT with `repo` scope (or fine-grained with Actions write)
 *
 * KV Namespace binding:
 *   VERSIONS — stores last-seen release tags ("stable", "beta" keys)
 */

interface Env {
  VERSIONS: KVNamespace
  GITHUB_TOKEN: string
}

const REPOS = {
  stable: "anomalyco/opencode",
  beta: "anomalyco/opencode-beta",
} as const

const BRIDGE_REPO = "templarsco/opencode-copilot-bridge"
const WORKFLOW_FILE = "build.yml"
const USER_AGENT = "opencode-release-watcher/1.0"

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function fetchLatestRelease(
  repo: string,
  token: string,
): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": USER_AGENT,
      },
    },
  )
  if (!res.ok) {
    console.error(
      `[release-watcher] Failed to fetch ${repo}: ${res.status} ${res.statusText}`,
    )
    return null
  }
  const data = (await res.json()) as { tag_name: string }
  return data.tag_name
}

async function triggerWorkflow(
  channel: string,
  token: string,
): Promise<boolean> {
  const res = await fetch(
    `https://api.github.com/repos/${BRIDGE_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { channel },
      }),
    },
  )
  // workflow_dispatch returns 204 on success
  if (res.status !== 204) {
    console.error(
      `[release-watcher] Workflow trigger failed for ${channel}: ${res.status} ${res.statusText}`,
    )
  }
  return res.status === 204
}

// ---------------------------------------------------------------------------
// Worker handlers
// ---------------------------------------------------------------------------

export default {
  /**
   * Cron trigger — runs every 60 seconds.
   * Compares current GitHub release tags against KV-stored versions
   * and dispatches builds for any new releases detected.
   */
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const results: string[] = []

    // Fetch latest releases from both repos in parallel
    const [stableTag, betaTag] = await Promise.all([
      fetchLatestRelease(REPOS.stable, env.GITHUB_TOKEN),
      fetchLatestRelease(REPOS.beta, env.GITHUB_TOKEN),
    ])

    // Get stored versions from KV in parallel
    const [storedStable, storedBeta] = await Promise.all([
      env.VERSIONS.get("stable"),
      env.VERSIONS.get("beta"),
    ])

    // Check stable channel
    if (stableTag && stableTag !== storedStable) {
      const triggered = await triggerWorkflow("stable", env.GITHUB_TOKEN)
      if (triggered) {
        await env.VERSIONS.put("stable", stableTag)
        results.push(
          `Stable: ${storedStable ?? "none"} -> ${stableTag} — build triggered`,
        )
      } else {
        results.push(
          `Stable: ${stableTag} detected but workflow trigger failed`,
        )
      }
    }

    // Check beta channel
    if (betaTag && betaTag !== storedBeta) {
      const triggered = await triggerWorkflow("beta", env.GITHUB_TOKEN)
      if (triggered) {
        await env.VERSIONS.put("beta", betaTag)
        results.push(
          `Beta: ${storedBeta ?? "none"} -> ${betaTag} — build triggered`,
        )
      } else {
        results.push(
          `Beta: ${betaTag} detected but workflow trigger failed`,
        )
      }
    }

    if (results.length > 0) {
      console.log(
        `[release-watcher] ${new Date().toISOString()}\n${results.join("\n")}`,
      )
    }
  },

  /**
   * HTTP handler — exposes a simple status endpoint.
   * GET / returns the currently tracked versions and system health.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // POST /trigger?channel=stable|beta — manual trigger (requires auth)
    if (request.method === "POST" && url.pathname === "/trigger") {
      const authHeader = request.headers.get("Authorization")
      if (!authHeader || authHeader !== `Bearer ${env.GITHUB_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 })
      }
      const channel = url.searchParams.get("channel")
      if (channel !== "stable" && channel !== "beta") {
        return new Response("Bad Request: channel must be stable or beta", {
          status: 400,
        })
      }
      const triggered = await triggerWorkflow(channel, env.GITHUB_TOKEN)
      return new Response(
        JSON.stringify({ triggered, channel }),
        {
          status: triggered ? 200 : 502,
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    // GET / — status
    const [stable, beta] = await Promise.all([
      env.VERSIONS.get("stable"),
      env.VERSIONS.get("beta"),
    ])

    return new Response(
      JSON.stringify(
        {
          status: "ok",
          worker: "opencode-release-watcher",
          tracked: {
            stable: { repo: REPOS.stable, lastSeen: stable ?? "not set" },
            beta: { repo: REPOS.beta, lastSeen: beta ?? "not set" },
          },
          bridge: BRIDGE_REPO,
          polling: "every 60 seconds",
        },
        null,
        2,
      ),
      { headers: { "Content-Type": "application/json" } },
    )
  },
}
