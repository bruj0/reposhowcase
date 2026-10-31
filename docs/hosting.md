# Hosting

Two hosts are supported and `site.config.json` decides which ones publish. The
rule throughout is that **judgement lives in the config and the scripts obey
it**: no script decides a host, and no host decides a domain.

## The four modes

| Mode | Config | Served at | Needs |
|---|---|---|---|
| GitHub Pages, no domain | `targets: ["github-pages"]`, no `customDomain` | `<owner>.github.io/<repo>/` | a GitHub account |
| GitHub Pages, custom domain | `targets: ["github-pages"]`, `customDomain` set | that domain, at its root | a GitHub account and a domain |
| Cloudflare Pages, no domain | `targets: ["cloudflare-pages"]`, no domains | `<projectName>.pages.dev` | a Cloudflare account |
| Cloudflare Pages, custom domain | `targets: ["cloudflare-pages"]`, domains set | those domains | a Cloudflare account and a domain |

The shipped config is the first row. It is the only mode that needs no second
account, no domain and no token, so it is the one a new user meets first.

## Config shape

```json
"deploy": {
  "targets": ["cloudflare-pages", "github-pages"],
  "cloudflarePages": {
    "customDomains": ["example.net", "www.example.net"]
  },
  "githubPages": {
    "repository": "example-gh",
    "branch": "gh-pages",
    "customDomain": "example.com"
  }
}
```

`githubPages.repository` is optional. Omitted, the artifact is published to the
repository the source lives in, which needs no credential. Set to `owner/name`,
it goes to a separate public repository — the shape a private source needs.

`githubPages.customDomain` is a **single** hostname, not a list, because GitHub
stores exactly one in the `CNAME` file. Its `www` sibling is derived: GitHub
redirects between them once the DNS records exist.

## One apex per site

GitHub Pages allows one apex domain per site, plus its `www`. Two apex domains
need two sites. This is why a deployment with two domains usually keeps one on
Cloudflare: it is not a preference, it is the only arrangement that serves both.

A project site **with** a custom domain is served at that domain's root, so its
base path is `/` and the build is the same one Cloudflare receives. A project
site **without** one is served under `/<repo>/`, so `npm run build:gh` sets
`base` and every asset URL carries the prefix.

## What each host needs at DNS

GitHub Pages, apex and `www`, records **not** proxied:

```text
example.com       A      185.199.108.153
                        185.199.109.153
                        185.199.110.153
                        185.199.111.153
www.example.com   CNAME  <owner>.github.io
```

`www` must point at `<owner>.github.io` and never at the apex: GitHub documents
that pointing a subdomain at the apex breaks HTTPS enforcement.

Cloudflare Pages owns its records through its own proxy, and needs no manual
records once `npm run cf:setup` has run.

## Three ways this breaks quietly

1. **Missing `.nojekyll`.** The build writes CSS and JS to `_astro/`, and Jekyll
   drops directories beginning with an underscore. The page returns 200 and
   renders unstyled. `gh-deploy.mjs` writes the file; a hand-rolled deploy must
   too.
2. **A lost `CNAME`.** On a branch deploy the domain lives in the `CNAME` file.
   A force-push that does not include it removes the domain. `gh-deploy.mjs`
   regenerates it from the config on every run.
3. **A domain change with no deploy.** Adding or removing a custom domain
   changes the routing path but does not rebuild the site, so asset links stay
   broken until something is pushed. That is what `--force` is for.

## Credentials

Nothing is required for the default mode. When a target does need a credential,
it is written into `.env` by the user — never pasted into a conversation, an
issue or a commit. `npm run secrets:check` answers "is it there" without
printing the value.

| Key | Needed by |
|---|---|
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `cloudflare-pages` |
| `GH_TOKEN` | `github-pages` to an external repository, when SSH is unavailable |
| `GITHUB_TOKEN` | `npm run refresh`, optional, for view counts |

`GH_TOKEN` is optional on purpose: a local deploy pushes over SSH with the key
the operator already has. It is required only in CI, where no key exists.
