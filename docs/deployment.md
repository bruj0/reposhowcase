# Deploying to Cloudflare Pages

The site is published by **Direct Upload** from a scoped API token, not by a
Git-integrated Pages project. One command provisions everything, one command
publishes.

```bash
npm run cf:setup     # once: mint the scoped token, create the Pages project
npm run deploy       # build and upload
```

---

## Why Direct Upload, not the Git integration

A Git-integrated Pages project builds on Cloudflare's side from a connected
repository. It is the obvious choice, and it is the wrong one here, for three
reasons:

1. **It is a one-way door.** A project created with Git integration cannot
   later be switched to Direct Upload. Direct Upload can migrate the other way
   if it ever becomes necessary, so starting there keeps the option open.
2. **Connecting a repository needs a browser OAuth flow.** The Cloudflare
   GitHub App is authorised by a human in a browser. No API token can install
   it, so the step cannot be automated and cannot be scripted for a fork.
3. **The repository is private.** A Git integration has to be granted read
   access to it. Direct Upload needs no repository access at all — CI builds
   and uploads; Cloudflare never sees the source.

The cost of Direct Upload is that the build runs in CI rather than on
Cloudflare. This build takes under a second and hits no network, because the
catalogue is a committed snapshot.

---

## What `npm run cf:setup` creates

| Object | Detail |
|---|---|
| API token | `<projectName>-pages-deploy`, account-owned, `Pages Write` only |
| Pages project | `<projectName>`, production branch from the config |
| `.env` keys | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, mode 0600 |

It is idempotent. A second run reuses the working token and reports the
existing project. `--force` rotates the token; `--dry-run` writes nothing.

### The admin token is used once

`cf:setup` needs a token with `Account API Tokens: Write` so it can mint the
deploy token. That token is read from `.env` as
`cloudflare_admin_api_token`, and it is never used for anything else.

The deploy token it produces carries **`Pages Write` on one account and
nothing else**. A leaked deploy credential cannot touch DNS, Workers, R2,
Access or billing. Delete `cloudflare_admin_api_token` from `.env` once CI has
the deploy token — publishing does not need it again.

**The admin token is not asked to touch Pages.** It deliberately does not have
that permission, so every Pages call is made with the narrow token. That is
also the only way to prove the credential a publish will use is the one that
works.

### The deploy token never holds DNS permission

The standing token carries **`Pages Write` and nothing else**, whether or not
custom domains are configured.

Zone and DNS work needs permissions that must be scoped to exact zone ids, and
those ids are discoverable only by a token that already holds `Zone Read`. A
nested wildcard resource (`…account.<id>.zone.*`) is rejected at creation, so
the ids have to be looked up first. `cf:setup` does that with two short-lived
tokens:

| Step | Temporary token | Lifetime |
|---|---|---|
| Resolve hostname → zone | `Zone Read` on the account | 10 min |
| Reconcile DNS records | `DNS Read` + `DNS Write` on the resolved zones | 20 min |

Both are deleted in a `finally`, whether the work succeeded or threw. So the
credential CI holds **cannot edit DNS**, even for a site with custom domains.
That property is worth the extra round trip: a leaked deploy token can publish
a bad page, not redirect your mail or take a hostname.

A `Zone Read` grant must be on the **account** resource. Granting it on a zone
returns an empty zone list rather than an error, which reads as "this account
has no domains".

---

## Configuration

Everything site-specific lives in `site.config.json`. A fork edits this file
and nothing else.

| Key | Meaning | Default |
|---|---|---|
| `projectName` | Pages project name, and the `*.pages.dev` subdomain | required |
| `productionBranch` | Branch name that owns the production alias | `main` |
| `buildOutputDir` | Directory the build writes | `dist` |
| `githubOwner` | Account whose repositories form the catalogue | `bruj0` |
| `customDomains` | Hostnames to serve, in addition to `*.pages.dev` | `[]` |
| `tokenExpiryDays` | Deploy token lifetime; `0` means no expiry | `365` |
| `deployTokenName` | Name of the token in the Cloudflare dashboard | `<projectName>-pages-deploy` |

`projectName` doubles as the subdomain, so Cloudflare accepts only lowercase
letters, digits and hyphens. `cf:setup` rejects anything else before it
creates anything.

`customDomains` is validated the same way: hostnames are lowercased and a
trailing dot is stripped, but a duplicate is an error rather than being
deduplicated, because a repeated hostname is a typo.

