#!/usr/bin/env node
/**
 * Provision Cloudflare for this site: the scoped token, the Pages project,
 * and every hostname listed in `site.config.json`.
 *
 * Run once per site, and again after changing the config. It is idempotent:
 * a project that exists, a token that already publishes, a hostname already
 * attached and a DNS record already pointing at Pages are all left alone.
 *
 * The admin token is used for exactly one thing — minting tokens. It is not
 * asked to touch Pages or DNS. Zone and DNS work runs through short-lived
 * tokens that are deleted in `finally`, so the standing deploy token stays
 * scoped to `Pages Write` and a leaked CI credential still cannot edit DNS.
 *
 *   node scripts/cf-setup.mjs                    # provision or verify
 *   node scripts/cf-setup.mjs --force            # rotate the deploy token
 *   node scripts/cf-setup.mjs --dry-run          # report, write nothing
 *   node scripts/cf-setup.mjs --overwrite-dns    # replace a conflicting record
 *
 * Environment:
 *   CLOUDFLARE_ADMIN_API_TOKEN  required — `Account API Tokens: Write`
 *   CLOUDFLARE_ACCOUNT_ID       optional — picks an account when the token
 *                               reaches more than one
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  CloudflareError,
  addProjectDomain,
  createDnsRecord,
  createToken,
  deleteDnsRecord,
  deleteToken,
  ensureProject,
  findPermissionGroup,
  findToken,
  listDnsRecords,
  listProjectDomains,
  listProjects,
  listZones,
  resolveAccount,
  updateDnsRecord,
  verifyToken,
  withTemporaryToken,
} from './lib/cloudflare.mjs';
import { mask, readEnv, setEnvKey } from './lib/env.mjs';

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, '.env');
const CONFIG_PATH = path.join(ROOT, 'site.config.json');
const WRANGLER_PATH = path.join(ROOT, 'wrangler.toml');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const DRY_RUN = argv.includes('--dry-run');
const NO_MINT = argv.includes('--no-mint');
const OVERWRITE_DNS = argv.includes('--overwrite-dns');

/** Log one step, so a failure is attributable to a specific call. */
function step(message) {
  console.log(`\n▸ ${message}`);
}

/** Log a completed action. */
function ok(message) {
  console.log(`  ✓ ${message}`);
}

/** Log information that is not an action. */
function note(message) {
  console.log(`  · ${message}`);
}

/** Log a problem that the run continues past. */
function warn(message) {
  console.log(`  ! ${message}`);
}

/**
 * Read and validate `site.config.json`.
 *
 * Validated by hand rather than with a schema library: a wrong value here
 * provisions infrastructure under the wrong name.
 *
 * @returns {Promise<object>}
 */
async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`site.config.json not found at ${CONFIG_PATH}.`);
  }

  const site = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

  for (const key of ['projectName', 'productionBranch', 'buildOutputDir']) {
    if (typeof site[key] !== 'string' || site[key].trim() === '') {
      throw new Error(`site.config.json: "${key}" must be a non-empty string.`);
    }
  }

  // A Pages project name is also its *.pages.dev subdomain, so Cloudflare
  // accepts only lowercase letters, digits and hyphens.
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(site.projectName)) {
    throw new Error(
      `site.config.json: "projectName" must be lowercase letters, digits and hyphens (got "${site.projectName}").`,
    );
  }

  site.customDomains = normalizeDomains(site.customDomains);
  site.tokenExpiryDays ??= 365;
  site.deployTokenName ??= `${site.projectName}-pages-deploy`;

  return site;
}

/**
 * Normalise and validate the configured hostnames.
 *
 * Case and a trailing dot are both accepted from a human and removed,
 * because `WWW.Example.com.` and `www.example.com` are the same DNS name and
 * treating them as two would create two records. Duplicates are rejected
 * rather than deduplicated: a repeated hostname in the config is a typo, and
 * silently fixing it hides the mistake.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeDomains(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('site.config.json: "customDomains" must be an array of hostnames.');
  }

  const hostname = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
  const normalized = [];
  const seen = new Map();

  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new Error(`site.config.json: customDomains contains a non-string: ${JSON.stringify(raw)}`);
    }

    const name = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!hostname.test(name)) {
      throw new Error(`site.config.json: "${raw}" is not a valid hostname.`);
    }
    if (name.endsWith('.pages.dev')) {
      throw new Error(
        `site.config.json: "${name}" is already a pages.dev name and cannot be a custom domain.`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `site.config.json: "${name}" is listed twice (also as "${seen.get(name)}"). Remove one.`,
      );
    }

    seen.set(name, raw);
    normalized.push(name);
  }

  return normalized;
}

/**
 * Fail when `wrangler.toml` disagrees with `site.config.json`.
 *
 * Two files describing one project is the shape that drifts. Rather than
 * parse TOML, this reads the single key it cares about and refuses to guess.
 *
 * @param {object} site
 */
