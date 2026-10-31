#!/usr/bin/env node
/**
 * Copy the canonical essay into the MkDocs source tree.
 *
 * The essay is written and kept in `personal-docs`, which is the source of
 * truth. This repository publishes a copy. Two files with the same prose drift
 * apart the moment one is edited, so the copy is generated, never hand-edited:
 * this script is the only writer of `essay/index.md`.
 *
 * The transform is small and deliberate, because MkDocs renders a file that
 * the newsletter pipeline renders differently:
 *
 *   1. The brain's YAML frontmatter is dropped. `type`, `tags` and `validate`
 *      are ingestion metadata for a different consumer; MkDocs reads none of
 *      them, and the H1 already carries the title.
 *   2. A subtitle line that repeats the H1 verbatim is dropped. The canonical
 *      file carries one so the newsletter render has a deck; on the page it
 *      prints the title twice.
 *   3. The file ends with exactly one newline.
 *
 *   node scripts/sync-essay.mjs             # write essay/index.md
 *   node scripts/sync-essay.mjs --check     # exit 1 when the copy has drifted
 *   node scripts/sync-essay.mjs --json      # one JSON object on stdout
 *
 * The source path is overridable with ESSAY_SOURCE, so a checkout elsewhere on
 * disk does not need a source edit.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const DEST = path.join(ROOT, 'essay', 'index.md');
const SRC =
  process.env.ESSAY_SOURCE ??
  path.join(
    os.homedir(),
    'Projects',
    'personal-docs',
    'Personal',
    'Published',
    'reposhowcase-agentic-catalogue',
    'reposhowcase-agentic-catalogue-v2.md',
  );

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const AS_JSON = argv.includes('--json');

/** Human-readable progress. Goes to stderr so `--json` stays parseable. */
function note(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Remove a leading YAML frontmatter block.
 *
 * The block must open on the first line and close on a line containing only
 * `---`. A file with no frontmatter comes back unchanged, so the transform is
 * safe for an essay that never had one.
 *
 * @param {string} text
 * @returns {string}
 */
function stripFrontmatter(text) {
  if (!text.startsWith('---\n')) return text;
  const close = text.indexOf('\n---\n', 4);
  if (close === -1) return text;
  return text.slice(close + '\n---\n'.length);
}

/**
 * Drop a deck line that repeats the H1.
 *
 * The canonical essay renders `# Title` followed by `*Title*`. On the page
 * that is the same sentence twice. Only an exact repeat is removed, so a
 * genuine subtitle survives.
 *
 * @param {string} text
 * @returns {string}
 */
function dropRepeatedSubtitle(text) {
  const lines = text.split('\n');

  const headingIndex = lines.findIndex((line) => line.startsWith('# '));
  if (headingIndex === -1) return text;

  const heading = lines[headingIndex].slice(2).trim();

  let next = headingIndex + 1;
  while (next < lines.length && lines[next].trim() === '') next += 1;
  if (next >= lines.length) return text;

  const match = /^\*([^*]+)\*$/.exec(lines[next].trim());
  if (!match) return text;
  if (match[1].trim() !== heading) return text;

  lines.splice(next, 1);

  // Collapse the blank line the removal left behind.
  if (next < lines.length && lines[next].trim() === '' && lines[next - 1]?.trim() === '') {
    lines.splice(next, 1);
  }

  return lines.join('\n');
}

/**
 * Produce the published text from the canonical text.
 *
 * @param {string} canonical
 * @returns {string}
 */
function render(canonical) {
  const body = dropRepeatedSubtitle(stripFrontmatter(canonical));
  return `${body.replace(/\s+$/, '')}\n`;
}

function fail(message, code = 2) {
  process.stderr.write(`sync-essay: ${message}\n`);
  process.exit(code);
}

if (!fs.existsSync(SRC)) {
  fail(`source not found: ${SRC}\nSet ESSAY_SOURCE to the canonical essay path.`);
}

const canonical = fs.readFileSync(SRC, 'utf8');
const rendered = render(canonical);
const current = fs.existsSync(DEST) ? fs.readFileSync(DEST, 'utf8') : null;
const drifted = current !== rendered;

if (CHECK) {
  if (drifted) {
    const result = { status: 'drifted', source: SRC, destination: DEST };
    process.stdout.write(`${AS_JSON ? JSON.stringify(result) : `drifted: ${DEST} does not match ${SRC}`}\n`);
    process.exit(1);
  }
  const result = { status: 'clean', source: SRC, destination: DEST };
  process.stdout.write(`${AS_JSON ? JSON.stringify(result) : 'clean'}\n`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.writeFileSync(DEST, rendered);

note(drifted ? `updated ${DEST}` : `${DEST} already current`);

if (AS_JSON) {
  process.stdout.write(
    `${JSON.stringify({
      status: drifted ? 'updated' : 'unchanged',
      source: SRC,
      destination: DEST,
      bytes: Buffer.byteLength(rendered),
    })}\n`,
  );
}
