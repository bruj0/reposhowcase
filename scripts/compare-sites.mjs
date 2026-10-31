#!/usr/bin/env node
/**
 * Compare two builds of the site, for parity.
 *
 * Used to check that a rewritten implementation produces the same catalogue as
 * the one it replaces. Takes two `dist/` directories or two URLs and reports
 * each aspect separately, because "identical" is too vague to act on and
 * byte-identical is the wrong target: the page carries a build timestamp.
 *
 *   node scripts/compare-sites.mjs <a> <b>
 *
 * Exits 1 when an aspect that must match does not.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [a, b] = process.argv.slice(2);

if (!a || !b) {
  console.error('usage: node scripts/compare-sites.mjs <dist-dir|url> <dist-dir|url>');
  process.exit(2);
}

/**
 * Read the HTML from a directory or a URL.
 *
 * @param {string} target
 * @returns {Promise<string>}
 */
async function load(target) {
  if (/^https?:\/\//.test(target)) {
    const res = await fetch(target, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`${target} returned HTTP ${res.status}`);
    return res.text();
  }
  return readFile(path.join(target, 'index.html'), 'utf8');
}

/**
 * Everything worth comparing, pulled out of the rendered page.
 *
 * @param {string} html
 */
function extract(html) {
  const all = (re) => [...html.matchAll(re)].map((m) => m[1]);

  return {
    cards: all(/class="card"[^>]*data-name="([^"]*)"/g).length
      ? [...html.matchAll(/<article\s+class="card"[\s\S]*?data-name="([^"]*)"/g)].map((m) => m[1])
      : [],
    axes: [...html.matchAll(/data-axis="([^"]*)"\s+data-value="([^"]*)"/g)].map(
      (m) => `${m[1]}=${m[2]}`,
    ),
    sort: all(/data-sort="([^"]*)"/g),
  };
}

const [htmlA, htmlB] = await Promise.all([load(a), load(b)]);
const left = extract(htmlA);
const right = extract(htmlB);

const problems = [];

/**
 * Compare two lists and report the first difference.
 *
 * @param {string} label
 * @param {string[]} one
 * @param {string[]} two
 * @param {{fatal?: boolean}} [options]
 */
function compare(label, one, two, { fatal = true } = {}) {
  if (one.length !== two.length) {
    const added = two.filter((x) => !one.includes(x));
    const missing = one.filter((x) => !two.includes(x));

    // A mode that one build offers and the other does not is an addition
    // unless something was lost. Losing an item is always fatal.
    if (!fatal && added.length > 0 && missing.length === 0) {
      console.log(`· ${label}: ${one.length} vs ${two.length}, added ${added.join(', ')}`);
      return;
    }

    problems.push(`${label}: ${one.length} vs ${two.length}`);
    if (added.length) problems.push(`  added: ${added.join(', ')}`);
    if (missing.length) problems.push(`  missing: ${missing.join(', ')}`);
    return;
  }

  const orderDiffers = one.some((value, index) => value !== two[index]);
  if (orderDiffers) {
    const at = one.findIndex((value, index) => value !== two[index]);
    if (fatal) {
      problems.push(`${label}: same items, different order at position ${at + 1}`);
      problems.push(`  ${one[at]} vs ${two[at]}`);
    } else {
      console.log(`· ${label}: order differs at position ${at + 1} (not fatal)`);
    }
    return;
  }

  console.log(`✓ ${label}: ${one.length} identical`);
}

compare('cards', left.cards, right.cards);
compare('filter buttons', left.axes, right.axes);
// A new sort mode is an addition, not a change, so this one only reports.
compare('sort buttons', left.sort, right.sort, { fatal: false });

if (problems.length > 0) {
  console.error('\n✗ parity failed');
  for (const line of problems) console.error(`  ${line}`);
  process.exit(1);
}

console.log('\n✓ parity holds');
