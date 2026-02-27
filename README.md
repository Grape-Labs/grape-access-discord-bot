# Grape Access Discord Bot

Discord bot that assigns/removes guild roles based on Grape Access gate checks.

## Features

- Slash commands:
  - `/setup-gate gate_id guild_id pass_role_id [fail_action]`
  - `/verify`
  - `/check user_wallet gate_id`
  - `/sync-gate gate_id`
- SQLite persistence for gate mappings, identity links, and check history.
- Revalidation worker that re-checks mapped users on an interval.
- Gate metadata manifest (`grape.access-manifest.v1`) support with DB/config overrides.
- Structured logs for checks and role updates.
- Dry-run mode for sync/revalidation role changes.

## Required env vars

Copy `.env.example` and set values.

- `DISCORD_TOKEN`: bot token.
- `DISCORD_CLIENT_ID`: application client ID.
- `DISCORD_GUILD_ID`: default guild for command registration.
- `RPC_ENDPOINT`: Solana RPC URL.
- `CLUSTER`: `mainnet-beta` | `devnet` | `testnet`.
- `CHECK_MODE`: `simulate` (default) or `write`.
- `ACCESS_FRONTEND_BASE_URL`: frontend origin that serves `/access`.

## Setup

```bash
npm install
npm run register-commands
npm run dev
```

## Verification link callback

To persist `user_wallet_links`, post verification results to:

- `POST /verification/link`
- Optional auth header: `x-verify-secret: <VERIFY_SHARED_SECRET>`
- JSON body:
  - `discordUserId`
  - `walletPubkey`
  - `guildId`
  - Optional: `verifiedAt`, `source`

## Data model

Tables:

- `guild_gate_map(guild_id, gate_id, pass_role_id, fail_action, enabled)`
- `user_wallet_links(discord_user_id, wallet_pubkey, guild_id, verified_at)`
- `check_results(discord_user_id, wallet_pubkey, gate_id, passed, checked_at, source, proof)`
- `bot_settings(recheck_interval_sec, rpc_endpoint, cluster)`

## Notes

- Never stores user private keys.
- Bot should have least-privilege role permissions (manage roles only where required).
- `/verify` returns links:
  - Access check: `<ACCESS_FRONTEND_BASE_URL>/access?gateId=<gate_id>`
  - Verification: `https://verification.governance.so/dao/<DAO_ID>`
  - Reputation: `https://vine.governance.so/dao/<DAO_ID>`
