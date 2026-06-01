# CLAUDE.md

Project-state context for AI sessions. README.md describes what the tool
is and how to develop on it. This file captures the non-obvious things
that aren't documented there or in the code — the deploy quirks, branch
topology at time of writing, and patterns worth knowing before changing
things.

Snapshot date: 2026-06-01.

## Vision — `VISION.md` (the next big direction)

`VISION.md` is the living design/architecture doc for where Throughline is
heading beyond V1: **a structured lens over the OneDrive filesystem** —
folder-bound containers, the **reference-vs-shelf** distinction, an **onboarding**
flow that adopts existing folder trees, and **open-in-native-app** (click a file →
the local server opens it in Excel/Word/etc., not a download). It supersedes the
§H "folder-scan attachments" line and reframes ticket T4. `BUILDPATH.md` maps the
shipped V1 (phases A–G); when the folder-lens epic's sequence is locked it
graduates into BUILDPATH as Epic E1. `design-conversation-05302026.md` is the
frozen origin conversation.

## Issue tracker — `TICKETS.md` (read at session start)

`TICKETS.md` (repo root, **gitignored / local-only**, so it may be absent on
clones other than Noah's dev box) is the running ticket log of issues, feature
ideas, and bugs Noah notices while *using* Throughline. **Protocol:** when Noah
reports a problem/idea in passing, APPEND it there as a numbered ticket and
confirm — do **not** fix it ad hoc unless he explicitly asks. Tickets accumulate
until he triggers a *processing session* (triage → prioritize → plan a sprint →
clear). The file's header documents the format and workflow. (The larger
deferred V1+ backlog lives in `BUILDPATH.md` §H.)

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
- `system-ui-and-triage` (origin) — unmerged, branched off
  `adhoc-inbox`. The big one (V1: programs, PM frameworks, AI shape wizard,
  RAG, chart atoms). **Now pushed** (`origin/system-ui-and-triage` matches
  local). It is 4 commits ahead of `adhoc-inbox`:
  1. dashboard (tile grid + glidepath + People view) + entry triage
     modal + schema **v2** + the **Node server** backend.
  2. real atomizer providers — `anthropic` + `cdsapi` (orange).
  3. reskin to the playground look (navy header, DM fonts) + demo
     glidepath/owner data.
  4. ingestion surface — **Import .md / drag-drop** a Markdown file.
