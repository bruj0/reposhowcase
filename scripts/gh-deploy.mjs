#!/usr/bin/env node
/**
 * Build the site and publish it to GitHub Pages.
 *
 * Pages needs three things that `dist/` does not contain:
 *
 *   - `.nojekyll`, because the build puts its CSS and JS in `_astro/` and
 *     Jekyll silently drops directories whose names begin with an underscore.
 *     Without it the page returns 200 and renders unstyled.
 *   - `CNAME`, when a custom domain is configured, because on a branch deploy
 *     the domain lives in that file and this script force-pushes.
 *   - a branch that is a single orphan commit, so generated HTML does not
 *     accumulate history.
 *
 *   node scripts/gh-deploy.mjs                # build, publish, or report no-op
 *   node scripts/gh-deploy.mjs --dry-run      # build, assemble, push nothing
 *   node scripts/gh-deploy.mjs --force        # push even when nothing changed
 *   node scripts/gh-deploy.mjs --skip-build   # publish dist/ as it stands
 *   node scripts/gh-deploy.mjs --json         # one JSON object on stdout
 *
 * `--force` exists because adding or removing a custom domain changes the
 * routing path without triggering a rebuild, so a deploy that would otherwise
 * be a no-op is the exact deploy that must go out.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from './lib/config.mjs';
import { readEnv } from './lib/env.mjs';

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, '.env');
const argv = process.argv.slice(2);

const DRY_RUN = argv.includes('--dry-run');
const AS_JSON = argv.includes('--json');
const FORCE = argv.includes('--force');
const SKIP_BUILD = argv.includes('--skip-build');

/** Human-readable progress. Goes to stderr so `--json` stays parseable. */
function note(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Run a command and return its stdout.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, inherit?: boolean}} [options]
 * @returns {string}
 */
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
}

/** Every file under a directory, relative, sorted. */
function listFiles(directory, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(directory, entry.name), relative));
    else out.push(relative);
  }
  return out.sort();
}

/**
 * A hash of the artifact, so an unchanged build is a reportable no-op.
 *
 * Paths are included because a rename with identical bytes is still a change
 * to what the site serves.
 *
 * @param {string} directory
 * @returns {string}
 */
