/**
 * Minimal Cloudflare API v4 client for provisioning a Pages project and the
 * scoped token that publishes it.
 *
 * No dependencies: Node's global fetch is enough, and every call here is a
 * one-shot provisioning step rather than a hot path.
 *
 * Why a hand-written client instead of the SDK: the official SDK pulls a
 * large tree for four endpoints, and provisioning must work on a fresh clone
 * before `npm install` has necessarily run.
 */

const API = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  /**
   * @param {string} message Human-readable summary.
   * @param {{status?: number, errors?: unknown[], path?: string}} [meta]
   *   Wire detail kept for the caller to print; never contains a token.
   */
  constructor(message, { status, errors, path } = {}) {
    super(message);
    this.name = 'CloudflareError';
    this.status = status;
    this.errors = errors;
    this.path = path;
  }
}

/**
 * Call the Cloudflare API and return `result`.
 *
 * Cloudflare signals failure two ways: an HTTP 4xx/5xx, and a 200 carrying
 * `success: false`. Both are treated as errors, because a caller that only
 * checks the status code will silently accept the second.
 *
 * @param {string} token Bearer token. Never logged, never included in errors.
 * @param {string} path Path below `/client/v4`, e.g. `/accounts`.
 * @param {{method?: string, body?: unknown, raw?: boolean}} [options]
 *   `raw` returns the whole envelope instead of just `result`, which is what
 *   a paginated caller needs to read `result_info.total_pages`.
 * @returns {Promise<any>}
 */
export async function api(token, path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new CloudflareError(
      `Cloudflare returned a non-JSON response for ${method} ${path} (HTTP ${res.status}).`,
      { status: res.status, path },
    );
  }

  if (!res.ok || payload.success === false) {
    const errors = payload.errors ?? [];
    const detail = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || 'no detail';
    throw new CloudflareError(
      `Cloudflare rejected ${method} ${path} (HTTP ${res.status}) — ${detail}`,
      { status: res.status, errors, path },
    );
  }

  return raw ? payload : payload.result;
}

/**
 * Confirm a token is live and learn which kind it is.
 *
 * Account-owned and user-owned tokens are verified at different endpoints.
 * A token that is account-owned returns 1000 "Invalid API Token" from the
 * user endpoint even when it is perfectly valid, so trying both is the only
 * reliable check.
 *
 * @param {string} token
 * @returns {Promise<{kind: 'account'|'user', id: string}>}
 */
export async function verifyToken(token) {
  try {
    const r = await api(token, '/user/tokens/verify');
    return { kind: 'user', id: r.id };
  } catch {
    // Fall through: the token is probably account-owned.
  }

  const accounts = await api(token, '/accounts');
  for (const account of accounts) {
    try {
      const r = await api(token, `/accounts/${account.id}/tokens/verify`);
      return { kind: 'account', id: r.id, accountId: account.id };
    } catch {
      // Try the next account.
    }
  }

  throw new CloudflareError(
    'The token is not valid. It could not verify as a user token or an account token.',
  );
}

/**
 * Resolve the account to operate on.
 *
 * An explicit `CLOUDFLARE_ACCOUNT_ID` always wins. Otherwise the token must
 * reach exactly one account; with several, guessing would provision into the
 * wrong one, so the caller has to choose.
 *
 * @param {string} token
 * @param {string} [override]
 * @returns {Promise<{id: string, name: string}>}
 */
export async function resolveAccount(token, override) {
  const accounts = await api(token, '/accounts');

  if (accounts.length === 0) {
    throw new CloudflareError(
      'The token cannot see any account. A Pages deploy token needs at least `Pages Write` on one.',
    );
  }

  if (override) {
    const match = accounts.find((a) => a.id === override);
    if (!match) {
      throw new CloudflareError(
        `CLOUDFLARE_ACCOUNT_ID is set to ${override}, but the token cannot see that account. Visible: ${accounts
          .map((a) => `${a.name} (${a.id})`)
          .join(', ')}`,
      );
    }
    return { id: match.id, name: match.name };
  }

  if (accounts.length > 1) {
    throw new CloudflareError(
      `The token can reach ${accounts.length} accounts. Set CLOUDFLARE_ACCOUNT_ID to pick one:\n` +
        accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n'),
    );
  }

  return { id: accounts[0].id, name: accounts[0].name };
}

/**
 * Look up a permission group id by its Cloudflare display name.
 *
 * Names are resolved at runtime rather than hardcoded, because an id copied
 * into source is unreadable in review and silently wrong if it is ever
 * mistyped. `CLOUDFLARE_PG_<NAME>` overrides the lookup for the rare case
 * where Cloudflare renames a group.
 *
 * @param {string} token
 * @param {string} accountId
 * @param {string} name e.g. `Pages Write`
 * @returns {Promise<{id: string, name: string}>}
 */
