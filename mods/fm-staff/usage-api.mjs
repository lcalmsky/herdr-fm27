// Reads Claude Code's keychain credentials JSON on stdin, asks the usage endpoint /usage reads, and
// prints {fetched_at, fable?: {used, resets_at}}. Exits 1 on any failure so cca keeps the last record.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The endpoint's `limits` row for the Fable week: kind "weekly_scoped" scoped to the model named Fable.
export function fableOf(body) {
  const row = (body?.limits ?? []).find((l) => l?.kind === "weekly_scoped" && /^fable$/i.test(l.scope?.model?.display_name ?? ""));
  if (!row || typeof row.percent !== "number") return null;
  const at = Date.parse(row.resets_at);
  return { used: row.percent, resets_at: Number.isFinite(at) ? Math.floor(at / 1000) : null };
}

async function main() {
  let creds = "";
  for await (const chunk of process.stdin) creds += chunk;
  const token = JSON.parse(creds).claudeAiOauth.accessToken;
  const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) process.exit(1);
  const fable = fableOf(await r.json());
  process.stdout.write(JSON.stringify({ fetched_at: Math.floor(Date.now() / 1000), ...(fable && { fable }) }));
}

// Compared as real paths: a file URL escapes spaces and non-ASCII, and argv may go through a link.
const entry = process.argv[1] && realpathSync(process.argv[1]);
if (entry === realpathSync(fileURLToPath(import.meta.url))) main().catch(() => process.exit(1));