async function checkWranglerAgrees(site) {
  if (!existsSync(WRANGLER_PATH)) {
    note('wrangler.toml absent — deploy passes every value on the command line.');
    return;
  }

  const toml = await readFile(WRANGLER_PATH, 'utf8');
  const match = /^\s*name\s*=\s*"([^"]*)"/m.exec(toml);

  if (!match) {
    throw new Error(
      'wrangler.toml has no top-level `name`. Add one matching site.config.json, ' +
        'or delete the file if deploy supplies every value itself.',
    );
  }

  if (match[1] !== site.projectName) {
    throw new Error(
      `wrangler.toml says name = "${match[1]}" but site.config.json says "${site.projectName}". ` +
        'Two names for one project will deploy to different places. Make them match.',
    );
  }

  ok(`wrangler.toml agrees: name = "${site.projectName}"`);
}

/**
 * Build the deploy token policies: `Pages Write` and nothing else.
 *
 * DNS is deliberately absent. Custom domains are provisioned with short-lived
 * tokens, so the credential that CI holds cannot edit DNS even though it can
 * configure the site's hostnames.
 *
 * @param {string} adminToken
 * @param {string} accountId
 * @returns {Promise<{policies: object[], granted: string[]}>}
 */
async function buildPolicies(adminToken, accountId) {
  const pages = await findPermissionGroup(adminToken, accountId, 'Pages Write');

  return {
    policies: [
      {
        effect: 'allow',
        resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
        permission_groups: [{ id: pages.id }],
      },
    ],
    granted: [`${pages.name} (account ${accountId})`],
  };
}

/**
 * Confirm a token can actually reach the Pages API.
 *
 * A freshly minted token is not instantly consistent, so a first failure is
 * retried. The last error is returned rather than discarded: a policy that
 * grants nothing and a bug in the request both look like "false" otherwise.
 *
 * @param {string} token
 * @param {string} accountId
 * @param {number} [attempts]
 * @returns {Promise<{ok: boolean, error?: Error}>}
 */
