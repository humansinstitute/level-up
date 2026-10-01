# Level Up WApp — team invite spike

A mobile-first Vite/React client and Bun server for Nostr sign-in, device-local accounts, public profiles, team creation, reusable QR invites, and team lobbies.

## Run locally

```bash
bun install
bun run build
PORT=3000 bun run start
```

Open `http://localhost:3000`. Players can sign with a NIP-07 browser extension that exposes `window.nostr`, or create a Nostr identity encrypted in IndexedDB on that browser. Any valid signer is accepted by default.

For separate frontend development, run the Bun server on port 3000 and `bun run dev`; Vite proxies `/api` to the server. The production server serves the compiled `dist` directory.

## Access and persistence

Set `WAPP_ACCESS_MODE=restricted` to enable the optional preview allowlist. In restricted mode, Pete's npub is allowed by default; `WAPP_OWNER_NPUB` replaces that owner and `WAPP_ALLOWED_NPUBS_JSON` adds npubs. These values remain server-only.

The managed Level Up app had no usable Tower database binding when this spike was implemented, so domain state uses a narrow repository interface backed temporarily by Bun SQLite. `LEVELUP_DATABASE_PATH` defaults to `runtime-data/levelup.sqlite`; the directory is ignored by Git and must be mounted on durable storage when containerized. Team, membership, hashed invite, project, template-selection, and Round 1 collaboration state survive an app restart. Authentication challenges and cookies remain deliberately in memory, so restart requires users to sign in again without losing their team membership.

`ROUND_BRAINSTORM_SECONDS` configures the server-authored Round 1 deadline and defaults to 300 seconds. Round collaboration uses the same-origin `/api/projects/:id/round-stream` WebSocket, with authenticated HTTP snapshots and event catch-up as recovery paths.

Tower-managed Postgres through the generic WApp database API remains the accepted production authority. SQLite is a local spike adapter, not a change to that decision.

Device-account secrets never reach the server. The browser vault uses PBKDF2-SHA-256 and AES-256-GCM; logout locks the decrypted key but retains the encrypted record until the player explicitly forgets it. Public kind-0 profiles are cached separately in Dexie and refreshed from the three CSP-allowlisted relays without blocking the team lobby.
