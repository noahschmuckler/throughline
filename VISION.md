# Throughline — Vision & Architecture (living doc)

The forward-looking design doc. Builds on `design-conversation-05302026.md`
(the origin conversation). V1 (shipped) is mapped in `BUILDPATH.md` (phases
A–G); issues/ideas from real use accumulate in `TICKETS.md`. This file is where
the *next* big direction lives, and what we plan coding sprints against.

Last updated: 2026-05-31.

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
- **M3 · Workspaces** — point Throughline at multiple shared folders; switch
  between them; per-workspace bindings.
- **M4 · User onboarding** — a friendly setup for a new user (clone/sync +
  register-task + share-folder), folding in loop-de-loop's Graph-access-request
  wizard (T6).

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

**Locked decisions (2026-05-31):** open-in-native-app pulled early (yes);
lens-not-vault confirmed (yes); "shelf" is the word (yes); onboarding intelligence
= heuristic **+ cdsapi `gpt-mini`** + user confirm.

The "get something to Natalia soon to test sync" goal **reorders** the work —
folder-lens features (S0/S1/S3) alone would still clobber on concurrent edits,
which is the exact thing we want to study. So:

- **Sprint 1 — sync MVP (E2 M0 + M1, + minimal M2)** on the *current* V1 app:
  identity + 3-way auto-merge + flag the few real conflicts. This is literally
  what we hand Natalia to test consolidation/conflict resolution.
- **Sprint 2 — folder-lens MVP (E1 S0 + S1 + S3):** bind a container to a real
  folder, see its live files, open them in their native apps.
- **Then interleave** E1 S2/S4/S5 (viewer, onboarding, AI mapping) with E2 M3/M4
  (workspaces, user onboarding); loop-de-loop intake (T6) stays downstream.

Once Sprint 1 is locked, it graduates into `BUILDPATH.md` as **Epic E2** with
concrete per-task verify steps (same discipline V1 used).

## Open questions for planning (E2 / sync)

1. **Identity source** — auto-detect the **Windows username**, or a name set in
   `.env`? (Needed for M0 / edit authorship.)
2. **Confirm the multi-workspace model** — each shared OneDrive folder = a
   workspace; a user can be in several; cross-dyad collaboration = a shared
   workspace. (vs. any wish for one combined DB.)
3. **Conflict philosophy** — OK to **auto-merge disjoint changes + flag only
   same-object / same-field** conflicts (recommended), rather than always-manual
   resolution?
