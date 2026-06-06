# Throughline — Vision & Architecture (living doc)

The forward-looking design doc. Builds on `design-conversation-05302026.md`
(the origin conversation). V1 (shipped) is mapped in `BUILDPATH.md` (phases
A–G); issues/ideas from real use accumulate in `TICKETS.md`. This file is where
the *next* big direction lives, and what we plan coding sprints against.

Last updated: 2026-06-06.

---

## North star (evolved)

Throughline is a **structured lens over the dyad's existing OneDrive
filesystem.** Today those folders *are* Noah + Natalia's omnibus
project-management system — and they're obtuse: no M365 tool (with the partial
exception of Copilot) reads the tree as a whole and gives it meaning. Throughline
manages the **context around the work** — what folder belongs to what project,
what's been decided, who owes what, what's been said to whom — **without owning
or editing the work itself.** The atom substrate captures *meaning*; the
filesystem holds *materials*; Throughline binds the two.

It does **not** need to edit spreadsheets. It needs to make the filesystem
legible, navigable, and accountable.

---

## The object model (v2)

Container types stay `program | project | reference | inbox`, plus two
cross-cutting concepts: **shelf** and **bound folder**.

### Reference vs. shelf — the key new distinction

| | **Reference file** | **Shelf** |
|---|---|---|
| What it is | a curated *knowledge* container | a bucket of *working files* |
| Holds | **atoms** (observation / decision / action / outcome) | files only — no atoms |
| You... | consult & query it | operate *from* it; rarely browse it |
| Purpose | hold meaning you'll come back to | hold the materials needed to get a project done |
| Lifecycle | accrues meaning over time | exists to finish the work |
| Future | portable to SQL / vector DB | stays as files |