- `folder-lens-mvp` (origin, **current**) — branched off
  `system-ui-and-triage`. **This is the active branch and the one orange
  runs.** Pushed to GitHub at the user's request to test on the orange
  device. Adds, on top of V1:
  1. **Epic E1 — folder lens** (`lib/files.js`, `/api/fs/list` + `/api/fs/open`,
     `container.folder`, bind/browse modal, **expandable lazy-loaded file tree**,
     open-in-native-app). Local-Node only; Worker 501s. See the Folder lens
     section below.
  2. **Convert project ⇄ reference file** (both directions, Edit modal).
  3. **Triage files into reference files** too (not just projects).
  4. **Atom retype** in the entry drawer (fix the AI's mis-classification).
  5. **Removed the deprecated copy-attachments UI** (folder lens replaces it).

Each branch stacks on the previous. Verify what a branch actually adds
with `git log <parent>..HEAD --oneline` before reading the diff.
**Guardrail change:** the old "never push" rule is lifted for
`folder-lens-mvp` — the user asked to push it. Still confirm before pushing
anything else.

## Running it / seeing it right now (for a cold start)

Two ways to run the SAME app locally; pick one.

- **Node (orange-shape)**: `node server.js` → `http://127.0.0.1:8787`
  (override `PORT`). State in `./data/state.json` (gitignored).
- **Cloudflare local**: `npx wrangler dev` → also `:8787`, runtime is
  `workerd`, state in the **preview KV**.

Heads-up: a `wrangler dev` (`workerd`) instance is often **already
running on 8787** from a prior session — `node server.js` will then fail
with `EADDRINUSE`. That's not a bug; just open the browser to
`http://127.0.0.1:8787`, or run Node on another port
(`PORT=8799 node server.js`). Identify the holder with
`ss -ltnp | grep 8787` (`workerd` = wrangler, `node` = our server).

To load the demo (incl. glidepaths): `node scripts/seed.mjs --url
http://127.0.0.1:<port> --force`. After editing `public/*`, the user
must hard-refresh (Ctrl+Shift+R) to bust the browser cache.

Verification without a real browser: `--screenshot` / `--dump-dom` via
`google-chrome --headless=new` works in this env; opening a
**remote-debugging port does NOT** (sandbox kills it), so CDP driving
is out. To exercise a click-only surface (triage, import), temporarily
add a boot-time hook reading a `?…=1` query param, screenshot, then
remove it (this is how triage + import were verified).

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
  dyad shares one project DB — this is the production target. **Deploy kit
  lives in `deploy/`** (mirrors atom_sandbox): `bash deploy/bundle.sh` →
  `dist/throughline-<sha>.zip` + `install-throughline-<sha>.ps1.txt`; the
  installer registers a `ThroughlineServer` logon scheduled task that runs
  `node --env-file=.env server.js` on **:8787**. No `node_modules` to vendor
  (server has zero runtime deps). `deploy/README-orange.md` is the operator
  guide — note the shared-OneDrive last-write-wins caveat (each dyad member
  runs their own local server, both pointing `THROUGHLINE_DB` at the same
  synced OneDrive `state.json`; attachments land in `…/attachments/` beside
  it). Orange ships **blank** — do not bundle/run the seeder. Config via
  `.env.example` (set `THROUGHLINE_DB` + `LLM_PROVIDER=cdsapi`).

The front-end is byte-for-byte identical against either backend — it
only speaks REST. Writes are atomic-ish (tmp + rename) in `lib/store.js`.

## Folder lens — `lib/files.js` + `/api/fs/*` (Epic E1, local-only)

Throughline is a **lens** over the OneDrive filesystem, not a vault: a container
can be **bound** to a real folder and show its *live* files, opening them in
their native app — but it **never writes or deletes** in the bound tree (the
filesystem is the source of truth). Full design in `VISION.md` (slice S0+S1+S3).

- **`ONEDRIVE_ROOT`** (`.env`) — the root of the bound tree. Absolute (a OneDrive
  path on orange) or relative to the repo root (fixtures/dev). **Defaults to the
  folder holding `THROUGHLINE_DB`.** Bindings (`container.folder`) are stored
  **root-relative** so they're portable between Noah's and Natalia's boxes.
- **`lib/files.js`** — the file-access seam (local `node:fs` behind a
  `setFsBackend()` interface so a Graph impl can slot in later). The
  **security gate** is `resolveWithinRoot(rel)`: it rejects `..`/absolute escapes
  via a `path.relative()` containment check **before any disk access** — a web UI
  can never make the server touch a path outside `ONEDRIVE_ROOT`. Also
  `rootDir()`, `listFolder(rel)` → `{path, folders:[{name}], files:[{name,size,
  mtime,ext}]}` (sorted, dotfiles skipped), `statSafe`, `toRootRel`,
  `openCommandFor(abs,plat)` (pure), and `openFile(rel)`.
- **Endpoints (Node only):** `GET /api/fs/list?path=<root-rel>` (400 on
  escape/bad path, 404 if missing) and `POST /api/fs/open {path}` (validate →
  spawn the platform opener detached: win32 `cmd /c start "" <abs>`, darwin
  `open`, linux `xdg-open`; returns the constructed `{command,args}`). The
  **Worker 501s** all `/api/fs/*` (no cloud filesystem) — same pattern as
  attachments; the front-end degrades with a clear message.
  `THROUGHLINE_OPEN_DRYRUN=1` skips the actual GUI spawn (the sandbox can't launch
  one) so the open path stays verifiable.
- **Front-end:** project/reference detail has a **Folder** section
  (`renderFolderLens`): "🔗 Bind a folder" → `openFolderBrowser` (in-app modal
  that lists the root via `/api/fs/list`, navigates subfolders + breadcrumb,
  "Use this folder" sets `container.folder`); once bound it shows the **live**
  files as an **expandable tree** (`renderFolderFiles` → `mountFsLevel`, which
  lazily fetches each subfolder's children on first expand — so a deep/large tree
  stays fast) above the legacy copy-attachments block, and a click on a file
  calls `/api/fs/open` (`openBoundFile`) instead of downloading.
- **Tests:** `test/files.test.mjs` (`npm test` / `node --test test/`) — covers
  the traversal refusals and the per-platform open command.

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

**Second AI seam — project classifier (`shared/classify.js`, v3).** Same
runtime-agnostic shape, same provider seam. `/api/classify` (in BOTH
backends) runs `classifyProject({description, excerpt, answers}, {llmCall})`
and returns `{framework, reason, suggested_phases_or_states[],
suggested_metric, is_program, if_program_subprojects[], first_action,
source}`. It powers the **guided shape wizard** (home "✦ New project" →
`openProjectWizard`): two plain-English radio questions (+ a conditional
"do you know the measure?" + description + optional pasted excerpt) →
classify → an **editable** recommendation preview (`openProjectRecommendation`)
→ `provisionFromRecommendation` creates the project with its `framework` +
seeds a first open-action atom (`seedFirstAction`). Like atomize, a
bad/empty model reply **degrades to a deterministic heuristic** (maps the
wizard answers/keywords → framework, and flags a *program* when a long
description spans ≥2 workstream domains) — so the wizard works at zero
spend with no key. The "no defined end" wizard answer routes to a
**reference file**, not a project. Full program (multi-subproject)
provisioning is the D-phase follow-up; until then a program recommendation
creates one project.

## Demo data

`scripts/seed.mjs` populates 7 containers (1 program + 3 projects + 3
reference files; the program groups the payroll + CRM projects via
`program_id`) with ~42 entries and ~95 atoms spanning a "busy week" centered
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

The preview KV currently has the seeded demo data **including the v2
glidepath metrics / owners / completion** on the 3 demo projects (added
on this branch so the local test box shows curves). The `wrangler dev`
instance on `:8787` serves it. Production KV is whatever was there
beforehand — by snapshot date that's just one leftover `smoke_5` test
container.

**Orange ships BLANK.** The seeder is a local-test convenience only —
do **not** run it on orange. The Node server returns an empty state
(`{containers:[], entries:[], atoms:[], people_meta:{}}`) until the
first write, and `data/` is gitignored so the local demo file can't
travel in the bundle. On orange you point `THROUGHLINE_DB` at a fresh
OneDrive path and start clean: the first ad-hoc capture lazy-creates
the Inbox, and projects are created by hand. The sample glidepath
metrics / owners live only in `scripts/seed-data.mjs` (demo_* only).

## Data model — at a glance

Authoritative source: `public/app.js` (vanilla DOM, single-file SPA,
hash-routed) and `src/index.js` (Worker stub; only `/api/state` is
handled, everything else is static assets).

- **State doc** (KV key `throughline:state`, or the Node JSON file):
  `{ schema_version: 3, containers[], entries[], atoms[], people_meta{} }`.
  **v3 is backward-compatible** (as v2 was): both backends + `normalizeState`
  in `public/app.js` tolerate v1/v2 docs (default the missing fields) and
  preserve unknown keys on write. The two backends bump the version number
  only — their `...spread` passes container inner-fields through untouched,
  so the v3 container fields survive a round-trip; the front-end
  `normalizeContainer` (in `public/app.js`) is what defaults any missing v3
  fields on read, so render code can rely on the shape.
- **`containers[]`**: `{ id, type, title, goal_or_purpose, summary,
  tags[], status, created_at, updated_at }` where `type` is one of
  `'program' | 'project' | 'reference_file' | 'inbox'`. Inbox is a singleton
  with id `'inbox'`, lazy-created on first ad-hoc capture. **v3 added the
  `program` type** (a strategic container above projects) and these optional
  fields: on **every** container `program_id` (string|null — links a
  project/reference to its parent program; null = standalone) and `rag`
  (`'green'|'amber'|'red'|null`; null = derive); on **projects** `framework`
  (`'kanban'|'pdsa'|'milestone'|'timeline'|null`) + `framework_config` (object,
  shape depends on the framework — see the `FRAMEWORKS` registry in
  `public/app.js`); on **programs** `objective` (string) + `key_results[]`
  (`{id,label,target,current,unit}`). **Projects gained optional v2
  metadata** (still present): `emoji, color, category, completion (0–100),
  owners[], next_meeting (YYYY-MM-DD), metrics[]` where each metric is
  `{ label, target, color, data:number[], interventions:[{idx,label}] }`
  (drives the glidepath). All optional — absent on references/inbox and
  on lean projects. A legacy project with `framework:null` renders exactly
  as it did pre-v3. **Epic E1 added** on **projects + reference files**
  `folder` (string|null — a **root-relative** path under `ONEDRIVE_ROOT` that
  binds the container to a real OneDrive folder; null = unbound). Defaulted in
  `normalizeContainer`; still schema_version 3, optional, backward-compatible.
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

- **Type-label central lookup**: `CONTAINER_LABELS` in `public/app.js`
  (now `program | project | reference_file | inbox`). Adding a container
  type is one row there plus styling for the matching `.type-mark.<cls>`
  and `.type-badge.<cls>` rules.
- **Framework registry**: `FRAMEWORKS` in `public/app.js` is the single
  source of truth for the PM-framework templates (kanban/pdsa/milestone/
  timeline) — each holds a plain-English `label` (shown in pickers; NO
  jargon in required flows), an optional `blurb` (post-selection help),
  `metricFields`, and `defaultConfig()` (seeds a project's
  `framework_config` on selection). Helpers: `frameworkLabel/Blurb/ConfigFor`.
- **Drawer flow**: `openEntryDrawer(containerId, entryId)`. If
  `entryId` is null, a fresh entry is pushed into state at
  `containerId`. The drawer's container picker lets entries be
  *moved* between containers by mutating `entry.container_id`. Each atom
  row has a **type selector** (`[data-atom-kind]` → `changeAtomKind`) to
  re-classify it (obs/decision/action/outcome) — the AI mis-files often, so
  this is a frequent fix. Re-typing adjusts kind-specific fields (gaining
  `action` seeds `assigned_to`/`due_date`, leaving it drops them; gaining/
  losing `outcome` adds/clears `parent_atom_id`, which is what makes it
  close/stop-closing an action) and re-buckets the atom into its section.
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
  a **framework-appropriate main panel** + owners) and an **Entries** tab
  (the original entry-stack + action-rail, in `tpl-project-entries`).
  References/inbox skip the tab bar and render entries directly.
  `ui.projectTab` holds the selection.
