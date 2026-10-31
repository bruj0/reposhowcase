---
name: site-identity
description: Sets the brand, the GitHub account and the hostnames in site.config.json, and removes any remaining account-specific text from the source. Use when the user says "rename the site", "change the title", "set the brand", "point this at my account", "it still says someone else's name", or "change the tagline". Do NOT use to change which repositories appear — that is catalogue-curate.
---

# site-identity

Everything a reader sees that is not a repository: the name, the tagline, the
hero copy, the header and footer links, and the hostnames.

## When to use

- A fresh clone still showing the previous owner's name.
- A rename, a new tagline, a new domain.
- The footer links point at somebody else's GitHub account.

## Inputs

From the user: the site name, optionally an eyebrow, tagline, headline, lede,
and the hostnames. `githubOwner` if it is not the account `gh api user`
reports.

## Procedure

1. Read `site.config.json`. Every brand string supports `{placeholders}` that
   resolve from `name`, `projectName` and `githubOwner`.
2. Write the values. `title` and `description` become the `<title>` and the
   meta description, so write them as a search result would read.
3. `headline` may contain inline HTML (`<em>`), because it is rendered with
   `set:html`. `lede`, `eyebrow` and the links are plain text.
4. If a new string is needed that has no key yet, add the key to the loader in
   `scripts/lib/config.mjs` **and** `scripts/lib/config.py` in the same change,
   then run `node scripts/check-config.mjs`. A key that exists in one loader
   and not the other is the drift this project specifically guards against.
5. Search the source for anything the config now owns:

   ```bash
   grep -rn "github.com/" src/ | grep -v "site.brand"
   ```

   A hit is a hardcoded link that a rename will not reach.

## Scripts used

```bash
node scripts/check-config.mjs   # the two loaders agree
npm run build                   # the config validates and renders
```

## How to tell it worked

```bash
# new brand.name "Example", githubOwner "octocat", previous brand "OldName"
npm run build
grep -rl "OldName" dist/ ; echo "exit=$?"        # exit=1, no brand leftovers
grep -o '<title>[^<]*' dist/index.html           # the configured title
grep -o 'github.com/octocat' dist/index.html     # the configured account
```

Substitute your own previous brand for `OldName`. Searching for a literal
name that is not yours proves nothing: it passes whether or not the rename
worked.

Note the scope: the *catalogue data* will still contain the previous owner's
repository URLs until `npm run refresh` is run for the new account. That is
data, not identity, and `site-identity` must not pretend otherwise.