There is no `wrangler.toml`. `cf-deploy.mjs` passes the project name, branch
and output directory to wrangler on the command line, so the config has one
owner. A leftover `wrangler.toml` whose `name` disagrees is treated as an
error, not a preference.

---

## Custom domains

List every hostname you want served. Apex and `www` are separate entries
because they are separate DNS names:

```json
"customDomains": ["coderscorp.com", "www.coderscorp.com"]
```

`cf:setup` does three things for each entry:

1. **Attaches it to the Pages project.** Idempotent — an attached hostname is
   reported and skipped.
2. **Creates a proxied CNAME** to `<project>.pages.dev`.
3. **Re-runs are free.** A record already pointing at the right target is
   reported and left alone; a record pointing at the right target with the
   proxy off just gets the proxy enabled.

### Apex is not a special case

A plain DNS CNAME is illegal at a zone apex, and an apex usually already holds
SPF, DMARC and verification TXT records. Cloudflare's **proxied** CNAME is
different: measured on a live zone, a proxied CNAME at the apex was accepted
alongside two existing TXT records and served correctly. So the apex needs no
special handling, and the mail records are untouched.

### Attaching a domain does not create its DNS record

Measured: after `POST …/pages/projects/<name>/domains` returned 200, the zone
still had no record for that hostname, and the domain sat in `initializing`
until the record existed. The two steps are separate, which is why DNS
permission is needed at all.

### Records that point somewhere else

If an `A`, `AAAA` or `CNAME` already exists at the hostname, it points at
something else — possibly a live service. `cf:setup` **refuses to replace it**
and exits non-zero:

```
! coderscorp.com points elsewhere (A 65.108.126.170)
  pass --overwrite-dns to point it at coderscorp.pages.dev
```

`--overwrite-dns` deletes those records and creates the CNAME. `TXT`, `MX` and
every other type are never touched. This is a separate flag on purpose: a
mistyped hostname should not silently take a domain off the internet.

### Certificates take a few minutes

A new hostname starts as `pending` or `initializing` while Cloudflare issues a
certificate. Requests fail until it completes. Watch it with:

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/<name>/domains" \
  | jq '.result[] | {name, status, verification_data}'
```

### `www` and apex both serve; neither redirects

Both hostnames serve identical content. That is what "load from both" means,
and it is what Cloudflare gives you when both are attached.

If you want a canonical hostname, that is a separate decision with a separate
mechanism — a Cloudflare redirect rule or a `_redirects` file in the build
output. Neither is configured here, because the choice (apex → `www` or the
reverse) belongs to the operator.

### Something can answer before Pages

`cf:setup` fetches every hostname at the end and reports what it actually
serves, because provisioning can succeed while the site is unreachable.

The measured case: a **forwarding Page Rule** on the zone sent every path to
a fixed URL, so `coderscorp.com/`, `/index.html` and `/anything/else` all
returned `302` to the same place and Pages never saw the request. No DNS
record and no Pages setting can override that.

**A Page Rule is invisible to an account-owned token.** `GET …/pagerules`
returns `1011 Page Rules endpoint does not support account owned tokens`, and
that is not a permissions problem — no account token can read them, at any
permission level. Only a user-owned token, or the dashboard, can see or
remove one.

So `cf:setup` detects the symptom and tells you where to look:

```
! coderscorp.com: redirects to https://github.com/bruj0
  · a redirect rule or Page Rule on the zone is answering before Pages
```

The fix is manual: Cloudflare dashboard → the zone → **Rules → Page Rules** →
delete or disable the forwarding rule. Then re-run `npm run cf:setup` to
confirm.

A path-preserving redirect is a different shape and worth distinguishing: if
`/foo` lands on `…/foo`, the rule is forwarding with a path variable. A fixed
target for every path — what happened here — is a plain static forward.

### `ENOTFOUND` from the verification step is usually local

`cf:setup` runs on your machine and uses the OS resolver, which can hold a
negative or stale answer for a hostname that was created minutes ago. The step
reports the socket code for exactly this reason:

```
· bruj0.net: could not connect (ENOTFOUND)
  local DNS may not have the new record yet; the site can still be live