- **Framework views (v3)**: `renderProjectOverview` branches on
  `c.framework` to pick the Overview main panel, each with its
  `frameworkBlurb()` shown after selection (B6):
  - `kanban` → `renderKanbanBoard(c)`: columns from
    `framework_config.states`; a card is an **action atom** placed by its
    `workflow_state` (closed actions auto-fall to the last/Done column);
    per-card `<select>` moves it, card body opens the entry.
  - `pdsa` → `renderPdsaCycle(c)` (clickable Plan/Do/Study/Act from
    `framework_config.phase`) + the glidepath + an Aim/Baseline/Target line.
  - `milestone` → `renderMilestoneList(c)`: checkbox-toggled milestones
    (`framework_config.milestones`, first not-done row = "next"), edited in
    the Edit modal via `milestonesToText`/`textToMilestones`
    (`Label | owner | YYYY-MM-DD | criteria | x`).
  - `timeline` → `renderTimeline(c)`: a derived next/overdue trigger
    (`nextTriggerFor`) over a reverse-chron event log of entries.
  - no framework (legacy/null) → the plain glidepath, exactly as pre-v3.
  The framework is chosen with a plain-English picker (`frameworkSelectHtml`)
  in the project create + edit modals; **the official PM-tool name is shown
  inline** — plain-language label leads, proper noun in parens, e.g. "A
  pipeline of content or tasks that move through stages (Kanban)" — and the
  panel labels show it too ("Board · Kanban"). `FRAMEWORKS[id].name` holds the
  proper noun (`frameworkName`). (This is a deliberate relaxation of the
  original "no jargon" rule, at the user's request, to help them associate the
  plain-English shape with the real method.) Selecting one seeds
  `framework_config` from `frameworkConfigFor(id)`.
