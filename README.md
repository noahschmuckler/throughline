# Throughline

A shared dyad accountability tool for Noah and Natalia — projects and
reference files made of dated entries (meetings, emails, freetext),
broken down into the four kinds of statement worth tracking:

- **Observations** — what we noticed.
- **Decisions** — what we chose.
- **Actions** — what someone owes the rest of us.
- **Outcomes** — what came of an earlier action or decision.

The right rail on every project page is *open actions for that project*
— actions with no outcome yet. The whole point of the tool is to keep
that list honest.

## v1 status

Cloudflare Pages demo for UI/UX iteration. Manual entry only. No AI, no
entity model (tags do the cross-cutting work), no auth, no migration.

Production form lives on orange-device Node instances with OneDrive
sync — that's a future sibling project, not this repo.

## Local development

```sh
npm install
npm run dev
# open the URL wrangler prints (usually http://127.0.0.1:8787)
```

`wrangler dev` runs the Worker + Assets locally with a KV emulator.

## Deploy

The Cloudflare project is connected to this repo on GitHub; every push
to `main` deploys automatically. If you want to deploy manually:

```sh
npx wrangler login    # one-time
npm run deploy
```

A new KV namespace can be created and bound with:

```sh
npx wrangler kv namespace create THROUGHLINE
# paste the printed id into wrangler.toml under [[kv_namespaces]]
```

## Data shape

A single JSON document under KV key `throughline:state`:

```jsonc
{
  "schema_version": 1,
  "containers": [ /* projects + reference files */ ],
  "entries":    [ /* dated meeting / email / freetext entries */ ],
  "atoms":      [ /* observations / decisions / actions / outcomes */ ]
}
```

An action is *open* iff no atom of kind `outcome` carries
`parent_atom_id` pointing to it. Closing an action = writing its
outcome. Cancellation is just an outcome that says so.
