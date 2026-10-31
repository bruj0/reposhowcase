#!/usr/bin/env python3
"""Attach each repository's README text to the catalogue snapshot.

The purpose and platform classifiers read the README as well as the
metadata, so the classifier sees what the project says about itself and
not only what its file names suggest.

Writes the README text into src/data/repos.json under `readmeText`.
Contract
--------
``--json`` prints one JSON object on stdout and nothing else, so ``| jq``
always works. ``--dry-run`` performs no writes. Exit 0 on success, 1 on
failure, 2 when a human is needed. There is no interactive prompt.
"""

import base64
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
MAX_CHARS = 4000


def readme_text(name):
    res = subprocess.run(
        ["gh", "api", f"repos/{OWNER}/{name}/readme"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if res.returncode != 0:
        return ""
    try:
        data = json.loads(res.stdout)
    except json.JSONDecodeError:
        return ""
    raw = base64.b64decode(data["content"]).decode("utf-8", "replace")
    return raw[:MAX_CHARS]


def main():
    args = flags()
    path = "src/data/repos.json"
    catalogue = json.load(open(path))

    for repo in catalogue["repos"]:
        name = repo["name"]
        repo["readmeText"] = readme_text(name)
        print(f"  {name}: {len(repo['readmeText'])} chars", file=sys.stderr)

    if not args.dry_run:
        json.dump(catalogue, open(path, "w"), indent=2)

    if args.json:
        emit_json({"updated": len(catalogue["repos"]), "dry": args.dry_run})
        return

    note(f"updated {len(catalogue['repos'])} repositories")


if __name__ == "__main__":
    main()
