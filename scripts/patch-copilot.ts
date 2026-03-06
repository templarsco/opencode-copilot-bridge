#!/usr/bin/env bun
/**
 * patch-copilot.ts
 *
 * Patches OpenCode's copilot.ts with JWT token exchange for full Copilot model access.
 * Uses string anchoring instead of unified diffs — resilient to upstream code changes
 * as long as the anchor patterns still exist.
 *
 * Transformations:
 *  1. Swap CLIENT_ID to VS Code OAuth app (for broader model access)
 *  2. Inject JWT functions (vscodeToken, exchange, jwt) before CopilotAuthPlugin
 *  3. Patch Authorization header to use JWT with fallback
 *  4. Remove Openai-Intent header (blocks claude models)
 *  5. Add Copilot-specific headers (Integration-Id, Editor-Version, etc.)
 *
 * Each transformation is idempotent — running twice produces the same result.
 *
 * Usage: bun run scripts/patch-copilot.ts <path-to-copilot.ts>
 */

const target = process.argv[2]
if (!target) {
  console.error("Usage: bun run scripts/patch-copilot.ts <path-to-copilot.ts>")
  process.exit(1)
}

const file = Bun.file(target)
if (!(await file.exists())) {
  console.error(`File not found: ${target}`)
  process.exit(1)
}

let src = await file.text()
let changes = 0
let warnings = 0

// ─── Transform 1: Swap CLIENT_ID to VS Code OAuth app ──────────────
if (src.includes("Ov23li8tweQw6odWQebz")) {
  src = src.replace(
    /const CLIENT_ID\s*=\s*"Ov23li8tweQw6odWQebz".*/,
    'const CLIENT_ID = "Iv1.b507a08c87ecfe98" // VS Code client ID for full Copilot model access',
  )
  console.log("[1/5] ✓ Swapped CLIENT_ID to VS Code OAuth app")
  changes++
} else if (src.includes("Iv1.b507a08c87ecfe98")) {
  console.log("[1/5] — CLIENT_ID already correct, skipping")
} else {
  console.warn("[1/5] ⚠ CLIENT_ID pattern not found — file structure may have changed")
  warnings++
}

// ─── Transform 2: Inject JWT functions before CopilotAuthPlugin ────
if (src.includes("async function vscodeToken")) {
  console.log("[2/5] — JWT functions already present, skipping")
} else {
  const anchor = "export async function CopilotAuthPlugin"
  const idx = src.indexOf(anchor)
  if (idx === -1) {
    console.error("[2/5] ✗ FATAL: Anchor 'CopilotAuthPlugin' not found. Cannot inject JWT.")
    console.error("       The file structure has changed significantly. Manual patching required.")
    process.exit(1)
  }

  const jwt = [
    "// Copilot JWT token exchange — exchanges VS Code's OAuth token for a",
    "// Copilot JWT that unlocks additional models (e.g. claude-opus-4.6-fast).",
    "let cached: { token: string; expires: number } | undefined",
    "",
    "async function vscodeToken() {",
    "  const dir = process.env.LOCALAPPDATA",
    "  if (!dir) return undefined",
    "  try {",
    '    const apps = await Bun.file(`${dir}/github-copilot/apps.json`).json()',
    "    for (const [key, val] of Object.entries(apps as Record<string, any>))",
    '      if (key.includes("Ov23liV9UpD7Rnfnskm3")) return val.oauth_token as string',
    "  } catch {}",
    "  return undefined",
    "}",
    "",
    "async function exchange(token: string) {",
    '  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {',
    "    headers: {",
    "      Authorization: `token ${token}`,",
    '      Accept: "application/json",',
    '      "User-Agent": "GithubCopilot/1.250.0",',
    '      "Editor-Version": "vscode/1.95.0",',
    '      "Editor-Plugin-Version": "copilot/1.250.0",',
    '      "X-GitHub-Api-Version": "2024-12-15",',
    "    },",
    "  })",
    "  if (!res.ok) return undefined",
    "  const data = (await res.json()) as { token: string; expires_at: number }",
    "  if (!data.token || !data.expires_at) return undefined",
    "  const expires = data.expires_at < 1e10 ? data.expires_at * 1000 : data.expires_at",
    "  return { token: data.token, expires }",
    "}",
    "",
    "async function jwt() {",
    "  if (cached && cached.expires > Date.now() + 300_000) return cached.token",
    "  const token = await vscodeToken()",
    "  if (!token) return undefined",
    "  const result = await exchange(token)",
    "  if (!result) return undefined",
    "  cached = result",
    "  return cached.token",
    "}",
    "",
  ].join("\n")

  src = src.slice(0, idx) + jwt + src.slice(idx)
  console.log("[2/5] ✓ Injected JWT functions (vscodeToken, exchange, jwt)")
  changes++
}

