/**
 * Split this instance from the product it demonstrates.
 *
 * This repository is one deployment of a template: a particular owner, a
 * particular brand, and a catalogue of that owner's repositories. The product
 * is the same code with none of that — a sample catalogue, a placeholder
 * owner, and a README written for a stranger.
 *
 * The split is a whitelist. A file upstream does not reach the product because
 * it exists; it reaches the product because it is named here. That is the
 * whole point: adding a research note, an instance script, or a report about
 * this account must not publish it.
 *
 * The product repository is a build artifact. Delete it, run `--sync`, and the
 * same tree comes back.
 *
 * Usage:
 *   node scripts/release.mjs --check   report drift and instance data, change nothing
 *   node scripts/release.mjs --sync    write the product tree and commit it
 *
 * Exit codes:
 *   0  the product matches the release set
 *   1  it does not: drift, or instance data in a file that would ship
 *   2  the product repository is absent, which a person has to create
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const downstream = path.join(root, '..', 'reposhowcase');

/**
 * Upstream files that ship, copied verbatim. A directory is copied whole.
 *
 * `scripts/` ships whole because every script in it is the toolchain: the
 * config loaders, the refresh, the deploy, and the audit passes. No script
 * carries instance data. What carries instance data is `src/data/repos.json`
 * and `catalogue/`, and those are not in this list.
 *
 * `docs/deployment.md` ships because it explains the deploy a user performs.
 * `docs/readme-report.md` does not: it is an audit of this account's
 * repositories, which is the instance, not the product.
 */
const RELEASE_FILES = [
  // Build
  'astro.config.mjs',
  'tsconfig.json',
  'package.json',
  'package-lock.json',

  // The site
  'src/',
  'public/favicon.svg',

  // The toolchain
  'scripts/',

  // The skills a user drives the toolchain with
  '.agents/',

  // Configuration the user fills in, and the CI that publishes it
  '.env.example',
  '.github/workflows/deploy.yml',
  'docs/deployment.md',
  'docs/hosting.md',
];

/**
 * Directory whose contents overwrite the product's copies, path for path.
 *
 * `release/README.md` becomes `README.md`, `release/site.config.json` becomes
 * `site.config.json`, and so on. These files have no useful upstream version:
 * the instance's README is about this account, and its config names it.
 *
 * A file here takes precedence over the same path in `RELEASE_FILES`, which is
 * how `release/src/data/repos.json` replaces the instance's catalogue with the
 * sample.
 */
const RELEASE_OWNED = 'release';

/** The product's own name, in its manifest and everywhere it is asserted. */
const PRODUCT_NAME = 'reposhowcase';

/** Files that must exist in the product, to catch a clobbered tree. */
const REQUIRED = ['README.md', 'LICENSE', 'package.json', 'site.config.json'];

/** Directories never treated as release content, nor removed. */
const IGNORED = new Set(['.git', 'node_modules', 'dist', '.astro', '.wrangler']);

function exists(target) {
  return fs.existsSync(target);
}

/** Every file in a tree, relative to the tree's root, dotfiles included. */
function listFiles(directory, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(path.join(directory, entry.name), relative));
    } else {
      out.push(relative);
    }
  }
  return out.sort();
}

/**
 * Rewrite the manifest for the product.
 *
 * The name changes so the package, the Pages project and the repository share
 * one word. `private` stays: this is a site, not a package anyone installs
 * from npm, and publishing it by accident would be a confusing artifact.
 *
 * @param {string} manifest Raw upstream `package.json`.
 * @returns {string}
 */