async function canPublish(token, accountId, attempts = 5) {
  let lastError;

  for (let i = 0; i < attempts; i += 1) {
    try {
      await listProjects(token, accountId);
      return { ok: true };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Mint a deploy token, revoking any previous token of the same name first.
 *
 * The revoke is unconditional. One site owns one deploy credential; a second
 * token with the same name is a credential nobody can identify and nobody
 * dares delete.
 *
 * @param {string} adminToken
 * @param {string} accountId
 * @param {object} site
 * @param {object[]} policies
 * @returns {Promise<{id: string, value: string}>}
 */
async function mintDeployToken(adminToken, accountId, site, policies) {
  // Cloudflare rejects a fractional-second timestamp: it wants
  // "2005-12-30T01:02:03Z", and `toISOString()` emits milliseconds.
  const expiresOn =
    site.tokenExpiryDays > 0
      ? new Date(Date.now() + site.tokenExpiryDays * 86_400_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z')
      : null;

  const stale = await findToken(adminToken, accountId, site.deployTokenName);
  if (stale) {
    await deleteToken(adminToken, accountId, stale.id);
    ok(`revoked the previous "${site.deployTokenName}" (${stale.id})`);
  }

  const created = await createToken(adminToken, accountId, {
    name: site.deployTokenName,
    policies,
    expiresOn,
  });

  ok(`minted "${site.deployTokenName}" (${created.id})`);
  ok(expiresOn ? `expires ${expiresOn.slice(0, 10)}` : 'no expiry');

  return created;
}

/**
 * Map each configured hostname to the Cloudflare zone that owns it.
 *
 * The zone ids are needed before a DNS-scoped token can be minted, and only
 * a token holding `Zone Read` can discover them. That lookup happens in a
 * short-lived token so the admin token does not need zone access of its own.
 *
 * @param {string} adminToken
 * @param {string} accountId
 * @param {string[]} hostnames
 * @returns {Promise<{hostname: string, zoneId: string, zoneName: string}[]>}
 */
async function resolveHostnames(adminToken, accountId, hostnames) {
  if (hostnames.length === 0) return [];

  const zones = await withTemporaryToken(
    adminToken,
    accountId,
    {
      name: `zone-lookup-${Date.now()}`,
      permissionGroupNames: ['Zone Read'],
      resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
      expiresInMinutes: 10,
    },
    (token) => listZones(token),
  );

  return hostnames.map((hostname) => {
    // Longest suffix wins, so a zone `example.co.uk` beats a zone `co.uk`.
    const matches = zones
      .filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`))
      .sort((a, b) => b.name.length - a.name.length);

    if (matches.length === 0) {
      throw new Error(
        `"${hostname}" does not belong to any zone in this Cloudflare account. ` +
          `Available zones: ${zones.map((z) => z.name).join(', ') || 'none'}. ` +
          'Add the domain to Cloudflare, or remove it from customDomains.',
      );
    }

    return { hostname, zoneId: matches[0].id, zoneName: matches[0].name };
  });
}

/**
 * Attach every hostname to the Pages project.
 *
 * Idempotent: a hostname already attached is reported and skipped. Attaching
 * a hostname does not create its DNS record — that is a separate step, and
 * measured behaviour, not an assumption.
 *
 * @param {string} deployToken
 * @param {string} accountId
 * @param {object} site
 * @returns {Promise<boolean>} Whether the run needs a non-zero exit.
 */
async function attachHostnames(deployToken, accountId, site) {
  if (site.customDomains.length === 0) {
    note('no custom domains configured');
    return false;
  }

  const attached = new Set(
    (await listProjectDomains(deployToken, accountId, site.projectName)).map((d) => d.name),
  );

  let failed = false;

  for (const hostname of site.customDomains) {
    if (DRY_RUN) {
      note(attached.has(hostname) ? `${hostname}: already attached` : `${hostname}: would attach`);
      continue;
    }

    if (attached.has(hostname)) {
      ok(`${hostname} already attached`);
      continue;
    }

    try {
      await addProjectDomain(deployToken, accountId, site.projectName, hostname);
      ok(`${hostname} attached`);
    } catch (err) {
      warn(`${hostname} could not be attached — ${err.message}`);
      failed = true;
    }
  }

  return failed;
}

/**
 * Point every hostname at this Pages project.
 *
 * Records are created as proxied CNAMEs to `<project>.pages.dev`. A proxied
 * CNAME is allowed at a zone apex even when TXT records already exist there,
 * which is measured, not assumed — a plain CNAME at an apex that holds SPF or
 * DMARC would be invalid.
 *
 * Existing A, AAAA or CNAME records at the same name are a conflict: they
 * point at something else, and replacing them silently would take a live
 * service off the internet. They are only replaced with `--overwrite-dns`.
 * TXT, MX and other types are never touched.
 *
 * @param {string} adminToken
 * @param {string} accountId
 * @param {object} site
 * @param {{hostname: string, zoneId: string}[]} mappings
 * @returns {Promise<boolean>} Whether the run needs a non-zero exit.
 */
async function reconcileDns(adminToken, accountId, site, mappings) {
  if (mappings.length === 0) return false;

  const target = `${site.projectName}.pages.dev`;
  const resources = {};
  for (const map of mappings) {
    resources[`com.cloudflare.api.account.zone.${map.zoneId}`] = '*';
  }

  return withTemporaryToken(
    adminToken,
    accountId,
    {
      name: `dns-setup-${Date.now()}`,
      permissionGroupNames: ['DNS Read', 'DNS Write'],
      resources,
      expiresInMinutes: 20,
    },
    async (token) => {
      let failed = false;

      for (const { hostname, zoneId } of mappings) {
        const records = await listDnsRecords(token, zoneId, hostname);
        const cname = records.find((r) => r.type === 'CNAME');
        const pointsHere = cname && cname.content === target;

        if (pointsHere) {
          if (cname.proxied) {
            ok(`${hostname} → ${target} (proxied)`);
            continue;
          }
          if (DRY_RUN) {
            note(`${hostname}: would enable the proxy`);
            continue;
          }
          await updateDnsRecord(token, zoneId, cname.id, { proxied: true });
          ok(`${hostname} → proxy enabled`);
          continue;
        }

        const blockers = records.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));

        if (blockers.length > 0 && !OVERWRITE_DNS) {
          const current = blockers.map((r) => `${r.type} ${r.content}`).join(', ');
          warn(`${hostname} points elsewhere (${current})`);
          note(`pass --overwrite-dns to point it at ${target}`);
          failed = true;
          continue;
        }

        if (DRY_RUN) {
          note(`${hostname}: would create CNAME → ${target}`);
          if (blockers.length > 0) note(`${hostname}: would delete ${blockers.length} record(s)`);
          continue;
        }

        for (const blocker of blockers) {
          await deleteDnsRecord(token, zoneId, blocker.id);
          note(`${hostname}: removed ${blocker.type} ${blocker.content}`);
        }

        await createDnsRecord(token, zoneId, {
          type: 'CNAME',
          name: hostname,
          content: target,
          proxied: true,
          ttl: 1,
        });
        ok(`${hostname} → ${target} (proxied)`);
      }

      return failed;
    },
  );
}

/**
 * Fetch every hostname and report what it actually serves.
 *
 * Provisioning can report success while the site is unreachable: a
 * certificate may still be issuing, or — measured — a legacy forwarding Page
 * Rule can answer before Pages ever sees the request, and Page Rules are
 * invisible to an account-owned token, so no API call in this script can
 * detect one. Only fetching the hostname finds it.
 *
 * A connection failure is reported as "not serving yet" and does not fail the
 * run, because a new hostname legitimately needs time. A redirect to another
 * host, or an HTTP error, is a real problem and does fail it.
 *
 * @param {string[]} hostnames
 * @returns {Promise<boolean>} Whether the run needs a non-zero exit.
 */
async function verifyHostnames(hostnames) {
  if (hostnames.length === 0) return false;

  let failed = false;

  for (const hostname of hostnames) {
    let response;
    try {
      response = await fetch(`https://${hostname}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: { 'cache-control': 'no-cache' },
      });
    } catch (err) {
      // `fetch` wraps the socket error in `cause`; the code is what
      // distinguishes a stale local resolver (ENOTFOUND) from a real outage.
      const code = err.cause?.code ?? err.code ?? err.name;
      note(`${hostname}: could not connect (${code})`);
      if (code === 'ENOTFOUND') {
        note('local DNS may not have the new record yet; the site can still be live');
      }
      continue;
    }

    if (response.status === 200) {
      const body = await response.text();
      const cards = (body.match(/class="card"/g) ?? []).length;
      ok(`${hostname}: 200, ${cards} cards`);
      continue;
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      warn(`${hostname}: redirects to ${location}`);
      note('a redirect rule or Page Rule on the zone is answering before Pages');
      note('Page Rules are invisible to account-owned tokens — check Rules → Page Rules');
      failed = true;
      continue;
    }

    warn(`${hostname}: HTTP ${response.status}`);
    failed = true;
  }

  return failed;
}

/**
 * Provision with a token the user created in the dashboard.
 *
 * This path exists because minting needs `Account API Tokens: Write`, which is
 * a privileged credential most people have never created, and its only job is
 * to save one click. A token with `Cloudflare Pages: Edit` can create the
 * project and attach hostnames by itself.
 *
 * It cannot edit DNS. Zone and DNS permissions have to be scoped to exact zone
 * ids, and discovering those ids needs a token the admin flow mints. So this
 * path prints the records to create rather than guessing, which is honest and
 * takes about a minute by hand.
 *
 * @param {object} site
 * @param {string|null} token
 * @param {Record<string,string>} fileEnv
 */
async function runWithPastedToken(site, token, fileEnv) {
  if (!token) {
    throw new Error(
      'No credential found. Either paste a token with `Cloudflare Pages: Edit` as ' +
        'CLOUDFLARE_API_TOKEN in .env, or add `cloudflare_admin_api_token` so this ' +
        'script can mint one.',
    );
  }
  ok(`pasted token ${mask(token)}`);

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? fileEnv.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID is required with a pasted token. It is the 32-character ' +
        'id in the dashboard URL: dash.cloudflare.com/<account-id>',
    );
  }
  ok(`account ${accountId}`);

  if (DRY_RUN) {
    const probe = await canPublish(token, accountId);
    note(probe.ok ? 'token can publish' : `token cannot publish: ${probe.error?.message}`);
    note('dry run: no project was created and no hostname was attached');
    return;
  }

  step('Checking the token can publish');
  const probe = await canPublish(token, accountId);
  if (!probe.ok) {
    throw new Error(
      `The pasted token cannot reach the Pages API: ${probe.error?.message ?? 'unknown'}\n` +
        '  It needs `Cloudflare Pages: Edit` on this account.',
    );
  }
  ok('can list Pages projects');

  step('Ensuring the Pages project');
  const { created, project } = await ensureProject(
    token,
    accountId,
    site.projectName,
    site.productionBranch,
  );
  ok(created ? `created ${project.name}` : `exists: ${project.subdomain}`);

  step('Attaching custom domains');
  let failed = await attachHostnames(token, accountId, site);

  if (site.customDomains.length > 0) {
    step('DNS');
    note('A pasted token cannot edit DNS, so no records were changed.');
    note(`Point each hostname at ${site.projectName}.pages.dev with a proxied CNAME:`);
    for (const hostname of site.customDomains) {
      note(`  ${hostname}  →  CNAME  ${site.projectName}.pages.dev  (proxied)`);
    }
    note('Or add `cloudflare_admin_api_token` and re-run without --no-mint.');
  }

  step('Verifying hostnames');
  failed = (await verifyHostnames(site.customDomains)) || failed;

  printSummary(site, { id: accountId, name: 'from CLOUDFLARE_ACCOUNT_ID' }, null);

  if (failed) {
    console.log('\nSome hostnames are not serving yet. Anything above that names a DNS');
    console.log('record or a Page Rule needs a manual change in the dashboard.');
    process.exitCode = 1;
  }
}

