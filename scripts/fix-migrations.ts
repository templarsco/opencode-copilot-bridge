#!/usr/bin/env bun
// fix-migrations.ts — Fix OpenCode Drizzle migration tracking
//
// Problem: OpenCode v1.2.21+ updated Drizzle ORM from beta.12 to beta.16,
// which changed migration tracking from hash-based to name-based.
// Databases created by older versions have __drizzle_migrations entries
// with NULL names. New Drizzle doesn't recognize them → tries to re-run
// all migrations → CREATE TABLE fails → app crashes.
//
// Fix: Backfill the migration names so Drizzle recognizes them as applied.
//
// Usage: bun run scripts/fix-migrations.ts [--db-path <path>] [--dry-run] [--backup]
//
// See: https://github.com/anomalyco/opencode/issues/16678

import { Database } from "bun:sqlite"
import { existsSync, copyFileSync } from "fs"
import { join } from "path"

// Known migration name → created_at timestamp mapping
const MIGRATIONS: Record<string, number> = {
  "20260127222353_familiar_lady_ursula": 1769552633000,
  "20260211171708_add_project_commands": 1770830228000,
  "20260213144116_wakeful_the_professor": 1770993676000,
  "20260225215848_workspace": 1772056728000,
  "20260227213759_add_session_workspace_id": 1772228279000,
  "20260228203230_blue_harpoon": 1772310750000,
  "20260303231226_add_workspace_fields": 1772579546000,
}

function getDefaultDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local")
    // Check XDG-style path first (OpenCode uses this)
    const xdgData = process.env.XDG_DATA_HOME || join(home, ".local", "share")
    const xdgPath = join(xdgData, "opencode", "opencode.db")
    if (existsSync(xdgPath)) return xdgPath
    // Fallback to LocalAppData
    return join(localAppData, "opencode", "opencode.db")
  }
  const xdgData = process.env.XDG_DATA_HOME || join(home, ".local", "share")
  return join(xdgData, "opencode", "opencode.db")
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const doBackup = args.includes("--backup")
  const dbPathIdx = args.indexOf("--db-path")
  const dbPath = dbPathIdx >= 0 ? args[dbPathIdx + 1] : getDefaultDbPath()

  console.log(`\n  OpenCode Migration Fix`)
  console.log(`  ─────────────────────`)
  console.log(`  Database: ${dbPath}`)
  console.log(`  Mode:     ${dryRun ? "DRY RUN (no changes)" : "LIVE"}`)

  if (!existsSync(dbPath)) {
    console.log(`\n  ✗ Database not found. Nothing to fix.`)
    process.exit(0)
  }

  // Backup if requested
  if (doBackup && !dryRun) {
    const backupPath = `${dbPath}.migration-fix-backup`
    if (!existsSync(backupPath)) {
      copyFileSync(dbPath, backupPath)
      console.log(`  Backup:   ${backupPath}`)
    } else {
      console.log(`  Backup:   already exists, skipping`)
    }
  }

  const db = dryRun ? new Database(dbPath, { readonly: true }) : new Database(dbPath)

  // Check if __drizzle_migrations table exists
  const tableExists = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .get()
  if (!tableExists) {
    console.log(`\n  ✗ No __drizzle_migrations table. Database may be from a very old version.`)
    db.close()
    process.exit(0)
  }

  // Get current migrations
  const rows = db.query("SELECT id, hash, created_at, name, applied_at FROM __drizzle_migrations ORDER BY created_at").all() as any[]

  console.log(`\n  Current state: ${rows.length} migration(s) tracked`)

  // Check if fix is needed
  const nullNames = rows.filter((r) => !r.name)
  if (nullNames.length === 0) {
    console.log(`  ✓ All migrations have names. No fix needed.`)
    db.close()
    process.exit(0)
  }

  console.log(`  ⚠ ${nullNames.length} migration(s) have NULL names — fix needed\n`)

  // Apply fixes
  let fixed = 0
  let added = 0

  for (const [name, expectedTimestamp] of Object.entries(MIGRATIONS)) {
    // Check if this migration name already exists
    const existingByName = db
      .query("SELECT id FROM __drizzle_migrations WHERE name = ?")
      .get(name) as any
    if (existingByName) {
      console.log(`  ✓ ${name} — already tracked`)
      continue
    }

    // Check if there's a row with matching timestamp but null name
    const existingByTs = db
      .query("SELECT id, created_at FROM __drizzle_migrations WHERE created_at = ? AND (name IS NULL OR name = '')")
      .get(expectedTimestamp) as any

    if (existingByTs) {
      if (!dryRun) {
        db.query("UPDATE __drizzle_migrations SET name = ?, applied_at = datetime('now') WHERE created_at = ? AND (name IS NULL OR name = '')")
          .run(name, expectedTimestamp)
      }
      console.log(`  ${dryRun ? "→" : "✓"} ${name} — ${dryRun ? "would update" : "updated"} (matched by timestamp)`)
      fixed++
    } else {
      // No matching row — insert a new one
      if (!dryRun) {
        db.query("INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES ('', ?, ?, datetime('now'))")
          .run(expectedTimestamp, name)
      }
      console.log(`  ${dryRun ? "→" : "✓"} ${name} — ${dryRun ? "would insert" : "inserted"} (no matching timestamp)`)
      added++
    }
  }

  db.close()

  console.log(`\n  Summary: ${fixed} updated, ${added} inserted${dryRun ? " (dry run)" : ""}`)
  if (!dryRun && (fixed > 0 || added > 0)) {
    console.log(`  ✓ Migration tracking fixed! OpenCode should now start correctly.`)
  }
  console.log("")
}

main()
