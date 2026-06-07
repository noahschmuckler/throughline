# CLAUDE.md

Project-state context for AI sessions. README.md describes what the tool
is and how to develop on it. This file captures the non-obvious things
that aren't documented there or in the code — the deploy quirks, branch
topology at time of writing, and patterns worth knowing before changing
things.

Snapshot date: 2026-06-07.

## WHERE WE ARE NOW (read this first)

**The ingestion epic is SHIPPED, live-verified end-to-end, and MERGED to
`main`** (2026-06-07, on Noah's authorization; v1 consult → v2
decisions-back-in → T13 native gpt-5.4 engine — the two sections below).
Caveat: the FINAL sprint additions (dedup gate, program-grouped pickers,
back-to-program, engine-name header, T20 diagnostics) were merged **without
an orange retest** — verify them on the next orange run. Tests: 79/79
(`node --test test/`).

**CURRENT SPRINT (processed 2026-06-07) — SPRINT 1: "industrial ingestion".**
The processing session ran; results live in `TICKETS.md` "Triaged / planned"
(full priorities + approaches there). Sprint 1 contents: **T16** server-side
async ingestion + results inbox queue (core, design-first), **T26**
chat↔review flexing (consult session survives the decision-set→review
transition), **T20 steps 3–4** (retry on empty reply + a config flag to skip
the heuristic fallback on big dumps — A/B the 5.4 "fix this mess" hypothesis
during real orange work), **T22** next-action queue, plus riders **T18**
(program_id on decision-set creates), **T10** (kanban states edit UI),
**T1+T2** (state-write hardening). **Sprint 2 = the E3 design conversation**
(VISION.md first: T11 keystone, T9/T19 inside, T17 after T26). T27 stage 1
floats; T3/T5-rest/T6/T7 parked (T7 pending the T20 experiment). **Sprint 1
work goes on a NEW branch off `main`** (e.g. `industrial-ingestion`).

