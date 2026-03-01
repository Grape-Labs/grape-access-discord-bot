#!/usr/bin/env node
import "dotenv/config";
import { kv } from "@vercel/kv";

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) {
    return undefined;
  }
  return process.argv[idx + 1];
}

const apply = process.argv.includes("--apply");
const yes = process.argv.includes("--yes");
const prefix = getArg("--prefix") || process.env.KV_KEY_PREFIX || "grape-access-discord-bot:v1";

if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error("Missing KV_REST_API_URL or KV_REST_API_TOKEN.");
  process.exit(1);
}

const match = `${prefix}:*`;
const keys = [];
let cursor = "0";
do {
  const [next, batch] = await kv.scan(cursor, { match, count: 1000 });
  cursor = String(next);
  for (const key of batch) {
    keys.push(key);
  }
} while (cursor !== "0");

console.log(`Prefix: ${prefix}`);
console.log(`Matched keys: ${keys.length}`);
console.log(`Sample keys: ${keys.slice(0, 20).join(", ") || "none"}`);

if (!apply) {
  console.log("Dry run only. Re-run with --apply --yes to delete.");
  process.exit(0);
}

if (!yes) {
  console.error("Refusing to delete without --yes.");
  process.exit(1);
}

for (let i = 0; i < keys.length; i += 200) {
  const chunk = keys.slice(i, i + 200);
  if (chunk.length > 0) {
    // @vercel/kv supports variadic del.
    await kv.del(...chunk);
  }
}

console.log(`Deleted keys: ${keys.length}`);
