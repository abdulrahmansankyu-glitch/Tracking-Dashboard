/**
 * Build the standalone single-file tracker.
 *
 * Produces one self-contained .html — no server, no network, no install. Open it
 * from a file, a USB stick or any static host and it works, including reading and
 * writing real .xlsx workbooks.
 *
 * It is assembled from the same sources the hosted app runs, not a re-creation:
 * `registers.js`, `query.js` and `excel.js` are inlined verbatim, and `app.js` is
 * the identical UI. Only the transport differs — `standalone.js` installs a local
 * handler that answers the same paths from browser storage. That is the whole
 * point of the arrangement: the offline copy cannot drift from the deployed one,
 * because there is only one copy of the logic.
 *
 *   node apps/tracker/build-standalone.js [outfile]
 */

import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Strip ES module syntax so several modules can share one inline script scope.
 *
 * These files import only from each other and from `exceljs` — which the inlined
 * browser bundle has already put on `globalThis` — so removing the import lines
 * leaves every reference resolvable within the combined scope.
 */
function flatten(source) {
  return (
    source
      // `import x from '...'` / `import { a, b } from '...'`, including multi-line.
      .replace(/^import\s+[\s\S]*?\s+from\s+'[^']*';\s*$/gm, '')
      // Bare re-export statements — the flattened scope needs no re-exporting.
      .replace(/^export\s*\{[^}]*\}\s*;\s*$/gm, '')
      // `export const` / `export function` / `export class` → plain declarations.
      .replace(/^export\s+(?=(const|let|var|function|async|class)\b)/gm, '')
      .trim()
  );
}

const read = (path) => readFile(path, 'utf8');

async function build(outfile, { fragment = false } = {}) {
  const [exceljsBundle, styles, registers, query, excel, standalone, app] = await Promise.all([
    // ExcelJS ships a browser UMD build, so reading and writing real .xlsx files
    // needs no server and no bundler of our own.
    read(require.resolve('exceljs/dist/exceljs.min.js')),
    read(join(here, 'public/styles.css')),
    read(join(here, 'src/registers.js')),
    read(join(here, 'src/query.js')),
    read(join(here, 'src/excel.js')),
    read(join(here, 'public/standalone.js')),
    read(join(here, 'public/app.js')),
  ]);

  // The shared modules are wrapped in their own scope rather than concatenated
  // beside the UI. `app.js` keeps small local copies of `daysUntil` and `dueState`
  // so it can run on its own against the hosted API, and in one flat scope those
  // would collide with the originals. The only thing that needs to cross the
  // boundary is the local handler, and it is installed on `globalThis`.
  const modules = `(() => {\n${[registers, query, excel, standalone].map(flatten).join('\n\n')}\n})();`;

  const body = `<div id="root">
      <div class="empty"><span class="spin"></span> Loading tracker…</div>
    </div>

    <!-- ExcelJS browser build, inlined so the page needs nothing from the network. -->
    <script>${exceljsBundle}</script>

    <script type="module">
// Assembled by apps/tracker/build-standalone.js from the tracker's own sources.
// Edit those, not this file — every rebuild overwrites it.

${modules}

${app}
    </script>`;

  // Published artifacts are wrapped in their own document skeleton, so that build
  // emits the page contents alone. A second <html>/<head> nested inside theirs is
  // exactly the kind of thing browsers paper over until one day they do not.
  const html = fragment
    ? `<title>Engineering Activity Tracker</title>
<style>
${styles}
</style>

${body}
`
    : `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Engineering Activity Tracker</title>
    <meta
      name="description"
      content="Daily tracking for engineering action notices, IWS, PZV, EIS, routine inspections, CTS recommendations and PDM findings, with Excel import and export."
    />
    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232a78d6'/%3E%3Cpath d='M8 21h4v3H8zM14 14h4v10h-4zM20 8h4v16h-4z' fill='%23fff'/%3E%3C/svg%3E"
    />
    <style>
${styles}
    </style>
  </head>
  <body>
    ${body}
  </body>
</html>
`;

  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, html, 'utf8');

  const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
  console.log(`[tracker] built ${outfile} (${mb} MB)`);
  return outfile;
}

const args = process.argv.slice(2);
const fragment = args.includes('--fragment');
const named = args.find((a) => !a.startsWith('--'));
const outfile = resolve(
  named ??
    join(here, fragment ? 'dist/tracker-artifact.html' : 'dist/engineering-activity-tracker.html'),
);

build(outfile, { fragment }).catch((error) => {
  console.error('[tracker] build failed:', error);
  process.exit(1);
});