export async function findPermissionGroup(token, accountId, name) {
  const overrideKey = `CLOUDFLARE_PG_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const override = process.env[overrideKey];
  if (override) return { id: override, name };

  const groups = await api(token, `/accounts/${accountId}/tokens/permission_groups`);
  const match = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());

  if (!match) {
    throw new CloudflareError(
      `Cloudflare exposes no permission group named "${name}". ` +
        `The account token may lack the access needed to list permission groups, ` +
        `or Cloudflare renamed it. Set ${overrideKey} to the group id to bypass this lookup.`,
    );
  }

  return { id: match.id, name: match.name };
}

/**
 * List every Pages project in the account.
 *
 * No `per_page` is sent on purpose. The Pages projects endpoint rejects every
 * value of it — `?per_page=25` and `?per_page=100` both return 400 with
 * "Invalid list options provided" — while `?page=N` is accepted. Sending a
 * page size here looks like ordinary pagination and silently breaks the call.
 *
 * @param {string} token
 * @param {string} accountId
 * @returns {Promise<{name: string, subdomain: string, domains: string[]}[]>}
 */
export async function listProjects(token, accountId) {
  const projects = [];

  for (let page = 1; page <= 50; page += 1) {
    const payload = await api(token, `/accounts/${accountId}/pages/projects?page=${page}`, {
      raw: true,
    });
    projects.push(...payload.result);

    const totalPages = payload.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
  }

  return projects;
}

/**
 * Create the Pages project if it does not exist.
 *
 * Direct Upload is deliberate. A Git-integrated Pages project cannot later be
 * switched to Direct Upload, so choosing it would be a one-way door that also
 * requires the Cloudflare GitHub App over a browser OAuth flow — impossible
 * from a token, and it would not reach a private repository. Direct Upload
 * from CI is the portable choice for a template.
 *
 * @param {string} token
 * @param {string} accountId
 * @param {string} name
 * @param {string} productionBranch
 * @returns {Promise<{created: boolean, project: object}>}
 */
export async function ensureProject(token, accountId, name, productionBranch) {
  const existing = (await listProjects(token, accountId)).find((p) => p.name === name);
  if (existing) return { created: false, project: existing };

  const project = await api(token, `/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    body: { name, production_branch: productionBranch },
  });

  return { created: true, project };
}

/**
 * Resolve the zone that owns a hostname.
 *
 * Tries the hostname itself first, then strips one label at a time, so
 * `www.example.co.uk` resolves to the `example.co.uk` zone without a
 * public-suffix list. Requires `Zone Read` on the admin token; without it
 * Cloudflare returns an authentication error and the caller reports that
 * plainly rather than pretending the zone does not exist.
 *
 * @param {string} token
 * @param {string} hostname
 * @returns {Promise<{id: string, name: string}>}
 */
export async function resolveZone(token, hostname) {
  const labels = hostname.split('.');
  const candidates = labels.slice(0, -1).map((_, i) => labels.slice(i).join('.'));

  for (const candidate of candidates) {
    let zones;
    try {
      zones = await api(token, `/zones?name=${encodeURIComponent(candidate)}&per_page=1`);
    } catch (err) {
      throw new CloudflareError(
        `Cannot resolve the zone for "${hostname}". Listing zones needs \`Zone Read\` on the admin token. ` +
          `Either add that permission, or leave \`customDomains\` empty and use the *.pages.dev subdomain.`,
        { status: err.status, errors: err.errors },
      );
    }
    if (zones.length > 0) return { id: zones[0].id, name: zones[0].name };
  }

  throw new CloudflareError(
    `No Cloudflare zone matches "${hostname}". The domain must be in this account before Pages can serve it.`,
  );
}

/**
 * List every zone the token can see.
 *
 * `Zone Read` must be granted on the **account** resource, not on a zone
 * resource: a zone-scoped grant returns an empty list rather than an error,
 * which reads as "this account has no domains".
 *
 * @param {string} token
 * @returns {Promise<{id: string, name: string, status: string}[]>}
 */
export async function listZones(token) {
  const zones = [];

  for (let page = 1; page <= 50; page += 1) {
    const payload = await api(token, `/zones?page=${page}`, { raw: true });
    zones.push(...payload.result);

    const totalPages = payload.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
  }

  return zones;
}

/**
 * Read the DNS records at one exact hostname.
 *
 * Reading records needs `DNS Read`, which is a zone-scoped permission.
 * `Zone Read` alone is not enough — it lists zones but returns 403 for
 * their records.
 *
 * @param {string} token
 * @param {string} zoneId
 * @param {string} name
 * @returns {Promise<object[]>}
 */
