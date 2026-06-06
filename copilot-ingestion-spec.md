# Copilot-assisted ingestion — schema & gate spec (v0.1)

Status: **design, not built.** Written 2026-06-06, after the Mode-B probe
(`copilot-probe/`) confirmed enterprise Copilot can read a binary OneDrive
`.xlsx` and return cell-cited JSON verdicts. This doc specs the three concrete
artifacts and the verification gate needed to wire that into Throughline's
existing triage pipeline. It supersedes the loose JSON shapes in
`throughline_copilot_design.md`.

Grounded in the v3 data model (see CLAUDE.md "Data model"). The ingestion
endpoint is **Node-only** (orange device), like the folder lens — there is no
cloud backend.

---

## 0. Two modes, one pipeline

The same pipeline has two entry points that converge on the **existing triage
overlay** (`commitTriage` is the only thing that writes real atoms):

- **Mode A — pure text dump.** Local `gpt-mini`/`gpt-5.4` extracts → triage
  draft. Copilot is an **optional** consult ("does this look right?"). Happy
  path skips it entirely.
- **Mode B — document-grounded.** "Brain dump + *what do I do with this
  spreadsheet*." The local pipeline can't read a binary `.xlsx`/email, so
  **Copilot is the front-line reader.** The probe proved this works.

Both modes produce the same two artifacts (**export bundle** out, **decision
set** in) and run through the same **verify-and-normalize gate** before triage.

```
dump (+docs) ──▶ local extract (mini/5.4) ──▶ DRAFT  ──▶ triage overlay ──▶ commitTriage ──▶ state.json
                                                │  ▲                          ▲
                                  "Chat about   │  │  decision set            │
                                   this" export │  │  (verified+normalized)   │
                                                ▼  │                          │
                                       export bundle ──▶ [attach to Copilot chat] ──▶ Copilot
                                                          reads docs, returns verdicts
                                                                   │
                                                                   ▼
                                              download → ~/Downloads → import → GATE ───┘
```

---

## 1. Stable id scheme

Every proposed item carries a **bundle-local** id, stable across the round trip.
These are **not** real `state.json` ids — they're resolved to `uid()`s only at
commit (§6).

| prefix | meaning            | who assigns |
|--------|--------------------|-------------|
| `p1…`  | proposed container | Throughline (draft) |
| `a1…`  | proposed atom      | Throughline (draft) |
| `n1…`  | new item Copilot adds that the draft missed | Copilot |