```

Check with a public resolver before believing it:

```bash
dig +short @1.1.1.1 A bruj0.net
curl -sI --resolve "bruj0.net:443:$(dig +short @1.1.1.1 A bruj0.net | head -1)" https://bruj0.net/
```

---

## Publishing

### From this machine

```bash
npm run deploy                  # production branch
npm run deploy -- --branch x    # preview deployment
npm run deploy -- --skip-build  # upload dist/ as it stands
npm run deploy -- --dry-run     # build, then print the upload command
```

The token is read from `.env` and passed to wrangler through the environment,
never on the command line — an argument is visible in `ps`.

### From GitHub Actions

`.github/workflows/deploy.yml` publishes on every push to `main`. It reads the
project name, branch and output directory from `site.config.json` rather than
duplicating them, so renaming the site needs no workflow edit.

Add two repository secrets once:

```bash
gh secret set CLOUDFLARE_API_TOKEN --body "$(grep '^CLOUDFLARE_API_TOKEN=' .env | cut -d= -f2-)"
gh secret set CLOUDFLARE_ACCOUNT_ID --body "2e9c09b27d2a089c531b12ae0f0e6ff3"
```

The workflow fails with an explicit message when `CLOUDFLARE_API_TOKEN` is
missing, rather than deploying nothing and reporting success.

---

## Rotating and revoking

```bash
npm run cf:setup -- --force   # revoke the old token, mint a new one, update .env
```

A mint always revokes the previous token of the same name, so the account
holds exactly one deploy credential per site. Without that rule a re-run leaves
a second token with an identical name — a credential nobody can identify and
nobody dares delete.

When rotating in CI, update the repository secret after the local rotation.
Both the old and new token work until the old one is revoked, so the order
does not matter.

To revoke everything: delete the token at
<https://dash.cloudflare.com/profile/api-tokens>. The Pages project and its
deployments are unaffected; only future publishes fail.

---

## What was measured, and what it cost to learn

These are observations from this account on 2026-10-30, not documentation
claims. Each one broke something first.

| Finding | Detail |
|---|---|
| Account-owned tokens verify elsewhere | `/user/tokens/verify` returns `1000 Invalid API Token` for a valid account-owned token. `/accounts/{id}/tokens/verify` is the correct endpoint, and trying both is the only reliable check. |
| `Account API Tokens: Write` grants no Pages access | The token that can mint tokens cannot list Pages projects. Provisioning must mint first, then act. |
| The Pages projects endpoint rejects `per_page` | `?per_page=25` and `?per_page=100` both return `8000024 Invalid list options provided`. `?page=N` works. This looks like ordinary pagination and silently breaks the call. |
| `expires_on` rejects milliseconds | It wants `2005-12-30T01:02:03Z`. JavaScript's `toISOString()` emits `.234Z`, which is rejected with the whole payload echoed back. |
| A 400 and an auth failure look the same behind a retry loop | The first version retried on any error and reported "cannot reach the Pages API", which hid a query-parameter bug behind a permissions story. The retry now returns the last error. |
| Attaching a Pages domain creates no DNS record | `POST …/pages/projects/<name>/domains` returned 200 with status `initializing`, and the zone still had no record for the hostname. |
| `Zone Read` does not read DNS records | It lists zones. `/zones/{id}/dns_records` still returns 403. Records need `DNS Read`, a separate zone-scoped permission. |
| `Zone Read` on a zone resource shows nothing | It must be granted on the **account** resource. Zone-scoped, it returns an empty list instead of an error, which reads as "no domains in this account". |
| Zone resources cannot be wildcarded | `com.cloudflare.api.account.<id>.zone.*` is rejected with `1001 Token creation request was rejected`, alone and combined with an account-scoped policy. Only exact zone ids are accepted, so the ids must be discovered before a DNS-scoped token can be minted. |
| A proxied CNAME is legal at an apex with TXT records | A plain CNAME cannot coexist with SPF or DMARC, but Cloudflare accepted a proxied CNAME at the apex alongside two TXT records and served it. |
| Page Rules are closed to account-owned tokens | `GET …/pagerules` returns `1011 Page Rules endpoint does not support account owned tokens` with every account permission granted. No account-owned credential can read or edit a Page Rule. |
| A forwarding Page Rule wins over Pages | With a proxied CNAME to Pages in place, every path still returned `302` to the rule's fixed target. DNS and Pages settings cannot override it. |

Resource keys for account-owned tokens need the account id:
`com.cloudflare.api.account.<account_id>`. Bare `com.cloudflare.api.account`
and the wildcard `com.cloudflare.api.account.*` are both rejected with `1001`.

---

## Checking the deployment

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<projectName>.pages.dev
```

To confirm the catalogue actually rendered rather than merely returning 200:

```bash
curl -s https://<projectName>.pages.dev/ | grep -c 'class="card"'
```

The dashboard is at
`https://dash.cloudflare.com/<accountId>/pages/view/<projectName>`, and
`npm run cf:setup` prints the exact URL.
