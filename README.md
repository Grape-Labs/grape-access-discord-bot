# Grape Access Discord Bot (Vercel + KV)

Discord bot that assigns/removes roles based on Grape Access checks using:

- Discord Interactions webhook (`/api/discord/interactions`)
- Verification callback (`/api/verification/link`)
- Verification callback alias (`/api/discord/callback`)
- Vercel Cron worker (`/api/cron/revalidate`)

## State persistence

State is stored in **Vercel KV**:

- Gate mappings from `/setup-gate`
- User wallet links from `/api/verification/link`
- Sync jobs from `/sync-gate`
- Worker last-run timestamps

Set a `KV_KEY_PREFIX` if you share the same KV instance with other apps.

DAO ID resolution for `/verify` links:

- Uses explicit `verification_dao_id` and `reputation_dao_id` from `/setup-gate` when provided
- Uses `dao_id` as fallback for either DAO when specific values are omitted
- Otherwise attempts on-chain recovery from gate criteria accounts (Vine config / Grape space)
- Falls back to manifest `daoId` when available

## Commands

- `/setup-gate gate_id pass_role_id [guild_id] [dao_id] [verification_dao_id] [reputation_dao_id] [fail_action]`
- `/verify`
- `/check`
- `/debug-identity gate_id`
- `/link-identity gate_id identity_pda [link_pda]`
- `/link-wallet wallet`
- `/sync-gate gate_id [dry_run]`

`/check` behavior:

- Uses your latest linked wallet for this guild
- Checks all enabled gate mappings for the guild
- If no local wallet link exists, attempts on-chain Grape Verification lookup via DAO + Discord identity
- With `BASIC_IDENTITY_CHECK_MODE=true`, falls back to identity-only pass/fail when wallet link is missing

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
- `BASIC_IDENTITY_CHECK_MODE` (default `true`)
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `KV_REST_API_READ_ONLY_TOKEN`
- `KV_URL`
- `REDIS_URL`
- `KV_KEY_PREFIX` (default: `grape-access-discord-bot:v1`)
- `BOOTSTRAP_GATES_JSON`
  - Supports optional `verificationDaoId`, `reputationDaoId`, and `daoId` fallback.

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

POST/GET `/api/verification/link`

Aliases:

- `/api/discord/callback`
- `/api/verification/add`
- `/api/verification/verify`

Headers:

- `x-verify-secret: <VERIFY_SHARED_SECRET>` (if configured)
- `authorization: Bearer <VERIFY_SHARED_SECRET>` (also supported)

JSON body:

- `discordUserId` (required)
- `walletPubkey` (required)
- `guildId` (required unless `gateId` maps to exactly one configured guild)
- `gateId` (optional; if set, syncs only that gate)
- `verifiedAt` (optional)
- `source` (optional)
- `identityPda` (optional; stores identity override for mapped gate(s))
- `linkPda` (optional; stores link override for mapped gate(s))

Snake_case and nested body payload variants are supported (for example: `discord_user_id`, `wallet_pubkey`, `guild_id`, `gate_id`, `identity_pda`, `link_pda`, and nested under `payload`, `data`, `event`, `verification`, `context`, `meta`, or `result`).

GET query aliases supported:

- `discordUserId` or `discord_user_id` or `platform_user_id`
- `walletPubkey` or `wallet` or `wallet_pubkey` or `wallet_address` or `address`
- `guildId` or `guild_id` or `guild`
- `gateId` or `gate_id`
- `identityPda` or `identity_pda` or `identityAccount`
- `linkPda` or `link_pda` or `linkAccount`

## Program IDs

- Access: `GPASSzQQF1H8cdj5pUwFkeYEE4VdMQtCrYtUaMXvPz48`
- Verification: `VrFyyRxPoyWxpABpBXU4YUCCF9p8giDSJUv2oXfDr5q`
- Reputation: `V1NE6WCWJPRiVFq5DtaN8p87M9DmmUd2zQuVbvLgQwX`
