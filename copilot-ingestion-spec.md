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
                                       paste-in (primary) / download → import → GATE ───┘
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

**Lesson from the first live consult (2026-06-06): the bundle must be
self-describing.** A bare JSON file + "does this look right?" made Copilot review
the JSON *format* (verbose structural praise) instead of consulting on the
breakdown. Two-layer fix: (1) every bundle embeds **`_instructions`** — a task
brief telling the reading model its role (critique the atom breakdown + filing,
flag what `raw_dump`'s draft missed, help answer `needs_clarification[]`, prefer
existing containers; do NOT review formatting) — the probe proved Copilot follows
instructions inside attached content; (2) "Chat about this" also copies an
**opening prompt** to the clipboard (`OPENING_PROMPT` in `ingest.js`) so the chat
starts on the consult, not on JSON critique. v2's decision-set reply will harden
this same scaffold into a strict output contract.

```jsonc
{
  "_artifact": "throughline.chat_about_this",
  "_schema": "ingest-v1",
  "_instructions": "You are consulting on a draft ingestion for Throughline, ...", // task brief for the reading model (BUNDLE_INSTRUCTIONS)
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
        "summary": "...", "program_id": null, "open_actions": 2 },
      { "id": "c_def", "type": "project", "framework": "kanban",
        "title": "Provider onboarding Q3", "summary": "...",
        "program_id": "c_net", "open_actions": 5 },
      { "id": "c_net", "type": "program", "title": "Provider network reliability",
        "summary": "...", "program_id": null, "open_actions": 0,
        "objective": "Every provider question answerable in one place",
        "key_results": [
          { "label": "Roster questions self-served", "current": 20, "target": 90, "unit": "%" }
        ] }
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

**Program hierarchy stays visible in the flat list** (fixed 2026-06-06): every
container entry carries **`program_id`** (null = standalone), and `type:"program"`
entries add **`objective`** + **`key_results`** (label/current/target/unit — internal
kr ids never leave). Copilot reconstructs program → projects from `program_id`; no
nesting needed. A project's context is usually set by its parent program and sibling
projects, so this matters for placement quality.

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
  of the file's used range, read server-side via **vendored SheetJS** (see §5
  note — bundled into the deploy zip, no separate install on orange). ✅ →
  `source_ok`.
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

### The xlsx reader — vendored SheetJS (DECIDED 2026-06-06)
§4C reads cell ranges server-side. Use **SheetJS Community Edition** (`xlsx`,
Apache-2.0), **vendored as a single pure-JS file into the deploy bundle**
(e.g. `vendor/xlsx.mjs`, `import`ed by `server.js`). Rationale:
- It is pure JS, no native build, no transitive deps, **no network calls** —
  runs fully offline/locally.
- **Vendored ⇒ no separate install on orange.** It ships inside the installer
  zip; Natalia/others never run `npm install` or touch the npm registry. This
  was the deciding requirement — onboarding must not gain an install step.
- To an enterprise box it's just more JS read by the already-approved
  `node.exe`, not a new executable/installer, so allowlisting (AppLocker/WDAC)
  doesn't gate it.
- **Tradeoff:** this becomes the Node server's **first runtime dependency**
  (the deploy kit's "zero runtime deps" line in CLAUDE.md must be updated when
  this lands) and adds a few hundred KB–~1 MB to the bundle (trivial for a
  self-downloading installer). Fallback if ever vetoed: a minimal in-house
  reader (unzip via `zlib` + parse `sheetN.xml` used-range) — more code, zero
  third-party; only if SheetJS is rejected.

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

## 7b. Probe 2 (2026-06-06) — a REAL decision set, Mode A, full workspace

Setup: the live program-retool dump (~7.6 KB) ran the real loop for the first
time — gpt-mini draft (28 atoms, 5 actions) → bundle (38-container
`state_summary` incl. the new `program_id` hierarchy) → high-utility prose
consult → a follow-up prompt embedding the §3 shape → **Copilot returned a
complete, valid §3 decision set on the first try.** Raw artifacts: local-only at
`data/probe2/` (sensitive — scrubbed from git history after review; do NOT
recommit).

**What worked (de-risks the gate):**
- Single valid JSON object keyed by id; all 28 `a*` ids verdicted, no id
  invented, no id skipped. 5 `n*` creates + 1 `p*` container create.
- **Real container ids used correctly throughout** — every `target` was a
  verbatim `state_summary` id or the new `p*`. Zero fabricated containers.
- Full verb vocabulary exercised (accept/edit/drop/recategorize/create/
  merge_into); `merge_into` targets were surviving atom ids, no cycles.
- It caught the draft's fabricated action and `drop`ped it with the right note.
- `note` + `confidence` on every verdict.

**Gate requirements discovered (the guardrail list):**
1. **Verbs blur — make the gate field-driven, not verb-strict.** `recategorize`
   verdicts also carried new `body` text (spec said that's `edit`'s job). Apply
   whatever valid fields are present; treat the verb as intent, not contract.
2. **Id allocation is assumed, not negotiated** — with no `p*` in proposed{},
   Copilot minted `p2` (not `p1`). Gate: accept any *unused* `p*`/`n*` key as a
   create; never assume sequence.
3. **Atoms targeted at a PROGRAM container** — several verdicts filed atoms onto
   the program itself. Legal in the data model (entries key off any container
   id) but the program detail page renders the OKR dashboard, not entries →
   those atoms would be near-invisible. Gate: warn + offer remap (child project
   or keep), or the program page grows an entries surface. DECIDE BEFORE v2.
4. **`assigned_to: "narrator"`** — first-person commitments got a placeholder
   owner. Gate: alias-resolve narrator/me/I → the instance user (couples to
   multi-user M0 identity); also `_instructions` should state who the user is.
   (It did correctly pull other owners' full names out of the raw dump.)
5. **No `source_ref`, no `due_date`** — consistent with probe 1's "ignores fine
   fields" finding, now confirmed in Mode A (no quoted raw_dump grounding
   either). The 5.4 normalize pass stays load-bearing.
6. **Empty-string noise on drop/merge** (`body:""`, `kind`, nulls) — harmless;
   gate ignores extra/empty fields.
7. **No `_meta` echo** (version_hash/session_id) — the §3 optional echo won't
   come back unless the requesting prompt explicitly demands it. v2's
   decision-set request prompt must ask for it if staleness checking matters.

**Bundle gap found (v1.x fix):** the draft's per-cluster `suggestedId` never
reaches proposed{} — `chatAboutThis` snapshots the *assigned* target only, so an
untriaged draft exports every atom as `target:null` (this run: all 28) and
Copilot re-derives placement from scratch. It placed well anyway, but the
draft's signal is being thrown away: add `suggested_target` to proposed atoms.

**Workflow lesson:** the two-step flow (consult prose first, *then* request the
decision set) worked and is worth keeping — folding the §3 format into the
initial `_instructions` risks Copilot skipping the conversation and jumping to
output. v2 ships the decision-set request as a second copy-paste prompt.

**Inbound channel lesson:** Copilot printed the decision set **in-chat**, not as
a downloadable file — it's inconsistent about producing downloads. So v2's
import surface is a **paste field first, file picker second** (the Downloads
browser becomes the fallback, not the primary). Bonus: a paste field naturally
handles the non-JSON case — pasted freetext (a prose Copilot reply, or any raw
text) routes to the existing cdsapi re-process path (atomize) instead of the
gate. One intake surface, three grades: §3 JSON → gate; near-JSON → 5.4 repair →
gate; freetext → atomize.

---

## 8. Phasing

- **v1 — read-only consult.** "Chat about this" exports the bundle; Copilot
  sanity-checks against `raw_dump` (+ docs) and replies in prose. **No
  import/gate.** Smallest thing that delivers the missing conversation; zero
  ingestion risk. ("Does this look about right?")
- **v2 — decisions back in.** Import the decision set, run the full gate (§4),
  land in triage. The real loop. Adds the **paste-in import field** (primary
  channel — Copilot prints in-chat more reliably than it makes downloads; pasted
  freetext degrades to the atomize path) with the home-scoped Downloads browser
  as the file fallback, `atom.source_ref`, the 5.4 normalize pass, and
  **vendored SheetJS** for §4C source_ref bounds-checking (bundled in the
  installer — no separate install).
- **v3 — auto-expansion.** Only if v2 proves the round-trips are worth automating:
  Copilot requests more detail on a thin item → Throughline extracts → re-export.
  Highest complexity, least-used; deferred on purpose.

---

## 9. Open questions / to verify

- **Consistency:** tested **in deployment**, not via a pre-probe — ship the loop
  and watch how stable Copilot's JSON is across real use; recalibrate how hard the
  5.4 gate must work from that. (Per Noah: deploy first, then observe consistency.)
- **xlsx reader:** DECIDED — vendored SheetJS in the bundle (see §5). No longer open.
- **Email refs:** `source_ref` for `.eml`/`.msg` is a quoted line, not a range —
  §4C needs a text-contains check instead of a cell-bounds check for those.
- **`state_summary` budget:** at what container count does the summary itself get
  too big to attach? May need a relevance filter (only containers plausibly
  related to the dump).
