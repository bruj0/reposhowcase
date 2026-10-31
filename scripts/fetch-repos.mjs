#!/usr/bin/env node
/**
 * Refresh the catalogue snapshot from the GitHub API.
 *
 * Writes src/data/repos.json - the file the Astro build reads. The build
 * never calls the API itself, so a build works with no network access and
 * no token, and a catalogue change shows up in a pull request as a diff
 * rather than as a silent change to a deployed page.
 *
 * Filtering rule, which is the whole point of this script:
 *   - `affiliation=owner` drops repositories the account only collaborates on
 *   - `fork == false` drops forks
 *   - `visibility === 'public'` drops private repositories
 *   - `isEmpty` drops repositories with nothing in them
 *   - `isUnnoticed` drops small repositories that nobody has ever used
 *
 * The first three are needed. `affiliation=owner` alone would surface every
 * fork and every private repository the account has ever touched.
 *
 * Usage:
 *   node scripts/fetch-repos.mjs                 # unauthenticated, public data only
 *   GITHUB_TOKEN=ghp_... node scripts/fetch-repos.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './lib/config.mjs';

/**
 * The owner and every threshold come from `site.config.json`.
 *
 * `GITHUB_OWNER` still wins when set, which is what a one-off run against
 * another account needs.
 */
const config = loadConfig();
const OWNER = process.env.GITHUB_OWNER ?? config.githubOwner;
const RULES = config.catalogue;

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/data/repos.json');
const EXCLUDED_OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../catalogue/excluded.json');
const PER_PAGE = 100;
const MAX_PAGES = 10;

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'coderscorp-catalogue',
};

if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

/**
 * Raised when GitHub refused to answer because the rate limit ran out.
 *
 * A distinct type matters because every fetch in this script sits inside a
 * `catch` that tolerates a missing resource. Swallowing this one turns a
 * rate-limited run back into the silent corruption it exists to prevent.
 */
class RateLimitError extends Error {}

/**
 * Abort when GitHub refused to answer because the rate limit ran out.
 *
 * This exists because the alternative was measured: an unauthenticated run
 * exhausted the 60-request budget partway through, every remaining tree and
 * README lookup failed, `fetchTree` returned an empty list, and `isEmpty`
 * read that as "this repository has no code" — so the script wrote 15
 * applications instead of 53 and reported 48 of them as empty. The output
 * looked like a legitimate refresh.
 *
 * A 404 is a real answer and must stay a real answer. A 403 or 429 carrying
 * `x-ratelimit-remaining: 0` is not an answer at all, and writing the file
 * anyway destroys hand-curated data.
 *
 * @param {Response} res
 * @param {string} what Short description for the error message.
 */
function assertNotRateLimited(res, what) {
  if (res.ok) return;
  if (res.status !== 403 && res.status !== 429) return;

  const remaining = res.headers.get('x-ratelimit-remaining');
  if (res.status !== 429 && remaining !== '0') return;

  const resetSeconds = Number(res.headers.get('x-ratelimit-reset') ?? 0);
  const resetAt = resetSeconds ? new Date(resetSeconds * 1000).toISOString() : 'an unknown time';

  throw new RateLimitError(
    `GitHub rate limit reached while fetching ${what} (HTTP ${res.status}). ` +
      `The catalogue was NOT written, because a failed lookup and a repository with no files ` +
      `are indistinguishable after the fact.\n` +
      `  Reset at: ${resetAt}\n` +
      `  Fix: authenticate the run — GITHUB_TOKEN=$(gh auth token) node scripts/fetch-repos.mjs\n` +
      `  Authenticated requests get 5000/hour instead of 60/hour.`,
  );
}

/**
 * @returns {Promise<Array<object>>} every repository owned by the account.
 */
