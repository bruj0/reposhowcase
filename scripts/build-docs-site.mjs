#!/usr/bin/env node
/**
 * Assemble the MkDocs source tree for the published documentation site.
 *
 * The site publishes four documents that live in three different places, and
 * the repository layout is not a layout MkDocs can read directly:
 *
 *   essay/index.md    -> site_src/index.md     the landing page
 *   README.md         -> site_src/readme.md    the project overview
 *   docs/hosting.md   -> site_src/hosting.md
 *   docs/deployment.md-> site_src/deployment.md
 *
 * Pointing `docs_dir` at the repository root instead is not an option: MkDocs
 * copies everything under `docs_dir` into the site, so the root would publish
 * `node_modules/`, `dist/` and `.git/`. A staging directory is the only shape
 * that publishes exactly the documents this site claims to publish.
 *
 * `site_src/` is generated and gitignored. Nothing is edited there by hand: a
 * change to a page is a change to the file it came from.
 *
 *   node scripts/build-docs-site.mjs             # assemble site_src/
 *   node scripts/build-docs-site.mjs --dry-run   # report, write nothing
 *   node scripts/build-docs-site.mjs --json      # one JSON object on stdout
 *
 * Exit codes:
 *   0  assembled, or --dry-run reported what it would do
 *   2  a source file is missing
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'site_src');

/**
 * Every page the site publishes.
 *
 * `to` is a flat filename on purpose: MkDocs builds one URL per file and a flat
 * tree keeps the URLs stable (`/readme/`, `/hosting/`) instead of leaking the
 * repository's directory structure into the address bar.
 */
const PAGES = [
  { from: 'essay/index.md', to: 'index.md' },
  { from: 'README.md', to: 'readme.md' },
  { from: 'docs/deployment.md', to: 'deployment.md' },
  { from: 'docs/hosting.md', to: 'hosting.md' },
];

/**
 * Non-markdown files a page links to or displays.
 *
 * MkDocs copies these into the site verbatim, so a relative link such as
 * `assets/screenshot.png` or `LICENSE` in the source keeps working.
 */
const ASSETS = ['assets/screenshot.png', 'LICENSE'];

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const AS_JSON = argv.includes('--json');

/** Human-readable progress. Goes to stderr so `--json` stays parseable. */
function note(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message, code = 2) {
  process.stderr.write(`build-docs-site: ${message}\n`);
  process.exit(code);
}

const missing = [...PAGES.map((page) => page.from), ...ASSETS].filter(
  (relative) => !fs.existsSync(path.join(ROOT, relative)),
);
if (missing.length > 0) {
  fail(`missing source file(s):\n${missing.map((file) => `  ${file}`).join('\n')}`);
}

/**
 * Give the landing page its own document title.
 *
 * MkDocs titles the site's root page from `site_name`, which is the product
 * name. The landing page is the essay, so the tab and the search result would
 * say "Repo Showcase" instead of the essay's title. A per-page frontmatter
 * `title` overrides that, and taking it from the H1 keeps the two in step when
 * the essay is renamed. Pages that already declare a title are left alone.
 *
 * @param {string} text
 * @returns {string}
 */
function withLandingTitle(text) {
  if (/^---\n[\s\S]*?^title:/m.test(text.slice(0, 400))) return text;

  const heading = /^# (.+)$/m.exec(text);
  if (!heading) return text;

  return `---\ntitle: ${heading[1].trim()}\n---\n\n${text}`;
}

const written = [];

if (!DRY_RUN) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
}

for (const page of PAGES) {
  const source = path.join(ROOT, page.from);
  const destination = path.join(OUT, page.to);
  const bytes = fs.statSync(source).size;

  if (!DRY_RUN) {
    // Pages are flattened into one directory, so a link to `docs/hosting.md`
    // has to become `hosting.md` or it points at a page the site never builds.
    // Without the rewrite `mkdocs build --strict` aborts on the missing target.
    const text = fs.readFileSync(source, 'utf8').replaceAll('](docs/', '](');
    fs.writeFileSync(destination, page.to === 'index.md' ? withLandingTitle(text) : text);
  }
  written.push({ from: page.from, to: path.relative(ROOT, destination), bytes });
}

for (const asset of ASSETS) {
  const source = path.join(ROOT, asset);
  const destination = path.join(OUT, asset);
  const bytes = fs.statSync(source).size;

  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  written.push({ from: asset, to: path.relative(ROOT, destination), bytes });
}

if (!DRY_RUN) {
  note(`assembled ${OUT} (${written.length} files)`);
} else {
  note(`would assemble ${OUT} (${written.length} files)`);
}

if (AS_JSON) {
  process.stdout.write(
    `${JSON.stringify({ status: DRY_RUN ? 'dry-run' : 'assembled', output: OUT, files: written })}\n`,
  );
}