- **Glidepath**: `renderGlidepath(metrics)` returns '' when there are
  no plottable series, and Overview shows a placeholder. Metrics are
  edited in the project Edit modal via a compact one-series-per-line
  text format (`metricsToText`/`textToMetrics`). Used by the `pdsa` panel
  and the default (no-framework) panel.
- **Programs (v3 strategic tier)**: a `type:'program'` container groups
  projects via their `program_id`. Created with "New program"
  (`openNewProgramModal`: objective + key-results text
  `keyResultsToText`/`textToKeyResults`, line `Label | current | target |
  unit`); edited via `openEditProgramModal`. The program detail page renders
  `renderProgramDashboard` (OKR-shaped: objective, KRs as progress bars, a
  subproject grid with per-child RAG + status + open counts, and a recent-
  activity feed across children) instead of the project tabs. On **home**,
  programs show as distinct navy tiles (`renderProgramTile`) and their child
  projects are hidden from the top level (they live under the program).
  Projects are linked to a program via the `programSelectHtml` picker in the
  project create/edit modals. The shape wizard provisions a whole program +
  subprojects when classify returns `is_program` (`openProgramRecommendation`
  → `provisionProgram`). RAG: `ragOf(c)` = manual `c.rag` else derived
  (overdue → red, many open → amber, else green); a program's RAG is the
  worst of its children (`programRag`). **NB:** entries/atoms must use
  `uid()` for ids, NOT `uniqueSlug` (which only dedupes container ids).