async function fetchAllRepos() {
  const all = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`https://api.github.com/users/${OWNER}/repos`);
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(page));
    // `type=owner` narrows to repositories the account created or owns.
    url.searchParams.set('type', 'owner');

    const res = await fetch(url, { headers });

    if (!res.ok) {
      // The first call is where an unauthenticated run usually dies, so the
      // actionable rate-limit message has to be reachable from here and not
      // only from the deeper per-repository lookups.
      assertNotRateLimited(res, `the repository list (page ${page})`);
      throw new Error(`GitHub API ${res.status} ${res.statusText} for page ${page}`);
    }

    const batch = await res.json();
    all.push(...batch);

    if (batch.length < PER_PAGE) break;
  }

  return all;
}

/**
 * Derive a coarse domain label so the catalogue can be filtered by what a
 * project does rather than by its GitHub language.
 *
 * @param {object} repo
 * @returns {string}
 */
function classify(repo) {
  const text = `${repo.name} ${repo.description ?? ''} ${(repo.topics ?? []).join(' ')}`.toLowerCase();

  if (/vault|secret|fido|u2f|encrypt|security|auth|hsm|pkcs/.test(text)) return 'security';
  if (/k8s|kubernetes|proxmox|terraform|hcl|aws|ecs|eks|fargate|pipeline|ci\/cd|argocd|infra/.test(text)) return 'infrastructure';
  if (/agent|llm|mcp|rag|claude|codex|gemini|sdd|spec|memory|skill|prompt/.test(text)) return 'agent-tooling';
  if (/vscode|extension|desktop|monitor|plugin|cli/.test(text)) return 'tooling';
  return 'application';
}

const DOMAIN_ORDER = ['agent-tooling', 'infrastructure', 'security', 'tooling', 'application'];

const DOMAIN_LABEL = {
  'agent-tooling': 'Agent Tooling',
  infrastructure: 'Infrastructure',
  security: 'Security',
  tooling: 'Tooling',
  application: 'Applications',
};

/**
 * Count repository views over the traffic API's 14-day window.
 *
 * The traffic API requires push access, so it only works with a token. A
 * public catalogue does not need it: the count falls back to 0 and the
 * "most viewed" sort degrades to stars.
 *
 * @param {string} name
 * @returns {Promise<{views: number, uniques: number}>}
 */
async function fetchTraffic(name) {
  if (!process.env.GITHUB_TOKEN) return { views: 0, uniques: 0 };

  try {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${name}/traffic/views`, {
      headers: { ...headers, Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
    });
    if (!res.ok) return { views: 0, uniques: 0 };
    const data = await res.json();
    return { views: data.count ?? 0, uniques: data.uniques ?? 0 };
  } catch {
    return { views: 0, uniques: 0 };
  }
}

/**
 * List a repository's files, recursively.
 *
 * @param {string} name
 * @param {string} branch
 * @returns {Promise<string[]>}
 */
async function fetchTree(name, branch) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${name}/git/trees/${branch}?recursive=1`,
      { headers },
    );
    if (!res.ok) {
      assertNotRateLimited(res, `the file tree of ${name}`);
      return [];
    }
    const data = await res.json();
    return (data.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    return [];
  }
}

/**
 * Decide whether a repository is empty.
 *
 * "Empty" means it carries nothing a reader could use: no code file, no
 * README beyond a stub, and no discussion. A repository that is only
 * images and a README still documents something, so it stays in the
 * catalogue. A repository whose only content is an issue thread - an RFC
 * discussion, for instance - carries real content too, so issue bodies
 * count.
 *
 * @param {string[]} paths
 * @param {number} readmeSize
 * @param {number} discussionLength
 * @returns {boolean}
 */
function isEmpty(paths, readmeSize, discussionLength, rules) {
  const META = new Set(['.gitignore', '.gitattributes', '.gitmodules', 'LICENSE', 'NOTICE']);
  const DOC_EXT = /\.(md|txt|rst|adoc)$/i;
  const IMG_EXT = /\.(png|jpe?g|gif|svg|ico|webp|pdf|mp4)$/i;

  const code = paths.filter((p) => {
    const base = p.split('/').pop();
    if (META.has(base) || base.startsWith('.git')) return false;
    if (DOC_EXT.test(base) || IMG_EXT.test(base)) return false;
    return true;
  });

  // The thresholds are policy, so they live in site.config.json.
  const stubReadme = readmeSize > 0 && readmeSize < rules.empty.stubReadmeBytes;
  const hasDiscussion = discussionLength >= rules.empty.discussionBytes;

  return code.length === 0 && (readmeSize === 0 || stubReadme) && !hasDiscussion;
}

