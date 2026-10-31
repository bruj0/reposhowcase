#!/usr/bin/env node
/**
 * Publish to every target named in `deploy.targets`, in a fixed order.
 *
 * Which hosts publish is a config decision, not a script decision: this file
 * reads the list and nothing else, so adding a target is a config change plus a
 * script, never an edit here.
 *
 * Stops at the first failure. A half-published site is worse than an
 * unpublished one, and the second host is usually the fallback for the first.
 *
 *   npm run deploy                        # every configured target
 *   npm run deploy -- --dry-run           # report, push nothing
 *   npm run deploy -- --skip-build        # reuse dist/ for both targets
 *
 * Flags are passed through untouched, so whatever `cf-deploy.mjs` and
 * `gh-deploy.mjs` accept works here.
 */

import { spawnSync } from 'node:child_process';

import { loadConfig } from './lib/config.mjs';

/** Fixed order. Cloudflare is the domain owner; GitHub is the second copy. */
const ORDER = ['cloudflare-pages', 'github-pages'];

const SCRIPT = {
  'cloudflare-pages': 'scripts/cf-deploy.mjs',
  'github-pages': 'scripts/gh-deploy.mjs',
};

const argv = process.argv.slice(2);
const config = loadConfig();

const selected = ORDER.filter((target) => config.deploy.targets.includes(target));

if (selected.length === 0) {
  console.error('✗ deploy.targets names no target this build knows how to publish.');
  process.exit(1);
}

for (const target of selected) {
  const script = SCRIPT[target];

  // A GitHub deploy that reuses dist/ would reuse the wrong base path: the
  // two builds differ, so --skip-build is only safe when one target is active.
  if (target === 'github-pages' && argv.includes('--skip-build') && selected.length > 1) {
    console.error(
      '✗ --skip-build with two targets is ambiguous: each target needs its own build.\n' +
        '  Run `npm run deploy:cf` and `npm run deploy:gh` separately instead.',
    );
    process.exit(1);
  }

  console.log(`\n▸ ${target}`);
  const result = spawnSync('node', [script, ...argv], { stdio: 'inherit' });

  if (result.error) {
    console.error(`✗ ${target} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n✗ ${target} failed. Later targets were not attempted.`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\n✓ published to ${selected.join(' and ')}`);