Cross-references (an atom's `target` → a container) use these bundle-local ids.
The gate builds the id→uid map at commit time.

---

## 2. Artifact A — the export bundle (`chat_about_this`)

Written by Throughline when the user clicks **"Chat about this"** on a draft.
The user attaches this file (and any source docs) to the Copilot chat.
**Lesson from the probe: do NOT rely on Copilot finding files by OneDrive path —
attach them to the chat.** `file_refs` paths are recorded for the lens, not as
Copilot's retrieval mechanism.

```jsonc
{
  "_artifact": "throughline.chat_about_this",
  "_schema": "ingest-v1",
  "version_hash": "tl_9f3a1c77",          // hash over proposed{} — integrity/staleness check
  "created_at": "2026-06-06T14:00:00Z",
  "session_id": "ing_2026-06-06_1400",    // ties the eventual decision set back to this draft

  "raw_dump": "Natalia's provider corner spreadsheet — people keep asking ...",

  "file_refs": [                          // source docs; attach these to the chat
    { "ref_id": "f1", "path": "Provider Corner/IMFM_Provider_Roster_2026.xlsx",
      "kind": "xlsx", "note": "the spreadsheet the dump is about" }
  ],

  "state_summary": {                      // working memory so Copilot places against REAL ids
    "containers": [
      { "id": "c_abc", "type": "reference_file", "title": "Credentialing SOPs",
        "summary": "...", "open_actions": 2 },
      { "id": "c_def", "type": "project", "framework": "kanban",
        "title": "Provider onboarding Q3", "summary": "...", "open_actions": 5 }
    ],
    "recent_actions": [ { "id": "at_x", "body": "...", "container_id": "c_def", "due_date": "2026-06-15" } ],
    "key_people": [ { "name": "Natalia Peden", "open": 4 } ]
  },

  "proposed": {                           // the thin draft from the local text pass
    "containers": [
      { "id": "p1", "kind": "reference_file", "title": "Provider Roster",
        "goal_or_purpose": "", "framework": null, "bind_folder": null,
        "confidence": 0.4, "source_ref": null,
        "note": "guessed from 'spreadsheet'; text pass can't read the xlsx" }
    ],
    "atoms": [
      { "id": "a1", "kind": "action", "body": "Check which providers' credentialing is expiring.",
        "target": "p1", "assigned_to": null, "due_date": null,
        "source_ref": null, "confidence": 0.5 },
      { "id": "a2", "kind": "observation", "body": "People keep asking who accepts new Medicaid patients.",
        "target": "p1", "source_ref": null, "confidence": 0.7 }
    ]
  },

  "needs_clarification": [
    "Which specific providers have lapsing credentialing, and by when?",
    "reference_file or project? what's the operational goal?"
  ]
}
```

`state_summary` is a **reduced** view (titles + ids + open counts + brief
summaries), never the full `state.json` — it's already >100 KB. It exists so
Copilot can say `"target": "c_def"` against a real container instead of guessing.

---

## 3. Artifact B — the decision set (Copilot's reply)

A **single JSON object keyed by id.** Each value is a verdict. This is exactly
the shape the probe returned successfully. Copilot may emit a plain-language
answer as prose *before* the block; the gate reads only the JSON.

```jsonc
{
  "_meta": { "version_hash": "tl_9f3a1c77", "session_id": "ing_2026-06-06_1400" }, // optional echo
  "p1": { "verb": "edit", "kind": "reference_file",
          "title": "IMFM Provider Roster & FAQ Reference",
          "source_ref": "FAQ!A1:B6", "confidence": 0.92, "note": "..." },
  "a1": { "verb": "edit", "kind": "action",
          "body": "Resolve credentialing for the 4 ACTION NEEDED providers (Haddad, Raman, Ortiz, Bjorn).",
          "target": "p1", "due_date": "2026-06-20",
          "source_ref": "Roster!E2:F17", "confidence": 0.95 },
  "a2": { "verb": "accept", "source_ref": "FAQ!A2", "confidence": 0.95 },
  "n2": { "verb": "create", "kind": "action",
          "body": "Build a proactive credentialing tracker off the Cred Expires column.",
          "target": "p1", "source_ref": "Roster!E2:F17", "confidence": 0.93,
          "note": "missed by the draft" }
}
```

### Verb vocabulary

| verb         | meaning | required extra fields |
|--------------|---------|-----------------------|
| `accept`     | keep the draft item unchanged | — |
| `edit`       | change fields of a draft item | the changed field(s) |
| `drop`       | discard a draft item | — |
| `recategorize` | change an atom's `kind` or a container's `kind`/`framework` | `kind` (and `framework` for projects) |
| `create`     | add a new item (id `n*`) | `kind`, `body`/`title`, `target` (for atoms) |
| `merge_into` | fold this atom into another | `target` = the surviving atom id |

### Per-verdict fields

- `verb` *(required, enum above)*
- `kind` — atoms: `observation|decision|action|outcome`; containers: `project|reference_file`
- `title` / `body` — only when changing or adding text
- `framework` — projects only: `kanban|pdsa|milestone|timeline|null`
- `target` — atom → container id; `merge_into` → surviving atom id
- `due_date` / `assigned_to` — actions
- `source_ref` — **REQUIRED whenever the decision is grounded in a doc.**
  Format `"Sheet!range"` for spreadsheets, or a short quoted line for emails.
  Treated as a **region hint, not an exact cell** (see §5C).
- `note` — one line of reasoning; `confidence` — 0.0–1.0

---

## 4. The verify-and-normalize gate

Sits between the imported decision set and the triage overlay. **Nothing is
filed by the gate** — its output is a *flagged* draft the human still curates.
Order: A → (B if needed) → re-A → C → D → E.

### A. Structural validation (pure code; cheap)
1. Parse JSON. On parse failure → go to **B** (5.4 repair), retry **once**.
2. Drop keys that are neither a known draft id (`p*`/`a*`) nor a new `n*`; log each.
3. Coerce `verb` to the enum; unknown verb with content → `edit`, else `drop` (logged).
4. `kind`/`framework`/atom `target` must resolve (target = a real `state_summary`
   container id, or a `p*`/`n*` container in this bundle). Unresolved target →
   default to **Inbox**, flag `unresolved_target`.

### B. gpt-5.4 normalization pass (the earned job — §7 finding #2)
Copilot reads well but is **sloppy with structured fields** (it ignored every
`due_date` in the probe). 5.4's job is **normalize + repair, never invent**:
- repair mangled JSON into the §3 shape;
- fill `due_date`/`assigned_to` from the cited `source_ref` cells when the verb
  implies a deadline;
- map a `target` given as a title back to a real id (fuzzy match vs `state_summary`);
- coerce verbs/kinds to enums.
Prompt constraint: 5.4 may only use content present in Copilot's reply or the
bundle. Its output is re-run through **A** and must pass clean.

### C. `source_ref` validation — region level only (§7 finding #1)
The probe showed refs are reliable at **column/region** granularity, wrong at
exact-cell (a1 cited a range that missed two of the four rows it named correctly).
So:
- Parse `Sheet!range`. Verify the **sheet exists** and the **range is in-bounds**
  of the file's used range (Throughline can read the xlsx locally via the lens /
  a SheetJS-style reader). ✅ → `source_ok`.
