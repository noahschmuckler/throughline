# Copilot Mode-B probe

A one-off test to see whether enterprise Copilot can read a binary OneDrive
spreadsheet and return clean, cell-cited JSON verdicts — the capability the
document-grounded ingestion path ("brain dump + what do I do with this
spreadsheet") depends on. Not part of the app; safe to delete after the test.

## Run it
1. Put `IMFM_Provider_Roster_2026.xlsx` and `throughline_chat_probe.json` in the
   same OneDrive folder (the Provider Corner folder is ideal). If you move them,
   fix the `path` in the JSON's `file_refs` to match.
2. Paste `throughline_copilot_prompt.txt` into Copilot, pointed at both files.

## What's planted (reading vs guessing)
The draft JSON is deliberately thin — a text-only pass that can't open the xlsx.
The signal lives in the file:
- **Urgent cluster** (only findable by reading): Haddad 2026-06-20, Raman 06-28,
  Ortiz 07-02, Bjorn 07-03 — all marked `ACTION NEEDED` in the Roster tab.
- **FAQ tab** = the recurring questions (the reference file's real purpose).
- **Checkable cell**: Priya Raman, NPI 1487654321, Rock Hill, Closed, 2026-06-28.

## Scoring
- **PASS**: plain answer to "what do I do with this spreadsheet" + one strictly
  valid `json` block; `a1` enriched with the four names/dates + a `Roster!…`
  source_ref; `p1` fleshed out from `FAQ!…`; ≥1 new `n1` item; source_refs point
  at the right cells.
- **PARTIAL**: content right, JSON mangled / vague source_refs → the gpt-5.4
  repair+verify gate is load-bearing; never file Copilot output directly.
- **FAIL**: can't open the xlsx, or hallucinates with no/invented source_refs →
  document-grounding needs local xlsx→text parsing instead.

The most diagnostic property: **does every spreadsheet-derived claim carry a
source_ref that points at the right cell?**
