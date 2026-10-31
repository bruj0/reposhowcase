---
name: site-launch
description: Drives Repo Showcase from a bare repository to a published catalogue, by asking the user what only they can answer and delegating everything else to the other skills. Use when the user says "set this up", "publish my repositories", "walk me through it", "build me a catalogue site", "launch the site", or "start from scratch". Do NOT use for a single change to an already-configured site — call the specific skill instead.
---

# site-launch

The orchestrator. It owns no config key of its own: every decision belongs to
the skill that owns it, and this one only sequences them and stops where no
credential reaches.

## When to use

- A repository with no `site.config.json` yet, or one whose `brand.name` is
  still a placeholder.
- The user wants the whole journey rather than a change.
- A previous run was interrupted (a dashboard visit, a certificate wait).

Do not use it to answer "sort them by stars" on a site that already exists.
That is `catalogue-sort`, and going through the orchestrator would make the
user answer five questions to change one value.

## Inputs

Nothing. It reads the current state and asks for what is missing.

## Procedure

Run the phases in order. After each, print what is done, what is blocked, and
what is needed — never encouragement, and never "published" before a URL has
been fetched and the catalogue seen in it.

**Phase 0 — read state.** Load `site.config.json` if it exists. Check whether
the Pages project exists and whether the hostnames serve. Resume at the first
thing that is not done; do not restart a finished phase.

**Phase 1 — the four questions.** Ask them in this order and do not invent an
answer to any of them:

| Question | Default offered |
|---|---|
| Which GitHub account? | the one `gh api user` reports |
| What is the site called? | none — it must be told |
| Which repositories belong? | all public, non-fork |
| Publish to GitHub Pages, and add Cloudflare later? | yes, GitHub Pages with no domain |

The fourth question is last and pre-answered on purpose. GitHub Pages with no
custom domain is the only mode that needs neither a second account nor a domain,
so the journey can finish before it is asked. A user who ignores it still
publishes; a user who wants Cloudflare answers, and `site-deploy` takes them
through it as a follow-up.

Hand answers 1–3 to `site-identity`, `catalogue-curate` and `catalogue-sort`.
Question 4 becomes `deploy.targets`.

**Never ask for a token in the conversation.** When Cloudflare is enabled, say
which key is needed, tell the user to write it into `.env`, and run
`npm run secrets:check` to confirm it is there. It prints whether the key
exists, never the value.

**Phase 2 — build the catalogue.** `catalogue-curate` applies the rules, then
`npm run refresh` fetches. Report the three counts it returns: kept, empty,
unnoticed. If kept is zero, stop: the rules are wrong, not the network.

**Phase 3 — tag.** Ask whether the repositories carry `purpose-*`,
`platform-*` and `language-*` topics. If not, run `catalogue-tag`. If the user
declines, say plainly that the filter will be absent, and continue.

**Phase 4 — sort.** `catalogue-sort`, from whatever the user said, or leave
`sort.default`.

**Phase 5 — publish.** `site-deploy`.

**Phase 6 — verify.** Fetch every hostname, count the cards, compare against
the number the catalogue says. Report the URL only after that.

## Where it must stop and hand control back

1. Creating a Cloudflare API token in the dashboard, when the user chose to
   paste one.
2. Deleting a forwarding Page Rule. Page Rules are invisible to account-owned
   tokens, so no script here can see one, let alone remove it.
3. Waiting for a certificate. A freshly attached hostname fails until the
   certificate issues; that is minutes of doing nothing, and saying so is
   better than retrying.
4. Creating disposable repositories, when the smoke test is being run.
5. Anything destructive: `--overwrite-dns`, deleting a project, revoking a
   token. Ask explicitly. Never infer consent from an earlier yes.

## Scripts used

None directly. It calls `site-identity`, `catalogue-curate`, `catalogue-tag`,
`catalogue-sort` and `site-deploy`, and uses their acceptance steps rather
than restating them.

## How to tell it worked

```bash
npm run build && npx astro check          # clean
node scripts/check-config.mjs             # both loaders agree
curl -s https://<domain>/ | grep -c 'class="card"'   # matches the catalogue count
```

And the judgement that matters: the user answered five questions and typed no
code. If anything in the journey needed an edit to `src/`, the skill is not
finished, whatever the checks say.
