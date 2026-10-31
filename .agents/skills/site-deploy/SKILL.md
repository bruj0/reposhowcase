---
name: site-deploy
description: Provisions Cloudflare Pages for this site and publishes it, including custom domains, DNS records and post-deploy verification. Use when the user says "publish this", "deploy", "deploy to Cloudflare", "set up the domain", "point my domain at it", "it is not loading", "the domain redirects somewhere else", or "how do I get it live". Do NOT use to change what the site contains — that is catalogue-curate, catalogue-tag or catalogue-sort.
---

# site-deploy

Provisioning and publishing, with the four failures that actually happen.

## When to use

- First publish, or a redeploy after a change.
- A domain does not serve, serves the wrong thing, or redirects elsewhere.
- A token needs rotating.

## Inputs

`site.config.json` (`projectName`, `productionBranch`, `buildOutputDir`,
`customDomains`) and one credential.

## Procedure

**1. Choose the credential path.**

| The user has | Path |
|---|---|
| A Cloudflare token with `Cloudflare Pages: Edit` | paste it as `CLOUDFLARE_API_TOKEN`; skip minting |
| An admin token with `Account API Tokens: Write` | `npm run cf:setup`, which mints a Pages-only token |
| Neither | tell them exactly which to create, and stop |

The pasted token is the shorter path and asks for less. `cf:setup` mints a
token scoped to `Pages Write` and nothing else, so a leaked CI credential
cannot edit DNS.

**2. Provision.**

```bash
npm run cf:setup                 # project, token, hostnames, DNS
npm run cf:setup -- --dry-run    # reports, writes nothing
npm run cf:setup -- --overwrite-dns   # only when a record points elsewhere
```

`cf-setup` refuses to replace an `A`, `AAAA` or `CNAME` that points at
something else unless `--overwrite-dns` is passed. Do not pass that flag to
make an error go away: a mistyped hostname should not take a domain off the
internet. Check what the existing record serves first.

**3. Publish.**

```bash
npm run deploy                  # build and upload
npm run deploy -- --skip-build  # upload dist/ as it stands
```

**4. Verify.** Fetch every hostname and count the cards. The tool does this
itself; read its output rather than repeating the claim.

## The four failures, and what each looks like

| Symptom | Cause | What to do |
|---|---|---|
| `HTTP 302` to an unrelated URL | A forwarding **Page Rule** answers before Pages | Page Rules are invisible to account-owned tokens (`1011`). A human must remove it in Rules → Page Rules. No permission fixes this |
| `ENOTFOUND` locally, works elsewhere | The OS resolver has a stale or negative answer | Check with `dig +short @1.1.1.1 A <host>` before believing it is broken |
| Connection fails for minutes after attaching a domain | The certificate is still issuing | Wait. Do not re-run setup; it will not hurry it |
| `npm run refresh` aborts with a rate-limit message | GitHub anonymous limit is 60 requests an hour | Use `GITHUB_TOKEN=$(gh auth token)` |

## Scripts used

```bash
npm run cf:setup
npm run cf:deploy   # via: npm run deploy
node scripts/compare-sites.mjs <a> <b>   # parity between two deployments
```

## How to tell it worked

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/         # 200
curl -s https://<domain>/ | grep -c 'class="card"'                  # equals the catalogue count
```

Never report "published" from the API's answer. Fetch the URL and look at the
page. Provisioning once reported success while every request was being
redirected away by a rule no API call could see.
