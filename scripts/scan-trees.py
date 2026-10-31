#!/usr/bin/env python3
"""Classify every catalogue repository by what it actually contains.

A recursive tree scan, because the root listing hides the difference
between a repo with a code file in a subdirectory and a repo with only a
LICENSE. Writes /tmp/repo_trees.json.
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

# Files that document or license the project rather than implement it.
DOC_EXT = {".md", ".txt", ".rst", ".adoc"}
META_NAMES = {
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".editorconfig",
    "license",
    "license.md",
    "license.txt",
    "notice",
}
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".pdf", ".mp4"}


def tree(name, branch):
    res = subprocess.run(
        ["gh", "api", f"repos/{OWNER}/{name}/git/trees/{branch}?recursive=1"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if res.returncode != 0:
        return None
    data = json.loads(res.stdout)
    if "tree" not in data:
        return None
    return [t["path"] for t in data["tree"] if t["type"] == "blob"]


def main():
    args = flags()
    catalogue = json.load(open("src/data/repos.json"))
    probe = json.load(open("/tmp/repo_probe.json"))
    out = {}

    for repo in catalogue["repos"]:
        name = repo["name"]
        branch = probe[name]["defaultBranch"]
        paths = tree(name, branch)
        if paths is None:
            paths = probe[name]["files"]

        blobs = [p for p in paths if "/" not in p or True]
        docs = []
        code = []
        meta = []
        images = []

        for p in paths:
            base = p.rsplit("/", 1)[-1]
            lower = base.lower()
            ext = "." + lower.rsplit(".", 1)[-1] if "." in lower else ""
            if base in META_NAMES or lower.startswith(".git") or base == "LICENSE":
                meta.append(p)
            elif ext in DOC_EXT:
                docs.append(p)
            elif ext in IMG_EXT:
                images.append(p)
            else:
                code.append(p)

        out[name] = {
            "branch": branch,
            "total": len(paths),
            "code": code,
            "docs": docs,
            "meta": meta,
            "images": images,
            "paths": paths,
        }
        print(f"  {name}: {len(code)} code, {len(docs)} docs", file=sys.stderr)

    if not args.dry_run:
        json.dump(out, open("/tmp/repo_trees.json", "w"), indent=2)

    if args.json:
        emit_json({"count": len(out), "trees": out})
        return

    note(f"scanned {len(out)} repositories")


if __name__ == "__main__":
    main()