**Worked examples (from real use, 2026-05-31):**
- A provider 1:1 → a **reference file** for that provider. The meeting's
  observations and decisions live as **atoms** (queryable JSON, "what have I
  discussed with him"); the one-off actions were already done, so only outcome
  atoms were added. It even *spawned another reference* (a beta-tester list for
  an onboarding program Noah doesn't own and wasn't ready to instantiate as a
  project). Reference = structured, parked, consulted.
- A folder with **1 master spreadsheet + 85 derived spreadsheets** that were
  mailed to individual providers → a **shelf**, affiliated with the (not-yet-
  instantiated) project that produced them. Not reference — Noah will never
  "check" it for insight; it's just stuff needed to do the work.

Rule of thumb: **reference = knowledge you query (has atoms); shelf = materials
you operate on (has files).** A container can have several shelves.

### Bound folders — bind, don't copy

Every container (program / project / reference) and every shelf **binds to a real
OneDrive folder.** A container's files are a **live view** of its bound folder,
not copies hoarded in an opaque store. Two ways a binding comes to exist:
- **Created** by Throughline (new project → it makes the OneDrive folder), or
- **Adopted** via onboarding (point Throughline at an existing folder).

Both end identically: a container pointing at a real folder. This supersedes the
V1 copy-based attachment model (`BUILDPATH.md` §G / ticket **T4**): "upload"
becomes "drop a file into the bound folder."

Filesystem shape:
```
<OneDrive root>/
├─ <Program>/
│   ├─ <Project>/
│   │   └─ <Shelf>/          ← files only
│   └─ <Reference>/          ← atoms live in state.json; may also bind a shelf of source docs
├─ <Project (standalone)>/
└─ <Reference (cross-cutting)>/
```

---

## The architecture: a lens, not a vault

Throughline is an **overlay / index** over the folder tree, not a store that owns
copies.
- Source of truth for **materials** = the filesystem.
- Source of truth for **meaning** (atoms, status, structure, bindings) =
  `state.json`.

**Why this is uniquely possible for Throughline:** the Node server runs *on the
same machine* as the locally-synced OneDrive files, so it reads, writes, and
*opens* them directly via `fs` + the OS — **no Microsoft Graph API, no cloud
round-trip.** That local-app position is exactly what lets it interact with the
filesystem "as a whole" in a way the cloud M365 tools can't.

---

## Hosting — the major open decision (local device vs. central server)

Raised 2026-05-31. Noah has access to an **enterprise dev server** reachable by
anyone logged into their orange device (or an in-network desktop). Two models:

- **Local (current):** a Node server on each orange device, pointed at a shared
  OneDrive folder. **Great for the folder-lens** — the server reads and *opens*
  the user's locally-synced OneDrive files directly via `fs` + the OS. **But
  multi-user is the hard part** (Epic E2's OneDrive last-write-wins / merge).
  Needs a per-user install.
- **Central server (likely endgame):** one Throughline on the dev server,
  per-user **SSO**, reached at a URL — **no per-user install**, usable from any
  enterprise machine (not just the orange laptop). An onboarding wizard writes a
  per-user config; you share a OneDrive folder and send them a link.

The pivotal trade-off:
- A central server **dissolves the E2 sync problem** — one authoritative process
  owns state, so concurrency is normal serialized writes, *not* a merge-over-
  OneDrive race. **This likely makes the E2 OneDrive merge engine throwaway —
  so do not build it yet.**
- A central server **complicates the folder-lens** — it can't `fs`-read each
  user's OneDrive or `start` Excel on their desktop. File access then needs the
  **Graph API** (one app registration + admin consent — which actually *solves*
  the per-user Graph gap, vs. every user needing their own), and
  open-in-native-app needs **Office URI schemes** (`ms-excel:ofe|u|<cloud-url>`)
  for Office files, with a download/"open in web" fallback otherwise.
- **Auth becomes mandatory** the moment it's network-exposed (can't serve
  unauthenticated state to others), so SSO is a *prerequisite* for any non-solo
  use, not an add-on.

**Design stance to hold regardless:** the front-end is already backend-agnostic
(Node + Worker backends exist; a central server is a *third*, additive backend —
no UI changes). Add a **file-access seam** (`listFolder` / `readFile` /
`openFile`) with a local-`fs` impl now and a Graph impl later, so single-user
functionality we build now ports to either model.

**DECIDED (2026-05-31): stay local for now.** Rationale: the software engineers
warned that functional software *on the server* falls under heavier regulatory
scrutiny — keep it on local devices until it's primetime-ready. Consequences
we accept: multi-user is handled by **manual turn-taking** (Noah tells Natalia
"don't touch it until you see my push; same in reverse") instead of an automated
merge — so the **E2 merge engine stays deferred**. The folder-lens takes the
simple local path (`fs` + shell-open), no Graph/SSO. The central server remains
the plausible eventual home once it's primetime-ready; until then, keep building
behind the **file-access seam** so that move stays cheap.

## Capabilities of the vision

1. **Filesystem viewer.** An in-app browser of the bound tree. A container's page
   shows its folder's *live* contents and its shelves.
2. **Onboarding (adopt existing trees).** Point Throughline at a real folder →
   the server walks it → a heuristic/AI step proposes a role for each subfolder
   (**sub-container** of type X, or **shelf**) with one-line reasons → an
   **editable preview** → commit (creates the bound containers + shelves, indexes
   files by reference — no copying). This reuses the shape-wizard + triage
   commit pattern; the `classify` seam does the AI mapping, with a heuristic
   fallback (depth + name keywords: `raw/exports/archive/scans` → shelf;
   `analytics/comms/intervention` → sub-container).
   - Critically, subfolders ≠ subprojects: the per-folder decision is always
     "**sub-container or shelf?**"
3. **Open in the native app** (the differentiator — and the thing Noah expects
   Natalia to flag). Clicking a file **opens it in its default program**
   (`.xlsx`→Excel, `.docx`→Word, `.txt`→Notepad), *not* a download. Mechanism:
   the local server runs the OS "open" (`start "" "<path>"` on Windows) on a path
   it has **validated is inside the configured OneDrive root.** Local-Node-only;
   hard-disabled on the cloud Worker. This is "manage the context around the
   spreadsheet without editing it," made real.
4. **Reconcile loop.** Folders drift — renamed/moved in Explorer, files added
   outside the app. On load, Throughline re-walks bound folders and surfaces
   new/removed files and new subfolders → "new shelf? new sub-container?" This
   generalizes the `BUILDPATH.md` §H "folder-scan attachments" line to whole
   trees.
5. **Reverse direction.** Creating a program/project in Throughline creates its
   OneDrive folder structure.

---

## Load-bearing decisions (settle before/while building)

- **Per-user relative paths.** Noah's bound path is `C:\Users\nschmuc1\...`;
  Natalia's differs. The shared `state.json` must store bindings **relative to
  each user's configured `ONEDRIVE_ROOT`** (`.env`), never absolute. This couples
  directly to ticket **T3** (multi-user sync) — same machine-specific-vs-shared
  problem.
- **Drift tolerance.** A missing folder is surfaced as "missing," never a crash,
  never a lost container record.
- **Never delete a real folder.** Deleting a container *unbinds*; it must never
  touch the filesystem. The files are sacred.
- **Security of shell-open + serve.** Every path the server opens or serves is
  validated to live under `ONEDRIVE_ROOT` (no traversal); shell-open exists only
  on the local Node backend and is hard-off on the Worker.
- **Scale.** Index structure + filenames, never file contents; lazy-load. The
  85-spreadsheet folder must list instantly.

---

## Users & collaboration (the real shape)

Throughline is **not** a single-dyad tool. Known roster (2026-05-31):
- **Noah** (medical director) — primary.
- **Natalia Peden** — operations dyad (general). **First onboard**, initially to
  test synchronous edits / consolidation / conflict resolution — not yet for
  daily use.
- **Amanda Grady** — operations dyad for urgent care.
- **Scott Freiberg** + **Stephanie Paruolo** — another med-dir/ops dyad (later).
- Plus each user's **direct reports**, onboarded by that user. Growing.

Critically, collaboration is a **mesh, not hub-and-spoke**: e.g. Natalia ⇄ Amanda
may collaborate *without* routing through Noah. So sharing must **not** be gated
on a single owner.

**Architecture fit — multi-workspace.** Each shared scope = one shared OneDrive
folder + its `state.json` (+ the bound subfolders for the lens). A user can belong
to several workspaces; a cross-dyad collaboration is simply a workspace shared
with those people. This maps cleanly onto how OneDrive sharing already works
(share a folder with specific people) and needs **no central server** — which the
enterprise won't easily allow anyway. Getting this shared-folder substrate
**robust and user-friendly is make-or-break for adoption.**

## Loop intake (downstream — ticket T6)

Throughline has **no loop decoder today**; current meeting intake is export the
Copilot Facilitator summary to Markdown → Import/drag the `.md` → Atomize. The
separate `loop-de-loop` tool parses `.loop` artifacts but needs **Graph API
access** other users don't have — though it ships a strong wizard that walks a
user through *requesting* that access. Plan: package loop-de-loop / loop-file
intake as an included Throughline utility, and reuse its access-request wizard
for **new-user onboarding** — after fixing its known bugs (skips some `.loop`
files; re-reads already-processed files).

## Epic E2 — Multi-user & sync (now near-term, not "down the line")

Because Natalia's first use is explicitly to **test sync/conflict**, this stops
being optional. Stages:

- **M0 · Identity** — each running instance knows *who* the user is (Windows
  username, or a name in `.env`), used to author edits/atoms.
- **M1 · Auto-merge sync** — each instance keeps a *last-synced snapshot*; when the
  shared `state.json` changes (or a OneDrive *conflict-copy* appears), do a
  **3-way merge keyed by object id**. Because `entries`/`atoms` are append +
  id-keyed, **disjoint additions merge with zero loss** (the common case); only
  *same-object, same-field* edits are true conflicts. This is the robust core
  that makes concurrent editing a net positive — and it delivers Noah's
  git-branch/merge intuition **without a server.**
- **M2 · Conflict resolution UI** — surface the few real conflicts; let the user
  choose. Also reconcile/sweep OneDrive `*conflicted copy*` files.
- **M3 · Workspaces / "circles"** — point Throughline at multiple shared folders;
  switch/filter between them; federate them into one dashboard. **Full design
  below.**
- **M4 · User onboarding** — **DONE for the single-workspace case (Epic E1.5, see
  CLAUDE.md "Onboarding & distribution"): meridian-briefing distributor tile +
  self-downloading installer + two-step setup wizard; Noah + Natalia live.** What
  remains here is the *multi-workspace* onboarding (a new user joining several
  circles) and folding in loop-de-loop's Graph-access-request wizard (T6).

### Circles — the M3 design (worked out 2026-06-05, then PAUSED)

The load-bearing fact: **a OneDrive shared folder is the atomic unit of access —
sharing cascades down with no reliable sub-restriction** (enterprise ODB is
SharePoint-backed so break-inheritance is *technically* possible, but it's fragile
and must NOT be the basis of confidentiality). So:

- **circle = audience = one top-level shared folder = one workspace = one
  `state.json`.** A user belongs to several. Throughline **federates** the
  workspaces it can see into one view. A project lives in exactly one circle, so
  **its audience IS that folder's share** — Throughline writes *zero* access-control
  code; OneDrive's sharing is the permission system. The mesh case (Natalia+Amanda
  without Noah) just never syncs to Noah's box.