- **RAG status (v3)**: every container has an authoritative status —
  manual `c.rag` (`green|amber|red`) set via the `ragSelectHtml` picker in the
  Edit modals ("Auto" = derive), else `ragOf` derives it (overdue open action →
  red, >4 open → amber, else green; programs roll up to the worst child).
  Surfaced as a dot on project/program tiles (`tile-rag`), a `ragChip` in the
  container header, RAG dots in the program subproject grid, and an at-a-glance
  count grid in the home header (`#home-rag` — the photograph-able weekly status).
- **People (derived)**: `derivePeople()` scans atoms for `assigned_to`,
  buckets each person's open + overdue actions across every container,
  and overlays `state.people_meta[name]`. Only people with **open**
  work appear.
- **Entry triage (AI-assisted ingestion)**: the drawer's "✦ Atomize
  notes" button calls `openTriageModal(entryId)` → `POST /api/atomize`
  → a triage overlay (`#triage`) of proposed atom clusters. Each
  cluster/atom is filed into a **project OR reference file** — the picker
  (`optionsFor`) groups both under `<optgroup>`s and offers `+ New project…`
  **and** `+ New reference file…` inline (`triageCreateContainer` is
  type-aware; `triage.newForm[id]` holds `{type,value}`), plus Inbox. The
  sidebar shows both project and reference chips with counts. `commitTriage()`
  writes real atoms; when one capture spans several containers the source entry
  goes to the **dominant** target and the rest fan out into **sibling entries**
  cloned from it. Manual atom entry remains the always-available path.
- **Convert between project ⇄ reference file** (bidirectional): the Edit modal
  has "→ Reference file" on a project (`convertProjectToReference`) and
  "→ Project" on a reference (`convertReferenceToProject`). Both flip `type`
  only — every entry/atom stays attached (they key off the stable container id).
  Project→reference **keeps** the project-only fields
  (`framework`/`framework_config`/`metrics`/`owners`/`completion`/`next_meeting`/
  `category`/`emoji`/`color`) but they go **dormant** (the reference view doesn't
  read them), and clears `program_id` (a reference isn't a subproject).
  Reference→project re-activates any dormant fields (so a round-trip restores the
  Overview) or, for a never-a-project reference, makes an unstructured project
  (`framework:null`, `framework_config:{}`). Each direction `confirm()`s with a
  plain summary of what changes; the pair is reversible and non-destructive.
- **File import (ingestion entry point)**: dashboard "⤓ Import .md…"
  button → `openFileImport()`, and drag-drop on `.home` → both call
  `importTextFile(file)`. It reads the file (FileReader), makes a
  `kind:'meeting'` Inbox entry (title via `titleFromMarkdown()` = first
  `#` heading / first line / filename, body → `notes`), and opens the
  drawer one click from Atomize. Standard browser picker → works on
  orange (OneDrive files show in the OS dialog); no server upload.
- **File attachments (DEPRECATED UI, removed)**: the old copy-attachments
  section on project/reference detail was **removed** — it's superseded by the
  **folder lens** (Epic E1), which shows a container's real OneDrive files in
  place instead of uploading copies. The Node `/api/attachments` endpoints (write
  under `attachments/<container_id>/` beside `THROUGHLINE_DB`; `GET
  /api/attachments/<cid>/<name>` serves; Worker `501`s) and any existing
  `container.attachments[]` data are **left intact** (so prior uploads still
  resolve), but nothing in the UI creates or lists them now. `renderAttachments`/
  `uploadAttachment` are gone.
- **Visual theme (playground look)**: the shell is a **dark navy header
  zone** — a persistent `.hdr-top` (teal "Throughline" badge + meta +
  save status) plus a per-view dark band: `.hdr-main` on home (DM-serif
  title + sub line + the `.view-toggle`) and `.panel-hdr` on a container
  (back + emoji + title + tabs + Edit). Those dark bands use negative
  side margins (`margin: 0 -32px`) to span the centered column and line
  up with `.hdr-top`. Fonts are **DM Serif Display / DM Sans** (set in
  `:root --display/--sans`; the `font-variation-settings` reset near the
  end of `styles.css` neutralizes leftover Fraunces opsz tweaks). Tiles
  are colorful (project `color` or a hashed fallback) with white text;
  everything below the header is the light editorial surface.

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
