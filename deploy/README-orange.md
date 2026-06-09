# Throughline — orange-device deployment (operator guide)

This puts Throughline on the enterprise ("orange") box as a local app that
auto-starts at logon, with its single state file living in a **OneDrive shared
folder** so you and Natalia work against one project DB.

## The model (read this first)

Throughline is a local web app, not a cloud service. Each person runs their own
copy of the server on their own machine; both point `THROUGHLINE_DB` at the
**same OneDrive shared folder**. OneDrive syncs that one `state.json` between
you. You each open `http://127.0.0.1:8787` locally.

```
  Noah's box                          Natalia's box
  node server.js  ──┐              ┌── node server.js
   :8787            │              │     :8787
                    ▼              ▼
        OneDrive: \Throughline\state.json   (synced)
                  \Throughline\attachments\ (synced)
```

**Concurrency caveat (important):** OneDrive is file-sync, not a real-time
database. If you and Natalia both save at the *same moment*, OneDrive can create
a "conflict copy" of `state.json` and one set of edits can be lost. In practice
this is fine for a two-person dyad with light, turn-taking edits, but: don't
both do heavy editing simultaneously, let OneDrive finish syncing (green check)
before the other person makes big changes, and keep an eye out for
`state-<name>'s conflicted copy.json` files. A proper shared backend is a future
upgrade; for v1 the OneDrive share is the deliberate, low-friction choice.

## Install path A — git clone + sync (preferred)

