# Throughline — Install / update (orange device)

**Prereq:** Node 20.6+ on PATH, and the OneDrive client signed into your work
account with your shared `Throughline` folder synced.

This package is a self-contained zip: server, front-end, and the runtime
`node_modules` are all inside. There is no npm install and no GitHub pull on the
orange device — you move the zip over and extract.

## First install
1. Unzip this package anywhere (Right-click → **Extract All**).
2. Open the extracted `throughline` folder.
3. Double-click **`start.bat`** → a browser opens at `http://127.0.0.1:8787`.
4. On first run `start.bat` creates a `.env` from `.env.example`. Edit `.env`
   and set:
   - `THROUGHLINE_DB` = your shared OneDrive path, e.g.
     `C:\Users\<you>\OneDrive - <org>\Throughline\state.json`
   - `LLM_PROVIDER=cdsapi`
   Then double-click `start.bat` again. (Or use the in-app `#/setup` wizard.)

Circles (multi-folder federation) are **on by default** — Throughline scans the
parent of `ONEDRIVE_ROOT` and folds in any sibling folder that has a
`Throughline/state.json`. A box with no sibling circles just shows its one
workspace. Set `THROUGHLINE_CIRCLES=off` to opt out.

## Updating (new feature drop)
1. Double-click **`stop.bat`** in the *current* install (the running Node server
   holds the files open — Windows will otherwise say you need "administrator
   permission" to overwrite them).
2. Extract the new zip **over** the existing install folder, replacing files
   when prompted. Your `.env` and `data\` folder are preserved — the zip never
   contains them.
3. Double-click **`start.bat`**.

## Auto-start at logon (optional)
To have Throughline start automatically at every logon instead of
double-clicking `start.bat`, run once from inside the folder:
```
powershell -ExecutionPolicy Bypass -File deploy\register-task.ps1
```
This registers the `ThroughlineServer` scheduled task (runs
`node --env-file=.env server.js` in place). After a later zip update, restart it:
```
Stop-ScheduledTask -TaskName ThroughlineServer ; Start-ScheduledTask -TaskName ThroughlineServer
```

## Stopping / replacing
Closing the browser tab does **not** stop Throughline — the Node server keeps
running and holds the app's files open. Double-click **`stop.bat`** (or close
the black console window, or End `node.exe` in Task Manager → Details) before
deleting or extracting over an install. A reboot also clears the locks.

## Notes
- All project data lives in your OneDrive `Throughline` folder — there is no
  cloud service and no account or password. Sharing the folder *is* access
  control. Each dyad member runs their own local server pointing
  `THROUGHLINE_DB` at the same synced `state.json` (concurrent edits 3-way
  merge; per-circle backups land beside the state file).
- The Loop import button (🔁) is shelved pending corporate-TLS work, so the
  bundled `@azure/msal-node` / `turndown` deps are dormant — the server boots
  fine without ever touching them.
