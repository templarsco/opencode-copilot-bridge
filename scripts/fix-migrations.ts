#!/usr/bin/env bun
// fix-migrations.ts — Fix OpenCode Drizzle migration tracking + missing tables
//
// Problem 1: OpenCode v1.2.21+ updated Drizzle ORM from beta.12 to beta.16,
// which changed migration tracking from hash-based to name-based.
// Databases created by older versions have __drizzle_migrations entries
// with NULL names. New Drizzle doesn't recognize them → tries to re-run
// all migrations → CREATE TABLE fails → app crashes.
//
// Problem 2: Some migrations partially failed under the old tracking system.
// E.g., blue_harpoon was supposed to create both `account` and `account_state`
// tables, but only `account` was created. When new migrations reference the
// missing tables, the app crashes.
//
// Fix: Backfill migration names AND create any missing tables that should
// have been created by earlier migrations.
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
  "20260309230000_move_org_to_state": 1741564800000,
}

// Tables that MUST exist for the app to work.
// Each entry describes the table, which migration should have created it,
// and the CREATE TABLE SQL to use if it's missing.
const REQUIRED_TABLES: {
  name: string
  migration: string
  createSQL: string
  description: string
}[] = [
  {
    name: "account",
    migration: "20260228203230_blue_harpoon",
    description: "User account credentials and tokens",
    createSQL: `CREATE TABLE IF NOT EXISTS account (
      id text PRIMARY KEY NOT NULL,
      email text NOT NULL,
      url text NOT NULL,
      access_token text NOT NULL,
      refresh_token text NOT NULL,
      token_expiry integer,
      workspace_id text,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    )`,
  },
  {
    name: "account_state",
    migration: "20260228203230_blue_harpoon",
    description: "Active account selection state",
    createSQL: `CREATE TABLE IF NOT EXISTS account_state (
      id integer PRIMARY KEY NOT NULL,
      active_account_id text REFERENCES account(id) ON DELETE SET NULL,
      active_org_id text
    )`,
  },
]

// Columns that migrations add/remove. We need to handle cases where
// intermediate column states don't match what the migration expects.
const COLUMN_FIXES: {
  table: string
  column: string
  migration: string
  action: "ensure_absent" | "ensure_present"
  columnDef?: string
  description: string
}[] = [
  {
    table: "account",
    column: "selected_org_id",
    migration: "20260309230000_move_org_to_state",
    action: "ensure_absent",
    description:
      "Migration #8 drops selected_org_id from account. If it was never created, that's fine — just make sure it's gone.",
  },
]

function getDefaultDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  if (process.platform === "win32") {
    const xdgData =
      process.env.XDG_DATA_HOME || join(home, ".local", "share")
    const xdgPath = join(xdgData, "opencode", "opencode.db")
    if (existsSync(xdgPath)) return xdgPath
    const localAppData =
      process.env.LOCALAPPDATA || join(home, "AppData", "Local")
    return join(localAppData, "opencode", "opencode.db")
  }
  const xdgData = process.env.XDG_DATA_HOME || join(home, ".local", "share")
  return join(xdgData, "opencode", "opencode.db")
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(tableName) as any
  return !!row
}

