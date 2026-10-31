#!/usr/bin/env node
/**
 * Report which credentials the configured deploy targets need.
 *
 * This exists so an agent never has to ask for a token in a conversation, and
 * never has to read one back to prove it found one. It answers one question —
 * is the key present — and prints **no value**, not even a prefix or a length.
 * A checker that prints a token to prove it found one has leaked it into a log,
 * a scrollback buffer and a transcript.
 *
 *   node scripts/secrets-check.mjs             # human output, exit 1 if missing
 *   node scripts/secrets-check.mjs --json      # one JSON object on stdout
 *
 * Keys are read from the environment first, then from `.env` at the repository
 * root, which is gitignored and 0600. Nothing here writes, prompts or echoes.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from './lib/config.mjs';
import { readEnv } from './lib/env.mjs';

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, '.env');
const AS_JSON = process.argv.includes('--json');

/**
 * Which keys each target needs.
 *
 * The GitHub entry is conditional: a project site published from its own
 * repository needs no token at all, because the push uses the local git remote.
 * Only an external artifact repository, which is what a private source needs,
 * requires one.
 */
function requirements(config) {
  const out = [];
  const { targets, githubPages } = config.deploy;

  if (targets.includes('cloudflare-pages')) {
    out.push({ key: 'CLOUDFLARE_API_TOKEN', neededBy: 'cloudflare-pages', required: true });
    out.push({ key: 'CLOUDFLARE_ACCOUNT_ID', neededBy: 'cloudflare-pages', required: true });
  }

  if (targets.includes('github-pages') && githubPages.repository !== null) {
    // Optional, because a local deploy pushes over SSH with the operator's
    // existing key. It is required only where no key exists — CI — so calling
    // it required here would send people hunting for a secret they do not need.
    out.push({
      key: 'GH_TOKEN',
      neededBy: 'github-pages to an external repository, when SSH is unavailable',
      required: false,
    });
  }

  // Optional everywhere: without it GitHub's traffic API returns no numbers and
  // the catalogue falls back to sorting by creation date.
  out.push({ key: 'GITHUB_TOKEN', neededBy: 'npm run refresh, for view counts', required: false });

  return out;
}

async function main() {
  const config = loadConfig();
  const fileEnv = await readEnv(ENV_PATH);

  const envFileExists = fs.existsSync(ENV_PATH);
  const rows = requirements(config).map((entry) => ({
    ...entry,
    present: Boolean(process.env[entry.key] ?? fileEnv[entry.key]),
  }));

  const missing = rows.filter((row) => row.required && !row.present).map((row) => row.key);
  const ok = missing.length === 0;

  if (AS_JSON) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok,
          envFile: envFileExists,
          keys: rows.map(({ key, neededBy, required, present }) => ({
            key,
            neededBy,
            required,
            present,
          })),
          missing,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    if (!envFileExists) {
      console.log('· .env not found; only the environment is consulted');
    }
    for (const row of rows) {
      const mark = row.present ? '✓' : row.required ? '✗' : '·';
      const state = row.present ? 'present' : row.required ? 'MISSING' : 'absent (optional)';
      console.log(`${mark} ${row.key.padEnd(24)} ${state}`);
      if (!row.present) console.log(`  needed by ${row.neededBy}`);
    }
    if (ok) {
      console.log('\n✓ every required key is present. No value was read or printed.');
    } else {
      console.log(`\n✗ ${missing.length} required key(s) missing: ${missing.join(', ')}`);
      console.log('  Write them into .env yourself. Do not paste a token into a conversation.');
    }
  }

  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`\n✗ secrets check failed\n  ${err.message}\n`);
  process.exitCode = 1;
});