export async function listDnsRecords(token, zoneId, name) {
  return api(token, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
}

/**
 * Create a DNS record.
 *
 * @param {string} token
 * @param {string} zoneId
 * @param {object} record
 * @returns {Promise<object>}
 */
export async function createDnsRecord(token, zoneId, record) {
  return api(token, `/zones/${zoneId}/dns_records`, { method: 'POST', body: record });
}

/**
 * Update a DNS record by id.
 *
 * @param {string} token
 * @param {string} zoneId
 * @param {string} recordId
 * @param {object} record
 * @returns {Promise<object>}
 */
export async function updateDnsRecord(token, zoneId, recordId, record) {
  return api(token, `/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'PATCH',
    body: record,
  });
}

/**
 * Delete a DNS record by id.
 *
 * @param {string} token
 * @param {string} zoneId
 * @param {string} recordId
 */
export async function deleteDnsRecord(token, zoneId, recordId) {
  await api(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
}

/**
 * List the custom hostnames attached to a Pages project.
 *
 * @param {string} token
 * @param {string} accountId
 * @param {string} projectName
 * @returns {Promise<{name: string, status: string}[]>}
 */
export async function listProjectDomains(token, accountId, projectName) {
  return api(token, `/accounts/${accountId}/pages/projects/${projectName}/domains`);
}

/**
 * Attach a custom hostname to a Pages project.
 *
 * This does **not** create the DNS record. Measured: after attaching a
 * domain the zone still had no CNAME for it, so the record is a separate
 * step that needs DNS permission.
 *
 * @param {string} token
 * @param {string} accountId
 * @param {string} projectName
 * @param {string} hostname
 * @returns {Promise<object>}
 */
export async function addProjectDomain(token, accountId, projectName, hostname) {
  return api(token, `/accounts/${accountId}/pages/projects/${projectName}/domains`, {
    method: 'POST',
    body: { name: hostname },
  });
}

/**
 * Run a callback with a short-lived token, then delete the token.
 *
 * Zone and DNS permissions must be scoped to exact zone ids, and the ids are
 * discoverable only by a token that already holds `Zone Read`. A nested
 * wildcard resource (`…account.<id>.zone.*`) is rejected at creation, so the
 * only way to reach a zone-scoped grant is to look the ids up first. These
 * tokens make that possible without widening the standing credential or the
 * CI deploy token, and they are deleted in `finally` whether the callback
 * succeeds or throws.
 *
 * @param {string} adminToken Needs `Account API Tokens: Write`.
 * @param {string} accountId
 * @param {{name: string, permissionGroupNames: string[], resources: Record<string,string>,
 *          expiresInMinutes?: number}} spec
 * @param {(token: string) => Promise<any>} fn
 * @returns {Promise<any>} Whatever `fn` returns.
 */
export async function withTemporaryToken(adminToken, accountId, spec, fn) {
  const permissionGroups = [];
  for (const name of spec.permissionGroupNames) {
    permissionGroups.push(await findPermissionGroup(adminToken, accountId, name));
  }

  const minutes = spec.expiresInMinutes ?? 30;
  const expiresOn = new Date(Date.now() + minutes * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const created = await createToken(adminToken, accountId, {
    name: spec.name,
    policies: [{ effect: 'allow', resources: spec.resources, permission_groups: permissionGroups }],
    expiresOn,
  });

  try {
    return await fn(created.value);
  } finally {
    // A failed cleanup must not mask the callback's own error.
    try {
      await deleteToken(adminToken, accountId, created.id);
    } catch {
      // An expired or already-revoked token is the expected failure here.
    }
  }
}

/**
 * Create an account-owned API token with the given policies.
 *
 * @param {string} token Admin token with `Account API Tokens Write`.
 * @param {string} accountId
 * @param {{
 *   name: string,
 *   policies: {resources: Record<string,string>, permissionGroups: {id: string}[]}[],
 *   expiresOn?: string|null
 * }} spec
 * @returns {Promise<{id: string, value: string}>} `value` is returned once, by
 *   Cloudflare, and never again. The caller must persist it immediately.
 */
export async function createToken(token, accountId, spec) {
  return api(token, `/accounts/${accountId}/tokens`, {
    method: 'POST',
    body: {
      name: spec.name,
      policies: spec.policies,
      ...(spec.expiresOn ? { expires_on: spec.expiresOn } : {}),
    },
  });
}

/**
 * Find an account token by name.
 *
 * Paginates with `page` alone: the account tokens endpoint tolerates
 * `per_page`, but keeping one pagination idiom across this module avoids a
 * second version of the same mistake.
 *
 * @param {string} token
 * @param {string} accountId
 * @param {string} name
 * @returns {Promise<object|undefined>}
 */
export async function findToken(token, accountId, name) {
  for (let page = 1; page <= 50; page += 1) {
    const payload = await api(token, `/accounts/${accountId}/tokens?page=${page}`, {
      raw: true,
    });
    const match = payload.result.find((t) => t.name === name);
    if (match) return match;

    const totalPages = payload.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
  }
  return undefined;
}

/**
 * Delete an account token. Used by rotation.
 *
 * @param {string} token
 * @param {string} accountId
 * @param {string} tokenId
 */
export async function deleteToken(token, accountId, tokenId) {
  await api(token, `/accounts/${accountId}/tokens/${tokenId}`, { method: 'DELETE' });
}
