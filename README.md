# Draw Stuff

A tiny collaborative doodle canvas built with TypeScript, Effect, Cloudflare Workers, and Durable Objects. The interface uses system fonts and assets served by the Worker; there are no external runtime services.

## Run locally

Use Node.js 22.12 or newer and pnpm 11.15.1 (pinned in `package.json`).

```sh
pnpm install
pnpm dev
```

Wrangler serves the complete app, including the local Durable Object, at `http://localhost:8787`.

Open the same room URL in two browser windows to draw together. Changes to Worker code reload automatically; rebuild frontend changes with `pnpm build`.

```sh
pnpm test
pnpm build
pnpm exec wrangler deploy --dry-run
```

The regression tests cover acknowledgements, offline recovery, live previews, personal undo, ownership, room resets, validation, capacity, and storage failures.

## Deploy to Cloudflare Free

1. Create a Cloudflare account and open **Workers & Pages** in its dashboard. Use the **Workers Free** plan. No paid plan, trial, custom domain, R2 bucket, or D1 database is required.
2. Authenticate Wrangler with `pnpm exec wrangler login`. Complete Cloudflare's OAuth flow in your browser. Keep credentials out of the repository.
3. Run `pnpm exec wrangler whoami` to confirm the account. If Wrangler lists several accounts, select the intended account during deployment or add its public `account_id` to `wrangler.jsonc`.
4. Run `pnpm run deploy`. The build uploads the static UI and Worker. Wrangler creates the SQLite-backed Durable Object namespace using the checked-in migration. If prompted, choose a `workers.dev` subdomain.
5. Open the resulting `workers.dev` URL. Add `?room=your-room-name` to share a room. The default room is `lobby`.
6. Check Workers and Durable Objects usage in the Cloudflare dashboard. Free quotas are shared across this account's applications; requests fail when a quota is exhausted until it resets.

The app uses a single SQLite-backed Durable Object per room. Workers Free currently includes 100,000 Durable Object requests per day; incoming WebSocket messages count at a 20:1 ratio for request billing, and hibernation avoids duration charges while idle. Cloudflare may update plan limits; see [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## GitHub deployments and previews

Connect the existing `draw-stuff` Worker under **Settings → Builds → Connect** to `joeltheai/draw-stuff`, with `main` as the production branch. Set:

- Build command: `pnpm test && pnpm build`
- Deploy command: `pnpm exec wrangler deploy`
- Preview command: `pnpm exec wrangler preview`
- Root directory: `/`
- Build variables: `NODE_VERSION=24` and `PNPM_VERSION=11.15.1`

Leave **Enable Preview builds** checked. Pushes to `main` update production; other enabled branches get a separate Preview URL. Each Preview automatically receives its own Durable Object namespace and storage. The `previews.durable_objects` configuration supplies the `ROOMS` binding used by this app. Preview drawings do not share production canvas data; resource usage still counts toward the account's quotas.

Commit and push `wrangler.jsonc` and regenerated `worker-configuration.d.ts` before creating preview branches. See [Cloudflare preview configuration](https://developers.cloudflare.com/workers/previews/configuration/).

## Alchemy

[Alchemy](https://alchemy.run/getting-started/) is an Effect-based infrastructure-as-code and deployment tool that supports Cloudflare Workers and Durable Objects. It can replace Wrangler's provisioning workflow and becomes useful when coordinating several resources through an Effect stack. This version keeps Wrangler because all infrastructure fits in one configuration file and one automatic Durable Object migration. Adopting Alchemy would add a separate stack, provider login, and infrastructure state configuration without reducing the resources this app needs.

Application logic uses shared Effect schemas for the wire protocol, Effect services for SQLite storage and WebSocket broadcasting, typed room errors, and an Effect-backed local outbox. Cloudflare handlers bridge into these programs at the runtime boundary.

## Notes

- The drawing surface is a fixed 2000 × 2000 CSS pixels on every device. It never stretches to fit the screen. Choose **Draw** to doodle and **Move** to scroll with a finger or drag with a mouse. Mouse wheels, trackpads, and scrollbars also move the viewport.
- Canvas coordinates remain compatible with existing saved drawings. Drawings created before the fixed-size canvas did not record their original screen dimensions, so their original proportions cannot be recovered automatically.
- Canvas data is stored in the room's Durable Object SQLite storage and restored on reconnect.
- Live stroke previews are broadcast at most once per 60 ms batch and are not stored in SQLite. Finished segments are stored once and acknowledged; duplicate retries do not create duplicate strokes.
- Finished unsynced drawings stay in a per-tab session-storage outbox until acknowledged. They survive reconnects and reloads in that tab. Keep the tab open until it reports **Connected**; closing it can remove its session storage. If browser storage is unavailable or full, the app tells you to keep the tab open.
- Long gestures split into segments of at most 3,000 points, with personal undo removing the whole gesture. Each room holds up to 2,000 segments and 100,000 points. A full room keeps unsaved work locally and retries when an undo or clear creates space.
- Unsaved drawings are restored after reconnect even if the room was cleared in the meantime. Stale queued clear/undo actions are not replayed against a newer canvas. Pressing clear intentionally discards your local pending drawings as well as clearing the room.
- An anonymous browser identity owns new strokes. The server hashes its random token before sharing the author ID, and enforces ownership for undo. Existing drawings from the first version remain visible, but lack personal ownership.
- Anyone with a room URL can draw in that room. Room names are public identifiers, not access controls.
- `pnpm dev` runs the UI and Durable Object locally through Wrangler.
- Run `pnpm cf:types` after changing the Cloudflare bindings or Durable Object configuration.