function columnExists(
  db: Database,
  tableName: string,
  columnName: string,
): boolean {
  const cols = db.query(`PRAGMA table_info('${tableName}')`).all() as any[]
  return cols.some((c) => c.name === columnName)
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const doBackup = args.includes("--backup")
  const dbPathIdx = args.indexOf("--db-path")
  const dbPath =
    dbPathIdx >= 0 ? args[dbPathIdx + 1] : getDefaultDbPath()

  console.log(`\n  OpenCode Migration Fix v2`)
  console.log(`  ────────────────────────`)
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

  const db = dryRun
    ? new Database(dbPath, { readonly: true })
    : new Database(dbPath)

  // Check if __drizzle_migrations table exists
  if (!tableExists(db, "__drizzle_migrations")) {
    console.log(
      `\n  ✗ No __drizzle_migrations table. Database may be from a very old version.`,
    )
    db.close()
    process.exit(0)
  }

  // ─── Phase 1: Fix migration names ───────────────────────────────
  const rows = db
    .query(
      "SELECT id, hash, created_at, name, applied_at FROM __drizzle_migrations ORDER BY created_at",
    )
    .all() as any[]

  console.log(`\n  Phase 1: Migration name tracking`)
  console.log(`  ── ${rows.length} migration(s) currently tracked`)

  const nullNames = rows.filter((r) => !r.name)
  let namesFixed = 0
  let namesAdded = 0

  if (nullNames.length > 0) {
    console.log(
      `  ⚠ ${nullNames.length} migration(s) have NULL names — fix needed\n`,
    )
  }

  for (const [name, expectedTimestamp] of Object.entries(MIGRATIONS)) {
    // Check if this migration name already exists
    const existingByName = db
      .query("SELECT id FROM __drizzle_migrations WHERE name = ?")
      .get(name) as any
    if (existingByName) {
      continue
    }

    // Check if there's a row with matching timestamp but null name
    const existingByTs = db
      .query(
        "SELECT id, created_at FROM __drizzle_migrations WHERE created_at = ? AND (name IS NULL OR name = '')",
      )
      .get(expectedTimestamp) as any

    if (existingByTs) {
      if (!dryRun) {
        db.query(
          "UPDATE __drizzle_migrations SET name = ?, applied_at = datetime('now') WHERE created_at = ? AND (name IS NULL OR name = '')",
        ).run(name, expectedTimestamp)
      }
      console.log(
        `  ${dryRun ? "→" : "✓"} ${name} — ${dryRun ? "would update" : "updated"} (matched by timestamp)`,
      )
      namesFixed++
    } else {
      // No matching row — insert a new one
      if (!dryRun) {
        db.query(
          "INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES ('', ?, ?, datetime('now'))",
        ).run(expectedTimestamp, name)
      }
      console.log(
        `  ${dryRun ? "→" : "✓"} ${name} — ${dryRun ? "would insert" : "inserted"} (no matching entry)`,
      )
      namesAdded++
    }
  }

  if (namesFixed === 0 && namesAdded === 0) {
    console.log(`  ✓ All migration names are correct.`)
  } else {
    console.log(
      `\n  Names: ${namesFixed} updated, ${namesAdded} inserted${dryRun ? " (dry run)" : ""}`,
    )
  }

  // ─── Phase 2: Create missing tables ─────────────────────────────
  console.log(`\n  Phase 2: Table integrity`)

  let tablesCreated = 0

  for (const table of REQUIRED_TABLES) {
    if (tableExists(db, table.name)) {
      continue
    }

    console.log(
      `  ⚠ Table '${table.name}' missing (should exist from ${table.migration})`,
    )
    console.log(`    ${table.description}`)

    if (!dryRun) {
      db.exec(table.createSQL)
      console.log(`  ✓ Created '${table.name}'`)
    } else {
      console.log(`  → Would create '${table.name}'`)
    }
    tablesCreated++
  }

  if (tablesCreated === 0) {
    console.log(`  ✓ All required tables exist.`)
  }

  // ─── Phase 3: Column state reconciliation ───────────────────────
  console.log(`\n  Phase 3: Column reconciliation`)

  let columnsFixed = 0

  for (const fix of COLUMN_FIXES) {
    if (!tableExists(db, fix.table)) continue

    const hasCol = columnExists(db, fix.table, fix.column)

    if (fix.action === "ensure_absent" && hasCol) {
      // SQLite doesn't support DROP COLUMN on older versions, but
      // Bun's SQLite (3.45+) does. If it fails, we skip — the
      // column being present won't break anything, migration #8
      // just needs to not fail when trying to drop it.
      if (!dryRun) {
        try {
          db.exec(`ALTER TABLE ${fix.table} DROP COLUMN ${fix.column}`)
          console.log(
            `  ✓ Dropped '${fix.table}.${fix.column}' (${fix.description})`,
          )
          columnsFixed++
        } catch (e: any) {
          console.log(
            `  ⚠ Could not drop '${fix.table}.${fix.column}': ${e.message}`,
          )
          console.log(
            `    This is non-critical — the column will be ignored.`,
          )
        }
      } else {
        console.log(
          `  → Would drop '${fix.table}.${fix.column}' (${fix.description})`,
        )
        columnsFixed++
      }
    } else if (fix.action === "ensure_present" && !hasCol) {
      if (fix.columnDef) {
        if (!dryRun) {
          db.exec(
            `ALTER TABLE ${fix.table} ADD COLUMN ${fix.column} ${fix.columnDef}`,
          )
          console.log(
            `  ✓ Added '${fix.table}.${fix.column}' (${fix.description})`,
          )
          columnsFixed++
        } else {
          console.log(
            `  → Would add '${fix.table}.${fix.column}' (${fix.description})`,
          )
          columnsFixed++
        }
      }
    }
  }

  if (columnsFixed === 0) {
    console.log(`  ✓ All columns in expected state.`)
  }

  // ─── Summary ────────────────────────────────────────────────────
  const totalFixes = namesFixed + namesAdded + tablesCreated + columnsFixed
  console.log(`\n  ═══════════════════════════`)
  if (totalFixes === 0) {
    console.log(`  ✓ Database is healthy. No fixes needed.`)
  } else if (dryRun) {
    console.log(
      `  DRY RUN: ${totalFixes} fix(es) would be applied.`,
    )
    console.log(`  Run without --dry-run to apply.`)
  } else {
    console.log(`  ✓ Applied ${totalFixes} fix(es). OpenCode should now start correctly.`)
  }
  console.log("")

  db.close()
}

main()