- **No nesting** — because sharing cascades down, circles must be **siblings** at
  the OneDrive top level, never nested. A user's drive becomes a flat row of
  circle-folders (some owned, some "shared-with-me" shortcuts = reparse points,
  which the lens/setup browser now resolves).
- **Audience = folder placement, NOT permission edits.** To give work to a
  different group you **create a sibling project in that circle** (the common case —
  work usually diverges per audience anyway), rather than re-sharing a folder. This
  sidesteps break-inheritance entirely.
- **The Epic E1.5 wizard already built the primitive**: it separated the lens root
  (`ONEDRIVE_ROOT`) from the data file (`THROUGHLINE_DB` = `<root>/Throughline/state.json`)
  and detects an existing workspace. "A shared folder containing `Throughline/state.json`"
  *is* the workspace unit. **What's left is the federation layer.**
- **Federation (the actual M3 build):** discover workspaces by scanning the user's
  OneDrive top level (incl. shared-folder shortcuts) for `*/Throughline/state.json`;
  load each, **tag every container with its origin workspace**, route writes back to
  the right file; a **header dropdown** (`All` + one per circle) filters the
  dashboard and sets which circle new projects land in.
- **"Who can see" label:** Throughline can't read the real ACL (no Graph), so each
  `state.json` carries a **self-declared** top-level `workspace: { name, members[] }`
  (defaulted in `normalizeState`). The dropdown shows it ("Shared with: Noah,
  Amanda"). It's a *reminder*, not enforcement — the folder share is the real
  boundary; never let the label masquerade as security.
- **Personal workspace** (a folder shared with no one) holds the user's
  **cross-circle programs** + private layout/pins. A program there can reference
  children across circles; only that user's app resolves them all.
- **Cross-circle MOVE** is a rare migration, not a daily feature: a project is an
  id-keyed **subtree** (container → entries → atoms) — cut from the source
  `state.json`, paste into the target (no broken internal links, no dup; back up
  first), re-base the root-relative `folder` binding, handle `program_id`. **Files
  move manually** (the lens is read-only by design); Throughline only re-points the
  binding. Not MVP.

**Immediate concrete TODO when this resumes:** Noah is onboarding **Amanda** (urgent
care). Some **UC projects already live inside Natalia's folder** (there was nowhere
else). Need: (1) make the Noah+Amanda shared folder (likely Noah-owned, shared to
Amanda) with a `Throughline/` subfolder; (2) a **one-off split script** that lifts
those UC containers (+ their entries/atoms) out of Natalia's `…\Peden, Natalia L's
files…\Throughline\state.json` into the new Amanda `state.json` and removes them from
the source (backup first; clear dangling `program_id`); (3) move any bound files in
Explorer + re-point bindings; then Amanda installs pointed at the new folder and her
wizard shows "✓ Existing workspace — N projects." Until federation lands, Noah
switches circles by repointing `THROUGHLINE_DB` (motivation to prioritize M3).

## Epic E3 — Modular components & the LLM collaborator (added 2026-06-06)

Origin: a year-old north-star experience — an early ChatGPT session that, for ten
days, acted as a true PM collaborator: it held context across many initiatives,
and on each brain dump it *talked back usefully, then offered to create an
internal document with a structure fitted to the goal* (csv for structured info,
markdown for narrative, checklists, reference files, email drafts). Recreating
that has been the project ever since. The 2026-06-06 live Copilot consult (a real
program retool, `copilot-ingestion` v1) proved the conversational half works and
exposed exactly what's missing: **the artifact** — Copilot proposed a genuinely
good novel structure (a loop tracker) and had no way to hand it to Throughline,
and Throughline had no shape that fit it.

### The collaborator has three stages

1. **Understand a dump** — conversational consult on raw input. *Shipped*
   (`copilot-ingestion` v1: bundle out, prose back).
2. **Instantiate structure** — the LLM proposes the ideal PM surface for the
   situation *and emits an artifact that constructs it* (program + projects +
   components + seeded atoms), validated by the gate, built by the existing
   provisioning machinery.
3. **Route ongoing input** — unstructured input (dictation, email, `.loop`
   summaries) updates the right *existing* structures: closes actions with
   outcomes, advances board cards, files atoms into the right entries/projects,
   appends glidepath points + interventions. The decision-set/gate/commitTriage
   architecture was built pointing at exactly this.

The wizard's two-radio-button classify stays as the fallback, but **structure
should emerge conversationally** — the consult becomes the real front door for
shaping new work. (Real-use verdict: the wizard's suggestions underwhelm; the
consult's didn't.)

### Modular components — composition free, vocabulary closed

Replace "a project HAS ONE framework" with "a project is COMPOSED of
components." Today `renderProjectOverview` branches on `c.framework` to pick one
main panel; the components model generalizes that to N panels per project:
`components: [{type, config}, …]`.

The load-bearing guardrail (Noah's own): *the more freeform projects get, the
more error-prone LLM-emitted updates become.* So the trade is explicit —

- **Composition is free**: any project can hold a loop-table + a comms kanban +
  a milestone list + a date timeline. (The motivating retool wanted exactly that
  and would otherwise be 5 single-view projects in a trenchcoat.)
- **The vocabulary is closed**: components come from a typed registry (the
  existing `FRAMEWORKS` pattern, generalized) — each type has a renderer and a
  **strict config schema**. An LLM authoring a structure proposal picks from a
  menu and fills schema-validated fields; it **never invents structure**. The
  ingestion gate validates every component config the way it bounds-checks
  `source_ref`.
- **The system grows by vocabulary, not looseness**: a situation that doesn't
  fit (this week: the loop tracker) becomes a new registry row + renderer — not
  a loosening of the model.

Back-compat: `framework: 'kanban'` normalizes to `components: [{type:'kanban'}]`
in `normalizeContainer` (same pattern as every schema bump so far). The four
frameworks become the first four component types.

### The table component (the missing view type)

Kanban fits **homogeneous pipelines** — discrete deliverables flowing through
shared stations (the Throughline-features board works great). It does *not* fit
stakeholder-divergent knowledge work, where every open loop follows its own path
("asked Jessica by email" → "replied" → "drafting a legal doc" are not stations
the *next* loop will visit). For that, the right view is a **compact table**:
one row per loop — loop · owner · last touch · status — sorted by staleness.

Two table components, sequenced:

- **Atom-backed table first** (the loop tracker): rows are **action atoms** —
  owner = `assigned_to`, last touch = `updated_at`, status = `workflow_state`.
  Deliberately shares kanban's data model, so table ⇄ board is a pure re-render
  and "convert to a clean Kanban once decisions land" is the existing framework
  switch. This resolves ticket T9.
- **Spreadsheet-backed table later** (Jason-style; Natalia's existing xlsx):
  don't build a spreadsheet — **bind to one**, per the lens philosophy. A
  read-only component configured `{file, sheet, columns}` surfaces live cells
  from a real OneDrive workbook via the folder lens + the already-decided
  vendored SheetJS. The workbook stays the source of truth; Throughline never
  writes it.

### Settled by this design pass (no build needed)

- **Decision nodes — no new atom type.** An open question lives as an action
  atom ("Decide X vs Y") in its contextual display; resolution arrives as an
  entry holding the **closing outcome** ("resolved at this meeting",
  `parent_atom_id` → the action) *plus a decision atom* — associated by
  co-occurring in the same entry. The decision is what future reports surface.
  The data model supports this today; the table view just renders open-question
  actions distinctly (a tag, not a type).
- **Constraints** live in the project/program summary.

### Back pocket (named, deliberately not built)

- **Workstreams as a first-class concept** — the atom_sandbox lesson stands:
  hundreds of hand-built atom chains were overwhelming and not useful. The name
  "Throughline" keeps the *idea* (don't drop loops; watch work flow); the
  loop-table is the lightweight version. Revisit only if the table proves
  insufficient.
- **LLM-generated narrative updates** per project — possibly outmoded by a good
  dashboard; if ever wanted, the export bundle is already the machine-readable
  input a narrator would consume.

### Sequence (E3.x stages; plan sprints at the next processing session)

1. **E3.0 quick wins** — T10 kanban-states editor; T8 atomize provenance
   *(shipped 2026-06-06)*; verify orange cdsapi connectivity.
2. **E3.1 components model** — registry + `components[]` + migration + edit UI.
   **The keystone; everything below targets it.** (Ticket T11.)
3. **E3.2 atom-backed table component** — the loop tracker (closes T9); the
   CAHPS/DOH retool program is the live pilot.
4. **E3.3 ingestion v2 as specced** — decision set + gate + normalize +
   SheetJS (`copilot-ingestion-spec.md` §8; independent of E3.1, can
   interleave). Includes the T7 cluster-level triage relief.
5. **E3.4 structure proposals (v2.5)** — the bundle's `_instructions` grows the
   component menu + schemas; Copilot returns a layout; the gate validates;
   provisioning constructs it. *Stage-2 collaborator: the ChatGPT moment,
   recreated with a dashboard.*
6. **E3.5 mutation decisions** — decision sets that update existing state
   (close/advance/append/glidepath); then T6 plugs in email/`.loop` as input
   channels. *Stage-3 collaborator: the full unlock.*
7. **Parked** — xlsx-backed table; narrative updates; workstreams; circles (§M3).

## Proposed sprint sequence (reordered by the "get it to Natalia" goal)

**Epic E1 — Folder-lens.** Each stage is usable on its own:

- **S0 · Per-user OneDrive root** — `ONEDRIVE_ROOT` in `.env`; all bindings stored
  relative to it. (Foundational; couples to T3.)
- **S1 · Bind** — add `container.folder` (root-relative path); migrate the
  attachment view from copy-store → live listing of the bound folder.
- **S2 · Filesystem viewer** — in-app folder browser of the root; container pages
  show live folder contents; shelves as named subfolders.
- **S3 · Open-in-native-app** — server shell-open (path-validated) replacing
  download. *(High user value; Natalia-flag candidate — consider pulling early.)*
- **S4 · Onboarding wizard** — walk → heuristic map → editable preview → commit,
  introducing the **shelf** concept end to end.
- **S5 · AI mapping** — `classify` seam proposes folder roles; heuristic stays as
  fallback.
- **S6 · Reconcile loop** — drift detection + propose-new on load.
- **S7 · Reverse** — create-in-Throughline makes the OneDrive folder.

This epic **supersedes** `BUILDPATH.md` §H "folder-scan attachments" and
**reframes** ticket **T4** (attachments). When we lock the sequence + priorities,
it graduates into `BUILDPATH.md` as Epic E1 with per-stage tasks and the same
verify-each-step discipline V1 used.

---

## Sprint plan (current)

**Locked decisions (2026-05-31):** stay **local** (no server yet — regulatory
scrutiny); multi-user handled by **manual turn-taking** for now (E2 merge engine
**deferred**); open-in-native-app pulled early; lens-not-vault; "shelf" is the
word; onboarding intelligence = heuristic + cdsapi `gpt-mini` + confirm.

**ACTIVE → Sprint 1: folder-lens MVP (E1 S0 + S1 + S3), local-only.**
Bind a container to a real OneDrive folder, see its live files, and open them in
their native apps (local `fs` + shell-open — no Graph). Useful to Noah solo
immediately; if Natalia is in the same workspace, manual turn-taking covers it.

Then: E1 S2/S4/S5 (viewer → onboarding → AI mapping). E2 (real multi-user) and
loop-de-loop (T6) reopen when the server question does / it's primetime-ready.

The three **E2 sync questions are parked** (identity source; multi-workspace
model; conflict philosophy) — they only matter once we leave manual turn-taking.
