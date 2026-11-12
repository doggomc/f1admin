# Headquarters deployment

This code supports a separate Headquarters service and multiple backend replicas. Nothing is deployed merely by merging it. Existing deployments remain unchanged in the default `CONTROL_ROLE=standalone` mode.

## Architecture and safety

Headquarters is the **single writer** of a shared Race Control snapshot, stored under `freef1:headquarters:control:v1` in a shared Upstash Redis REST database. Backends in `replica` mode read it once at startup and again when they receive an authenticated update notification from Headquarters. There is **no periodic sync polling**. Headquarters sends one request to each configured backend after saving a change; each available backend makes one small shared-store read and then updates open site tabs via the existing update stream. Delivery is normally prompt but network delays and cold starts can occur.

Replicas keep their last confirmed snapshot in memory and save it to `DATA_DIR/race-control.json`. If Headquarters is offline but Upstash is up, replicas still work. If Upstash is down too, running replicas retain their settings; surviving a replica restart while Upstash is also down requires a persistent local disk. Without a prior valid snapshot, a new replica uses local/default state and is not guaranteed to match Headquarters. Do not rely on ephemeral Render storage for restart survival.

Only one active Headquarters instance may write. Authenticated replica admin changes are forwarded to Headquarters, which validates, saves and pushes them to all backends. Set `HQ_URL` on each replica. If Headquarters cannot be reached, the save is not confirmed and existing settings remain in use; check Headquarters before retrying, because a network timeout can leave the result uncertain. Headquarters commits changes to Upstash before confirming success and does not broadcast failed changes. If a write times out, its outcome can be unknown: Headquarters stops accepting further changes until it is restarted and re-reads the shared state. Inspect the setting after restarting; never assume a timed-out write did or did not reach Redis. Two Headquarters instances or an old standalone writer do not coordinate and are unsupported.

The shared control-store variables below are separate from existing `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, which continue to serve Discord/Help storage. Existing keys and ticket/bot data are not automatically migrated. Do not run the same Discord bot on multiple services. Keep it on the main backend unless deliberately switched, and leave the Headquarters bot token unset. Discord alert state and Help tickets are not synchronized by the control snapshot; ticket failover requires its own careful storage and bot plan.

## Configuration

Provision a shared Upstash REST database for control settings. On Headquarters and every participating backend set:

- `HQ_UPSTASH_REDIS_REST_URL` and `HQ_UPSTASH_REDIS_REST_TOKEN` to that shared database (secret; never use VITE variables).
- `HQ_URL` on each replica to the Headquarters HTTPS origin only, e.g. `https://f1hq.onrender.com`.
- `HQ_PUSH_SECRET` to the same strong random secret (at least 32 characters) on Headquarters and its replicas. Keep it private; rotate on all services together.
- `CONTROL_ROLE=headquarters` on the separate Headquarters Render service; `CONTROL_ROLE=replica` on the main backend and future backend services. Keep `standalone` until the migration is ready.
- Normal production admin credentials and secrets on every server; use unique credentials. Replica admin endpoints forward supported control changes to Headquarters after local admin authentication.
- `DATA_DIR` on a persistent disk for each replica where restart resilience is required. Never share a writable disk between servers.
- Existing `UPSTASH_REDIS_REST_*`, bot and Help configuration on the main backend remain unchanged.
- For each backend set `ALLOWED_ORIGIN` and `RELAY_ALLOWED_ORIGINS` to the exact frontend origins intended to use it (comma-separated). Stripped players have a separate allowlist. The current live site and existing approved preview pattern remain allowed for relay framing.

On Headquarters, configure `HQ_PUSH_TARGETS` separately as a JSON array of named backend **origins** (not frontend URLs or health paths), for example:

```
[{"name":"Main backend","url":"https://f1admin.onrender.com"}]
```

Every backend must have the same `HQ_PUSH_SECRET` and shared-store credentials and be running in replica mode. Do not send this secret to an untrusted backend. The control request is HTTPS, has no redirects, and is authenticated. After a save, delivery failures are shown on the dashboard; the save itself remains committed. An offline backend keeps its last known state. When it restarts it reads the latest settings once; if it stays running but misses the request, use **Retry backend updates** when it is available, or make a later change. There is no automatic background retry or periodic check. If shared storage is unavailable when it receives a notification, the backend retains its prior state and reports failure. A successful HTTP health check does not guarantee update delivery.

On Headquarters, set `HQ_TARGETS` to a JSON array of named health-check URLs, for example:

```
[{"name":"Main frontend","type":"frontend","url":"https://freef1-live.vercel.app/"},{"name":"Main backend","type":"backend","url":"https://f1admin.onrender.com/healthz"}]
```

Add future services by editing this variable and redeploying Headquarters. Only deployment-configured HTTPS URLs are checked, with a five-second timeout and no redirects. The dashboard checks when loaded or when **Check status** is clicked; it does not run a periodic health monitor. An HTTP result is not proof of playback, end-user connectivity, synchronization, or complete feature health.

For an additional frontend, set Vercel build variable `VITE_BACKEND_URL` to its backend HTTPS origin only, then rebuild. If unset, the current production backend remains the default. No credentials belong in frontend variables. Configure CORS and relay origins on the selected backend. Vercel/Render projects and DNS are not created by this code.

## Migrate current settings (one-time)

1. Back up the primary Race Control state and deployment settings. Confirm the existing combined `freef1:race-control:v1` snapshot exists in the current primary Upstash database. If it is only on local disk or legacy keys, first migrate/export it using the existing system; the seed tool does not guess or delete legacy state.
2. Temporarily stop admin changes on the current backend. Ensure there is no other Headquarters writer. Supply `SOURCE_UPSTASH_URL`, `SOURCE_UPSTASH_TOKEN`, `HQ_UPSTASH_REDIS_REST_URL`, `HQ_UPSTASH_REDIS_REST_TOKEN`, and `CONFIRM_HQ_SEED=yes` as secure environment variables, then run `node scripts/headquarters-seed.js`. Do not paste tokens into chat or commit them. The script reads the existing combined snapshot, strips retired News, and uses `SET NX` so it cannot overwrite an existing Headquarters snapshot. Verify the result before proceeding. If storage only has defaults, use caution: initializing it replaces nothing in the source but could result in wrong controls on replicas.
3. Deploy Headquarters with the shared-store variables and inventory. Verify the dashboard and imported settings. Keep its Discord bot disabled. Configure and deploy the primary backend as a replica with the same shared store, retaining its existing bot/ticket settings and durable storage. Test source controls, page outage, maintenance, authenticated push delivery, missed-update retry, open-tab updates and relay behavior. Resume edits through Headquarters or the authenticated replica admin panel after verifying push delivery. Record the previous deployment settings for rollback.
4. For a deliberately fresh setup only, `HQ_INITIALIZE=true` allows Headquarters to create defaults when the shared key is absent. Remove it after initialization; do not use it instead of importing existing state. It uses `SET NX` and never replaces a populated key.

If rolling back to standalone, first stop Headquarters edits and back up the latest shared state. The old standalone snapshot is not automatically updated, so restore the intended settings explicitly before accepting writes again. Do not allow old and new writers to run concurrently.