// ─── Transform 3: Patch Authorization header to use JWT ─────────────
const authOriginal = "Authorization: `Bearer ${info.refresh}`"
const authPatched = "Authorization: `Bearer ${(await jwt()) ?? info.refresh}`"

if (src.includes(authPatched)) {
  console.log("[3/5] — Authorization header already patched, skipping")
} else if (src.includes(authOriginal)) {
  src = src.replace(authOriginal, authPatched)
  console.log("[3/5] ✓ Patched Authorization header to use JWT with fallback")
  changes++
} else {
  // Try a broader regex in case formatting changed
  const authRegex = /Authorization:\s*`Bearer\s*\$\{info\.refresh\}`/
  if (authRegex.test(src)) {
    src = src.replace(authRegex, authPatched)
    console.log("[3/5] ✓ Patched Authorization header (fuzzy match)")
    changes++
  } else {
    console.warn("[3/5] ⚠ Authorization header pattern not found — may already use a different auth flow")
    warnings++
  }
}

// ─── Transform 4: Remove Openai-Intent header ──────────────────────
const intentRegex = /^[ \t]*"Openai-Intent":\s*"[^"]*",?\s*\r?\n/m
if (intentRegex.test(src)) {
  src = src.replace(intentRegex, "")
  console.log("[4/5] ✓ Removed Openai-Intent header (blocks claude models)")
  changes++
} else {
  console.log("[4/5] — Openai-Intent header not present, skipping")
}

// ─── Transform 5: Add Copilot headers after Authorization ──────────
if (src.includes('"Copilot-Integration-Id"')) {
  console.log("[5/5] — Copilot headers already present, skipping")
} else {
  // Find the Authorization line and detect its indentation
  const authMatch = src.match(/^([ \t]*)Authorization:\s*`Bearer .+$/m)
  if (authMatch) {
    const indent = authMatch[1]
    const lineStart = src.indexOf(authMatch[0])
    const lineEnd = src.indexOf("\n", lineStart)
    if (lineEnd !== -1) {
      const headers = [
        `${indent}"Copilot-Integration-Id": "vscode-chat",`,
        `${indent}"Editor-Version": "vscode/1.107.0",`,
        `${indent}"Editor-Plugin-Version": "copilot-chat/0.35.0",`,
        `${indent}"Openai-Organization": "github-copilot",`,
      ].join("\n")
      src = src.slice(0, lineEnd + 1) + headers + "\n" + src.slice(lineEnd + 1)
      console.log("[5/5] ✓ Added Copilot headers (Integration-Id, Editor-Version, etc.)")
      changes++
    }
  } else {
    console.warn("[5/5] ⚠ Could not find Authorization line to anchor Copilot headers")
    warnings++
  }
}

// ─── Summary ────────────────────────────────────────────────────────
console.log("")
if (changes === 0) {
  console.log("No changes needed — file already fully patched.")
  process.exit(0)
}

await Bun.write(target, src)
console.log(`✓ Patched ${target} (${changes} transformation${changes !== 1 ? "s" : ""} applied)`)

if (warnings > 0) {
  console.warn(`⚠ ${warnings} warning${warnings !== 1 ? "s" : ""} — review output above`)
  process.exit(2) // non-zero but not fatal
}
