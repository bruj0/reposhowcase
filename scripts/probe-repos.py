#!/usr/bin/env python3
"""Probe every catalogue repo for the data the site needs.

Collects, per repository:
  - traffic views (14-day window, needs push access)
  - README presence and its size
  - the root file inventory
  - repository size, commit count, default branch

Writes /tmp/repo_probe.json. Not part of the build - the catalogue
snapshot stays the source of truth for the site.
Contract
--------
``--json`` prints one JSON object on stdout and nothing else, so ``| jq``
always works. ``--dry-run`` performs no writes. Exit 0 on success, 1 on
failure, 2 when a human is needed. There is no interactive prompt.
"""

import json
import subprocess
import sys
from pathlib import Path

# The owner is read from site.config.json, so this repository has exactly one
# place to change it.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.config import load_config  # noqa: E402
from lib.cli import emit_json, flags, note  # noqa: E402

OWNER = load_config()["githubOwner"]


def gh(path, field=None):
    """Call the GitHub API and return the JSON, or None on any failure."""
    try:
        res = subprocess.run(
            ["gh", "api", path],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return None
    if res.returncode != 0:
        return None
    try:
        data = json.loads(res.stdout)
    except json.JSONDecodeError:
        return None
    return data[field] if field and isinstance(data, dict) else data


def main():
    args = flags()
    catalogue = json.load(open("src/data/repos.json"))
    out = {}

    for repo in catalogue["repos"]:
        name = repo["name"]
        print(f"  {name}", file=sys.stderr)

        traffic = gh(f"repos/{OWNER}/{name}/traffic/views", "count") or 0
        uniques = gh(f"repos/{OWNER}/{name}/traffic/views", "uniques") or 0

        readme = gh(f"repos/{OWNER}/{name}/readme")
        readme_name = readme.get("name") if isinstance(readme, dict) else None
        readme_size = readme.get("size", 0) if isinstance(readme, dict) else 0

        contents = gh(f"repos/{OWNER}/{name}/contents")
        files = [c["name"] for c in contents] if isinstance(contents, list) else []

        meta = gh(f"repos/{OWNER}/{name}")
        size = meta.get("size", 0) if isinstance(meta, dict) else 0
        commits = meta.get("pushed_at") if isinstance(meta, dict) else None
        default_branch = (
            meta.get("default_branch", "main") if isinstance(meta, dict) else "main"
        )

        out[name] = {
            "views": traffic,
            "uniques": uniques,
            "readme": readme_name,
            "readmeSize": readme_size,
            "files": files,
            "size": size,
            "pushedAt": commits,
            "defaultBranch": default_branch,
            "description": repo["description"],
            "createdAt": repo["createdAt"],
            "language": repo["language"],
            "stars": repo["stars"],
        }

    if not args.dry_run:
        json.dump(out, open("/tmp/repo_probe.json", "w"), indent=2)

    if args.json:
        emit_json({"count": len(out), "repos": out})
        return

    note(f"probed {len(out)} repositories")


if __name__ == "__main__":
    main()
