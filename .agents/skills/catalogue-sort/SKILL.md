---
name: catalogue-sort
description: Sets how the catalogue sorts by default, by writing one key in site.config.json. Use when the user says "sort by stars", "sort by newest", "most viewed first", "default to alphabetical", "put the most popular first", or "change the default order". Do NOT use to change which repositories appear (catalogue-curate) or to add filters (catalogue-tag).
---

# catalogue-sort

Sorting is a preference, so it is one config key and no code.

## When to use

- "Sort them by stars." → `sort.default: "stars"`.
- "Newest first." → `sort.default: "newest"`.
- "Most viewed first." → `sort.default: "views"`.
- "Alphabetical." → `sort.default: "name"`.

## Inputs

The phrase the user used, mapped to a comparator name:

| Phrase | Value |
|---|---|
| newest, latest, most recent | `newest` |
| most viewed, popular by traffic | `views` |
| most starred, most popular | `stars` |
| alphabetical, by name | `name` |

## Procedure

1. Read `sort.options` in `site.config.json`. The value must be one of them:
   the loader rejects a default that is not offered, and names the key.
2. Write `sort.default`.
3. If the user asked for an order that is not in `options`, adding it is a
   code change: a new comparator in `src/components/Catalogue.astro` and a
   label in `SORT_LABELS`, plus the name added to `sort.options`. Say that
   plainly rather than quietly picking the nearest existing mode.
4. The buttons are generated from `sort.options`, so nothing else needs
   editing.

## Scripts used

```bash
npm run build        # the loader validates sort.default against sort.options
```

## How to tell it worked

```bash
npm run build
grep -o 'data-sort="stars" aria-pressed="true"' dist/index.html   # one match
grep -c 'data-sort="' dist/index.html                            # equals sort.options.length
```

A mismatch means the page is not reading the config: check that
`sortDefault` is passed through `define:vars` in `Catalogue.astro`.
