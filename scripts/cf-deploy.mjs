#!/usr/bin/env node
/**
 * Build the site and publish it to Cloudflare Pages.
 *
 * Wraps `wrangler pages deploy` for two reasons: it loads `site.config.json`
 * so nothing is hardcoded, and it reads the scoped token from `.env` so the
 * credential never has to be exported by hand or typed into a command that
 * `ps` can read.
 *
 *   node scripts/cf-deploy.mjs                  # production
 *   node scripts/cf-deploy.mjs --branch test    # preview deployment
 *   node scripts/cf-deploy.mjs --skip-build     # publish dist/ as it stands
 *   node scripts/cf-deploy.mjs --dry-run        # build, print, upload nothing
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readEnv } from './lib/env.mjs';

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, '.env');
const CONFIG_PATH = path.join(ROOT, 'site.config.json');
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');

const argv = process.argv.slice(2);

/**
 * Read a flag's value: `--branch main` or `--branch=main`.
 *
 * @param {string} name
 * @returns {string|undefined}
 */
function flag(name) {
  const withValue = argv.find((a) => a.startsWith(`--${name}=`));
  if (withValue) return withValue.slice(name.length + 3);

  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  return undefined;
}

const SKIP_BUILD = argv.includes('--skip-build');
const DRY_RUN = argv.includes('--dry-run');

/**
 * Run a command, inheriting stdio so build and upload output stays live.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, cwd: ROOT });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited ${result.status}.`);
  }
}

async function main() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error('site.config.json not found. Copy site.config.json from the template and set "projectName".');
  }
  const site = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

  const fileEnv = await readEnv(ENV_PATH);
  const token = process.env.CLOUDFLARE_API_TOKEN ?? fileEnv.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? fileEnv.CLOUDFLARE_ACCOUNT_ID;

  if (!token) {
    throw new Error(
      'No CLOUDFLARE_API_TOKEN. Run `npm run cf:setup` once to mint a scoped token, ' +
        'or set the variable in the environment for CI.',
    );
  }

  const branch = flag('branch') ?? site.productionBranch;
  const outDir = path.join(ROOT, site.buildOutputDir);

  if (!SKIP_BUILD) {
    console.log('▸ Building');
    run('npm', ['run', 'build']);
  } else {
    console.log('▸ Skipping build (--skip-build)');
  }

  if (!existsSync(outDir)) {
    throw new Error(`Nothing to publish: ${site.buildOutputDir}/ does not exist after the build.`);
  }

  const args = [
    'pages',
    'deploy',
    outDir,
    '--project-name',
    site.projectName,
    '--branch',
    branch,
    // The working tree is frequently dirty during a local deploy, and
    // wrangler refuses to guess the commit otherwise.
    '--commit-dirty=true',
  ];

  console.log(`▸ Deploying ${site.buildOutputDir}/ to ${site.projectName} (${branch})`);
  if (DRY_RUN) {
    console.log(`  would run: wrangler ${args.join(' ')}`);
    return;
  }

  if (!existsSync(WRANGLER)) {
    throw new Error('wrangler is not installed. Run `npm install` first.');
  }

  run(WRANGLER, args, {
    ...process.env,
    CLOUDFLARE_API_TOKEN: token,
    ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
  });

  const host =
    branch === site.productionBranch
      ? `https://${site.projectName}.pages.dev`
      : `https://${branch}.${site.projectName}.pages.dev`;
  console.log(`\n✓ Published: ${host}`);
}

main().catch((err) => {
  console.error(`\n✗ Deploy failed\n  ${err.message}`);
  process.exitCode = 1;
});
