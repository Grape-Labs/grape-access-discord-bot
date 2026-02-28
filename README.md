# Grape Access Discord Bot (Vercel + KV)

Discord bot that assigns/removes roles based on Grape Access checks using:

- Discord Interactions webhook (`/api/discord/interactions`)
- Verification callback (`/api/verification/link`)
- Vercel Cron worker (`/api/cron/revalidate`)

## State persistence

State is stored in **Vercel KV**:

- Gate mappings from `/setup-gate`
- User wallet links from `/api/verification/link`
- Sync jobs from `/sync-gate`
- Worker last-run timestamps

Set a `KV_KEY_PREFIX` if you share the same KV instance with other apps.

DAO ID resolution for `/verify` links:

- Uses explicit `dao_id` from `/setup-gate` when provided
- Otherwise attempts on-chain recovery from gate criteria accounts (Vine config / Grape space)
- Falls back to manifest `daoId` when available

## Commands

- `/setup-gate gate_id guild_id pass_role_id [dao_id] [fail_action]`
- `/verify`
- `/check`
- `/sync-gate gate_id [dry_run]`

`/check` behavior:

- Uses your latest linked wallet for this guild
- Checks all enabled gate mappings for the guild
- If no local wallet link exists, attempts on-chain Grape Verification lookup via DAO + Discord identity

## Environment variables

Copy `.env.example` and set:

- `DISCORD_APP_ID`
- `DISCORD_BOT_TOKEN`
- `DISCORD_PUBLIC_KEY`
- `ACCESS_FRONTEND_BASE_URL`

Optional:

- `DISCORD_COMMAND_GUILD_ID` (faster command updates)
- `VERIFY_SHARED_SECRET`
- `CRON_SECRET`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `KV_REST_API_READ_ONLY_TOKEN`
- `KV_URL`
- `REDIS_URL`
- `KV_KEY_PREFIX` (default: `grape-access-discord-bot:v1`)
- `BOOTSTRAP_GATES_JSON`
  - Supports optional `daoId` for verification/reputation links.

## Local dev

```bash
npm install
npm run register-commands
npm run dev
```

## RPC Diagnostics

For direct RPC connectivity diagnostics from your deployed runtime:

- `GET /api/rpc/ping`
- Optional override: `GET /api/rpc/ping?endpoint=<urlencoded_rpc_endpoint>`

## Verification callback format

POST `/api/verification/link`

Headers:

- `x-verify-secret: <VERIFY_SHARED_SECRET>` (if configured)

JSON body:

- `discordUserId` (required)
- `walletPubkey` (required)
- `guildId` (required)
- `gateId` (optional; if set, syncs only that gate)
- `verifiedAt` (optional)
- `source` (optional)

## Program IDs

- Access: `GPASSzQQF1H8cdj5pUwFkeYEE4VdMQtCrYtUaMXvPz48`
- Verification: `VrFyyRxPoyWxpABpBXU4YUCCF9p8giDSJUv2oXfDr5q`
- Reputation: `V1NE6WCWJPRiVFq5DtaN8p87M9DmmUd2zQuVbvLgQwX`