/**
 * Decide whether a repository is too small and too unused to be listed.
 *
 * "Unnoticed" means three measured facts at once:
 *   - no stars
 *   - no views in the traffic window
 *   - ten files or fewer
 *
 * The third condition is what makes the rule safe. A repository with
 * 100 files and no stars is a project nobody adopted yet, which is a
 * different thing from a repository with three files and no stars,
 * which is a sketch.
 *
 * @param {object} repo
 * @returns {boolean}
 */
function isUnnoticed(repo, rules) {
  return (
    repo.stars <= rules.unnoticed.maxStars &&
    repo.views <= rules.unnoticed.maxViews &&
    repo.fileCount <= rules.unnoticed.maxFiles
  );
}

/**
 * Name the rule that keeps a repository out of the catalogue, before any
 * per-repository data is fetched.
 *
 * The allowlist is checked before everything else: a repository outside it is
 * never fetched, never counted, and never mistaken for something the content
 * rules dropped. That distinction matters when testing against an account that
 * already holds dozens of repositories.
 *
 * @param {object} repo Raw API record.
 * @param {Set<string>|null} allowed Allowlist, or null when everything is allowed.
 * @param {Set<string>} excluded Names the config excludes by hand.
 * @returns {string|null} A rule name, or null when the repository belongs.
 */
function exclusionRule(repo, allowed, excluded) {
  if (repo.visibility !== 'public') return 'private';
  if (excluded.has(repo.name)) return 'excluded';
  if (allowed && !allowed.has(repo.name)) return 'not-included';
  if (!RULES.includeForks && repo.fork === true) return 'fork';
  if (!RULES.includeArchived && repo.archived === true) return 'archived';
  return null;
}

