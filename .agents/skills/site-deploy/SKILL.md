---
name: site-deploy
description: Publishes this site to GitHub Pages, Cloudflare Pages, or both, including custom domains, DNS records, credentials and post-deploy verification. Use when the user says "publish this", "deploy", "deploy to GitHub", "deploy to Cloudflare", "set up the domain", "point my domain at it", "it is not loading", "the domain redirects somewhere else", or "how do I get it live". Do NOT use to change what the site contains — that is catalogue-curate, catalogue-tag or catalogue-sort.
---

# site-deploy

Provisioning and publishing, with the four failures that actually happen.

## When to use

- First publish, or a redeploy after a change.
- A domain does not serve, serves the wrong thing, or redirects elsewhere.
- A token needs rotating.

## Inputs

`site.config.json` — `deploy.targets` decides which hosts publish,
`deploy.cloudflarePages.customDomains` and `deploy.githubPages.customDomain`
decide which host owns which name — plus whatever credential those targets need,
which is usually none.

## Hosting modes

| Mode | Served at | Needs |
|---|---|---|
| GitHub, no domain | `<owner>.github.io/<repo>/` | a GitHub account |
| GitHub, custom domain | the domain, at its root | a GitHub account and a domain |
| Cloudflare, no domain | `<projectName>.pages.dev` | a Cloudflare account |
| Cloudflare, custom domain | the domain | a Cloudflare account and a domain |

**Never enable a second host on your own.** Ask. A user who wanted one host
should not discover a second one in their account afterwards.

**Never ask for a secret in the conversation, and never accept one if offered.**
A token pasted into a chat is in a transcript forever. Instead: name the key that
is needed, tell the user to write it into `.env` (gitignored, 0600), and then run
`npm run secrets:check`, which reports presence without printing a value.
Proceed only when it exits 0.

**One apex per site.** GitHub Pages serves one apex plus its `www`. If the
config asks for two apexes on GitHub, say so and propose the split; do not
silently move a domain.

## Procedure

**1. Choose the target.**

Do nothing if `deploy.targets` already says what the user wants. Otherwise ask
which host, and edit `deploy.targets` — that key is the only thing that decides
it.

**2. Choose the credential path.**

| The user has | Path |
|---|---|
| A Cloudflare token with `Cloudflare Pages: Edit` | paste it as `CLOUDFLARE_API_TOKEN`; skip minting |
| An admin token with `Account API Tokens: Write` | `npm run cf:setup`, which mints a Pages-only token |
| Neither | tell them exactly which to create, and stop |

The pasted token is the shorter path and asks for less. `cf:setup` mints a
token scoped to `Pages Write` and nothing else, so a leaked CI credential
cannot edit DNS.

**3. Provision.**

```bash
npm run cf:setup                 # project, token, hostnames, DNS
npm run cf:setup -- --dry-run    # reports, writes nothing
npm run cf:setup -- --overwrite-dns   # only when a record points elsewhere
```

`cf-setup` refuses to replace an `A`, `AAAA` or `CNAME` that points at
something else unless `--overwrite-dns` is passed. Do not pass that flag to
make an error go away: a mistyped hostname should not take a domain off the
internet. Check what the existing record serves first.

**4. Publish.**

```bash
npm run deploy                  # build and upload
npm run deploy -- --skip-build  # upload dist/ as it stands
```

**5. Verify.** Fetch every hostname and count the cards. The tool does this
itself; read its output rather than repeating the claim.

## The four failures, and what each looks like

| Symptom | Cause | What to do |
|---|---|---|
| `HTTP 302` to an unrelated URL | A forwarding **Page Rule** answers before Pages | Page Rules are invisible to account-owned tokens (`1011`). A human must remove it in Rules → Page Rules. No permission fixes this |
| `ENOTFOUND` locally, works elsewhere | The OS resolver has a stale or negative answer | Check with `dig +short @1.1.1.1 A <host>` before believing it is broken |
| Connection fails for minutes after attaching a domain | The certificate is still issuing | Wait. Do not re-run setup; it will not hurry it |
| `npm run refresh` aborts with a rate-limit message | GitHub anonymous limit is 60 requests an hour | Use `GITHUB_TOKEN=$(gh auth token)` |
| Page returns 200 but has no styling | `.nojekyll` is missing, so Jekyll dropped `_astro/` | `gh-deploy.mjs` writes it; a hand-rolled push must too |
| The custom domain vanished after a deploy | The force-push replaced the branch and the `CNAME` file went with it | Regenerate `CNAME` from `deploy.githubPages.customDomain` into the artifact |
| Assets 404 only on `*.github.io/<repo>/` | The build ran without `base` | Use `npm run build:gh`; the prefix is derived, never hand-written |
| Links break right after adding a domain | GitHub changes the routing path without rebuilding | `npm run deploy:gh -- --force` |

## Scripts used

```bash
npm run cf:setup
npm run deploy            # every target in deploy.targets, in order
npm run deploy:cf         # Cloudflare only
npm run deploy:gh         # GitHub Pages only
npm run secrets:check     # which keys are needed, present, printed never
node scripts/compare-sites.mjs <a> <b>   # parity between two deployments
```

## How to tell it worked

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/         # 200
curl -s https://<domain>/ | grep -c 'class="card"'                 # equals the catalogue count

# GitHub Pages with a custom domain: served at the root, so the base is "/"
curl -s https://<domain>/ | grep -o 'href="/_astro[^"]*' | head -1

# GitHub Pages without a domain: assets live under the repository name
curl -sI https://<owner>.github.io/<repo>/_astro/<file>.css | head -1   # 200
```

For the no-domain mode, check the **stylesheet** and not the page. A missing
`base` produces a page that returns 200 and renders unstyled, which passes
every check that only looks at the HTML status.

Never report "published" from the API's answer. Fetch the URL and look at the
page. Provisioning once reported success while every request was being
redirected away by a rule no API call could see.
