# CLAUDE.md

Project-state context for AI sessions. README.md describes what the tool
is and how to develop on it. This file captures the non-obvious things
that aren't documented there or in the code — the deploy quirks, branch
topology at time of writing, and patterns worth knowing before changing
things.

Snapshot date: 2026-05-30.

## Branch topology (as of snapshot)

- `main` (`b1d034e`) — production. Pre-dates the demo seeder and the
  preview environment.
- `seed-demo-data` (origin) — unmerged. Adds `scripts/seed.mjs` +
  `scripts/seed-data.mjs` and the `[env.preview]` block in
  `wrangler.toml`. PR open at
  github.com/noahschmuckler/throughline/pull/new/seed-demo-data.
- `adhoc-inbox` (origin) — unmerged, branched off `seed-demo-data`.
  Adds the Ad-hoc capture flow, Inbox container, and closed-action
  display. PR open at
  github.com/noahschmuckler/throughline/pull/new/adhoc-inbox.
- `system-ui-and-triage` (current) — unmerged, branched off
  `adhoc-inbox`. The big one: the project **dashboard** (tile grid +
  glidepath + People view), the **entry triage** ingestion modal, a
  schema bump to **v2**, and a second backend (**Node server** over a
  JSON file) so the stack can run locally on orange device against a
  OneDrive-backed DB. See the new sections below.

Each branch stacks on the previous. Verify what a branch actually adds
with `git log main..HEAD --oneline` before reading the diff.

## Deployment model — the important quirk

This repo runs as Cloudflare Workers + Assets (not Cloudflare Pages,
despite older language in README). Two distinct workers exist:

- **`throughline`** — production. Bound to KV namespace
  `fcf9208b03f54eaabd6524f5a76c7f03`. Deployed automatically by
  Cloudflare's git integration on push to `main`.
- **`throughline-preview`** — preview. Bound to KV namespace
  `db3df52a08194d30a50c55bbdd6343bf`. URL:
  `https://throughline-preview.noah-schmuckler.workers.dev`. Deployed
  **manually** via `npx wrangler deploy --env preview` from a local
  checkout that has the `[env.preview]` block in wrangler.toml.

The Cloudflare dashboard's "non-production deploy command" for Workers
Builds is NOT configured to `wrangler deploy --env preview`, so pushing
a non-main branch does NOT redeploy the preview worker on its own.
Until that is set up (Workers & Pages → throughline → Settings → Builds
→ Non-production deploy command), every preview deploy is a manual
terminal step.

`wrangler dev` (local) uses `preview_id` on the top-level KV binding,
so local hacking writes to the preview namespace, not production.

## Second backend — Node server (orange device) — added on `system-ui-and-triage`

There are now **two** backends serving the **same** `public/` SPA with
the **same** API (`GET/PUT /api/state`, `POST /api/atomize`):

- **Cloudflare Worker** (`src/index.js`) — the cloud demo. State in KV.
- **Node server** (`server.js` + `lib/store.js`) — the orange-device /
  local form. State is one JSON file at `THROUGHLINE_DB` (default
  `./data/state.json`, gitignored). Run with `npm start` (`node
  server.js`), default `http://127.0.0.1:8787`. **On orange, point
  `THROUGHLINE_DB` at a file inside a OneDrive shared folder** so the
  dyad shares one project DB — this is the production target; deploy it
  the way atom_sandbox does (logon scheduled task; see
  `~/GitHub_Repos/atom_sandbox/deploy/`). Config via `.env.example`.

The front-end is byte-for-byte identical against either backend — it
only speaks REST. Writes are atomic-ish (tmp + rename) in `lib/store.js`.

## AI ingestion seam (stub today)

`shared/atomize.js` + `shared/llm.js` are **runtime-agnostic** ESM (no
`node:*`, only `fetch`) imported by **both** backends. `/api/atomize`
runs `atomizeEntry(entry, { projects, llmCall })`; `makeLLMCall(env)`
picks the provider from `LLM_PROVIDER`:

