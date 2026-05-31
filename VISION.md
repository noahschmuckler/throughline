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

## Proposed sprint sequence (a starting point — we refine this together)

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

## Open questions for planning

1. Is **open-in-native-app (S3)** a must-have-early (Natalia adoption), even
   ahead of full onboarding?
2. Confirm the **lens-not-vault** stance: folders are the source of truth for
   materials, Throughline never owns/edits them. (Load-bearing.)
3. Does **"shelf"** stay the word? (Noah: yes, as of 2026-05-31.)
4. How much **AI** in onboarding vs. a good heuristic + human confirm for v1 of
   the epic?
