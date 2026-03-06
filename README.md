# OpenCode Copilot Bridge

Unlocks **all GitHub Copilot models** in [OpenCode](https://github.com/opencode-ai/opencode) — including preview models that arrive in VS Code before OpenCode supports them natively.

## The Problem

GitHub Copilot gives VS Code access to models that OpenCode can't use:
- OpenCode uses its own OAuth app, which doesn't support the Copilot token exchange
- Certain models (like `claude-opus-4.6-fast`) require specific headers that OpenCode doesn't send
- New preview models appear in VS Code weeks before OpenCode/models.dev adds them

## The Solution

This bridge fixes both **authentication** and **model discovery**:

| Layer | What it does |
|---|---|
| **JWT Patch** | Reads VS Code's Copilot token, exchanges it for a JWT via `copilot_internal/v2/token`, and uses that for API calls |
| **Header Fix** | Removes the `Openai-Intent` header that blocks certain models, adds required Copilot headers |
| **Model Discovery** | Queries the Copilot `/models` API to auto-discover and configure models missing from OpenCode |

## Requirements

- **Windows x64** (macOS/Linux support planned)
- **VS Code** with GitHub Copilot extension, signed in
- **GitHub Copilot** subscription (Pro, Business, or Enterprise)
- **Bun** runtime (for model discovery script)

## Quick Start

### Option 1: One-liner Install (Easiest)

```powershell
# Install stable bridge (Desktop Stable + CLI)
irm https://raw.githubusercontent.com/templarsco/opencode-copilot-bridge/main/scripts/install-bridge.ps1 | iex

# Install beta bridge (Desktop Beta)
powershell -Command "& { $script = irm 'https://raw.githubusercontent.com/templarsco/opencode-copilot-bridge/main/scripts/install-bridge.ps1'; $sb = [scriptblock]::Create($script); & $sb -Channel beta }"

# Install both stable and beta
powershell -Command "& { $script = irm 'https://raw.githubusercontent.com/templarsco/opencode-copilot-bridge/main/scripts/install-bridge.ps1'; $sb = [scriptblock]::Create($script); & $sb -Channel all }"
```

This wizard automatically:
- Downloads the latest bridge binary for the selected channel
- Closes any running OpenCode instances
- Backs up original binaries (`.original`)
- Replaces sidecars in the appropriate installations:
  - **Stable**: Desktop Stable (`%LOCALAPPDATA%\OpenCode\`) + CLI (`%USERPROFILE%\.bun\bin\`)
  - **Beta**: Desktop Beta (`%LOCALAPPDATA%\OpenCode Beta\`)
- Restarts Desktop apps
To uninstall and restore originals:
```powershell
git clone https://github.com/templarsco/opencode-copilot-bridge.git
.\opencode-copilot-bridge\scripts\install-bridge.ps1 -Uninstall
```

### Option 2: Manual Install

1. Download the latest `.exe` from [Releases](../../releases):
   - **Stable**: `opencode-copilot-bridge-*-stable-windows-x64.exe`
   - **Beta**: `opencode-copilot-bridge-*-beta-windows-x64.exe`
2. Close OpenCode (all instances)
3. Replace your installed OpenCode binary:
   ```
   # Desktop Stable sidecar (use stable binary)
   copy opencode-copilot-bridge-*-stable-*.exe "%LOCALAPPDATA%\OpenCode\opencode-cli.exe"

   # Desktop Beta sidecar (use beta binary)
   copy opencode-copilot-bridge-*-beta-*.exe "%LOCALAPPDATA%\OpenCode Beta\opencode-cli.exe"

   # CLI (use stable binary)
   copy opencode-copilot-bridge-*-stable-*.exe "%USERPROFILE%\.bun\bin\opencode.exe"
   ```
4. Restart OpenCode

### Option 3: Patch from Source

1. Clone this repo and the OpenCode source:
   ```powershell
   git clone https://github.com/templarsco/opencode-copilot-bridge.git
   git clone <opencode-source-repo>
   ```
2. Apply the patch and build:
   ```powershell
   .\opencode-copilot-bridge\scripts\apply-patch.ps1
   ```
3. Binary is at `packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`
## Model Discovery

The `discover-models.ts` script queries GitHub Copilot's API to find all available models and generates OpenCode configuration for any that are missing.

```powershell
# List all models available in your Copilot subscription
bun run scripts/discover-models.ts

# Show only models that need configuration
bun run scripts/discover-models.ts --diff

# Auto-add missing models to your opencode.json
bun run scripts/discover-models.ts --apply

# Output raw API response (for debugging)
bun run scripts/discover-models.ts --json

# Use a custom config path
bun run scripts/discover-models.ts --apply --config "C:\path\to\opencode.json"
```

The script automatically:
- Reads your VS Code Copilot OAuth token from `%LOCALAPPDATA%\github-copilot\apps.json`
- Exchanges it for a short-lived JWT (valid ~30 minutes)
- Queries `https://api.githubcopilot.com/models` for the full model catalog
- Maps Copilot model specs (context window, capabilities, reasoning) to OpenCode format
- Writes missing models to your `opencode.json` config

### When to run it

Run this script whenever:
- You suspect new models are available in VS Code but not in OpenCode
- After updating your Copilot subscription tier
- After a new OpenCode release (to check for newly supported models)

## How It Works

### Authentication Flow

```
VS Code Copilot Extension
    ↓ (stores OAuth token)
%LOCALAPPDATA%\github-copilot\apps.json
    ↓ (read by bridge)
GET api.github.com/copilot_internal/v2/token
    ↓ (returns JWT, ~30 min TTL)
Bearer {JWT} → api.githubcopilot.com/chat/completions
```

The JWT is cached in-memory and auto-refreshed 5 minutes before expiry. If the JWT can't be obtained (VS Code not signed in, etc.), it falls back to OpenCode's standard OAuth token.

### Header Changes

| Header | Before (blocks models) | After (works) |
|---|---|---|
| `Authorization` | `Bearer {gho_token}` | `Bearer {JWT}` |
| `Openai-Intent` | `conversation-edits` | *(removed)* |
| `Copilot-Integration-Id` | *(missing)* | `vscode-chat` |
| `Editor-Version` | *(missing)* | `vscode/1.107.0` |
| `Openai-Organization` | *(missing)* | `github-copilot` |

### Model Config Format

Models are added to `~/.config/opencode/opencode.json` under the `github-copilot` provider:

```json
{
  "provider": {
    "github-copilot": {
      "models": {
        "claude-opus-4.6-fast": {
          "name": "Claude Opus 4.6 (fast mode)",
          "attachment": true,
          "reasoning": true,
          "temperature": true,
          "tool_call": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 200000, "input": 128000, "output": 64000 },
          "variants": {
            "low": { "budgetTokens": 1024 },
            "medium": { "budgetTokens": 10240 },
            "high": { "budgetTokens": 32000 },
            "max": { "budgetTokens": 64000 }
          }
        }
      }
    }
  }
}
```

See `config/opencode.json.example` for a full example.

## Auto-Build CI

This repo includes a GitHub Actions workflow that tracks **both channels**:

| Channel | Source | Tag Pattern | Check Frequency |
|---|---|---|---|
| **Stable** | `anomalyco/opencode` | `bridge-v1.2.x` | Every 6 hours |
| **Beta** | `anomalyco/opencode-beta` | `bridge-beta-YYYYMMDDHHMM` | Every 6 hours |

For each channel, the CI:
1. Checks for new upstream releases
2. Clones the release tag (via `OPENCODE_PAT` secret), applies the patch, builds a Windows binary
3. Creates a tagged release with the patched `.exe`

### Setup

The CI needs access to both OpenCode source repositories. Add a GitHub PAT as a secret:

1. Go to **Settings → Secrets and variables → Actions**
2. Add secret `OPENCODE_PAT` with a PAT that has `repo` scope and read access to `anomalyco/opencode` AND `anomalyco/opencode-beta`

You can also trigger a build manually from the [Actions tab](../../actions), choosing to build `stable`, `beta`, or `both`.

## Troubleshooting

### "The requested model is not supported"
- Ensure VS Code is signed into GitHub Copilot (check the Copilot icon in the status bar)
- Run `bun run scripts/discover-models.ts --json` to verify the model appears in the API
- Check that the model is configured in `opencode.json`

### JWT exchange fails
- Verify `%LOCALAPPDATA%\github-copilot\apps.json` exists and contains a token
- Try signing out and back into GitHub Copilot in VS Code
- Check your Copilot subscription is active

### Patch doesn't apply
- The patch is based on a specific OpenCode version and may need updating
- Check the latest release for an updated patch
- Or use a pre-built binary from releases

## Technical Details

- **Three OAuth apps discovered**: OpenCode (`Ov23li8tweQw6odWQebz`, 35 models), Legacy (`Iv1.b507a08c87ecfe98`, 35 models), VS Code (`Ov23liV9UpD7Rnfnskm3`, 40+ models with exchange support)
- **The `Openai-Intent` header** blocks certain models (`claude-opus-4.6-fast` and potentially others). Removing it entirely fixes the issue.
- **JWT lifetime**: ~30 minutes. Auto-refreshed with a 5-minute buffer before expiry.
- **Fallback**: If JWT exchange fails, the bridge falls back to OpenCode's standard `gho_` token. Models requiring JWT will not work, but standard models remain functional.

## License

MIT
