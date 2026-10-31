#!/usr/bin/env python3
"""Report the catalogue repositories that lack a README or usage instructions.

Three tiers, because "no README" and "no instructions" are different
problems:

  MISSING   - no README file at all
  STUB      - a README too short to tell a reader what the repo is or how
              to run it
  NO-USE    - a README that describes the project but gives no way to run
              it: no install step, no command, no example

Writes /tmp/readme_report.json.
Contract
--------
``--json`` prints one JSON object on stdout and nothing else, so ``| jq``
always works. ``--dry-run`` performs no writes. Exit 0 on success, 1 on
failure, 2 when a human is needed. There is no interactive prompt.
"""

import base64
import json
import re
import subprocess
import sys
from pathlib import Path

# The owner is read from site.config.json, so this repository has exactly one
# place to change it.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.config import load_config  # noqa: E402
from lib.cli import emit_json, flags, note  # noqa: E402

OWNER = load_config()["githubOwner"]

# A README must say what the thing is and how to use it. A stub fails the
# first test.
STUB_BYTES = 200

# Signals that a README tells a reader how to run the thing.
USE_PATTERNS = [
    r"```",  # a fenced code block
    r"`[^`\n]+`",  # an inline code span
    r"\b(usage|install|installation|quick\s*start|getting started|running|how to use|setup|deploy|apply|enable)\b",
    r"^\s*\$\s+\S+",  # a shell prompt line
    r"\b(GET|POST|PUT|PATCH|DELETE)\s+\S+",  # an HTTP call example
    r"\b(import|from)\s+\S+",  # a code import line
    r"\b(pip|npm|docker|kubectl|terraform|make|go run|python|ansible|helm|packer|vagrant)\b",
]


def gh_json(path):
    res = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=30)
    if res.returncode != 0:
        return None
    try:
        return json.loads(res.stdout)
    except json.JSONDecodeError:
        return None


def readme_text(name):
    data = gh_json(f"repos/{OWNER}/{name}/readme")
    if not isinstance(data, dict):
        return None, 0
    raw = base64.b64decode(data["content"]).decode("utf-8", "replace")
    return raw, data.get("size", 0)


def has_usage_instructions(text):
    """Does the README tell a reader how to run the thing?"""
    for pattern in USE_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE | re.MULTILINE):
            return True
    return False


def main():
    args = flags()
    catalogue = json.load(open("src/data/repos.json"))
    report = {"missing": [], "stub": [], "noUsage": [], "ok": []}

    for repo in catalogue["repos"]:
        name = repo["name"]
        text, size = readme_text(name)

        if text is None:
            report["missing"].append(
                {
                    "name": name,
                    "language": repo["language"],
                    "files": repo["fileCount"],
                    "views": repo["views"],
                    "url": repo["url"],
                }
            )
            continue

        body = text.strip()
        has_use = has_usage_instructions(body)

        if size < STUB_BYTES:
            report["stub"].append(
                {
                    "name": name,
                    "bytes": size,
                    "language": repo["language"],
                    "files": repo["fileCount"],
                    "views": repo["views"],
                    "url": repo["url"],
                    "preview": body[:200],
                }
            )
        elif not has_use:
            report["noUsage"].append(
                {
                    "name": name,
                    "bytes": size,
                    "language": repo["language"],
                    "files": repo["fileCount"],
                    "views": repo["views"],
                    "url": repo["url"],
                    "preview": body[:300],
                }
            )
        else:
            report["ok"].append(name)

        print(f"  {name}: {size}b", file=sys.stderr)

    counts = {key: len(value) for key, value in report.items()}

    if not args.dry_run:
        json.dump(report, open("/tmp/readme_report.json", "w"), indent=2)

    if args.json:
        emit_json({"counts": counts, "report": report})
        return

    note(
        f"missing={counts['missing']} stub={counts['stub']} "
        f"noUsage={counts['noUsage']} ok={counts['ok']}"
    )


if __name__ == "__main__":
    main()