- Sheet missing / range out-of-bounds → `source_unverified` (flag, **do not drop**).
- Substantive `create`/`edit` body with **no** `source_ref` → `ungrounded`
  (high-scrutiny flag in triage).
- **Never** reject good content over a fuzzy range. `source_ref` is a "jump to
  this area of the file" pointer the human confirms via the lens.

### D. Anti-corruption / anti-truncation (Noah's "roughly matches", made precise)
- **Mode A:** any `accept` whose item text differs from the bundle, or any
  silently-changed body on a no-edit verb → flag `unexpected_mutation`. (In a
  pure sort, substance shouldn't change.)
- **Mode B:** substance legitimately comes from Copilot, so no byte-match. Instead
  bound the blast radius:
  - **coverage:** decision set must reference a sane fraction of draft ids; if
    **>40% of `p*`/`a*` ids are silently missing** → likely truncation → **abort
    to user** ("the reply looks truncated — re-run the chat"), don't file.
  - **echo:** if `_meta.version_hash` is present and ≠ bundle's → **warn**
    ("answered against an older draft; reconcile?"). Absent → warn only (the probe
    didn't echo it; don't hard-fail on Copilot's omissions).
- **Hard stop** (no triage, back to user): JSON unparseable after B, OR coverage
  fail, OR every verdict `ungrounded` in Mode B.

### E. Hand to triage (Pass 2 = existing UI)
Apply the verified decision set to the draft → final proposed state, rendered in
the **existing triage overlay** with per-item badges: `source_ok` / `source_unverified`
/ `ungrounded` / `unresolved_target` / `unexpected_mutation`. User accepts / edits
/ rejects exactly as today; `commitTriage` writes. **The human pass is mandatory
and is the "conversation's" final authority** — matches "this doesn't get directly
filed."

---

## 5. Mapping to the v3 data model

### Containers (`p*`/`n*` → `containers[]`)
On commit: `{ id: uid(), type: kind, title, goal_or_purpose, summary:"",
tags:[], status:"active", program_id:null, rag:null, created_at, updated_at }`.
- `kind:"project"` → also `framework` + `framework_config = frameworkConfigFor(framework)`.
- `bind_folder` (root-relative, optional) → `container.folder` (Epic E1 field) —
  this is how "what do I do with this spreadsheet" ends as a **bound reference**
  living in the lens.

### Atoms (`a*`/`n*` → `atoms[]`)
On commit: `{ id: uid(), entry_id, kind, body, tags:[], created_at, updated_at }`;
actions add `assigned_to`/`due_date`; outcomes add `parent_atom_id`.

### One new optional field — `atom.source_ref`
v3 has no provenance field on atoms. **Add `source_ref: string|null`** (root-rel
file path + range, e.g. `"Provider Corner/...xlsx#Roster!E2:F17"`), defaulted
`null`. Backward-compatible like `container.folder` was — **stays
`schema_version: 3`**, both backends pass it through untouched, the front-end
normalizer defaults it on read. This is what makes every doc-grounded atom
**re-auditable against the real file via the lens** (the whole trust model in §4C).
SteadyHand carried the same field in its extraction schema.

---

## 6. Commit semantics (entry-first, id-map)

Atoms hang off **entries**, so commit can't just write atoms:
1. **Preserve the raw dump first** — `raw_dump` → one `entries[]` row
   (`kind:"freetext"`, `notes = raw_dump`) in the dominant target container (or
   Inbox). Truncation can then only cost auto-extracted atoms, never the source.
2. Build the **id map** `p*/n*/a* → uid()`; resolve atom `target`s through it.
3. When items fan across several containers, reuse the existing triage behavior:
   source entry → **dominant** target, the rest → **sibling entries** cloned from it.
4. `merge_into` folds the atom's body into the surviving atom (append), no new row.

---

## 7. Probe-derived calibrations (baked into the above)

1. **`source_ref` is region-accurate, not cell-accurate** → §4C validates
   sheet-exists + in-bounds only; never auto-rejects on a fuzzy range.
2. **Copilot ignores fine structured fields** (every `due_date` was blank despite
   the dates sitting in column F) → §4B 5.4 pass exists primarily to *normalize
   structured fields*, secondarily to repair JSON.
3. **OneDrive path-retrieval failed; chat-attach worked** → §2 handoff is "attach
   to chat," and the inbound channel is download→`~/Downloads`→local read (reuse
   the setup wizard's home-scoped browser). The OneDrive-write channel is dropped.
4. **Copilot won't hallucinate when it lacks the file** (it refused and asked to
   relink) — a trust win, but means the bundle + docs must actually reach the chat.
5. **JSON discipline was clean on run 1** — encouraging, but unproven across runs;
   keep the 5.4 repair path. (Consistency probe = run the same prompt 3×.)

---

## 8. Phasing

- **v1 — read-only consult.** "Chat about this" exports the bundle; Copilot
  sanity-checks against `raw_dump` (+ docs) and replies in prose. **No
  import/gate.** Smallest thing that delivers the missing conversation; zero
  ingestion risk. ("Does this look about right?")
- **v2 — decisions back in.** Import the decision set, run the full gate (§4),
  land in triage. The real loop. Adds `atom.source_ref`, the home-scoped Downloads
  browser, and the 5.4 normalize pass.
- **v3 — auto-expansion.** Only if v2 proves the round-trips are worth automating:
  Copilot requests more detail on a thin item → Throughline extracts → re-export.
  Highest complexity, least-used; deferred on purpose.

---

## 9. Open questions / to verify

- **Consistency:** run the probe prompt 3× — does JSON stay clean? Recalibrates
  how hard the 5.4 gate must work.
- **xlsx reader on orange (Node):** §4C/§5 need server-side cell-range reads.
  Pick a zero-/light-dep reader (SheetJS `xlsx`) — note this would be the Node
  server's **first runtime dep** (currently zero), so weigh it.
- **Email refs:** `source_ref` for `.eml`/`.msg` is a quoted line, not a range —
  §4C needs a text-contains check instead of a cell-bounds check for those.
- **`state_summary` budget:** at what container count does the summary itself get
  too big to attach? May need a relevance filter (only containers plausibly
  related to the dump).
