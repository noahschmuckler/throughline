// Builds the distributable zip for the orange device (zip-drop deploy path):
//   npm run package
// Output: dist-package/throughline-<version>.zip containing server.js, the
// libs, the built-in front-end, start.bat/stop.bat, and a prod-only
// node_modules. Requires only Node 20.6+ on the target machine -- zero npm
// install there.
//
// Deploy flow: run this on the dev box -> move the zip to the orange device ->
// stop.bat -> Extract-All over the existing install (preserves .env + data\)
// -> start.bat.
//
// Progressive versioning: each package bumps the patch version so every zip is
// distinct and ordered (throughline-0.3.1.zip, -0.3.2.zip, ...). Pass --no-bump
// to repackage the current version without advancing it.

import { execSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkgPath = join(root, 'package.json');

let pkgRaw = await readFile(pkgPath, 'utf8');
const pkg = JSON.parse(pkgRaw);
if (!process.argv.includes('--no-bump')) {
  const [maj, min, pat] = pkg.version.split('.').map((n) => Number(n) || 0);
  const next = `${maj}.${min}.${pat + 1}`;
  pkgRaw = pkgRaw.replace(`"version": "${pkg.version}"`, `"version": "${next}"`);
  await writeFile(pkgPath, pkgRaw);
  console.log(`version ${pkg.version} -> ${next}`);
  pkg.version = next;
}

const out = join(root, 'dist-package');
const stage = join(out, 'throughline');

await rm(out, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

// Runtime source. Excludes the Worker (src/), wrangler config, the seed scripts
// (orange ships blank), data\ and any .env (the operator's stays in place on an
// extract-over update).
console.log('staging source...');
const SRC = ['server.js', 'dethreader.ps1', 'lib', 'shared', 'public', '.env.example', 'README.md', 'CLAUDE.md'];
for (const item of SRC) {
  await cp(join(root, item), join(stage, item), { recursive: true });
}

// package.json: keep the real one (carries the Loop runtime deps + start script
// + the engines>=20 gate). node_modules is vendored below so these resolve
// offline; the boot path itself is zero-dependency.
await writeFile(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

// Double-clickable launchers + the operator guide, at the zip root.
await cp(join(root, 'deploy', 'start.bat'), join(stage, 'start.bat'));
await cp(join(root, 'deploy', 'stop.bat'), join(stage, 'stop.bat'));
await cp(join(root, 'deploy', 'README-install.md'), join(stage, 'README-install.md'));
// Keep the deploy scripts in the tree too (register-task.ps1 etc.).
await cp(join(root, 'deploy'), join(stage, 'deploy'), { recursive: true });

// Vendor a prod-only node_modules (the shelved Loop import needs @azure/msal-node
// + turndown). Stage a clean install in a temp dir so the dev tree's
// node_modules -- including wrangler -- is left untouched.
console.log('vendoring prod node_modules...');
const dep = await mkdtemp(join(tmpdir(), 'throughline-deps-'));
await cp(pkgPath, join(dep, 'package.json'));
try {
  await cp(join(root, 'package-lock.json'), join(dep, 'package-lock.json'));
} catch { /* lock optional */ }
execSync('npm install --omit=dev --no-audit --no-fund --silent', { cwd: dep, stdio: 'inherit' });
await cp(join(dep, 'node_modules'), join(stage, 'node_modules'), { recursive: true });
await rm(dep, { recursive: true, force: true });

const zipName = `throughline-${pkg.version}.zip`;
console.log('zipping...');
execSync(`zip -qr ${zipName} throughline`, { cwd: out, stdio: 'inherit' });
const { size } = await stat(join(out, zipName));
console.log(`packaged dist-package/${zipName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
