---
name: catalogue-tag
description: Assigns a purpose, a platform and a language to every catalogue repository, from a closed vocabulary, and writes them as GitHub topics. Use when the user says "tag my repos", "add filters", "categorise by purpose", "why is the filter empty", "set the platforms", "the filter has no buttons", or "add topics". Do NOT use to change which repositories appear — that is catalogue-curate.
---

# catalogue-tag

The filter is the reason this site exists, and the tags are the filter.

## When to use

- The filter renders no buttons, or only "All" — that means no `purpose-*`,
  `platform-*` or `language-*` topics exist yet.
- A new repository needs tagging.
- The vocabulary needs a new value.

## Inputs

The repository list from `src/data/repos.json`, and the closed vocabulary in
`site.config.json` → `taxonomy`.

## Procedure

1. **Read the repository, do not read its README for keywords.** A keyword
   classifier was measured wrong: it labelled an essay `cicd` because the word
   "deploy" appeared in the prose, and a Laravel demo `docker` because the word
   appeared once. Inspect the file tree, the entry point, and what the thing
   is for.
2. Assign one value per axis: `purpose`, `platform`, `language`. The value must
   already be in `taxonomy`; `scripts/apply-topics.py` refuses anything else
   and names the offender.
3. Write assignments to `catalogue/tags.json`:

   ```json
   { "repo-name": { "purpose": "tooling", "platform": "linux", "language": "python" } }
   ```

   Three values per repository, no prose, no notes. The reasoning does not
   belong in the file — it belongs in the pull request.
4. Preview, then apply:

   ```bash
   python3 scripts/apply-topics.py --dry --json | jq '.planned | length'
   python3 scripts/apply-topics.py --dry
   python3 scripts/apply-topics.py
   ```

5. The script **replaces** the three axis prefixes on each repository and
   preserves every other topic, because the others (`vault`, `golang`) are
   hand-curated. It does not merge: merging once let one repository hold both
   `platform-linux` and `platform-self-hosted`, and the page read whichever
   the API returned first.
6. Refresh so the page sees the new topics:

   ```bash
   GITHUB_TOKEN=$(gh auth token) node scripts/fetch-repos.mjs
   ```

## Adding a vocabulary value

Add it to `taxonomy` in `site.config.json` **first**, then use it. Adding it
only in `tags.json` fails validation, which is the intended behaviour: the
vocabulary is closed so the filter stays operable. An open set produced 77
distinct topics and a filter row with one repository behind each button.

## Scripts used

```bash
python3 scripts/apply-topics.py --dry --json   # the plan, as data
python3 scripts/apply-topics.py --dry          # the plan, readable
python3 scripts/apply-topics.py                # writes topics to GitHub
GITHUB_TOKEN=$(gh auth token) node scripts/fetch-repos.mjs   # refresh the snapshot
```

## How to tell it worked

```bash
python3 scripts/apply-topics.py --dry --json | jq '.planned | length'   # equals catalogue size
npm run build
grep -c 'data-axis=' dist/index.html    # greater than 3: at least one value per axis
```

Every repository in the catalogue must have an assignment. The script fails
with the names of any that do not, rather than leaving them untagged.