async function main() {
  const drv = process.argv.includes('--dry-run');
  const asJson = process.argv.includes('--json');

  const repos = await fetchAllRepos();

  const allowed = RULES.include.length > 0 ? new Set(RULES.include) : null;
  const excludedNames = new Set(RULES.exclude);

  /** Every repository left out, with the rule that left it out. */
  const exclusions = [];
  const candidates = [];

  for (const repo of repos) {
    const rule = exclusionRule(repo, allowed, excludedNames);
    if (rule) {
      exclusions.push({
        name: repo.name,
        rule,
        measured: {
          visibility: repo.visibility,
          fork: repo.fork === true,
          archived: repo.archived === true,
        },
      });
    } else {
      candidates.push(repo);
    }
  }

  const enriched = [];
  const skipped = [];
  const unnoticed = [];

  for (const repo of candidates) {
    const branch = repo.default_branch ?? 'main';

    const readmeRes = await fetch(`https://api.github.com/repos/${OWNER}/${repo.name}/readme`, {
      headers,
    });
    let readmeSize = 0;
    if (readmeRes.ok) {
      const readme = await readmeRes.json();
      readmeSize = readme.size ?? 0;
    } else {
      assertNotRateLimited(readmeRes, `the README of ${repo.name}`);
    }

    const paths = await fetchTree(repo.name, branch);
    const traffic = await fetchTraffic(repo.name);

    // Issue bodies count as content: an RFC repository carries its
    // proposals in issues, not in files.
    let discussionLength = 0;
    try {
      const issueRes = await fetch(
        `https://api.github.com/repos/${OWNER}/${repo.name}/issues?state=all&per_page=100`,
        { headers },
      );
      if (issueRes.ok) {
        const issues = await issueRes.json();
        discussionLength = issues.reduce(
          (sum, issue) => sum + (issue.body ?? '').length + issue.title.length,
          0,
        );
      } else {
        assertNotRateLimited(issueRes, `the issues of ${repo.name}`);
      }
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      discussionLength = 0;
    }

    const record = {
      name: repo.name,
      description: repo.description ?? '',
      language: repo.language ?? 'Other',
      stars: repo.stargazers_count ?? 0,
      forks: repo.forks_count ?? 0,
      topics: repo.topics ?? [],
      // The three controlled-vocabulary axes, read from the GitHub topics
      // that scripts/apply-topics.py writes. GitHub rejects a colon in a
      // topic name, so the separator is a hyphen.
      purpose: (repo.topics ?? []).find((t) => t.startsWith('purpose-'))?.slice(8) ?? '',
      platform: (repo.topics ?? []).find((t) => t.startsWith('platform-'))?.slice(9) ?? '',
      languageTag: (repo.topics ?? []).find((t) => t.startsWith('language-'))?.slice(9) ?? '',
      url: repo.html_url,
      homepage: repo.homepage ?? '',
      updatedAt: repo.updated_at,
      createdAt: repo.created_at,
      archived: repo.archived === true,
      domain: classify(repo),
      views: traffic.views,
      uniques: traffic.uniques,
      hasReadme: readmeSize > 0,
      readmeSize,
      fileCount: paths.length,
      empty: isEmpty(paths, readmeSize, discussionLength, RULES),
    };

    if (record.empty) {
      skipped.push(record);
      exclusions.push({
        name: repo.name,
        rule: 'empty',
        measured: { fileCount: paths.length, readmeSize, discussionLength },
      });
    } else if (isUnnoticed(record, RULES)) {
      unnoticed.push(record);
      exclusions.push({
        name: repo.name,
        rule: 'unnoticed',
        measured: { stars: record.stars, views: record.views, fileCount: record.fileCount },
      });
    } else {
      enriched.push(record);
    }
  }

  exclusions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Most recent first. The catalogue reads as a production log, so the
  // newest work leads.
  enriched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const payload = {
    owner: OWNER,
    // Stamped so the page can state when the catalogue was last refreshed.
    fetchedAt: new Date().toISOString(),
    domains: DOMAIN_ORDER.map((id) => ({ id, label: DOMAIN_LABEL[id] })),
    repos: enriched,
    // Kept for the report, not rendered on the page.
    skipped: skipped.map((r) => ({ name: r.name, fileCount: r.fileCount, readmeSize: r.readmeSize })),
    unnoticed: unnoticed.map((r) => ({
      name: r.name,
      fileCount: r.fileCount,
      stars: r.stars,
      views: r.views,
      language: r.language,
      createdAt: r.createdAt,
    })),
  };

  if (!drv) {
    await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await mkdir(dirname(EXCLUDED_OUT), { recursive: true });
    await writeFile(EXCLUDED_OUT, `${JSON.stringify(exclusions, null, 2)}\n`, 'utf8');
  }

  const counts = {
    owned: repos.length,
    candidates: candidates.length,
    kept: enriched.length,
    empty: skipped.length,
    unnoticed: unnoticed.length,
    excluded: exclusions.length,
  };

  if (asJson) {
    console.log(JSON.stringify({ counts, excluded: exclusions }, null, 2));
    return;
  }

  console.log(`Wrote ${enriched.length} applications to ${OUT}${drv ? ' (dry run)' : ''}`);
  console.log(`Fetched ${repos.length} owned repositories; ${candidates.length} public and not forked.`);
  console.log(`Removed ${skipped.length} empty repositories: ${skipped.map((r) => r.name).join(', ')}`);
  console.log(
    `Removed ${unnoticed.length} unnoticed repositories: ${unnoticed.map((r) => r.name).join(', ')}`,
  );
}

main().catch((err) => {
  if (err instanceof RateLimitError) {
    // Expected condition with a known fix, so it gets a message and not a
    // stack trace that buries the instruction.
    console.error(`\n✗ ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
