---
name: catalogue-curate
description: Decides which repositories belong in the catalogue, writes the rules to site.config.json, and reports what the rules excluded and why. Use when the user says "which repos belong", "drop the empty ones", "drop the abandoned ones", "only include these", "show my best 40", "why is X missing", "exclude that repo", or "curate the catalogue". Do NOT use to change tags — that is catalogue-tag.
---

# catalogue-curate

The exclusion policy, expressed as numbers in config rather than as code.

## When to use

- First setup, to decide what belongs.
- "Why is this repository missing?" — read `catalogue/excluded.json`.
- A repository should be added or removed by hand.

## Inputs

A sentence, and the measurements that make it enforceable. Examples:

| The user says | You write |
|---|---|
| "drop anything empty or abandoned" | the defaults: empty + unnoticed |
| "drop anything with no stars and under ten files" | `unnoticed: { maxStars: 0, maxViews: 0, maxFiles: 10 }` |
| "only include these three" | `catalogue.include: ["a", "b", "c"]` |
| "never show this one" | add it to `catalogue.exclude` |
| "include my forks too" | `includeForks: true` |

## Procedure

1. Translate the sentence into `catalogue.*` keys. Every threshold is a
   number in `site.config.json`; none lives in `scripts/fetch-repos.mjs`.
2. Deciding *inclusion* is judgement. Do not infer it from a keyword in a
   README — that was measured wrong: a classifier labelled an essay `cicd`
   because the word "deploy" appeared in the prose. Read the file tree.
3. The rules run in this order, and the order matters:
   `private` → `excluded` → `not-included` → `fork` → `archived` → `empty` →
   `unnoticed`. The allowlist is checked before the content rules so a
   repository outside it is never fetched or counted.
4. Run the refresh and report the counts, not the file path:

   ```bash
   GITHUB_TOKEN=$(gh auth token) node scripts/fetch-repos.mjs --json | jq .counts
   ```

5. Show the user the named exclusions with their rule. That file is the
   argument for the policy, and it is what answers "why is X missing".

## Scripts used

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/fetch-repos.mjs            # writes src/data/repos.json + catalogue/excluded.json
GITHUB_TOKEN=$(gh auth token) node scripts/fetch-repos.mjs --dry-run  # writes nothing
GITHUB_TOKEN=$(gh auth token) node scripts/fetch-repos.mjs --json     # counts + exclusions on stdout
```

An unauthenticated run cannot complete: 66 repositories need roughly 200
requests and the anonymous limit is 60 an hour. The script aborts rather than
writing a catalogue where every repository looks empty. If it aborts, fix the
credential; do not re-run and hope.

## How to tell it worked

```bash
jq '.counts' <(GITHUB_TOKEN=$(gh auth token) node scripts/fetch-repos.mjs --json)
jq -r '.[] | "\(.name) \(.rule)"' catalogue/excluded.json | head
```

The kept count must match what the user expected. If it does not, the rules
are wrong, not the GitHub API — say so and adjust the number together.