Post-T13 quick wins shipped 2026-06-07 (same branch): **chat markdown
rendering** (T14 — escape-first `mdToHtml`, assistant bubbles only);
**atomize elapsed counter + Cancel** (T12 — the consult-chat busy pattern in
the triage loading state); **⚙ Settings → Profile** (T15 — header button;
edits the localStorage narrator identity `throughline:user_name` + optional
`throughline:user_role`, stored for future prompt seasoning); **atomize
failure diagnostics + repair parser** (T20 steps 1+2 — `atomizeEntry` returns
`fail` with WHY it degraded incl. truncated-JSON detection, surfaced in the
T8 eyebrow + server warn-log; the gate's balanced-brace+repair parser is now
also in `shared/atomize.js`'s `parseModelJson`).

## SHIPPED — Copilot ingestion v2: "decisions back in"

**Goal:** close the loop — braindump → atomize draft → "Chat about this" bundle
→ Copilot consult → decision-set prompt → **📋 Paste from Copilot** → gate →
decisions-mode review overlay → commit to state.json. Plan file:
`~/.claude/plans/zesty-forging-fox.md`. Spec: `copilot-ingestion-spec.md`
(§4 as-built note + §7b probe-2 guardrails + §8 v2 status).

**Locked decisions:** (1) program-targeted atoms remap to the only child
project else null+warning (programs hold no atoms — the prompt tells Copilot);
(2) NOTHING auto-applies — all writes happen in commitTriage on user commit
(pending containers materialize there, only if referenced); (3) paste field is
the primary inbound channel, freetext degrades to the atomize path.

**Shipped (commits 1–6 on `copilot-ingestion`):**
`suggested_target` in proposed{}; `DECISION_PROMPT(userName)` + one-time
identity (`localStorage throughline:user_name`); **`public/gate.js`** (pure
ESM, mirrors ingest.js; `test/gate.test.mjs` covers every probe-2 guardrail);
the pending-export stash (`localStorage throughline:pending_ingest:<sid>`,
keep-5, deleted on commit; pairs a pasted decision set with its bundle —
accept verdicts have no body); the intake modal + three-grade routing; the
decisions-mode triage overlay (warnings strip, dropped/unaddressed strips,
`__pending__:<pid>` commit-time container creation in a commitTriage
pre-pass). Headless-verified via the temp-hook pattern (hooks removed).

**Deferred (still v2 or later):** gpt-5.4 repair pass, SheetJS source_ref
bounds-check, `atom.source_ref` persistence, committed-state edits (E3.5),
components model (E3.1 — see VISION.md Epic E3).

**WHERE WE LEFT OFF:** acceptance run round 1 found an intake bug — the pasted
decision set failed strict JSON.parse and fell through to the freetext path
(garbage Inbox entry titled "{", which the user should delete). FIXED
(2026-06-06 evening): `parseDecisionSet` now does string-aware balanced-brace
candidate extraction (longest first) + a pure-code repair pass (trailing
commas, smart quotes, BOM/zero-widths) before giving up, and the router never
entry-ifies JSON-looking input — a still-unparseable paste errors visibly in
the modal (`looksLikeJson`). Tests pass; the Copilot end-to-end loop was never
re-verified because round 2 hit the hard refusal that triggered T13 (next
section) — with the native engine primary, the Copilot loop is now the
secondary path and gets verified opportunistically, not as a gate.

## T13 SHIPPED + VERIFIED LIVE (2026-06-07) — native consult engine on cdsapi gpt-5.4

**Why (2026-06-06 evening, acceptance run round 2):** in the user's FOURTH
Copilot session of this iteration loop, the consult prompt worked but the
decision-set prompt got a hard refusal — "sorry, it looks like I can't chat
about this. Let's try a different topic." — with no recourse except a new
chat. Cause unknown (suspects: repeated structured-output prompts reading as
jailbreak-y, or the braindump's CONTENT — high-dose opioids/benzos/tapering —
tripping a safety filter on a mechanical-JSON demand). Conclusion: **a
load-bearing pipeline cannot depend on an engine that refuses unpredictably.**
Copilot demotes to an OPTIONAL path (still the only reader of OneDrive
binaries until SheetJS lands); the primary reasoner is **gpt-5.4 via cdsapi**.
Plan file: `~/.claude/plans/abundant-honking-noodle.md`.

**Shipped (now on `main`; tests green — 79/79):**
- **`shared/consult.js`** — `buildConsultPrompt(bundle, messages)` serializes
  the bundle + FULL turn history into one prompt per round (cdsapi
  `single_response` is stateless); `consultTurn` calls
  `llmCall({tier:'escalate', json:false})` → gpt-5.4. **NO heuristic
  fallback** — it throws on no-model / empty reply / provider error, by
  design (a silent fallback would reproduce the opaque-refusal problem).
  The bundle's embedded `_instructions` carries the consult brief, so
  shared/ never imports public/ingest.js. Tests: `test/consult.test.mjs`.
- **`json:false` is load-bearing**: the cdsapi seam appends a "raw JSON only /
  Begin with {" suffix when json=true (the default) — that would corrupt prose
  turns. ALL consult turns send json:false, including the decision-set turn
  (DECISION_PROMPT's text demands JSON; `parseDecisionSet` is tolerant). The
  anthropic provider now also gates its JSON_SYSTEM prompt on the json flag.
- **`/api/consult` in BOTH backends** (real in the Worker too — same shared
  code): POST `{bundle, messages}` → `{reply, llm}` (llm =
  `describeLLM(env,'escalate')`, e.g. "cdsapi · gpt-5.4"); errors 500 with
  the message. **`server.requestTimeout = 0`** in server.js — Node's 5-min
  default would kill slow gpt-5.4 turns mid-call.
- **Chat overlay** — own `#chat-shroud`/`#chat-panel` element (index.html) at
  **z-index 100**, above `.triage-shroud` (90): the triage draft stays alive
  underneath; Close returns to it intact. NB the modal shroud is z-70 —
  nothing stacks above triage except this. Conversation is **ephemeral,
  in-memory** (`chat` module global; gone on close/reload — deliberate v1).
- **Flow:** the sidebar's primary **"💬 Chat about this"** → `openConsultChat`
  → `buildChatBundle()` (the bundle assembly extracted out of the old
  `chatAboutThis`, now shared) → auto-seeds turn 1 with `OPENING_PROMPT`.
  Busy = elapsed-seconds ticker + **Cancel** (AbortController; T12 lesson).
  Errors render as red in-chat rows, transcript intact — visible failure.
  **"→ Decision set"** sends `DECISION_PROMPT(userName)` flag-scoped
  (`awaitingDecisionSet` — only THAT turn's reply is parsed) → the reply
  routes through `parseDecisionSet` → `openDecisionsReview` with the stash
  built in-memory — the whole v2 gate/review/commit back-half verbatim. The
  decisions-review eyebrow now names the engine ("cdsapi · gpt-5.4 decision
  set"; the paste path still says Copilot). The old export path survives as
  the secondary **"⬇ Export for Copilot"** button; 📋 Paste from Copilot
  unchanged. Headless-verified (temp-hook pattern, ok/busy/error/decision-set
  states; hook removed).

**ORANGE LIVE TEST PASSED (2026-06-07) — full loop, first-ever commit through
the decisions pipeline.** gpt-5.4 processed the real opioid-content braindump
**without refusing** (the exact Copilot failure mode), on the WORST-case input
(gpt-mini failed again → 75-atom heuristic mess as the draft). Findings:
- Consult quality ≈ Copilot's best: identified the one correct program (vs
  5-6 keyword-matched suggestions), advised repurposing the existing container
  rather than creating one, called out mis-groupings project-by-project,
  flagged 3 missed critical legal/procedural actions, and **independently
  converged on the multi-stream loop-table/modified-kanban again** (third LLM
  to do so — see T9/T11).
- Robustness: a deliberately off-topic verbose thank-you turn did NOT derail
  it — brief acknowledgment, graceful refocus (stateless history resubmit
  works).
- Decision set: ~60 s, 46 atoms / 9 actions, ~70/10/20 split across two
  existing projects + one proposed new container; gate → review → **commit
  worked as designed**.
- Para-verified: elapsed counter appreciated ("doesn't seem hung").

**Gaps found in the run became tickets:** T14/T15 + the T12 counter were
fixed same-day (see "WHERE WE ARE NOW" above); T16–T20 remain open in
TICKETS.md — async ingestion queue, persistent/forkable chats, `program_id`
on decision-set creates (the new container landed outside its program),
chat-driven mutations of existing containers (E3 family), and the gpt-mini
failure investigation (steps 1+2 of which — diagnostics + repair parser —
are also already shipped).

Next: sprint retro → TICKETS processing session (T14–T20 above + T7/T9/T10/
T11/T12/T16) → VISION.md E3 sequence. Deferred from this sprint: transcript
persistence (subsumed by T17), trimming history for long chats.

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

## Branch topology (as of 2026-06-07 — COLLAPSED)

**`main` is the only branch.** On 2026-06-07, at Noah's request, the historic
branch stack (`seed-demo-data` → `adhoc-inbox` → `system-ui-and-triage` →
`folder-lens-mvp` → `onboarding-installer` → `copilot-ingestion`) was
collapsed: every branch was already an ancestor of `main` (or merged then),
and all were deleted local + remote. `main` now carries the full lineage:
the demo seeder, the Ad-hoc/Inbox flow, V1 (programs, frameworks, wizard,
RAG, Node server, cdsapi/anthropic providers, playground reskin, .md
import), Epic E1 (folder lens, convert project⇄reference, atom retype),
E1.5 (installer + setup wizard + meridian-briefing launcher tile — live on
both orange boxes), and the full AI-ingestion epic (v1 consult + v2
decisions-back-in + T13 native gpt-5.4 engine + the run-feedback fixes).

**Workflow from here: every new piece of work gets a NEW branch off
up-to-date `main`**, merged back after Noah's review. Pushing `main` and
feature branches of this repo is authorized (and `throughline-launcher`/
`main` in meridian-briefing); `main` deploys nothing (see Deployment model).

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

## Deployment model — there is no cloud deploy anymore (updated 2026-06-06)

**There is no Cloudflare Worker attached to `throughline`.** The git
integration / auto-deploy-on-push-to-`main` described in earlier
snapshots is gone — **pushing to `main` deploys nothing.** `main` is now
just the shared branch you pull from (e.g. onto orange); a push has no
runtime side effects. The **only** live form of the app is the **local
Node server** (`server.js`) running on the orange device — see the Node
server section below. That is "production" now.

What remains is **local-only Cloudflare tooling**, kept for dev
convenience, not deployment:
- `src/index.js` is still a working Worker stub and `npx wrangler dev`
  still runs it locally on `:8787` against the **preview KV**
  (`preview_id` on the top-level binding), so local hacking never touches
  any cloud production state. This is just an alternate way to exercise
  the same `public/` SPA locally; it ships nowhere.
- Historical KV namespace ids (no longer wired to any live deploy):
  prod `fcf9208b03f54eaabd6524f5a76c7f03`, preview
  `db3df52a08194d30a50c55bbdd6343bf`. The old
  `throughline-preview.noah-schmuckler.workers.dev` URL and the
  `[env.preview]` / `wrangler deploy --env preview` flow are dormant.

Bottom line for an AI session: do **not** reason about Cloudflare
deploys, preview redeploys, or push-to-main side effects — they don't
exist. Distribution to orange is the `deploy/` kit + installer (Epic
E1.5), not Cloudflare.

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
  the traversal refusals and the per-platform open command. **Note (2026-06-05):**
  `listUnder` now **stat-resolves reparse-point dirents** so OneDrive cloud-sync
  roots (`OneDrive - UHG`) and shared-folder shortcuts (`Peden, …'s files`) — which
  Windows reports as symlinks, not dirs — are browsable; a stat failure (ACL-denied
  legacy junction) drops the entry. Without this the lens/setup browser silently
  hides OneDrive folders.

## Onboarding & distribution — Epic E1.5 (`onboarding-installer` branch)

How a non-technical user (Natalia, Amanda, …) stands up a **local** Throughline
without GitHub or editing `.env`. **Shipped + live on real orange boxes (2026-06-05).**
The model: **meridian-briefing is a pure file-distributor + launcher; nothing
Throughline runs on the CR DEV server** (it can't run Node). Three machines:
- **Linux dev box** — builds + publishes (`deploy/publish-throughline.sh`: runs
  `bundle.sh`, drops `throughline-latest.zip` + `install-throughline.ps1.txt` +
  `throughline-release.json` {version,sha,sha256,date} into the **sibling**
  `~/GitHub_Repos/meridian-briefing/public/throughline/`; does NOT push — prints the
  git commands). Deliberate publish; CR DEV picks it up via its normal `git pull`.
- **CR DEV server** (`cdseastdev.ms.ds.uhc.com:8080`, **plain HTTP**, no Node) —
  serves the static files. meridian-briefing's contribution is **zero-lockstep**:
  an **admin-only** `THROUGHLINE_TILE` in `public/briefing.js` AdminHome →
  `/throughline/index.html` (a self-contained static page: download button + the
  copy-paste PowerShell one-liner). No `server.js`/`server.ps1` route changes.
  (The bare dir `/throughline/` falls to the SPA, so the tile links the explicit
  `index.html`.) Merged to meridian-briefing **`main`**.
- **Orange box** (Windows, has Node) — runs the local Throughline + setup wizard.

**Installer (`deploy/install-throughline.ps1`, shipped as `.ps1.txt` to dodge the
browser/OneDrive download block):** a **self-downloading bootstrapper** — the user
downloads only the one `.ps1.txt`, renames + `Unblock-File` + runs it; it
`Invoke-WebRequest`s the zip from `$BundleBaseUrl` (default
`http://cdseastdev.ms.ds.uhc.com:8080/throughline`, override `$env:THROUGHLINE_BUNDLE_URL`;
`-Insecure`/`-NoBrowser` switches), verifies **sha256** against the manifest,
expands, reuses the existing stop-task→preserve-`.env`→register `ThroughlineServer`
→start logic, then opens the browser at **`/#/setup`** (hash route — bare `/setup`
404s). Update-in-place preserves `.env`.

**Setup wizard (`lib/setup.js` + `/api/setup/{status,browse,dbinfo,bind}`, Node-only):**
the chicken-and-egg is that `ONEDRIVE_ROOT` isn't set yet and the lens browse is
locked to it — so setup browses from **`os.homedir()`** via a *separate* home-rooted
gate (`resolveWithinHome`, reusing `resolveWithin`/`listUnder` from `lib/files.js`;
**do not widen the lens `/api/fs/list`**). Front-end (`public/app.js`): a **two-step**
`#/setup` wizard (shared `mountBrowser` helper; the boot path auto-redirects to it
when unconfigured, and the wizard **bounces to the dashboard when already configured**):
  1. pick the **shared OneDrive folder** (→ `ONEDRIVE_ROOT`, the lens root);
  2. pick **where `state.json` lives** — `/api/setup/dbinfo` lists candidates
     (`Throughline/state.json` *recommended* vs root `state.json`) with
     existing-workspace **counts**, so a second dyad member just confirms the team's
     workspace. Default = the `Throughline/` subfolder (keeps the shared root tidy).
- **`bindFolder(rootAbs, dbAbs)`** writes `.env` AND **applies to `process.env` live**
  — `rootDir()`/`dbPath()` read env at call time, so **no task restart is needed**
  (the old `schtasks /End`+`/Run` self-killed its own process tree on Windows → the
  "still restarting" hang; that path is gone). Validates `rootAbs` under home and
  `dbAbs` inside `rootAbs`; `mkdir`s the parent. `.env` is still persisted for next boot.
- **Tests:** `test/setup.test.mjs` (containment refusals, `.env`-preservation,
  default-DB, dbinfo counts) + the reparse test in `test/files.test.mjs`.

**Current live config (Noah + Natalia):** `ONEDRIVE_ROOT` = the shared-folder root
(Natalia-owned `…\OneDrive - UHG\Peden, Natalia L's files - IMFM Provider Corner`,
a shortcut on Noah's box); `THROUGHLINE_DB` = `…\Throughline\state.json` (the
~125 KB real workspace). **The next direction — multi-user "circles" — is paused;
the full design lives in `VISION.md` §M3.**

## Copilot-assisted ingestion — `copilot-ingestion-spec.md` (epic complete, merged to `main`)

The goal: recover SteadyHand's "brain dump → structured" ingestion, using
**enterprise Copilot** as the reasoning layer (it can read OneDrive binaries —
spreadsheets/emails — which the on-network `cdsapi` gpt-5.4/mini pipeline can't).
**Full design + schemas: `copilot-ingestion-spec.md` (read it first).** Origin of
the idea: `throughline_copilot_design.md` (Copilot's own draft). The `copilot-probe/`
folder holds the Mode-B probe (a roster `.xlsx` + prompt) and `copilot_response.txt`
(Copilot's real reply) that calibrated the design — PASS: Copilot reads binaries and
returns cell-cited JSON, but `source_ref` is region-accurate not exact-cell, it ignores
fine fields like `due_date`, and OneDrive *path*-retrieval failed (chat-**attach** works).

Architecture in one line: **two modes** (A = pure text dump; B = doc-grounded
"what do I do with this spreadsheet") → one **export bundle** out → Copilot →
**decision set** back → **verify+normalize gate** → the *existing triage overlay*
(`commitTriage` stays the only writer). Decisions are returned **id-keyed**, not as
the whole doc, so corruptible substance never leaves Throughline. The gpt-5.4 pass
is a **field-normalizer + JSON-repair**, not the reasoner. **SheetJS is DECIDED:**
vendored into the bundle (pure JS, no separate install on orange) for `source_ref`
bounds-checking — but only needed at v2.

**Phasing (spec §8): v1 read-only consult → v2 decisions-back-in + gate →
v2.5/T13 native engine → v3 auto-expansion. SheetJS still pending.**

**STATUS — v1 SHIPPED + verified live; v2 CORE SHIPPED; T13 (native gpt-5.4
consult engine — Copilot demoted to secondary) SHIPPED + VERIFIED LIVE
2026-06-07 (see the T13 block at the top of this file), tests green (79/79),
MERGED to `main` 2026-06-07.** What v1 added:
- **`public/ingest.js`** — pure runtime-agnostic ESM (served at `/ingest.js`,
  imported by `public/app.js` AND `test/ingest.test.mjs`): `buildStateSummary`,
  `buildProposed` (triage draft → bundle-local `p*`/`a*` ids), `buildNeedsClarification`,
  `versionHash` (FNV-1a over a stable stringify), `assembleBundle`. **`app.js`'s
  `openActionsOf` now delegates to `openActionsForContainer` here** (one open-action
  rule for UI + bundle).
- **`public/app.js`** — a **"💬 Chat about this"** button in the triage sidebar →
  `chatAboutThis()` builds the `throughline.chat_about_this` bundle (spec §2) and
  downloads it (`downloadJson`; no server upload). `triage.createdIds` tracks
  containers made during that triage (they become `p*` and are excluded from
  `state_summary` to avoid dup). `dominantBoundFileRefs` pulls `file_refs` from the
  dominant bound target's lens folder (else `[]`). **No new server endpoint; schema
  stays v3.**
- **`test/ingest.test.mjs`** (15 tests) + **`copilot-probe/sample-chat-about-this.json`**
  (a generated example bundle).

**Program-hierarchy gap — FIXED (2026-06-06):** `buildStateSummary` now emits
`program_id` on every container entry (null = standalone) and `objective`+
`key_results` (label/current/target/unit, no internal kr ids) on `type:"program"`
entries, so Copilot can reconstruct program→projects from the flat list. Spec §2
example updated, test added, sample bundle regenerated with a program in the
scenario.

**Self-describing bundle — ADDED (2026-06-06), from the first live consult:** the
user attached a real bundle and asked Copilot "does this look right" → Copilot
reviewed the JSON *format* (verbose structural praise) instead of consulting on
the breakdown. Fix (two layers, both in `ingest.js`): every bundle now embeds
**`_instructions`** (`BUNDLE_INSTRUCTIONS` — role + "do NOT review formatting" +
the four consult tasks), and `chatAboutThis()` copies **`OPENING_PROMPT`** to the
clipboard (also shown in the alert; clipboard can fail on http) so the chat opens
pointed at `_instructions`. `_instructions` is NOT in `version_hash` (boilerplate,
not draft). Spec §2 records the lesson. **Verified live 2026-06-06** (the
program-retool consult engaged with the breakdown, not the JSON format).

**Atomize provenance — SHIPPED (2026-06-06, T8):** a 75-atom draft from a real
8 KB dump was unattributable (model or silent heuristic fallback?). Now:
`describeLLM(env, tier)` in `shared/llm.js`; both `/api/atomize` handlers attach
`llm` ("cdsapi · gpt-mini" | null) beside the existing `source`; the triage
eyebrow reads "draft by cdsapi · gpt-mini" / "heuristic draft — <llm> failed" /
"heuristic draft (no model configured)"; and the cluster badge says **"keyword
match:"** instead of "AI suggests:" when the heuristic ran (it previously
mislabeled keyword matches as AI). Tiering confirmed implemented: atomize = tier
`reason` (cdsapi→gpt-mini), classify = tier `classify` (→gpt-nano); `LLM_MODEL`
unset means the tier map applies. Tests: `test/atomize.test.mjs`. **NOTE: this
slice touches `server.js` — orange preview needs the branch-run flow, not just a
`public\` copy.** **Verified live 2026-06-06:** the eyebrow exposed that the
user's preview launch line pointed at the wrong folder (no env → heuristic);
fixed, cdsapi/gpt-mini confirmed running (~90 s on an 8 KB dump → T12).

**v1 VERIFIED LIVE END-TO-END (2026-06-06):** with cdsapi actually wired (the
earlier 75-atom mess was the heuristic — the preview launch line had pointed at
the wrong folder, so no env loaded), gpt-mini produced a dramatically better
draft on the same 8 KB dump (28 atoms, 5 actions, correct project suggested) and
the Copilot consult on that bundle was high-utility (split/retype/merge/missing-
atom critiques, a proposed new project, framework advice that independently
converged on the E3 loop-table). **Lesson: consult quality gates on draft
quality** — garbage draft in, format-critique out; decent draft in, real PM
collaboration out. Caveat: the gpt-mini run took ~90 s with a frozen
"Atomizing notes…" (ticket T12).

**The next big direction is captured in `VISION.md` Epic E3** (modular project
components + the three-stage LLM collaborator: consult → structure proposals →
mutation routing). Tickets T7/T9/T10/T11 hang off it; sprint planning happens at
the next TICKETS.md processing session.

**Previewing a dev branch on orange (how the user tests):** the running app is the
installed copy at `%USERPROFILE%\throughline` served by the **`ThroughlineServer`**
logon scheduled task on `:8787`; it is a *separate folder* from the user's GitHub
Desktop checkout, and the meridian-briefing install/update tile pulls *published
releases*, not branches. To preview a branch: `schtasks /End /TN "ThroughlineServer"`
(+ free port 8787), then from the checkout run
`node --env-file="$env:USERPROFILE\throughline\.env" server.js` (reuses the real
shared-OneDrive `.env`); Ctrl+C + `schtasks /Run /TN "ThroughlineServer"` to restore.
v1 was front-end-only so copying `public\` over the install also works.

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

- **README accuracy pass**: README still describes a "Cloudflare Pages
  demo" / cloud deploy. That's doubly stale now — there is no cloud
  deploy at all (see Deployment model above); the live form is the local
  Node server. Cheap fix next time README is touched.
- **package-lock.json**: not tracked. The Node server has zero runtime
  deps so it doesn't matter today. If the team starts caring about
  reproducible installs, add it.
- *(Removed: the old Cloudflare per-preview-branch KV isolation and
  non-prod-deploy-command gaps — both moot now that nothing deploys to
  Cloudflare.)*
- **Closed-action display only visible in drawer**: the container
  detail's entry stack just shows atom counts on each card, not which
  actions are closed. Possible follow-up if users want a glance-level
  signal.
