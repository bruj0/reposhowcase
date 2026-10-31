/**
 * Read and write the repo's `.env` without disturbing what is already there.
 *
 * `.env` is written by hand, is gitignored, and holds values the operator
 * cares about (`cloudflare_admin_api_token`). Rewriting it wholesale with a
 * serializer would drop comments and reorder lines, so this module edits the
 * single key it owns and leaves every other byte alone — the same rule the
 * deployflow repo applies to `app.yaml`.
 */

import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const KEY_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * Parse `.env` content into a plain object.
 *
 * Only the shapes this repo actually uses are handled: `KEY=value`,
 * `KEY="value"`, `KEY='value'`, blank lines and `#` comments. No escapes, no
 * interpolation, no multi-line values — a partial parser that says so is
 * safer than one that half-implements the format.
 *
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = KEY_LINE.exec(line);
    if (!match) continue;

    let value = match[2].trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);

    out[match[1]] = value;
  }
  return out;
}

/**
 * Read `.env` from disk, returning `{}` when it does not exist yet.
 *
 * @param {string} path
 * @returns {Promise<Record<string,string>>}
 */
export async function readEnv(path) {
  if (!existsSync(path)) return {};
  return parseEnv(await readFile(path, 'utf8'));
}

/**
 * Set one key in `.env`, creating the file if needed.
 *
 * When the key already exists (in any position) that line is replaced in
 * place. Otherwise the key is appended on its own line. The file is then
 * forced to mode 0600, because it now holds a credential that can publish to
 * the account.
 *
 * @param {string} path
 * @param {string} key
 * @param {string} value
 * @returns {Promise<{changed: boolean}>}
 */
export async function setEnvKey(path, key, value) {
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
  const lines = existing === '' ? [] : existing.replace(/\n$/, '').split('\n');

  let replaced = false;
  const next = lines.map((line) => {
    const match = KEY_LINE.exec(line);
    if (match && match[1] === key) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!replaced) next.push(`${key}=${value}`);

  const body = `${next.join('\n')}\n`;
  const changed = body !== existing;

  if (changed) await writeFile(path, body, { mode: 0o600 });

  // Enforced on every call, not only on a write: a `.env` created by an
  // earlier tool can already be world-readable, and this module's whole
  // reason to exist is a file that holds credentials.
  await chmod(path, 0o600);

  return { changed };
}

/**
 * Mask a secret for display: enough to tell two tokens apart in a log, not
 * enough to use one.
 *
 * @param {string} secret
 * @returns {string}
 */
export function mask(secret) {
  if (!secret) return '(unset)';
  if (secret.length <= 12) return `${'*'.repeat(secret.length)}`;
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}