function transformManifest(manifest) {
  const pkg = JSON.parse(manifest);
  pkg.name = PRODUCT_NAME;
  pkg.description =
    'Turn one GitHub account into a catalogue page of the applications it shipped.';
  pkg.private = true;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Rewrite the lockfile's package name to match the manifest.
 *
 * The lockfile records the name twice — at the root and under `packages[""]`
 * — and copying it verbatim left the product's lockfile announcing the
 * instance's name. `npm ci` then disagrees with `package.json`, and the name
 * leaks through a file nobody thinks to grep.
 *
 * @param {string} lockfile Raw `package-lock.json`.
 * @returns {string}
 */
function transformLockfile(lockfile) {
  const lock = JSON.parse(lockfile);
  lock.name = PRODUCT_NAME;
  if (lock.packages?.['']) lock.packages[''].name = PRODUCT_NAME;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/**
 * The product tree, as a path-to-bytes map.
 *
 * Building the whole tree in memory is what makes `--check` and `--sync` agree
 * by construction: the sync writes exactly this map, and the check compares
 * exactly this map, so the two cannot disagree about what the release is.
 *
 * @returns {Map<string, Buffer>}
 */
function expectedTree() {
  const out = new Map();

  for (const entry of RELEASE_FILES) {
    const source = path.join(root, entry);
    if (!exists(source)) throw new Error(`release file missing upstream: ${entry}`);
    if (fs.statSync(source).isDirectory()) {
      for (const inner of listFiles(source)) {
        out.set(
          path.posix.join(entry, inner),
          fs.readFileSync(path.join(source, inner)),
        );
      }
    } else {
      out.set(entry, fs.readFileSync(source));
    }
  }

  // Last, so a release-owned file wins over the same path above.
  const ownedRoot = path.join(root, RELEASE_OWNED);
  if (!exists(ownedRoot)) {
    throw new Error(`missing the ${RELEASE_OWNED}/ directory that holds product-only files`);
  }
  for (const inner of listFiles(ownedRoot)) {
    out.set(inner, fs.readFileSync(path.join(ownedRoot, inner)));
  }

  out.set(
    'package.json',
    Buffer.from(transformManifest(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))),
  );

  if (out.has('package-lock.json')) {
    out.set(
      'package-lock.json',
      Buffer.from(transformLockfile(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))),
    );
  }

  return out;
}

/**
 * What the product repository currently carries, path to bytes.
 *
 * Read from git's index rather than from the working tree. The working tree
 * holds `node_modules` and a `dist` the comparison must ignore, and the
 * removal step must never touch them.
 *
 * @returns {Map<string, Buffer>}
 */
function actualTree() {
  const out = new Map();
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: downstream, encoding: 'utf8' });
  } catch {
    return out;
  }
  for (const line of tracked.split('\n')) {
    const file = line.trim();
    if (!file) continue;
    const absolute = path.join(downstream, file);
    if (!exists(absolute)) continue;
    out.set(file, fs.readFileSync(absolute));
  }
  return out;
}

/**
 * Instance data that must not reach the product.
 *
 * Read from the instance's own config, so the terms follow the instance rather
 * than being hardcoded here. Every term is a fact about this deployment: its
 * GitHub account and its brand name.
 *
 * @returns {string[]}
 */
function forbiddenTerms() {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8'));
  const terms = new Set();
  for (const value of [config.githubOwner, config.brand?.name]) {
    if (typeof value === 'string' && value.trim() !== '') terms.add(value.trim());
  }
  return [...terms];
}

/** Whether a file is text, judged by the first few kilobytes. */
function looksTextual(buffer) {
  return !buffer.subarray(0, 8192).includes(0);
}

/**
 * Find instance data in the tree that would ship.
 *
 * A missing file is caught by the set comparison; this catches a file that
 * exists but names the wrong account.
 *
 * @param {Map<string, Buffer>} tree
 * @returns {{file: string, term: string}[]}
 */
function findLeaks(tree) {
  const terms = forbiddenTerms();
  const hits = [];
  for (const [file, buffer] of tree) {
    if (!looksTextual(buffer)) continue;
    const text = buffer.toString('utf8');
    for (const term of terms) {
      if (text.includes(term)) hits.push({ file, term });
    }
  }
  return hits;
}