- **`heuristic`** (default) — deterministic stub (sentence-split +
  keyword classify + project keyword-match). Zero spend; the shipping
  default so the capture→triage→commit loop always works.
- **`anthropic`** (+`ANTHROPIC_API_KEY`) — real Messages API. Cloud /
  dev box. On the Worker, set the key with `wrangler secret put`.
- **`cdsapi`** — Optum's on-network `single_response` endpoint
  (`POST {system,user,model,verbose}`, reply under
  `response|reply|text|content|output|answer`). **This is the
  orange-device provider** — the enterprise box can't reach Anthropic,
  but cdsapi needs no key on-network. Tier models `gpt-nano|gpt-mini|
  gpt-5.4`; pin one with `LLM_MODEL`. Mirrors atom_sandbox's
  `lib/llm.js` exactly so the two stay translatable.

`atomizeEntry` is provider-agnostic: it sends the prompt
(`buildAtomizePrompt`), then `parseModelJson` tolerantly pulls JSON out
of the reply (handles ```` ```json ```` fences / surrounding prose); a
bad/empty reply degrades to the heuristic rather than 500-ing. Remaining
model-quality work is marked `// TODO(AI)`.

## Demo data

`scripts/seed.mjs` populates 6 containers (3 projects + 3 reference
files) with ~42 entries and ~95 atoms spanning a "busy week" centered
on the Friday of the run week. Dates are computed relative to "now" so
re-running keeps the demo fresh. All demo containers have ids prefixed
`demo_`; the runner refuses to clobber existing demo data without
`--force` and always preserves non-demo containers.

Usage:

```
node scripts/seed.mjs                                              # local
node scripts/seed.mjs --target prod --url https://<deployed-url>   # cloud
node scripts/seed.mjs --force                                      # reseed
```

The preview KV currently has the seeded demo data (was populated via
the preview worker URL). Production KV is whatever was there
beforehand — by snapshot date that's just one leftover `smoke_5` test
container.

## Data model — at a glance

Authoritative source: `public/app.js` (vanilla DOM, single-file SPA,
hash-routed) and `src/index.js` (Worker stub; only `/api/state` is
handled, everything else is static assets).

- **State doc** (KV key `throughline:state`, or the Node JSON file):
  `{ schema_version: 2, containers[], entries[], atoms[], people_meta{} }`.
  **v2 is backward-compatible**: both backends + `normalizeState` in
  `public/app.js` tolerate v1 docs (default the missing fields) and
  preserve unknown keys on write.
- **`containers[]`**: `{ id, type, title, goal_or_purpose, summary,
  tags[], status, created_at, updated_at }` where `type` is one of
  `'project' | 'reference_file' | 'inbox'`. Inbox is a singleton with
  id `'inbox'`, lazy-created on first ad-hoc capture. **Projects gained
  optional v2 metadata**: `emoji, color, category, completion (0–100),
  owners[], next_meeting (YYYY-MM-DD), metrics[]` where each metric is
  `{ label, target, color, data:number[], interventions:[{idx,label}] }`
  (drives the glidepath). All optional — absent on references/inbox and
  on lean projects.
- **`people_meta`**: `{ [name]: { title, color, pathways[], reports[] } }`
  — optional overlay. People themselves are **derived** from atom
  `assigned_to` (see `derivePeople()`); `people_meta` only adds the
  hand-authored extras (empty by default).
- **`entries[]`**: `{ id, container_id, kind, occurred_at, title,
  participants[], tags[], notes, created_at, updated_at }` where
  `kind` is one of `'meeting' | 'email' | 'freetext'`.
- **`atoms[]`**: `{ id, entry_id, kind, body, tags[], created_at,
  updated_at }` where `kind` is one of `'observation' | 'decision' |
  'action' | 'outcome'`. Actions add `assigned_to`, `due_date`.
  Outcomes add `parent_atom_id` linking back to the action/decision
  they close.
- An action is "open" iff no outcome has its id as `parent_atom_id`.
  Closure is derived, never stored on the action.

## Patterns worth knowing before changing things

- **Type-label central lookup**: `CONTAINER_LABELS` in `public/app.js`.
  Adding a fourth container type is one row there plus styling for the
  matching `.type-mark.<cls>` and `.type-badge.<cls>` rules.
- **Drawer flow**: `openEntryDrawer(containerId, entryId)`. If
  `entryId` is null, a fresh entry is pushed into state at
  `containerId`. The drawer's container picker lets entries be
  *moved* between containers by mutating `entry.container_id`.
- **Ad-hoc capture**: `openAdHocEntryDrawer()` lazy-creates Inbox via
  `getOrCreateInbox()` and opens the drawer pre-pointed at it. The
  picker still allows immediate filing into a project / reference.
- **Promote (Inbox → new container)**: `openNewContainerModal(type, {
  presetTitle, onCreate })`. The `onCreate` callback fires after the
  new container is created and is used to reassign the entry's
  `container_id` to the new id.
- **Closed-action display**: action atoms detect their closing outcome
  via `outcomeForAction(actionId)`. Closed actions swap rail color
  (copper → moss), replace the overdue tag with a "✓ closed" badge,
  and render an inline outcome reference row beneath the meta. The
  outcome may live in a different entry.
- **Dashboard (home)**: `renderHome` → summary bar + a Projects⇄People
  `view-toggle`. Projects view = a `tile-grid` of project containers
  (`renderProjectTile`) plus the pinned Inbox row + reference-file rows
  below. People view is deep-linkable at `#/people`. `completionOf()`
  uses the stored `completion` or, absent it, derives closed/total
  actions — so a fresh project still shows a meaningful bar.
- **Project detail tabs**: projects get an **Overview** tab (KPI grid +
  glidepath SVG from `renderGlidepath(metrics)` + owners) and an
  **Entries** tab (the original entry-stack + action-rail, now in
  `tpl-project-entries`). References/inbox skip the tab bar and render
  entries directly. `ui.projectTab` holds the selection.
- **Glidepath**: `renderGlidepath(metrics)` returns '' when there are
  no plottable series, and Overview shows a placeholder. Metrics are
  edited in the project Edit modal via a compact one-series-per-line
  text format (`metricsToText`/`textToMetrics`).
- **People (derived)**: `derivePeople()` scans atoms for `assigned_to`,
  buckets each person's open + overdue actions across every container,
  and overlays `state.people_meta[name]`. Only people with **open**
  work appear.
- **Entry triage (AI-assisted ingestion)**: the drawer's "✦ Atomize
  notes" button calls `openTriageModal(entryId)` → `POST /api/atomize`
  → a triage overlay (`#triage`) of proposed atom clusters. Each
  cluster/atom is assigned to a project (or Inbox / a new project made
  inline). `commitTriage()` writes real atoms; when one capture spans
  several projects the source entry goes to the **dominant** target and
  the rest fan out into **sibling entries** cloned from it. Manual atom
  entry remains the always-available path.

## Known gaps / things deferred

- **Per-preview-branch KV isolation**: all preview deployments share
  the one preview KV. True per-branch isolation needs runtime
  key-namespacing in `src/index.js` (hostname → key prefix). Not
  implemented.
- **Cloudflare dashboard non-prod deploy command**: not set up. While
  that gap persists, preview redeploys are manual.
- **README accuracy pass**: a few lines still describe "Cloudflare
  Pages demo" — the shape is actually Workers + Assets. Cheap fix
  next time something else in README is touched.
- **package-lock.json**: not tracked. Cloudflare builds work without
  it. If the team starts caring about reproducible installs, add it.
- **Closed-action display only visible in drawer**: the container
  detail's entry stack just shows atom counts on each card, not which
  actions are closed. Possible follow-up if users want a glance-level
  signal.
