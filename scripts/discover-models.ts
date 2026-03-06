#!/usr/bin/env bun
/**
 * discover-models.ts — Auto-discover Copilot models and generate OpenCode config
 *
 * Reads VS Code's Copilot OAuth token, exchanges it for a JWT,
 * queries the Copilot models API, and generates opencode.json
 * model configurations for models not yet known to OpenCode.
 *
 * Usage:
 *   bun run scripts/discover-models.ts                  # List all available models
 *   bun run scripts/discover-models.ts --diff           # Show only models missing from OpenCode
 *   bun run scripts/discover-models.ts --apply          # Write missing models to opencode.json
 *   bun run scripts/discover-models.ts --json           # Output raw API response
 *   bun run scripts/discover-models.ts --config <path>  # Custom opencode.json path
 *
 * Requirements:
 *   - Bun runtime (https://bun.sh)
 *   - VS Code with GitHub Copilot extension (authenticated)
 *   - Windows (reads %LOCALAPPDATA%\github-copilot\apps.json)
 */

import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const VSCODE_APP_ID = "Ov23liV9UpD7Rnfnskm3"
const TOKEN_ENDPOINT = "https://api.github.com/copilot_internal/v2/token"
const MODELS_ENDPOINT = "https://api.githubcopilot.com/models"

// --- Types ---

interface CopilotModel {
  id: string
  name: string
  version: string
  vendor: string
  model_picker_enabled: boolean
  preview: boolean
  capabilities: {
    type: string
    family: string
    tokenizer?: string
    limits: {
      max_context_window_tokens: number
      max_output_tokens: number
      max_prompt_tokens: number
      vision?: { max_prompt_image_size: number }
    }
    supports: {
      streaming?: boolean
      tool_calls?: boolean
      vision?: boolean
      reasoning_effort?: boolean
      [key: string]: boolean | undefined
    }
  }
  billing?: {
    is_premium?: boolean
    multiplier?: number
  }
  policy?: {
    state?: string
  }
}

interface OpenCodeModel {
  name: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  modalities?: {
    input: string[]
    output: string[]
  }
  limit: {
    context: number
    input: number
    output: number
  }
  cost?: {
    input: number
    output: number
  }
  variants?: Record<string, Record<string, unknown>>
}

// --- Token Exchange ---

async function readVSCodeToken(): Promise<string | undefined> {
  const dir = process.env.LOCALAPPDATA
  if (!dir) {
    console.error("ERROR: LOCALAPPDATA not set. This script requires Windows.")
    return
  }
  const filepath = join(dir, "github-copilot", "apps.json")
  if (!existsSync(filepath)) {
    console.error(`ERROR: ${filepath} not found. Is VS Code Copilot installed and authenticated?`)
    return
  }
  try {
    const apps = JSON.parse(readFileSync(filepath, "utf-8"))
    for (const [key, val] of Object.entries(apps as Record<string, any>)) {
      if (key.includes(VSCODE_APP_ID)) return val.oauth_token as string
    }
  } catch (e) {
    console.error("ERROR: Failed to parse apps.json:", e)
  }
  console.error(`ERROR: No token found for app ${VSCODE_APP_ID} in apps.json`)
}

async function exchangeJWT(token: string): Promise<string | undefined> {
  const res = await fetch(TOKEN_ENDPOINT, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "User-Agent": "GithubCopilot/1.250.0",
      "Editor-Version": "vscode/1.95.0",
      "Editor-Plugin-Version": "copilot/1.250.0",
      "X-GitHub-Api-Version": "2024-12-15",
    },
  })
  if (!res.ok) {
    console.error(`ERROR: JWT exchange failed (HTTP ${res.status})`)
    return
  }
  const data = (await res.json()) as { token: string; expires_at: number }
  if (!data.token) {
    console.error("ERROR: JWT response missing token field")
    return
  }
  const expires = new Date(data.expires_at < 1e10 ? data.expires_at * 1000 : data.expires_at)
  console.error(`JWT obtained, expires ${expires.toISOString()}`)
  return data.token
}

// --- Models API ---

async function fetchModels(jwt: string): Promise<CopilotModel[]> {
  const res = await fetch(MODELS_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "vscode/1.107.0",
      "Editor-Plugin-Version": "copilot-chat/0.35.0",
      "Openai-Organization": "github-copilot",
      Accept: "application/json",
    },
  })
  if (!res.ok) {
    console.error(`ERROR: Models API failed (HTTP ${res.status})`)
    return []
  }
  const body = await res.json()
  // API may return { data: [...] } or just [...]
  if (Array.isArray(body)) return body
  if (body && Array.isArray(body.data)) return body.data
  console.error("ERROR: Unexpected models response shape")
  return []
}

// --- Model Mapping ---

