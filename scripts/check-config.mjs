#!/usr/bin/env node
/**
 * Prove the two config implementations agree.
 *
 * `scripts/lib/config.mjs` is what the build uses; `scripts/lib/config.py` is
 * what the Python utilities use. They are written twice because the languages
 * differ, which means they can drift. This compares them on the real config
 * and exits non-zero if they disagree.
 *
 *   node scripts/check-config.mjs
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_PATH, loadConfig } from './lib/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Key-sorted JSON, so two objects compare by content rather than by the order
 * their languages happened to emit.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(/** @type {Record<string, unknown>} */ (value)[key])]),
    );
  }
  return value;
}

const fromJs = canonical(loadConfig(CONFIG_PATH));

const pythonSource = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
from lib.config import load_config
print(json.dumps(load_config(${JSON.stringify(CONFIG_PATH)})))
`;

let fromPython;
try {
  const out = execFileSync('python3', ['-c', pythonSource], { encoding: 'utf8' });
  fromPython = canonical(JSON.parse(out));
} catch (err) {
  console.error('✗ the Python loader failed');
  console.error(`  ${err.stderr?.trim() || err.message}`);
  process.exit(1);
}

const js = JSON.stringify(fromJs, null, 2);
const py = JSON.stringify(fromPython, null, 2);

if (js !== py) {
  console.error('✗ the two config loaders disagree');
  const jsLines = js.split('\n');
  const pyLines = py.split('\n');
  const limit = Math.max(jsLines.length, pyLines.length);
  for (let i = 0; i < limit; i += 1) {
    if (jsLines[i] !== pyLines[i]) {
      console.error(`  line ${i + 1}`);
      console.error(`    mjs: ${jsLines[i] ?? '(absent)'}`);
      console.error(`    py : ${pyLines[i] ?? '(absent)'}`);
      break;
    }
  }
  process.exit(1);
}

console.log(`✓ both loaders agree on ${path.relative(ROOT, CONFIG_PATH)}`);