async function main() {
  console.log('Cloudflare setup');

  const site = await loadConfig();
  note(`project   ${site.projectName}`);
  note(`branch    ${site.productionBranch}`);
  note(`output    ${site.buildOutputDir}`);
  note(`domains   ${site.customDomains.length ? site.customDomains.join(', ') : 'none (*.pages.dev)'}`);

  step('Checking wrangler.toml');
  await checkWranglerAgrees(site);

  step('Reading credentials');
  const fileEnv = await readEnv(ENV_PATH);
  const adminToken =
    process.env.CLOUDFLARE_ADMIN_API_TOKEN ??
    process.env.cloudflare_admin_api_token ??
    fileEnv.CLOUDFLARE_ADMIN_API_TOKEN ??
    fileEnv.cloudflare_admin_api_token;
  const pastedToken =
    process.env.CLOUDFLARE_API_TOKEN ?? fileEnv.CLOUDFLARE_API_TOKEN ?? null;

  // Two ways in. Minting needs an admin token and produces a narrower one;
  // pasting a Pages token needs one permission and nothing else. The pasted
  // path is the shorter one, so it is chosen whenever the admin token is
  // absent or `--no-mint` asks for it.
  if (NO_MINT || !adminToken) {
    await runWithPastedToken(site, pastedToken, fileEnv);
    return;
  }

  ok(`admin token ${mask(adminToken)}`);

  const identity = await verifyToken(adminToken);
  ok(`${identity.kind}-owned token, active`);

  step('Resolving the account');
  const account = await resolveAccount(adminToken, process.env.CLOUDFLARE_ACCOUNT_ID);
  ok(`${account.name} (${account.id})`);

  step('Resolving permissions');
  const { policies, granted } = await buildPolicies(adminToken, account.id);
  for (const name of granted) ok(name);
  if (site.customDomains.length > 0) {
    note('DNS is provisioned with short-lived tokens; the deploy token stays Pages-only');
  }

  // Reuse a working token rather than minting a second one on every run.
  step('Finding a usable deploy token');
  const existingToken = process.env.CLOUDFLARE_API_TOKEN ?? fileEnv.CLOUDFLARE_API_TOKEN;
  let deployToken = null;
  let createdTokenId = null;

  if (existingToken && !FORCE) {
    const probe = await canPublish(existingToken, account.id);
    if (probe.ok) {
      ok(`CLOUDFLARE_API_TOKEN in .env already publishes ${mask(existingToken)}`);
      note('pass --force to rotate it');
      deployToken = existingToken;
    } else {
      note(`the token in .env cannot publish (${probe.error?.message ?? 'unknown'})`);
      note('it will be replaced');
    }
  }

  if (DRY_RUN) {
    if (!deployToken) note('would mint a scoped token and write CLOUDFLARE_API_TOKEN to .env');
    note('a dry run creates nothing; Pages and DNS state is reported only');
    const mappings = site.customDomains.length
      ? await resolveHostnames(adminToken, account.id, site.customDomains)
      : [];
    for (const m of mappings) note(`${m.hostname} belongs to zone ${m.zoneName} (${m.zoneId})`);
    if (mappings.length) await reconcileDns(adminToken, account.id, site, mappings);
    printSummary(site, account, null);
    return;
  }

  if (!deployToken) {
    step('Minting the scoped deploy token');
    const created = await mintDeployToken(adminToken, account.id, site, policies);

    step('Verifying the new token');
    const probe = await canPublish(created.value, account.id);
    if (!probe.ok) {
      throw new Error(
        `The new token cannot reach the Pages API: ${probe.error?.message ?? 'unknown error'}\n` +
          `  It was created (${created.id}); delete it at ` +
          'https://dash.cloudflare.com/profile/api-tokens and re-run.',
      );
    }
    ok('can list Pages projects');

    step('Writing .env');
    await setEnvKey(ENV_PATH, 'CLOUDFLARE_API_TOKEN', created.value);
    ok(`CLOUDFLARE_API_TOKEN=${mask(created.value)} → .env (mode 0600)`);

    deployToken = created.value;
    createdTokenId = created.id;
  }

  if (process.env.CLOUDFLARE_ACCOUNT_ID === undefined) {
    const wrote = await setEnvKey(ENV_PATH, 'CLOUDFLARE_ACCOUNT_ID', account.id);
    if (wrote.changed) ok(`CLOUDFLARE_ACCOUNT_ID=${account.id} → .env`);
  }

  // The project is created with the deploy token, not the admin token: the
  // admin token carries no Pages permission by design, and this doubles as
  // proof that the credential a publish will use is the one that works.
  step('Ensuring the Pages project');
  const { created: projectCreated, project } = await ensureProject(
    deployToken,
    account.id,
    site.projectName,
    site.productionBranch,
  );
  ok(projectCreated ? `created ${project.name}` : `exists: ${project.subdomain}`);

  let failed = false;

  step('Attaching custom domains');
  failed = (await attachHostnames(deployToken, account.id, site)) || failed;

  if (site.customDomains.length > 0) {
    step('Pointing DNS at Pages');
    const mappings = await resolveHostnames(adminToken, account.id, site.customDomains);
    for (const m of mappings) note(`${m.hostname} → zone ${m.zoneName}`);
    failed = (await reconcileDns(adminToken, account.id, site, mappings)) || failed;

    step('Verifying hostnames');
    failed = (await verifyHostnames(site.customDomains)) || failed;
  }

  printSummary(site, account, createdTokenId ? { id: createdTokenId } : null);

  if (failed) {
    console.log('\nSome hostnames are not serving yet. Where the note above points at a');
    console.log('Page Rule or a redirect rule, that needs a manual change in the Cloudflare');
    console.log('dashboard — it is outside what a token from this account can reach.');
    console.log('Re-run `npm run cf:setup` afterwards to confirm.');
    process.exitCode = 1;
  }
}

