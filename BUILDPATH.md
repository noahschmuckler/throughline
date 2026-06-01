# Throughline — V1 Build Path

**Purpose.** This document maps Throughline's *current* state against the
features designed in `design-conversation-05302026.md`, then lays out an
ordered, verifiable build path to V1. It is written to be driven
autonomously (e.g. via `/goal`): each phase is a self-contained unit of
work with an explicit *Definition of Done* and a *Verification* recipe.
Work top-to-bottom, finish one task fully (including verification and a
progress-log entry) before starting the next, and never skip the
guardrails.

Snapshot date: 2026-05-30. Branch: `system-ui-and-triage` (local only).
Companion docs: `CLAUDE.md` (deploy quirks, run instructions, patterns),
`design-conversation-05302026.md` (the source vision).

---

## 0. How to use this document (read first, every session)

You are continuing a long build. Context may have been reset since the
last task. To re-orient:

1. Read this whole file. The **Progress log** (bottom) is the source of
   truth for what's already done — trust it over your assumptions.
2. Read `CLAUDE.md` for how to run and verify the app in this sandbox.
3. Pick the **first unchecked task** in the first incomplete phase. Do
   not jump ahead — phases build on each other's schema and helpers.
4. Implement → verify (see each task's recipe) → append a Progress-log
   entry with the date, what changed, files touched, and how you proved
   it works → check the box.
5. If a task is genuinely blocked (needs a human decision, an external
   credential, or something outside this repo), write a **BLOCKED** note
   in the Progress log explaining exactly what's needed, then move to the
   next *independent* task if one exists, otherwise stop and surface it.

**Operating mode for this run:** build the **full V1 scope** (Phases A–G)
end to end, phase by phase, verifying each. Phase H is the deferred
backlog — do not start it without a human go-ahead.

---

## 1. North Star (the one-paragraph vision)

Throughline is a frictionless capture-and-surface tool for a
medical-director / operations-director dyad (Noah + Natalia) running many
heterogeneous initiatives inside a large healthcare org. The atom
substrate (entries → typed atoms: observation / decision / action /
outcome) is **already solved and good** — V1 is about composing it into a
layered hierarchy with the right management frame at each level:

```
Program  (strategic container, OKR-shaped dashboard)
  └─ Project       (exactly ONE PM framework: kanban | pdsa | milestone | timeline)
  └─ Reference file (no framework — ongoing accumulation, e.g. provider behaviors)
       └─ Entry    (dated capture: meeting | email | freetext)
            └─ Atom (observation | decision | action | outcome)
```

Two non-negotiable design values from the conversation: **(a) frictionless
capture and plain-English UX** — neither user is a project manager and
neither should ever have to type or understand the word "PDSA"; **(b)
shareability** — every record is legible to a non-Throughline user (the
OneDrive tree and auto-generated READMEs are the fallback surface).

---

## 2. Current state — what already exists (do not rebuild)

Verified against the code on 2026-05-30. Cite these when extending.

**Backends (two, byte-for-byte identical REST contract).**
- Cloudflare Worker `src/index.js` (KV) and Node `server.js` + `lib/store.js`
  (single JSON file at `THROUGHLINE_DB`, default `./data/state.json`,
  atomic tmp+rename).
- API: `GET/PUT /api/state`, `POST /api/atomize`, static assets.
- Empty state: `{schema_version:2, containers:[], entries:[], atoms:[], people_meta:{}}`.

**Data model (`schema_version: 2`).**
- `containers[]`: `{id, type, title, goal_or_purpose, summary, tags[],
  status('active'|'archived'), created_at, updated_at}`. `type` ∈
  `project | reference_file | inbox`. **No nesting, no program tier.**
  Projects also carry optional v2 metadata: `emoji, color, category,
  completion(0–100), owners[], next_meeting, metrics[]`.
- `metrics[]` (per project): `{label, target, color, data:number[],
  interventions:[{idx,label}]}` → drives the glidepath SVG. Interventions
  are **static labels, NOT linked to atoms.**
- `entries[]`: `{id, container_id, kind('meeting'|'email'|'freetext'),
  occurred_at, title, participants[], tags[], notes, created_at, updated_at}`.
- `atoms[]`: `{id, entry_id, kind, body, tags[], created_at, updated_at}`.
  Actions add `assigned_to, due_date`. Outcomes add `parent_atom_id`.
  Open/closed is **derived** (an action is closed iff some outcome has its
  id as `parent_atom_id`).
- `people_meta{}`: optional overlay; people are otherwise **derived** from
  atom `assigned_to`.

**Front-end (`public/app.js`, vanilla single-file SPA, hash-routed).**
- Routes: `#/` (home), `#/people`, `#/c/<id>` (container detail).
- Home: Projects⇄People toggle; project tile-grid + reference rows + inbox.
- Project detail: **Overview** tab (KPI grid + glidepath SVG + owners) and
  **Entries** tab (entry stack + action rail). References/inbox skip tabs.
- **Triage/atomize**: drawer "✦ Atomize notes" → `POST /api/atomize` →
  cluster overlay → assign clusters/atoms to projects → `commitTriage()`
  writes atoms, fanning out across sibling entries when one capture spans
  projects.
- **File import**: "⤓ Import .md…" + drag-drop on `.home` →
  `importTextFile()` reads a file into a new Inbox entry's `notes`.

**AI seam (`shared/atomize.js` + `shared/llm.js`, runtime-agnostic ESM).**
- `atomizeEntry(entry, {projects, llmCall})` → `{clusters, source}`.
- `makeLLMCall(env)` selects provider from `LLM_PROVIDER`: `heuristic`
  (default, zero-spend deterministic), `anthropic` (`ANTHROPIC_API_KEY`),
  `cdsapi` (Optum on-network `single_response`, no key, models
  `gpt-nano|gpt-mini|gpt-5.4`). Tiers: `classify|reason|escalate`.
- Pattern to mirror: a bad/empty model reply **degrades to a heuristic**
  rather than erroring. Keep this for every new AI call.

**Demo data (`scripts/seed-data.mjs` + `seed.mjs`).** 3 demo projects (with
metrics/owners/completion) + 3 reference files, `demo_*` ids, dates
relative to "now". `node scripts/seed.mjs --force` reseeds. **Orange ships
blank — never seed orange.**

**What does NOT exist yet (the V1 gap):** program tier · per-project PM
framework · the shape wizard · program/OKR dashboard · framework-specific
project dashboards (board / PDSA cycle / milestone timeline) · RAG status
scheme · atom-linked chart annotations · file attachments (only state JSON
is persisted; import lands text into `notes`).

---

## 3. Gap analysis (design feature → status → phase)

| # | Design feature | Today | Target | Phase |
|---|---|---|---|---|
| 1 | Program tier above project | none | `type:'program'` container + `program_id` link on projects/refs | A, D |
| 2 | One PM framework per project | none | `framework` field + per-framework config + dashboard | A, B |
| 3 | Four templates: kanban, PDSA, milestone, timeline | none | each provisions scaffold + metric fields + view | B |
| 4 | Shape wizard (3 plain-English Qs, no jargon) | none | modal → classify call → editable recommendation → provision + first action | C |
| 5 | AI structuring call (cdsapi/anthropic, JSON, heuristic fallback) | atomize only | `shared/classify.js` + `POST /api/classify` | C |
| 6 | Program/OKR dashboard | none | objective + key results + subproject RAG grid + recent-entries feed | D |
| 7 | Framework-appropriate project dashboards | overview+glidepath only | board / PDSA quadrant / milestone timeline / event log | B |
| 8 | RAG status, single authoritative color, aggregating up | `completion%` only | `rag` field + derive program rollup | E |
| 9 | One owner per action | yes (`assigned_to`) | keep; surface "overdue → needs follow-up" (mostly present) | E |
| 10 | Atoms on graphs (manual annot + intervention mark) | static labels | click-to-add note (date pre-fill) + intervention marker linked to atom | F |
| 11 | File attachments (upload pathway) | none (text→notes) | upload → backend attachments store + record in container | G |
| 12 | OneDrive legible tree + auto README | single JSON | folder tree + auto README.md | H (deferred) |
| 13 | Folder-scan attachments · click-to-link atom · waterfall template | none | — | H (deferred) |
| 14 | Loop Deloop wire-in · prepare-for-review export · email · metric connector | none | — | H (deferred) |

---

## 4. Guardrails (NON-NEGOTIABLE — violating these breaks the product)

1. **Never `git push`.** This branch is local by the user's instruction.
   Commit locally only if the user asks; otherwise leave the tree dirty.
2. **Schema changes must be backward-compatible.** Bump to
   `schema_version: 3` once (in Phase A) and never again for V1. Every new
   field is **optional with a sane default**. `normalizeState` (in
   `public/app.js`) and both backends must still load a v1/v2 doc, default
   the missing fields, and **preserve unknown keys on write**. A legacy
   project with no `framework` must render exactly as it does today.
3. **The front-end stays backend-agnostic.** `public/` speaks only REST
   and must work byte-for-byte against *both* `node server.js` and
   `wrangler dev`. Any new endpoint must be implemented in **both**
   `server.js` and `src/index.js` with an identical contract.
4. **AI calls degrade, never 500.** Every new model call (the wizard
   included) must fall back to a deterministic heuristic on a bad/empty/
   absent reply — mirror `atomizeEntry`. The shipping default provider is
   `heuristic` (zero spend); the capture→structure loop must work with no
   API key.
5. **Provider policy:** dev/test on this Linux box uses `anthropic`
   (`ANTHROPIC_API_KEY`); the **orange** shipping path is `cdsapi`
   (on-network, no key). Build provider-agnostic via the existing
   `shared/llm.js` seam — do not hardcode a provider in feature code.
6. **Plain English leads; official names shown inline.** Originally the rule
   was "no jargon anywhere in a required flow." The user has since asked to
   see the official PM-tool name inline (e.g. "A pipeline … (Kanban)",
   "Board · Kanban") so they can learn the association. So: the plain-English
   description leads, and the proper noun (`FRAMEWORKS[id].name`) appears in
   parens after it / next to the panel label. Don't make the user *type* or
   *decode* a method name to proceed, but it's fine — desired — to show it.
7. **Never run the seeder on orange**, and never commit `data/`.
8. **Preserve the substrate.** Don't change the meaning of the four atom
   types or the derived open/closed-action rule. New structure layers on
   top; it does not mutate atom semantics.
9. **Keep `CLAUDE.md` honest.** When a phase changes how the app is run,
   the data model, or a pattern, update the relevant `CLAUDE.md` section in
   the same task.

---

## 5. Verification playbook (how to prove a change in this sandbox)

This environment has no interactive browser and CDP/remote-debug is killed
by the sandbox. Use these instead (all per `CLAUDE.md`):

- **Run Node on a free port** (a `wrangler dev` may already hold 8787):
  `PORT=8799 node server.js` → `http://127.0.0.1:8799`. Check the holder
  with `ss -ltnp | grep 8787`.
- **Seed demo data** for a realistic screen:
  `node scripts/seed.mjs --url http://127.0.0.1:8799 --force`.
- **Headless screenshot / DOM dump** (works here):
  `google-chrome --headless=new --screenshot=/tmp/x.png --window-size=1400,2000 'http://127.0.0.1:8799/#/c/demo_crm_cutover'`
  or `--dump-dom`. Inspect the PNG with the Read tool.
- **Click-only surfaces (wizard, triage, import):** opening a debug port
  is out, so temporarily add a **boot-time hook** in `app.js` that reads a
  `?…=1` query param to auto-open the surface, screenshot it, then **remove
  the hook**. This is exactly how triage + import were verified.
- **API-level checks** (cheap, deterministic, preferred for logic):
  `curl -s localhost:8799/api/state | jq …`, and round-trip a `PUT` to
  confirm normalization/backward-compat. For AI endpoints, `curl` a
  `POST /api/classify` with a sample body and assert the JSON shape; test
  the **heuristic** path with no key set, and (optionally) the `anthropic`
  path with `LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=… node server.js`.
- After editing `public/*`, a real browser needs **hard-refresh**
  (Ctrl+Shift+R); headless Chrome always loads fresh.

**A task is not done until you have produced concrete evidence** (a
screenshot path, a curl/jq transcript, or a round-trip assertion) and
recorded it in the Progress log.

---

## 6. The build path

Each task: **why → files → Definition of Done (DoD) → Verify.** Keep diffs
small and the app runnable after every task.

### Phase A — Schema v3 groundwork (foundation for everything)

> One backward-compatible schema bump that adds the program tier and the
> framework field as optional metadata. No new UI required to land this —
> it's the substrate Phases B–E build on. After this phase a legacy doc
> must still load and render identically.

- [x] **A1. Bump schema + extend normalization.** In both backends'
  `EMPTY_STATE`/default and in `normalizeState` (`public/app.js`), move to
  `schema_version: 3`. Add, all optional with defaults:
  - on **containers**: `program_id` (string|null, default null),
    `rag` ('green'|'amber'|'red'|null, default null).
  - new container `type` value **`'program'`** (a strategic container).
  - on **project** containers: `framework`
    ('kanban'|'pdsa'|'milestone'|'timeline'|null, default null) and
    `framework_config` (object, default `{}`).
  - on **program** containers: `objective` (string) and `key_results[]`
    (`{id,label,target,current,unit}`).
  **DoD:** loading a v1/v2 doc upgrades it in memory without data loss,
  unknown keys survive a `PUT`, and a project with `framework:null` renders
  exactly as today. **Verify:** `curl` the existing v2 demo state, `PUT` it
  back, diff to confirm only defaults were added and nothing dropped;
  screenshot `#/c/demo_crm_cutover` and confirm it is visually unchanged.

- [x] **A2. Central lookups for the new type + frameworks.** Extend
  `CONTAINER_LABELS` (`public/app.js`) with the `program` row (label, type
  mark/badge css) per the documented "fourth container type" pattern. Add a
  single `FRAMEWORKS` registry object (id → `{label, blurb, columns/phases
  defaults, metricFields}`) that later phases read from — define it now,
  even if unused, so B/C share one source of truth. Add matching
  `.type-mark.program` / `.type-badge.program` styles in `styles.css`.
  **DoD:** registry exists and is imported where needed; no behavior change
  yet. **Verify:** app still loads; lint/console clean in a headless load.

- [x] **A3. Update `CLAUDE.md` data-model section** to describe v3
  (program type, `program_id`, `framework`, `framework_config`, `rag`,
  program `objective`/`key_results`) and note v3 is backward-compatible.
  **DoD/Verify:** section reads accurately against the code.

### Phase B — Per-project framework templates + dashboards

> Deliver the four frameworks as real, selectable structure with a
> framework-appropriate Overview. This is the largest chunk of visible
> value and is independent of the wizard (frameworks can be set by hand
> here; the wizard in Phase C just automates the choice). Reuse the
> existing tab shell and glidepath.

Recommended representation (refine if needed, keep backward-compat):
- **kanban** → `framework_config.states: [{id,label}]` (default
  backlog/in-progress/in-review/done); a "card" is an **action atom**
  surfaced by a `framework_config`-independent `workflow_state` tag on the
  atom (reuse atoms — do not invent a parallel store). Board groups the
  project's action atoms by state.
- **pdsa** → `framework_config: {aim, baseline, target, frequency,
  phase('plan'|'do'|'study'|'act')}` + reuse existing `metrics[]` for the
  time series. Dashboard = the four-phase cycle indicator + the glidepath.
- **milestone** → `framework_config: {milestones:[{id,label,owner,
  due_date,criteria,done}], baseline_state, target_state}`. Dashboard = a
  timeline/checklist of milestones with owner + due + done state.
- **timeline** → no extra config; primary view is the project's entries in
  reverse-chronological order with a floated **next-trigger** (`next_meeting`
  or the soonest open-action `due_date`). Reuses entries.

- [x] **B1. Framework selector in container create/edit.** Add a framework
  picker to the project create + edit modals (plain-language option labels
  — e.g. "a pipeline of content/tasks", "improving a measured outcome",
  "phased build with milestones", "a situation driven by key dates" — that
  map to kanban/pdsa/milestone/timeline). Persist `framework` +
  initialize `framework_config` defaults from `FRAMEWORKS`. **DoD:** can set
  a framework on a demo project and it round-trips through `PUT`. **Verify:**
  edit `demo_crm_cutover` to `kanban` via a temporary boot hook or by
  PUTing state; confirm persisted.

- [x] **B2. Kanban board view.** When `framework==='kanban'`, the project
  Overview renders a column board of the project's open/closed action atoms
  grouped by `workflow_state` (default unstated → first column). Allow
  moving a card by editing its `workflow_state`. **DoD/Verify:** seed a
  kanban project, screenshot the board, confirm cards land in columns.

- [x] **B3. PDSA view.** When `framework==='pdsa'`, Overview shows the
  Plan→Do→Study→Act cycle indicator (current `phase` highlighted) above the
  existing glidepath (`renderGlidepath`), plus aim/baseline/target KPIs.
  **DoD/Verify:** screenshot a pdsa demo project; phase indicator + chart
  render; legacy projects unaffected.

- [x] **B4. Milestone view.** When `framework==='milestone'`, Overview
  shows a milestone checklist/timeline (label · owner · due · ✓/◻ · go-no-go
  criteria) with a next-milestone highlight. Editable in the Edit modal via
  a compact one-line-per-milestone text format (mirror the existing
  `metricsToText`/`textToMetrics` pattern). **DoD/Verify:** screenshot;
  toggling a milestone done updates state.

- [x] **B5. Timeline view.** When `framework==='timeline'`, Overview floats
  a "Next: <date> — <label>" trigger and lists entries reverse-chron.
  **DoD/Verify:** screenshot; next-trigger picks the soonest relevant date.

- [x] **B6. Help text (optional, post-selection only).** After a framework
  is chosen, show a one-line "what this is / why it fits" blurb from
  `FRAMEWORKS[...].blurb`. Never in a required step. **DoD/Verify:** blurb
  appears on Overview; no jargon in any required flow.

- [x] **B7. Update `CLAUDE.md`** "Project detail tabs" + "Patterns" with the
  framework views and the `workflow_state`/milestone formats.

### Phase C — The shape wizard (AI-assisted structuring)

> Three plain-English questions → a classify call → an editable
> recommendation → provision the project with its framework **and a
> pre-populated first action atom** so it never starts empty. Provider:
> anthropic for dev, cdsapi for orange, heuristic fallback always.

- [x] **C1. `shared/classify.js` (runtime-agnostic).** Mirror
  `shared/atomize.js` structure. `classifyProject({description, excerpt,
  answers}, {llmCall})` builds the lean JSON prompt from the design doc
  (§"AI-assisted structuring call") and returns
  `{framework, reason, suggested_phases_or_states[], suggested_metric,
  is_program, if_program_subprojects[], first_action}`. Use
  `parseModelJson` (extract or share it). **Heuristic fallback** (no
  `llmCall` or bad reply): pick a framework from the wizard answers +
  keyword match, synthesize a sensible `first_action`. **DoD:** pure ESM,
  no `node:*`, importable by both backends. **Verify:** unit-call it with a
  mock `llmCall` and with `null` → both return a valid object.

- [x] **C2. `POST /api/classify` in BOTH backends.** Wire
  `classifyProject` behind the endpoint using `makeLLMCall(env)` (tier
  `classify` or `reason`). Identical contract in `server.js` and
  `src/index.js`. **DoD/Verify:** `curl -s -X POST localhost:8799/api/classify
  -d '{"description":"Improve our lagging CAHPS access measure","answers":{…}}'`
  returns the JSON shape with `LLM_PROVIDER` unset (heuristic) **and** with
  `LLM_PROVIDER=anthropic` + key (optional live check).

- [x] **C3. Wizard UI (3 questions, no jargon).** New "✦ New project (guided)"
  flow. Q1 "What are you working toward?" Q2 "How will you know it's done?"
  Q3 (conditional, only if Q1=measured outcome) "Do you already know the
  metric?" — wording per design §"shape wizard". Plus a description box and
  optional pasted-text excerpt. On submit → `POST /api/classify`. **DoD:**
  three-question modal renders and collects answers. **Verify:** boot-hook
  auto-open + screenshot; the "no defined end" branch routes toward a
  Reference file, not a Project.

- [x] **C4. Editable recommendation preview → provision.** Render the
  classify result as an **editable** preview (framework dropdown, phase/
  state chips, metric, first action). On confirm: create the project with
  the chosen `framework` + `framework_config` seeded from the suggestion,
  and create the **first action atom** (in a fresh entry) so the project
  starts with momentum. **DoD/Verify:** complete the wizard end-to-end
  against the heuristic backend; confirm a new project exists with the
  framework set and one open action; screenshot the result.

- [x] **C5. Update `CLAUDE.md`** with the classify seam + wizard flow,
  alongside the existing atomize/triage description.

### Phase D — Program tier + program dashboard

> Add the strategic container and its OKR-shaped dashboard, and extend the
> wizard to provision a program with subprojects when `is_program` is true.

- [x] **D1. Program containers + linking.** Allow creating a
  `type:'program'` container (objective + key_results). Let projects/refs
  set `program_id` to nest under it (in create/edit, and via a "move to
  program" control). **DoD/Verify:** create a program, attach two demo
  projects, round-trip state.
- [x] **D2. Program dashboard view.** A program's detail page renders:
  objective; key results as progress bars (`current/target`); a
  **subproject grid** (each child project as a tile with its RAG + one-line
  status + open-action count); and a recent-entries feed across all
  children. Deep-linkable at `#/c/<program-id>`. **DoD/Verify:** screenshot
  a seeded program with ≥2 subprojects; grid + KRs render; clicking a tile
  drills into the project.
- [x] **D3. Home reflects the hierarchy.** The dashboard groups standalone
  projects/refs and shows programs as top-level tiles that expand to their
  children (or link through). Inbox + cross-cutting references remain
  pinned. **DoD/Verify:** screenshot home; programs are distinguishable
  from standalone projects.
- [x] **D4. Wizard `is_program` branch.** When classify returns
  `is_program:true`, the preview offers to create a Program plus the listed
  `if_program_subprojects` (each with its own framework). On confirm,
  provision the program + children + each child's first action. **DoD/
  Verify:** run the wizard with a CAHPS-style description that should
  classify as a program (force it via the heuristic if needed); confirm a
  program with subprojects is created.
- [x] **D5. Seed a demo program** (e.g. wrap two existing demo projects in
  a "demo_program_*") so the dashboard has realistic content, `demo_`-
  prefixed, dates relative to now. **DoD/Verify:** `seed.mjs --force`
  produces it; refuses to clobber without `--force`.
- [x] **D6. Update `CLAUDE.md`** (data model + dashboard sections) for the
  program tier.

### Phase E — RAG status (single authoritative color, aggregating up)

- [x] **E1. Project/ref RAG.** A manual `rag` selector on projects/refs
  (red/amber/green), shown as the authoritative status chip on tiles and
  detail headers. Default derives from existing signals (overdue actions →
  amber/red, else green) when unset, so nothing is colorless. **DoD/
  Verify:** set RAG on a project; chip shows everywhere; default derivation
  works for a project with an overdue action.
- [x] **E2. Program rollup.** A program's RAG = manual override else the
  worst child RAG. Surfaced on the program tile/header and the subproject
  grid. **DoD/Verify:** flip a child to red → program shows red unless
  overridden; screenshot.
- [x] **E3. Portfolio scannability.** Ensure the home view presents a
  photograph-able domain/status grid (the "weekly text to Dr. Schechter"
  artifact). **DoD/Verify:** screenshot reads clearly at a glance.
- [x] **E4. `CLAUDE.md`** note on the RAG scheme + rollup rule.

### Phase F — Atoms on graphs (manual annotation + intervention marks)

> Extend the existing glidepath so interventions can be **linked to atoms**
> and added by clicking, rather than only typed as static labels.

- [x] **F1. Annotation data model.** Extend `metrics[].interventions[]` (or
  add an `atom_ids` array per data bucket) so an intervention can reference
  an atom id, per design §"Atoms on graphs". Keep the existing static-label
  form working. **DoD/Verify:** round-trip a metric with an atom-linked
  intervention.
- [x] **F2. "Add a note" (manual, date pre-filled).** Clicking a point/axis
  on the chart opens a small field pre-filled with the bucket's date;
  submitting creates an **observation atom** in a "chart annotation" entry
  and marks the point. **DoD/Verify:** boot-hook the chart open, simulate
  add, confirm a new observation atom exists and a marker renders.
- [x] **F3. "Mark intervention start."** One-click vertical phase-boundary
  marker at the clicked date for PDSA projects, labeled with the current
  phase. **DoD/Verify:** screenshot a marked intervention on a pdsa demo.

(Click-to-link an *existing* atom is deferred to Phase H per the design's
V1.1 line.)

### Phase G — File attachments (upload pathway)

> Design V1 ships the **upload** pathway only (folder-scan is V1.1/H).
> Persist real files, not just text-into-notes.

- [x] **G1. Attachment record on containers.** Add optional
  `attachments[]` (`{id, filename, label, mime, added_at}`) to containers
  in the schema (still v3, optional). **DoD/Verify:** round-trips.
- [x] **G2. Node upload endpoint.** `POST /api/attachments` on `server.js`
  writes the file under an `attachments/` dir beside `THROUGHLINE_DB`
  (atomic), appends the record. On the Worker, either store small blobs in
  KV or return a clear "not supported in cloud demo" — **document whichever
  you choose** and keep the front-end graceful. **DoD/Verify:** `curl`
  upload a small file → file on disk + record in state.
- [x] **G3. UI: upload + list as links.** Project/ref view gets an "Add
  attachment" control and lists attachments as hyperlinks. **DoD/Verify:**
  screenshot; link points at the stored file.
- [x] **G4. `CLAUDE.md`** "ingestion surface" + attachments note.

### Phase H — Deferred backlog (do NOT start without human go-ahead)

Per design §"Later iterations" and V1.1 lines: waterfall template ·
folder-scan attachment pathway · click-to-link existing atom on chart ·
OneDrive folder tree + auto-generated `README.md` per program/project ·
Loop Deloop ingestion wire-in · multi-user authorship (author name on
entries/atoms) · "prepare for review" cdsapi export · email capture ·
Epic/Optum metric data connector · per-preview-branch KV isolation ·
Cloudflare non-prod deploy-command setup · README accuracy pass.

---

## 7. Definition of Done for V1 (the exit check)

V1 is complete when the **CAHPS test case** can be run end to end (the
design's acceptance bar): the wizard onboards a CAHPS program for a
non-expert user; it provisions a program (OKR dashboard) with subprojects
spanning ≥3 frameworks (e.g. milestone for analytics, kanban for provider
comms, pdsa for the QI intervention); each project shows its
framework-appropriate dashboard and open actions by owner; RAG aggregates
to the program; a metric chart accepts a manual atom annotation; and at
least one attachment can be uploaded and surfaced as a link — all working
against the heuristic backend with **zero spend**, and against
`anthropic` when a key is present. Capture (entry → atom) and triage
remain unbroken throughout.

---

## 9. Epic E1 — Folder-lens MVP (post-V1, ACTIVE)

> The next sprint. Full design + rationale in `VISION.md`. Scope locked
> 2026-05-31: **local-only** (no server/Graph yet — regulatory scrutiny;
> multi-user via manual turn-taking), folder-lens slice **S0 + S1 + S3**: bind a
> container to a real OneDrive folder, show its **live** files, and **open them
> in their native app** (Excel/Word/Notepad) instead of downloading. Same
> work-and-verify discipline as the V1 phases (§0–§5 still apply).
>
> **Epic-specific guardrails (in addition to §4):**
> - **Path safety is critical.** Every fs path is resolved and validated to live
>   under `ONEDRIVE_ROOT`; reject any `..`/absolute escape *before* touching the
>   disk. A web UI must never be able to make the server read/open an arbitrary
>   path. Add a test that escape attempts are refused.
> - **fs endpoints are local-Node-only.** Implement `/api/fs/*` in `server.js`;
>   the Worker (`src/index.js`) returns **501** (no local filesystem in the
>   cloud) — same pattern as attachments. Front-end degrades gracefully.
> - **Never write/delete in the bound tree** in this MVP — read + open only. The
>   filesystem is the source of truth (lens, not vault).
> - **Bindings are stored root-relative** (portable to Natalia's box later).
> - **Verify on the Linux dev box:** use a fixture `ONEDRIVE_ROOT` with sample
>   folders/files. The GUI launch from open-in-app won't fire in the sandbox —
>   assert the *command + args constructed* and the path-validation instead.

- [x] **E1.0 · Config + file-access seam.** Add `ONEDRIVE_ROOT` to `.env.example`
  (default = the folder containing `THROUGHLINE_DB`). New `lib/files.js`:
  `rootDir()`, `resolveWithinRoot(rel)` (throws on escape), `listFolder(rel)` →
  `{path, folders:[{name}], files:[{name,size,mtime,ext}]}`, `statSafe`. Local
  `fs` impl behind a small interface so a Graph impl can slot in later.
  **Verify:** node test — `resolveWithinRoot` rejects `../`/absolute escapes and
  accepts in-tree paths; `listFolder` returns a fixture tree.

- [x] **E1.1 · `GET /api/fs/list` (both backends).** `server.js`: list a
  root-relative path via `listFolder`; 400 on a bad/escaping path, 404 if
  missing. `src/index.js`: `/api/fs/*` → 501. **Verify:** curl list a fixture
  root; an escape attempt → 400/403; Worker route returns 501 (syntax-checked).

- [x] **E1.2 · Bind a container to a folder (data + in-app folder browser).**
  Add `container.folder` (root-relative string|null) defaulted in
  `normalizeContainer`. UI: a **"Bind folder"** control on project/reference
  detail opens a **folder-browser modal** (lists the root via `/api/fs/list`,
  navigate into subfolders, **"Use this folder"** sets `container.folder` +
  saves). **Verify:** bind a demo container to a fixture folder; round-trips
  through PUT; screenshot the browser modal + the bound state.

- [x] **E1.3 · Render the bound folder's live contents.** On project/reference
  detail, when `container.folder` is set, show a **Files** section listing the
  bound folder's live folders + files (via `/api/fs/list`), above/replacing the
  copy-attachments block (which stays for now — deprecate later per T4).
  **Verify:** screenshot a container showing live files from the fixture folder.

- [x] **E1.4 · Open-in-native-app.** `lib/files.js` `openFile(rel)`: validate
  within root, spawn the platform opener detached (win32 `cmd /c start "" "<abs>"`,
  darwin `open`, linux `xdg-open`). `server.js`: `POST /api/fs/open {path}`;
  Worker → 501. UI: clicking a file in the bound listing calls `/api/fs/open`
  instead of downloading. **Verify:** curl open on linux → asserts the correct
  opener command + absolute path and returns ok (no 500); escape attempt
  refused; screenshot the file list with the open wiring.

- [x] **E1.5 · Update `CLAUDE.md`.** Document `ONEDRIVE_ROOT`, the `lib/files.js`
  file-access seam, the `/api/fs/list` + `/api/fs/open` endpoints (local-only,
  Worker 501), `container.folder`, and the open-in-native-app behavior.

**E1 Definition of Done:** point a project at a real OneDrive subfolder, see its
actual files on the project page, and click a spreadsheet to open it in Excel —
all local, with path-traversal blocked and the Worker cleanly 501-ing. Then it's
ready to use solo and to demo the lens idea to Natalia.

---

## 8. Progress log (append-only — the autonomous agent updates this)

> Newest at top. One entry per completed task (or BLOCKED note). Include:
> date · task id · what changed · files · evidence (screenshot path /
> curl transcript). This is how a future session knows what's done.

- 2026-06-01 — **E1.3 follow-up: expandable folder tree (user request).** Orange
  testing surfaced that bound subfolders looked clickable but didn't navigate.
  Replaced the flat one-level listing with a lazily-loaded expandable tree:
  `renderFolderFiles` now mounts `mountFsLevel(el, path)`, which renders folders
  (toggle rows) then files, and each subfolder fetches its own children via
  `/api/fs/list` only on first expand — arbitrary depth, nothing loads until
  opened (keeps a big tree fast). Files still open via `/api/fs/open`. Files:
  `public/app.js`, `public/styles.css` (`.fs-tree`/`.fs-row`/`.fs-children`),
  `CLAUDE.md`. Evidence: nested fixture (`Project Alpha/analytics/{deep/,
  cohort_q1.xlsx,cohort_q2.xlsx}`, `comms/email_draft.docx`, `master.xlsx`) —
  `/tmp/tl_tree_expanded.png` shows analytics + comms expanded with their files,
  `deep` collapsed and ready to drill further; subfolder list endpoint verified;
  14/14 tests still pass; temp `?expand=` hook removed (grep 0).
- 2026-05-31 — **E1.5 done → Epic E1 (folder-lens MVP) COMPLETE.** Documented the
  folder lens in `CLAUDE.md`: a new "Folder lens — `lib/files.js` + `/api/fs/*`"
  section (ONEDRIVE_ROOT, root-relative bindings, the `resolveWithinRoot` security
  gate, `listFolder`/`openFile`/`openCommandFor`, `/api/fs/list` + `/api/fs/open`
  local-only with Worker 501, the front-end bind/browse/open flow, DRYRUN, and
  `npm test`) plus the `container.folder` field in the data-model section. Files:
  `CLAUDE.md`. Evidence: section matches the code landed in E1.0–E1.4; final
  `node --test` → **14/14**, headless load of a bound container has no app JS
  errors, no leftover temp hooks. **Epic E1 DoD met:** bind a project to a real
  OneDrive subfolder → see its actual files on the project page → click a
  spreadsheet to open it in Excel — all local, path-traversal blocked, Worker
  cleanly 501-ing. Stopping here per the goal (do not start other epics/tickets).
- 2026-05-31 — **E1.4 done.** Click a bound file → it opens in its native app
  instead of downloading. `lib/files.js`: `openCommandFor(abs, plat)` (pure —
  win32 `cmd /c start "" <abs>`, darwin `open`, linux `xdg-open`) +
  `openFile(rel)` (validate within root → require a real file → spawn detached &
  unref; `THROUGHLINE_OPEN_DRYRUN=1` skips the spawn for sandbox verification;
  returns the constructed `{command,args}`). `server.js`: `POST /api/fs/open
  {path}` (escape/folder → 400, missing → 404, GET → 405). Worker → 501 (the
  existing `/api/fs/*` catch). UI: bound files are now `<button>`s wired to
  `openBoundFile` → `/api/fs/open`. Files: `lib/files.js`, `server.js`,
  `public/app.js`, `public/styles.css`, `test/files.test.mjs`. Evidence:
  `node --test` → **14/14** (incl. per-platform command + traversal refusal +
  folder/missing rejection); curl on :8821 (DRYRUN) → `{ok, command:"xdg-open",
  args:["/tmp/tl_fs_fixture/CRM Cutover/master.xlsx"]}`, `../` escape → **400**,
  folder → **400 not a file**, missing → **404**, GET → **405**, no path →
  **400**; Worker `/api/fs/open` → **501** (earlier). `/tmp/tl_e14_open.png`
  shows the clickable file buttons. Next: **E1.5** (CLAUDE.md).
- 2026-05-31 — **E1.3 done.** A bound container now shows its folder's LIVE
  contents. `renderFolderFiles` fetches `/api/fs/list?path=<folder>` and lists
  subfolders + files (icon by ext via `fileIcon`, size via `fmtBytes`); each file
  carries `data-file` (root-relative) for E1.4's open wiring. Renders in
  `#folder-files` above the (now legacy) copy-attachments block, which stays for
  now (deprecate per T4). 404 → "bound folder missing" notice; 501 → cloud
  message. Files: `public/app.js`, `public/styles.css` (already added E1.2).
  Evidence: `/tmp/tl_e13_files.png` — demo_crm_cutover bound to "CRM Cutover"
  shows 📁 analytics, 📊 master.xlsx 5 B, 📝 notes.docx 3 B (dotfile excluded,
  icons correct). Next: **E1.4** (open-in-native-app).
- 2026-05-31 — **E1.2 done.** Containers can bind to a real OneDrive folder.
  `normalizeContainer` now defaults `folder` (root-relative string|null) on
  projects + reference files. New `#project-folder` section (`renderFolderLens`)
  on project/ref detail: unbound → "🔗 Bind a folder"; bound → the path chip +
  **Change**/**Unbind** (unbind nulls `folder`, never touches disk). "Bind"/"
  Change" open `openFolderBrowser` — an in-app modal that lists the root via
  `/api/fs/list`, navigates subfolders (clickable rows + a breadcrumb + ↑..),
  and **"Use this folder"** sets `container.folder` + saves. 501 (cloud) degrades
  to a clear message. Files: `public/app.js`, `public/index.html` (template div),
  `public/styles.css`. Evidence: fixture root `/tmp/tl_fs_fixture`, seeded demo
  on :8821 — `/tmp/tl_e12_fb.png` shows the browser modal (root: CRM Cutover +
  top.txt, "Bind to: (root)"); PUT round-trip set `demo_crm_cutover.folder="CRM
  Cutover"` and GET read it back; `/tmp/tl_e12_bound.png` shows the bound chip +
  Change/Unbind. Temp `?fb=` boot-hook added then removed (grep 0). Next:
  **E1.3** (render the bound folder's live contents).
- 2026-05-31 — **E1.1 done.** `GET /api/fs/list` in both backends. `server.js`:
  `handleFsList` reads `?path=<root-relative>`, calls `listFolder`, maps errors —
  escape/absolute/non-string → **400**, ENOENT → **404**, ENOTDIR → 400, POST →
  405. `src/index.js`: `/api/fs/list` (and any `/api/fs/*`) → **501** (no cloud
  filesystem), mirroring the attachments pattern. Front-end will degrade on 501.
  Files: `server.js`, `src/index.js`. Evidence: fixture root `/tmp/tl_fs_fixture`,
  Node on :8821 — root list `{folders:[CRM Cutover], files:[top.txt]}`, subfolder
  list (size/mtime/ext), `../tl_outside.txt` → **400** "path escapes
  ONEDRIVE_ROOT", missing → **404**, POST → **405**; the live wrangler on :8787
  returned **501** for both `/api/fs/list` and `/api/fs/open`. Next: **E1.2** (bind
  a container to a folder + folder-browser modal).
- 2026-05-31 — **E1.0 done (Epic E1 starts).** Added the folder-lens file-access
  seam. New `lib/files.js`: `rootDir()` (ONEDRIVE_ROOT, default = THROUGHLINE_DB's
  dir), `resolveWithinRoot(rel)` (rejects `..`/absolute escapes via a
  `path.relative()` containment gate, *before* disk), `listFolder(rel)` →
  `{path, folders:[{name}], files:[{name,size,mtime,ext}]}` (sorted, dotfiles
  skipped), `statSafe`, `toRootRel`, and a `setFsBackend()` seam so a Graph impl
  can replace local `fs` later. `ONEDRIVE_ROOT` documented in `.env.example`
  (root-relative bindings, read+open only). Files: `lib/files.js`, `.env.example`,
  `test/files.test.mjs`, `package.json` (`npm test`). Evidence: `node --test test/`
  → **10/10 pass**, including traversal refusals (`../`, nested `../../`,
  re-anchored absolutes) and the fixture-tree listing. Next: **E1.1**
  (`GET /api/fs/list` in both backends).
- 2026-05-31 — **Post-V1 UX tweaks (user preview feedback).** (1) The Edit
  modal ran off the bottom edge on tall content — `.modal` now has
  `max-height: calc(100vh - 96px); overflow-y:auto` and the shroud padding
  dropped to 48px, so it scrolls within the viewport. (2) Per user request,
  the **official PM-tool name is now shown inline** alongside the plain-English
  label: added `FRAMEWORKS[id].name` (`frameworkName`); the picker options read
  "…stages (Kanban)" etc. and the framework panel labels read "Board · Kanban",
  "Cycle · PDSA", etc. Relaxes the old "no jargon" guardrail (#6 updated). Files:
  `public/styles.css`, `public/app.js`, `CLAUDE.md`, `BUILDPATH.md`. Evidence:
  `/tmp/tl_ux_modal.png` (modal scrolls at 760px height), `/tmp/tl_ux_panel.png`
  ("BOARD · Kanban" inline).
- 2026-05-31 — **G4 done → Phase G complete → FULL V1 (Phases A–G) DONE.**
  Documented the attachments upload pathway in `CLAUDE.md` (Node file store
  beside the DB, client-owns-record, Worker 501, folder-scan deferred); confirmed
  `/data/` is gitignored so attachments don't travel. Files: `CLAUDE.md`.
  **All of V1 scope (A–G) is implemented and verified.** Phase H remains the
  deferred backlog — do NOT start without a human go-ahead.
- 2026-05-31 — **G1 + G2 + G3 done.** Attachments (upload pathway): containers
  gain optional `attachments[]` (`{id,filename,label,mime,added_at,url}`). Node
  `POST /api/attachments` (base64 JSON, 15MB cap) writes the file to
  `attachments/<container_id>/` beside `THROUGHLINE_DB` and returns a record;
  `GET /api/attachments/<cid>/<name>` serves it. The **client** owns state and
  appends the record (no server/client state race). The Worker returns a clear
  501 (no cloud file store) — route present in both backends. UI: an Attachments
  section on project/reference detail (`renderAttachments` + `uploadAttachment`
  via FileReader→base64) with "+ Add file" and the files as links. Files:
  `server.js`, `src/index.js`, `public/index.html`, `public/app.js`,
  `public/styles.css`. Evidence: curl upload → file on disk + servable bytes +
  worker 501; UI upload added the record and `/tmp/tl_g3_attach.png` shows the
  "📎 Field mapping.txt" link. Next: **G4** (CLAUDE.md → closes Phase G + V1).
- 2026-05-31 — **F2 + F3 done → Phase F complete.** Glidepath points are now
  clickable (invisible hit-circles on the main series → `openChartAnnotation`).
  F2 "Add note": creates an observation atom (tagged `chart`) in a per-project
  "Chart annotations" entry (`getOrCreateAnnotationEntry`) and marks the point
  with an `atom_id`-linked intervention. F3 "Mark <phase> start" (pdsa only):
  adds an intervention labeled with the current PDSA phase, no atom. Files:
  `public/app.js`. Evidence: `/tmp/tl_f2_chart.png` shows the new "Gusto demo
  delivered" marker; curl confirmed the chart observation atom + `atom_id` link
  (F2) and the phase-labeled intervention with no atom (F3). Temp hooks removed.
  **Phase F (atoms on graphs) is done.** Next: **G1** (attachment record schema).
- 2026-05-31 — **F1 done.** Intervention objects now carry an optional `atom_id`
  (link to an atom). Made `textToMetrics(text, prevMetrics)` preserve `atom_id`
  by matching label+idx, so editing the metric text in the Edit modal no longer
  drops chart-linked atoms (save handler now passes `c.metrics`). renderGlidepath
  already tolerates the extra field. Files: `public/app.js`. Evidence: node test —
  atom_id preserved on text re-parse with prev, absent without. Note: our metric
  `data[]` is index-based (no per-point dates), so annotations are keyed by point
  index, not calendar date. Next: **F2** (click-to-add note).
- 2026-05-31 — **E4 done → Phase E complete.** Added a dedicated RAG note to
  `CLAUDE.md` (manual selector + Auto derivation + program rollup + where it's
  surfaced). Files: `CLAUDE.md`. **Phase E (RAG status) is done.** Next: **F1**
  (atom-annotation data model on the glidepath).
- 2026-05-31 — **E3 done.** Added an at-a-glance RAG status grid to the home
  dark header (`#home-rag` in `renderHomeSub`): counts top-level items (programs +
  standalone projects) by RAG → "🔴 N Needs attention · 🟡 N Watch · 🟢 N On
  track". With the per-tile dots + summary bar, home is now a photograph-able
  weekly-status artifact. Files: `public/index.html`, `public/app.js`,
  `public/styles.css`. Evidence: `/tmp/tl_e3_home.png` shows "1 Needs attention ·
  1 On track". Next: **E4** (CLAUDE.md RAG note).
- 2026-05-31 — **E2 done.** `programRag` (worst-of-children) already drove the
  program tile/header/grid; added a manual RAG override selector to
  `openEditProgramModal` so a program's status can be set by hand (else derived).
  Files: `public/app.js`. Evidence: replicated logic (derived→red, override→green,
  single-amber→amber); set program `rag:green` via curl → tile turns green over
  red children (`/tmp/tl_e2_home.png`). Next: **E3** (portfolio scannability).
- 2026-05-31 — **E1 done.** Added a manual RAG selector (`ragSelectHtml`,
  "Auto" = derive) to the project/reference Edit modal (persists/clears `c.rag`),
  a RAG dot on project tiles (`tile-rag`), and an authoritative RAG chip
  (`ragChip`) in the container detail header. `ragOf` already derives when
  unset. Files: `public/app.js`, `public/styles.css`. Evidence: set Ops project
  `rag:amber` (persisted via curl); `/tmp/tl_e1_home.png` shows the amber dot on
  Ops and a derived red dot on the program. Next: **E2** (program rollup).
- 2026-05-31 — **D6 done → Phase D complete.** Documented the program tier in
  `CLAUDE.md` (Patterns: programs/dashboard/home tiles/linking/wizard
  provisioning/RAG + the `uid()`-not-`uniqueSlug` note) and corrected the demo
  count to 7 (1 program + 3 projects + 3 references). Files: `CLAUDE.md`.
  **Phase D (program tier) is done.** Next: **E1** (project/ref RAG).
- 2026-05-31 — **D5 done.** Seeder now creates a demo program
  `demo_program_modernization` ("Vendor & systems modernization", objective +
  3 KRs) and nests `demo_payroll_renewal` + `demo_crm_cutover` under it via
  `program_id`. Extended `pushContainer` to pass through v3 fields
  (program_id/framework/framework_config/rag/objective/key_results). Files:
  `scripts/seed-data.mjs`. Evidence: reseed → 7 containers, program with 3 KRs,
  2 projects nested; runner refuses without `--force`; `/tmp/tl_d5_home.png`
  shows the PROGRAM tile + standalone Ops project. Next: **D6** (CLAUDE.md).
- 2026-05-31 — **D4 done.** Wizard now branches on `is_program`: a program
  recommendation (`openProgramRecommendation`) shows an editable program name +
  objective and the suggested subprojects (name + framework each editable);
  `provisionProgram` creates the program + each subproject (with its framework +
  a seeded first action) and opens the dashboard. **Fixed a real bug:**
  `seedFirstAction` used `uniqueSlug` (dedupes only container ids) so multiple
  seeded entries collided on one id, making every subproject show all actions —
  switched to `uid()`. Files: `public/app.js`, `public/styles.css`. Evidence:
  drove the wizard with a CAHPS description (temp hook, removed) → program + 4
  subprojects spanning milestone/kanban/pdsa/milestone, each with exactly 1 open
  action (jq verified) and a green RAG; `/tmp/tl_d4b_prog.png` shows the dashboard.
  Next: **D5** (seed a demo program).
- 2026-05-31 — **D3 done.** Home project grid now leads with distinct program
  tiles (`renderProgramTile` — navy gradient, "PROGRAM" badge, aggregate RAG dot,
  objective, child + open counts, links to dashboard) and shows only *standalone*
  projects (those with a `program_id` are hidden from top level, surfaced under
  their program). Files: `public/app.js`, `public/styles.css`. Evidence:
  `/tmp/tl_d3_home.png` — CAHPS program tile present, its 3 children hidden,
  Inbox + references pinned; no JS errors. Next: **D4** (wizard is_program branch).
- 2026-05-31 — **D2 done.** Program detail now renders an OKR dashboard
  (`renderProgramDashboard`, branched in `renderContainerTab`): objective, key
  results as proportional progress bars, a subproject grid (each child = RAG dot
  + title + one-line status + completion + open/overdue counts, links to the
  project), and a recent-activity feed across all children. Added `ragOf` +
  `programRag` + `childProjectsOf` + `RAG_COLOR` (shared with Phase E), and an
  `openEditProgramModal` (objective + key-results editing, archive). Files:
  `public/app.js`, `public/styles.css`. Evidence: `/tmp/tl_d2_dash.png` — program
  with 2 KRs + 3 linked projects (RAG red/green/red from overdue actions) +
  6-row activity feed; no JS errors. Next: **D3** (home reflects hierarchy).
- 2026-05-31 — **D1 done.** Added the program tier: "New program" home button →
  `openNewProgramModal` (title + objective + key-results textarea via
  `keyResultsToText`/`textToKeyResults`, line `Label | current | target | unit`).
  Projects can be linked to a program via a `programSelectHtml` picker added to
  the project create + edit modals (sets/clears `program_id`; only shown once a
  program exists). Files: `public/index.html`, `public/app.js`. Evidence: drove
  the program modal headlessly → program `cahps_improvement_2026` created with
  objective + 2 KRs; curl round-trip linked 2 demo projects via `program_id`
  (both survive GET); program detail page renders without JS errors
  (`/tmp/tl_d1_progpage.png`, generic entries view pending D2). Next: **D2**
  (program dashboard).
- 2026-05-31 — **C5 done → Phase C complete.** Documented the second AI seam
  (`shared/classify.js` + `/api/classify`) and the guided shape wizard in
  `CLAUDE.md`'s "AI ingestion seam" section (provider-agnostic, heuristic
  fallback, open-ended→reference, program-provisioning deferred to D). Files:
  `CLAUDE.md`. **Phase C (AI shape wizard) is done** — wizard works end-to-end at
  zero spend. Next: **D1** (program containers + linking).
- 2026-05-31 — **C4 done.** Replaced the minimal recommendation display with an
  editable preview: project name, framework dropdown (`frameworkSelectHtml`),
  suggested-steps chips, an optional measure, and the first step — all editable
  before commit. `provisionFromRecommendation` creates the project with the
  chosen `framework`+`framework_config` (pdsa measure → `aim`) and seeds a first
  open action atom via `seedFirstAction`. Program recommendations show their
  subprojects with a note that full program setup arrives in D4 (creates one
  project for now). Files: `public/app.js`, `public/styles.css`. Evidence: drove
  the whole wizard→edit→Create flow headlessly (temp hook, removed) — state went
  6→7 containers, new project `framework:pdsa` with `aim` set + exactly one open
  action; `/tmp/tl_c4_created.png` shows it rendering as a PDSA project with
  "OPEN ACTIONS: 1" and "saved just now". Next: **C5** (CLAUDE.md update →
  closes Phase C).
- 2026-05-31 — **C3 done.** Added the guided shape wizard: home primary button
  is now "✦ New project" → `openProjectWizard()` — a description box + two
  plain-English radio questions (Q3 "do you know the measure?" reveals only when
  goal = outcome) + optional pasted excerpt. "Get suggestion" POSTs to
  `/api/classify` and hands off to `openProjectRecommendation` (minimal display
  now; C4 makes it editable + provisions). "It doesn't have a finish line" routes
  to a **reference file**, not a project. "Skip — set up manually" falls back to
  the plain modal. Added a basic `provisionFromRecommendation` + `seedFirstAction`
  (single project + first-action atom). Files: `public/index.html`,
  `public/app.js`, `public/styles.css`. Evidence: `/tmp/tl_c3_wizard.png`
  (3-question modal, no jargon), `/tmp/tl_c3_rec.png` (live wizard→classify→
  recommendation: "a board fits best"), `/tmp/tl_c3_ref.png` (open-ended →
  New reference file with prefilled title). Temp boot-hooks removed (grep 0).
  Next: **C4** (editable recommendation preview + provisioning).
- 2026-05-31 — **C2 done.** Wired `POST /api/classify` into BOTH backends:
  `server.js` (`handleClassify`, reuses module-level `llmCall`) and
  `src/index.js` (`handleClassifyRequest`, `makeLLMCall(env)`) — identical
  contract: body `{description, excerpt, answers}` → `classifyProject` result.
  Files: `server.js`, `src/index.js`. Evidence: curl vs Node (port 8813) —
  simple→pdsa/source:heuristic, CAHPS→is_program w/ subs
  [milestone,kanban,pdsa,milestone], empty body→200 (never 500), GET→405,
  /api/state unregressed. Worker side syntax-checked + byte-identical wiring
  (live wrangler curl skipped to avoid disturbing the shared :8787 instance).
  No ANTHROPIC_API_KEY in env → heuristic path only (live Anthropic path
  un-exercised, non-blocking). Next: **C3** (wizard UI).
- 2026-05-31 — **C1 done.** Added `shared/classify.js` (runtime-agnostic ESM,
  mirrors atomize.js): `buildClassifyPrompt` + `classifyProject({description,
  excerpt, answers}, {llmCall})` → `{framework, reason, suggested_phases_or_states,
  suggested_metric, is_program, if_program_subprojects[], first_action, source}`.
  Heuristic fallback maps wizard answers/keywords → framework, and detects a
  program when a long description spans ≥2 distinct workstream domains. Defensive:
  bad/empty model reply degrades to heuristic (never throws). Files:
  `shared/classify.js`. Evidence: node import test — simple desc→single pdsa,
  CAHPS desc→program w/ 4 subprojects (milestone/kanban/pdsa), mock fenced-JSON
  llmCall→source:llm, garbage llmCall→degrades to heuristic. Next: **C2**
  (`POST /api/classify` in both backends).
- 2026-05-31 — **B7 done → Phase B complete.** Updated `CLAUDE.md`
  "Project detail tabs" + "Glidepath" patterns to document the four framework
  views (`renderKanbanBoard`/`renderPdsaCycle`/`renderMilestoneList`/
  `renderTimeline`), the `workflow_state` card model, the milestone text format,
  and the no-framework fallback. Files: `CLAUDE.md`. Evidence: section matches
  the code landed in B1–B6. **Phase B (PM framework templates + dashboards) is
  done.** Next: **C1** (`shared/classify.js`).
- 2026-05-31 — **B5 + B6 done.** B5: `framework==='timeline'` renders a floated
  next/overdue trigger (`nextTriggerFor` — soonest upcoming `next_meeting` or
  open-action due date) over a reverse-chron event log of entries (date · kind ·
  title, click → drawer). Files: `public/app.js`, `public/styles.css`. Evidence:
  `/tmp/tl_b5_timeline.png` (NEXT 2026-05-31 trigger + 8-row log). B6: the
  post-selection help blurb was already wired into every framework panel label
  in B2–B5 (`frameworkBlurb(...)`), shown only after a framework is chosen, with
  jargon-free pickers — no extra code; verified visible in each panel
  screenshot. Next: **B7** (CLAUDE.md update → closes Phase B).
- 2026-05-31 — **B4 done.** When `framework==='milestone'`, Overview renders a
  milestone checklist (`renderMilestoneList`): each row = checkbox (toggles
  `done`) · label · criteria · owner · due (overdue in red); first not-done row
  highlighted as "next"; optional From/To state line. Added compact
  `milestonesToText`/`textToMilestones` (line: `Label | owner | YYYY-MM-DD |
  criteria | x`) and a Milestones textarea in the Edit modal, saved into
  `framework_config.milestones` for milestone projects. Files: `public/app.js`,
  `public/styles.css`. Evidence: screenshot `/tmp/tl_b4_ms.png` (2 done struck,
  "Panel interviews" next+overdue, From/To line); jq confirms 4 milestones / 2
  done persisted. Next: **B5** (timeline view).
- 2026-05-31 — **B3 done.** When `framework==='pdsa'`, Overview shows a
  clickable four-step cycle strip (`renderPdsaCycle` — Plan/Do/Study/Act, current
  from `framework_config.phase`, click sets it) plus an Aim/Baseline/Target facts
  line, above the existing glidepath. The "PDSA" acronym is never shown (section
  titled "Cycle"; blurb spells out the words). Files: `public/app.js`,
  `public/styles.css`. Evidence: screenshot `/tmp/tl_b3_pdsa.png` shows the strip
  with "Do" active, facts line, and chart rendering; jq confirms persisted
  config. Next: **B4** (milestone view).
- 2026-05-31 — **B2 done.** When `framework==='kanban'`, the project Overview
  renders a column board (`renderKanbanBoard`) instead of the glidepath. Cards
  are the project's action atoms, grouped by `workflow_state` (closed actions
  auto-fall into the last/Done column, struck-through); a per-card `<select>`
  moves a card by setting `workflow_state`; clicking a card body opens its
  entry. KPI grid + owners block preserved; legacy/non-kanban projects still
  show the glidepath. Files: `public/app.js`, `public/styles.css`. Evidence:
  screenshot `/tmp/tl_b2_board.png` shows 4 columns (Backlog 3 / In progress 1
  / In review 1 / Done 2) with correct grouping; jq confirms the workflow_state
  distribution. Next: **B3** (PDSA view).
- 2026-05-30 — **B1 done.** Added `frameworkSelectHtml(selected)` (plain-English
  options, empty = unstructured) and wired a "How will you work this?" picker
  into the project **create** and **edit** modals. Create persists
  `framework`+`framework_config` (seeded from `frameworkConfigFor`); edit
  updates them and resets config when the framework changes, or deletes both
  when set back to none. Files: `public/app.js`. Evidence: screenshot
  `/tmp/tl_b1_edit.png` shows the picker in the edit modal (default "No set
  structure", no jargon); curl round-trip set `framework:"kanban"` +
  `framework_config.states` on `demo_crm_cutover` and GET returned them intact.
  Temp `?editc=` boot-hook added for the screenshot and then removed (grep
  confirms 0 `TEMP-VERIFY`). Next: **B2** (kanban board view).
- 2026-05-30 — **A3 done → Phase A complete.** Updated `CLAUDE.md` data-model
  section to v3 (program type; `program_id`/`rag` on all containers;
  `framework`/`framework_config` on projects; `objective`/`key_results` on
  programs; backward-compat note) and refreshed the central-lookup pattern
  note to cover the 4th container type + the new `FRAMEWORKS` registry. Files:
  `CLAUDE.md`. Evidence: section now matches the code landed in A1/A2. Next:
  **B1** (framework selector in container create/edit).
- 2026-05-30 — **A2 done.** Added the `program` row to `CONTAINER_LABELS`
  (cls `program`) and a single `FRAMEWORKS` registry (kanban/pdsa/milestone/
  timeline) with plain-English `label`, optional `blurb`, `metricFields`, and
  `defaultConfig()` — plus helpers `frameworkLabel/Blurb/ConfigFor`. Added
  `.type-mark.program` + `.type-badge.program` styles (navy). No behavior
  change yet. Files: `public/app.js`, `public/styles.css`. Evidence:
  `node --check public/app.js` OK; headless home load renders with no app JS
  errors; registry has 4 frameworks and all picker labels are jargon-free
  (verified by regex). Next: **A3**.
- 2026-05-30 — **A1 done.** Schema bumped v2→v3. Front-end `normalizeState`
  now maps containers through a new `normalizeContainer` that defaults the v3
  optional fields (`program_id`, `rag` on all; `framework`,`framework_config`
  on projects; `objective`,`key_results` on programs) without dropping keys.
  Both backends bump the version only — their `...o` spread already passes
  container inner-fields through, so unknown keys survive identically.
  Files: `public/app.js`, `lib/store.js`, `src/index.js`. Evidence: forced-v2
  doc PUT→GET returns v3 with unknown top-level + container keys preserved and
  0 data loss (6 containers/42 entries/95 atoms unchanged); screenshot
  `/tmp/tl_a1_crm.png` shows `demo_crm_cutover` rendering unchanged. Next: **A2**.
- 2026-05-30 — BUILDPATH.md authored. Current-state inventory verified
  against code (app.js, server.js, src/index.js, lib/store.js,
  shared/atomize.js, shared/llm.js, seed scripts). No build tasks started
  yet. Next: **A1**.
