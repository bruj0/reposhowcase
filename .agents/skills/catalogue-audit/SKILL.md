---
name: catalogue-audit
description: Reports which catalogue repositories lack a README or usage instructions, in three tiers, and produces a prioritised fix list. Use when the user says "which repos need a README", "audit the docs", "what is undocumented", "find repos without instructions", "documentation report", or "what should I write next". Reads only; never writes to GitHub.
---

# catalogue-audit

How well the catalogue documents itself, and what to fix first.

## When to use

- A periodic review of documentation quality.
- Before publishing, to decide what is worth fixing.
- "Is this repo documented?" — check one name against the report.

## Inputs

Nothing beyond a GitHub token, which the traffic and README API calls need.

## Procedure

1. Run the report:

   ```bash
   python3 scripts/report-readmes.py
   ```

2. Three tiers, because "no README" and "no instructions" are different
   problems:

   | Tier | Means | What to tell the user |
   |---|---|---|
   | `MISSING` | No README file at all | The repository page says nothing |
   | `STUB` | Under 200 bytes — a title, not a description | It looks documented but is not |
   | `NO-USE` | Describes the project, never says how to run it | A reader cannot start |

3. Rank by what a stranger would hit first: file count, then whether the
   repository is the largest in its tier. An 84-file repository with no README
   matters more than a six-file one.
4. Report the ratio as a fraction and a percentage, and say which numbers moved
   since the last run and why. A drop in the missing count caused by
   repositories *leaving* the catalogue is not an improvement — say so.

## Judgement, not just counting

The `NO-USE` detector is a heuristic: a fenced block, an inline code span, a
usage keyword, a shell prompt, an HTTP method, an import, or a tool name. It
produced a false positive once — a Mautic bundle documents usage with a `POST`
example, and the first pattern set had no rule for an inline span or an HTTP
method. If a repository is flagged and you believe it is documented, check the
README yourself before you write anything. The report is evidence, not a
verdict.

## Scripts used

```bash
python3 scripts/report-readmes.py     # writes /tmp/readme_report.json
```

## How to tell it worked

```bash
python3 scripts/report-readmes.py
# missing=N stub=N noUsage=N ok=N, and the four add up to the catalogue size
```

The four counts must sum to the number of repositories in
`src/data/repos.json`. If they do not, a repository was skipped rather than
classified, which is the failure that matters.
