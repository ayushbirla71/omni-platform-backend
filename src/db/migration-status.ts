import fs from "fs";
import path from "path";
import { query } from "./pool";

// Same location the migrator reads (works from src/db and from the compiled dist/db)
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

/**
 * Migration files shipped with this build that the connected database has not applied yet.
 * Migrations are never run automatically, so a deploy that skips them runs new code against an
 * old schema; surfacing this at boot makes that visible instead of failing request by request.
 */
export async function getPendingMigrations(): Promise<string[]> {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let applied: Set<string>;
  try {
    const rows = await query<{ filename: string }>("SELECT filename FROM schema_migrations");
    applied = new Set(rows.map((r) => r.filename));
  } catch {
    return files; // no schema_migrations table yet: nothing has been applied
  }
  return files.filter((f) => !applied.has(f));
}

/** Identifies the running build: git sha when the deploy provides GIT_SHA, plus when this code was built. */
export function describeBuild(): string {
  const sha = process.env.GIT_SHA ? process.env.GIT_SHA.slice(0, 12) : "unknown-sha";
  let builtAt = "unknown";
  try {
    builtAt = fs.statSync(__filename).mtime.toISOString();
  } catch {
    // keep "unknown"
  }
  const runtime = __filename.endsWith(".ts") ? "ts-node (source)" : "compiled dist";
  return `${sha}, code modified ${builtAt}, ${runtime}, cwd ${process.cwd()}`;
}