function toOpenCodeModel(m: CopilotModel): OpenCodeModel {
  const caps = m.capabilities
  const supports = caps.supports ?? {}
  const limits = caps.limits
  const hasVision = supports.vision ?? false

  const result: OpenCodeModel = {
    name: m.name || m.id,
    attachment: hasVision,
    reasoning: supports.reasoning_effort ?? false,
    temperature: true,
    tool_call: supports.tool_calls ?? false,
    limit: {
      context: limits.max_context_window_tokens,
      input: limits.max_prompt_tokens,
      output: limits.max_output_tokens,
    },
    cost: { input: 0, output: 0 },
  }

  // Add modalities
  const inputMods: string[] = ["text"]
  const outputMods: string[] = ["text"]
  if (hasVision) inputMods.push("image")
  result.modalities = { input: inputMods, output: outputMods }

  // Add reasoning variants for models that support reasoning_effort
  if (supports.reasoning_effort) {
    result.variants = {
      low: { budgetTokens: 1024 },
      medium: { budgetTokens: 10240 },
      high: { budgetTokens: 32000 },
      max: { budgetTokens: Math.min(64000, limits.max_output_tokens) },
    }
  }

  return result
}

// --- Config Management ---

function defaultConfigPath(): string {
  const home = homedir()
  return join(home, ".config", "opencode", "opencode.json")
}

function loadConfig(filepath: string): Record<string, any> {
  if (!existsSync(filepath)) return {}
  return JSON.parse(readFileSync(filepath, "utf-8"))
}

function getExistingModelIds(config: Record<string, any>): Set<string> {
  const ids = new Set<string>()
  const providers = config.provider ?? {}
  for (const [, prov] of Object.entries(providers as Record<string, any>)) {
    const models = (prov as any)?.models ?? {}
    for (const id of Object.keys(models)) ids.add(id)
  }
  return ids
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2)
  const showDiff = args.includes("--diff")
  const doApply = args.includes("--apply")
  const showJson = args.includes("--json")
  const configIdx = args.indexOf("--config")
  const configPath = configIdx >= 0 && args[configIdx + 1] ? args[configIdx + 1] : defaultConfigPath()

  // Step 1: Get VS Code token
  const token = await readVSCodeToken()
  if (!token) process.exit(1)

  // Step 2: Exchange for JWT
  const jwt = await exchangeJWT(token)
  if (!jwt) process.exit(1)

  // Step 3: Fetch models
  const models = await fetchModels(jwt)
  if (models.length === 0) {
    console.error("No models returned from API")
    process.exit(1)
  }

  console.error(`\nFound ${models.length} models from Copilot API\n`)

  // Step 4: Raw JSON output
  if (showJson) {
    console.log(JSON.stringify(models, null, 2))
    return
  }

  // Step 5: Load existing config for diff/apply
  const config = loadConfig(configPath)
  const known = getExistingModelIds(config)

  // Models that OpenCode's built-in models.dev snapshot typically knows about
  // (common model families — these are already in the snapshot)
  const KNOWN_FAMILIES = new Set([
    "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    "o1", "o1-mini", "o1-pro", "o3", "o3-mini", "o4-mini",
    "claude-3.5-sonnet", "claude-3-5-sonnet", "claude-sonnet-4", "claude-opus-4",
    "gemini-2.0-flash", "gemini-2.5-pro",
  ])

  // Filter to models that might need config
  const missing: CopilotModel[] = []
  const all: { id: string; vendor: string; preview: boolean; context: number; status: string }[] = []

  for (const m of models) {
    const status = known.has(m.id) ? "configured" : KNOWN_FAMILIES.has(m.capabilities?.family ?? "") ? "built-in" : "missing"
    all.push({
      id: m.id,
      vendor: m.vendor,
      preview: m.preview,
      context: m.capabilities?.limits?.max_context_window_tokens ?? 0,
      status,
    })
    if (status === "missing" && m.model_picker_enabled) {
      missing.push(m)
    }
  }

  // Print table
  console.log("Model ID".padEnd(40) + "Vendor".padEnd(15) + "Context".padEnd(12) + "Preview".padEnd(10) + "Status")
  console.log("-".repeat(87))
  for (const m of all.sort((a, b) => a.id.localeCompare(b.id))) {
    const ctx = m.context > 0 ? `${Math.round(m.context / 1000)}k` : "?"
    console.log(
      m.id.padEnd(40) +
      m.vendor.padEnd(15) +
      ctx.padEnd(12) +
      (m.preview ? "yes" : "no").padEnd(10) +
      m.status
    )
  }

  if (showDiff || doApply) {
    if (missing.length === 0) {
      console.log("\nAll models are already configured or built-in.")
      return
    }

    console.log(`\n${missing.length} model(s) need configuration:\n`)

    const entries: Record<string, OpenCodeModel> = {}
    for (const m of missing) {
      entries[m.id] = toOpenCodeModel(m)
      console.log(`  + ${m.id} (${m.vendor}, ${m.capabilities?.limits?.max_context_window_tokens ?? "?"}ctx)`)
    }

    if (doApply) {
      if (!config.provider) config.provider = {}
      if (!config.provider["github-copilot"]) config.provider["github-copilot"] = {}
      if (!config.provider["github-copilot"].models) config.provider["github-copilot"].models = {}

      for (const [id, model] of Object.entries(entries)) {
        config.provider["github-copilot"].models[id] = model
      }

      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
      console.log(`\nWritten to ${configPath}`)
    } else {
      console.log("\nRun with --apply to write these to opencode.json")
      console.log("\nGenerated config snippet:\n")
      console.log(JSON.stringify({ "github-copilot": { models: entries } }, null, 2))
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