If the repo is cloned on the orange box via GitHub Desktop (e.g.
`C:\Users\<you>\Documents\GitHub\throughline\`), run it **in place** — no file
copying, and "update" is just *Sync* in GitHub Desktop.

1. **Sync** in GitHub Desktop so the clone has the latest `main`/branch
   (you need the `deploy/` folder + V1 code).
2. Open **PowerShell** in the clone and register the auto-start task:
   ```powershell
   cd C:\Users\<you>\Documents\GitHub\throughline
   powershell -ExecutionPolicy Bypass -File deploy\register-task.ps1
   ```
   It creates `.env` from `.env.example` (if missing), registers the
   `ThroughlineServer` logon task pointing at the clone, and starts it.
3. Edit `.env` in the clone — set `THROUGHLINE_DB` to your OneDrive path and
   `LLM_PROVIDER=cdsapi` (see "Configure" below) — then restart:
   ```powershell
   Stop-ScheduledTask -TaskName ThroughlineServer ; Start-ScheduledTask -TaskName ThroughlineServer
   ```
4. Open `http://127.0.0.1:8787`.

**Just want to see it run once (no scheduled task)?**
```powershell
cd C:\Users\<you>\Documents\GitHub\throughline
copy .env.example .env      # then edit .env
node --env-file=.env server.js
```
Browse to `http://127.0.0.1:8787`; Ctrl+C to stop.

**To update later:** GitHub Desktop → *Sync*, then restart the task (step 3's
restart line). `.env` and your OneDrive state are never touched by a sync —
`.env` and `data/` are gitignored.

> Note: `register-task.ps1` requires **Node 20.6+** (the task launches with
> `--env-file`). It checks and tells you if Node is too old.

## Install path B — zip bundle (no git on the box)

Use this only if the orange box has no git/GitHub Desktop. `bash deploy/bundle.sh`
on the Linux box produces `dist/throughline-<sha>.zip` + an installer that copies
the bundle into `%USERPROFILE%\throughline\`. Steps are further down under
"Install (zip bundle)". For the clone workflow, ignore path B.

## Prerequisites (one-time, per machine)

- **Node 20.6+** on PATH (`node --version`). 20.6+ is required for the
  `--env-file` flag the scheduled task uses. No `npm install` is needed on
  orange — the bundle **vendors** the server's two runtime deps
  (`@azure/msal-node` + `turndown`, for the Loop/Deloop OneDrive import) as a
  prod-only `node_modules` (~17 MB) inside the zip.
- The OneDrive shared folder exists and is synced locally (e.g.
  `C:\Users\<you>\OneDrive - <org>\Throughline\`). Create an empty
  `Throughline\` folder there; the app creates `state.json` on first write.

## Bundle (on the Linux box)

```sh
cd ~/GitHub_Repos/throughline
bash deploy/bundle.sh
```

Outputs in `dist/`:

- `throughline-<sha>.zip` — source + a vendored prod-only `node_modules` (no
  `.env`, no `data/`, no seed scripts; orange starts blank).
- `install-throughline-<sha>.ps1.txt` — the PowerShell installer (shipped as
  `.txt` because OneDrive blocks the `.ps1` MIME type).

## Move to OneDrive

Get both files onto the orange box however you normally do (synced folder, or
the tailscale → iPhone → OneDrive flow). They must land in the same folder.

## Install (zip bundle)

1. Save both files into e.g. `%USERPROFILE%\throughline-deploy\`.
2. Rename `install-throughline-<sha>.ps1.txt` → `install-throughline-<sha>.ps1`.
3. Extract `throughline-<sha>.zip` alongside the installer (so it sits next to a
   folder named `throughline-<sha>\` or `throughline\`).
4. Run it:
   ```powershell
   & "$env:USERPROFILE\throughline-deploy\install-throughline-<sha>.ps1"
   ```

The installer stops any prior `ThroughlineServer` task, kills whatever holds
port 8787, copies the bundle to `%USERPROFILE%\throughline\`, creates `.env`
from `.env.example` (preserving an existing one), registers a non-admin
scheduled task that runs `node --env-file=.env server.js` at logon, starts it,
and prints `http://127.0.0.1:8787`.

## Configure (the one edit that matters)

Edit `%USERPROFILE%\throughline\.env`:

```dotenv
# Point at the OneDrive shared folder so the dyad shares one DB:
THROUGHLINE_DB=C:\Users\<you>\OneDrive - <org>\Throughline\state.json

# On-network enterprise LLM (no key needed). Powers the shape wizard + atomize.
LLM_PROVIDER=cdsapi
# LLM_MODEL=gpt-mini        # optional: pin a tier (gpt-nano | gpt-mini | gpt-5.4)
```

Then restart so the task picks it up:

```powershell
Stop-ScheduledTask  -TaskName ThroughlineServer
Start-ScheduledTask -TaskName ThroughlineServer
```

Open `http://127.0.0.1:8787/`. The workspace starts **empty** — the first
ad-hoc capture lazy-creates the Inbox; create projects/programs by hand or via
the ✦ New project wizard. **Do not run the seed script on orange** (it's a
local-demo convenience and isn't in the bundle).

Repeat the install + the same `THROUGHLINE_DB` path on Natalia's machine.

## AI provider notes

- `cdsapi` is the orange provider — Optum's on-network `single_response`
  endpoint, no key when on-network. It powers `/api/atomize` (triage) and
  `/api/classify` (the shape wizard). Check business policy on what data class
  may be routed through it.
- If cdsapi is unreachable or returns junk, both AI paths **degrade to the
  deterministic heuristic** — the app keeps working, just with simpler
  suggestions. Set `LLM_PROVIDER=heuristic` to force zero-spend behaviour.
- Attachments (the "+ Add file" button) work here — files are written next to
  `state.json` under `Throughline\attachments\`, so they sync over OneDrive too.

## Managing the task

```powershell
# Restart (after editing .env)
Stop-ScheduledTask -TaskName ThroughlineServer ; Start-ScheduledTask -TaskName ThroughlineServer

# Status / last run result
Get-ScheduledTaskInfo -TaskName ThroughlineServer

# Uninstall (task only — your data is safe in OneDrive)
Unregister-ScheduledTask -TaskName ThroughlineServer -Confirm:$false
Remove-Item -Recurse -Force "$env:USERPROFILE\throughline"
```

Your curation work lives in the OneDrive `state.json` (+ `attachments\`), not in
the install folder — uninstalling the app never touches it.

## Troubleshooting

- **Port 8787 didn't come up.** Re-run the installer (it kills the port owner
  first), or check `Get-ScheduledTaskInfo -TaskName ThroughlineServer`. A common
  cause is a `THROUGHLINE_DB` path whose parent folder doesn't exist yet —
  create the `Throughline\` folder in OneDrive first.
- **Edits aren't showing up for the other person.** Wait for OneDrive to finish
  syncing (green check on the folder), then refresh the browser
  (Ctrl+Shift+R). Look for `*conflicted copy*` files if edits seem lost.
- **Both ran Node but it says blank.** Confirm both `.env` files point at the
  *exact same* `THROUGHLINE_DB` path inside the synced OneDrive folder.