/** Compare the two trees. `differs` is a file present in both with other bytes. */
function compare(expected, actual) {
  const missing = [];
  const extra = [];
  const differs = [];
  for (const file of expected.keys()) {
    if (!actual.has(file)) missing.push(file);
    else if (!expected.get(file).equals(actual.get(file))) differs.push(file);
  }
  for (const file of actual.keys()) {
    if (!expected.has(file)) extra.push(file);
  }
  return { missing, extra, differs };
}

/** Report, without changing anything. */
function check() {
  const expected = expectedTree();
  const actual = actualTree();
  const { missing, extra, differs } = compare(expected, actual);
  const leaks = findLeaks(expected);

  for (const file of missing) console.log(`missing  ${file}`);
  for (const file of extra) console.log(`extra    ${file}`);
  for (const file of differs) console.log(`differs  ${file}`);
  for (const { file, term } of leaks) console.log(`instance data  ${file} names "${term}"`);

  const drift = missing.length + extra.length + differs.length;
  if (drift === 0 && leaks.length === 0) {
    console.log(`product matches the release set: ${expected.size} files, no instance data`);
    return true;
  }
  console.log(
    `\nproduct differs: ${missing.length} missing, ${extra.length} extra, ` +
      `${differs.length} changed, ${leaks.length} carrying instance data`,
  );
  return false;
}

/** Write the tree, remove anything it does not contain, and commit. */
function sync() {
  const expected = expectedTree();

  for (const [file, bytes] of expected) {
    const target = path.join(downstream, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }

  const { extra } = compare(expected, actualTree());
  for (const file of extra) {
    fs.rmSync(path.join(downstream, file), { force: true });
    console.log(`removed ${file}`);
  }

  // Directories the removals emptied, so the tree is exactly the release set.
  for (const entry of fs.readdirSync(downstream, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED.has(entry.name)) continue;
    const directory = path.join(downstream, entry.name);
    if (fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
      console.log(`removed ${entry.name}/`);
    }
  }

  const version = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ).version;

  // Stage only what this run wrote or removed.
  //
  // `git add -A` also commits whatever else is sitting in the product's working
  // tree. That is how a stray `_site/` build and a `mkdocs.yml` from another
  // project reached a public repository: the sync took the whole tree, not the
  // release set, and the whitelist stopped being a whitelist at the last step.
  const touched = [...expected.keys(), ...extra];
  execFileSync('git', ['add', '-A', '--', ...touched], { cwd: downstream });

  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: downstream,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

  // Everything else that is dirty was not produced by this run. Report it, and
  // leave it alone: neither committing nor deleting a file this script did not
  // write is its decision to make.
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: downstream,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .filter((line) => !staged.includes(line.slice(3).trim()));

  if (dirty.length > 0) {
    console.log('\ndirty but not staged, because this run did not write them:');
    for (const line of dirty) console.log(`  ${line}`);
  }

  if (staged.length === 0) {
    console.log('product is already up to date');
    return;
  }

  execFileSync('git', ['commit', '-m', `chore: sync from the instance at v${version}`], {
    cwd: downstream,
    stdio: 'inherit',
  });
  console.log(`\nproduct synced: ${expected.size} files`);
}

function main() {
  if (!exists(downstream)) {
    console.error(`the product repository is not at ${downstream}`);
    console.error('create it first:');
    console.error(`  gh repo create ${PRODUCT_NAME} --private --description "..."`);
    process.exit(2);
  }

  for (const required of REQUIRED) {
    if (!exists(path.join(downstream, required)) && actualTree().size > 0) {
      console.error(`product is missing a required file: ${required}`);
      process.exit(1);
    }
  }

  if (process.argv.includes('--check')) process.exit(check() ? 0 : 1);

  if (process.argv.includes('--sync')) {
    sync();
    return;
  }

  console.error('pass --check to verify, or --sync to write the product tree');
  process.exit(1);
}

main();