function hashArtifact(directory) {
  const hash = createHash('sha256');
  for (const file of listFiles(directory)) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(directory, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Assemble the artifact: the build output, plus the two files Pages needs.
 *
 * @param {object} config
 * @param {string} outDir
 * @returns {string} The staged directory.
 */
function assemble(config, outDir) {
  if (!fs.existsSync(outDir)) {
    throw new Error(`nothing to publish: ${path.relative(ROOT, outDir)}/ does not exist`);
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'reposhowcase-pages-'));
  fs.cpSync(outDir, staging, { recursive: true });

  // Jekyll skips `_`-prefixed paths; the whole stylesheet lives in one.
  fs.writeFileSync(path.join(staging, '.nojekyll'), '');

  const { customDomain } = config.deploy.githubPages;
  if (customDomain) fs.writeFileSync(path.join(staging, 'CNAME'), `${customDomain}\n`);

  return staging;
}

/**
 * The repository this artifact belongs to.
 *
 * `repository` is optional. Omitted, the artifact goes to the repository the
 * source lives in, which is what a public repository needs and needs no
 * credential to push to.
 *
 * @param {object} config
 * @returns {{owner: string, name: string, external: boolean}}
 */
function resolveRepository(config) {
  const { repository, owner, name } = config.deploy.githubPages;
  return { owner, name, external: repository !== null };
}

/**
 * The URL to push to.
 *
 * SSH first: a local deploy then needs no token at all, and the operator's
 * existing key already reaches every repository they own. A token is only
 * consulted when one is configured, which is the CI shape.
 *
 * @param {{owner: string, name: string}} repo
 * @param {string|undefined} token
 * @returns {string}
 */
function remoteUrl(repo, token) {
  if (token) return `https://x-access-token:${token}@github.com/${repo.owner}/${repo.name}.git`;
  return `git@github.com:${repo.owner}/${repo.name}.git`;
}

/**
 * The tip commit message on the remote branch, or null when it cannot be read.
 *
 * Used only to report a no-op. A failure here is not an error: it means the
 * branch is absent or the API is unreachable, and either way the deploy should
 * proceed.
 *
 * @param {{owner: string, name: string}} repo
 * @param {string} branch
 * @returns {string|null}
 */
function tipMessage(repo, branch) {
  try {
    return run('gh', [
      'api',
      `repos/${repo.owner}/${repo.name}/branches/${branch}`,
      '--jq',
      '.commit.commit.message',
    ]).trim();
  } catch {
    return null;
  }
}

async function main() {
  const config = loadConfig();
  const { targets, githubPages } = config.deploy;

  if (!targets.includes('github-pages')) {
    note('github-pages is not in deploy.targets; nothing to do.');
    return;
  }

  const fileEnv = await readEnv(ENV_PATH);
  const token = process.env.GH_TOKEN ?? fileEnv.GH_TOKEN;

  const repo = resolveRepository(config);
  const branch = githubPages.branch;
  const outDir = path.join(ROOT, config.buildOutputDir);

  if (!SKIP_BUILD) {
    note('▸ Building for GitHub Pages');
    try {
      run('npm', ['run', 'build:gh'], {
        env: { ...process.env, DEPLOY_TARGET: 'github-pages' },
        // With --json, stdout belongs to the one JSON object. Astro's build
        // output would otherwise split it into unparseable halves.
        inherit: !AS_JSON,
      });
    } catch (err) {
      if (AS_JSON && err.stderr) note(err.stderr.toString());
      throw err;
    }
  } else {
    note('▸ Skipping build (--skip-build)');
  }

  const staging = assemble(config, outDir);
  const hash = hashArtifact(staging);
  const files = listFiles(staging);

  const summary = {
    repository: `${repo.owner}/${repo.name}`,
    branch,
    domain: githubPages.customDomain,
    basePath: githubPages.basePath,
    files: files.length,
    hash,
    pushed: false,
    skipped: false,
  };

  if (!FORCE) {
    const tip = tipMessage(repo, branch);
    if (tip && tip.includes(hash)) {
      summary.skipped = true;
      if (AS_JSON) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      else note(`✓ unchanged (${hash}); pass --force to push anyway`);
      fs.rmSync(staging, { recursive: true, force: true });
      return;
    }
  }

  if (DRY_RUN) {
    if (AS_JSON) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else {
      note(`  would push ${files.length} files to ${repo.owner}/${repo.name}:${branch}`);
      for (const file of files) note(`    ${file}`);
    }
    fs.rmSync(staging, { recursive: true, force: true });
    return;
  }

  // The commit is authored by whoever is running the deploy. Their identity is
  // read, never written: changing it here would rewrite the operator's git
  // configuration for every other repository on the machine.
  const name = run('git', ['config', 'user.name'], { cwd: ROOT }).trim() || 'reposhowcase';
  const email = run('git', ['config', 'user.email'], { cwd: ROOT }).trim() || 'noreply@example.com';

  run('git', ['init', '--quiet', '--initial-branch', branch], { cwd: staging });
  run('git', ['add', '--all'], { cwd: staging });
  run(
    'git',
    ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--quiet', '-m', `deploy: ${hash}`],
    { cwd: staging },
  );

  note(`▸ Pushing ${files.length} files to ${repo.owner}/${repo.name}:${branch}`);
  run('git', ['push', '--quiet', '--force', remoteUrl(repo, token), `HEAD:${branch}`], {
    cwd: staging,
    inherit: true,
  });

  summary.pushed = true;
  fs.rmSync(staging, { recursive: true, force: true });

  if (AS_JSON) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else note(`✓ Published ${githubPages.site}`);
}

main().catch((err) => {
  process.stderr.write(`\n✗ GitHub Pages deploy failed\n  ${err.message}\n`);
  process.exitCode = 1;
});