/**
 * Print what was provisioned and what to do next.
 *
 * @param {object} site
 * @param {{id: string, name: string}} account
 * @param {{id: string}|null} created
 */
function printSummary(site, account, created) {
  console.log('\n──────────────────────────────────────────────');
  console.log(`Pages URL    https://${site.projectName}.pages.dev`);
  for (const domain of site.customDomains) console.log(`Custom       https://${domain}`);
  console.log(`Account      ${account.name}`);
  console.log(`Dashboard    https://dash.cloudflare.com/${account.id}/pages/view/${site.projectName}`);
  if (created) console.log(`Token id     ${created.id}`);

  console.log('\nNext:');
  console.log('  npm run deploy               publish from this machine');
  console.log('  npm run cf:setup             re-verify at any time');
  console.log('  npm run cf:setup -- --force  rotate the deploy token');
  console.log('\nA new custom domain needs a certificate before it serves HTTPS.');
  console.log('Cloudflare issues it automatically; that can take a few minutes.');
  console.log('\nThe admin token is not needed for publishing.');
  console.log('Remove `cloudflare_admin_api_token` from .env once CI holds the token.');
  console.log('\nFor GitHub Actions, add these repository secrets:');
  console.log('  CLOUDFLARE_API_TOKEN   the value of CLOUDFLARE_API_TOKEN in .env');
  console.log(`  CLOUDFLARE_ACCOUNT_ID  ${account.id}`);
}

main().catch((err) => {
  const isCf = err instanceof CloudflareError;
  console.error(`\n✗ ${isCf ? 'Cloudflare API' : 'setup'} failed`);
  console.error(`  ${err.message}`);
  if (isCf && err.errors?.length) {
    for (const e of err.errors) console.error(`  [${e.code}] ${e.message}`);
  }
  process.exitCode = 1;
});
