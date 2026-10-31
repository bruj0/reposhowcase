#!/usr/bin/env python3
"""Assign three GitHub topics to every catalogue repository.

The three axes are the ones a reader of a catalogue actually filters on:

  purpose   - what the repository is for
  platform  - what it deploys to
  language  - the language it is written in

**The assignments are explicit, not inferred.** A keyword classifier over
READMEs was tried first and misfired badly: "deploy" in an essay about
team structure matched the CI/CD rule, "claude" in a passing reference
matched the agent rule, and a Laravel demo matched Docker because its
README mentioned the word. A filter that lies is worse than no filter.

Every row in catalogue/tags.json was checked against the repository's own
contents - the file tree, the entry points and the README - using a shallow
clone, because a claim about a repository should be checkable without leaving
the machine.

Each axis has a controlled vocabulary. The vocabulary is the point: an
open topic set produces a filter row with 77 buttons and nothing in it.
Three axes of six to nine values each produce a filter a reader can
operate.

GitHub rejects a colon in a topic name, so the separator is a hyphen.

Usage:
    python3 scripts/apply-topics.py --dry    # show the plan
    python3 scripts/apply-topics.py          # write to GitHub
"""

import json
import subprocess
import sys
from pathlib import Path

# The owner is read from site.config.json, so this repository has exactly one
# place to change it.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.config import load_config  # noqa: E402

OWNER = load_config()["githubOwner"]

# ------------------------------------------------------------- vocabulary

PURPOSE = {
    "agent": "Agent tooling",
    "cicd": "CI/CD",
    "security": "Security",
    "infrastructure": "Infrastructure",
    "documentation": "Documentation",
    "tooling": "Tooling",
    "game": "Game",
}

PLATFORM = {
    "linux": "Linux",
    "macos": "macOS",
    "windows": "Windows",
    "kubernetes": "Kubernetes",
    "docker": "Docker",
    "proxmox": "Proxmox",
    "aws": "AWS",
    "cloudflare": "Cloudflare",
    "self-hosted": "Self-hosted",
    "virtualbox": "VirtualBox",
}

LANGUAGE = {
    "python": "Python",
    "go": "Go",
    "shell": "Shell",
    "php": "PHP",
    "rust": "Rust",
    "terraform": "Terraform",
    "html": "HTML",
    "markdown": "Markdown",
    "other": "Other",
}

# ------------------------------------------------- explicit assignments
#
# name: (purpose, platform, language)
#
# platform is the runtime the thing needs, not the tool that built it.
# A Terraform module that provisions AWS resources is `platform-aws`,
# because that is where it runs.

TAGS_PATH = Path(__file__).resolve().parents[1] / "catalogue" / "tags.json"


def load_tags():
    """Read ``catalogue/tags.json`` and check every value against the taxonomy.

    The vocabulary is closed on purpose: an open set produces a filter row with
    77 buttons and one repository behind each. A value outside
    ``site.config.json``'s ``taxonomy`` is a mistake, so it raises rather than
    being written to GitHub.
    """
    allowed = load_config()["taxonomy"]
    tags = json.loads(TAGS_PATH.read_text(encoding="utf-8"))

    problems = []
    for name, axes in tags.items():
        for axis in ("purpose", "platform", "language"):
            value = axes.get(axis)
            if value not in allowed[axis]:
                problems.append(f"  {name}: {axis} {value!r} is not in taxonomy.{axis}")

    if problems:
        raise SystemExit(
            "catalogue/tags.json has values outside the taxonomy:\n" + "\n".join(problems)
        )
    return tags


TAGS = load_tags()


def topics_for(repo):
    """Return the three topics for one repository, or None if unassigned."""
    name = repo["name"]
    if name not in TAGS:
        return None

    axes = TAGS[name]
    return [
        f"purpose-{axes['purpose']}",
        f"platform-{axes['platform']}",
        f"language-{axes['language']}",
    ]


def main():
    dry = "--dry" in sys.argv
    catalogue = json.load(open("src/data/repos.json"))

    plan = {}
    unassigned = []
    for repo in catalogue["repos"]:
        topics = topics_for(repo)
        if topics is None:
            unassigned.append(repo["name"])
        else:
            plan[repo["name"]] = topics

    if unassigned:
        print(f"no assignment for: {', '.join(unassigned)}", file=sys.stderr)
        return 1

    # Show the vocabulary that would result.
    vocab = {}
    for topics in plan.values():
        for t in topics:
            axis, _, value = t.partition("-")
            vocab.setdefault(axis, set()).add(value)

    if "--json" in sys.argv:
        print(
            json.dumps(
                {
                    "planned": plan,
                    "vocabulary": {axis: sorted(values) for axis, values in vocab.items()},
                    "dry": dry,
                },
                indent=2,
            )
        )
        return 0

    print("Vocabulary:")
    for axis in ("purpose", "platform", "language"):
        print(f"  {axis}: {', '.join(sorted(vocab.get(axis, [])))}")

    if dry:
        print("\nPlan:")
        for name in sorted(plan):
            print(f"  {name:38} {' '.join(plan[name])}")
        print(f"\n{len(plan)} repositories, {sum(len(v) for v in vocab.values())} distinct values")
        return 0

    ok = 0
    failed = []
    for name in sorted(plan):
        res = subprocess.run(
            ["gh", "api", f"repos/{OWNER}/{name}", "--jq", ".topics"],
            capture_output=True,
            text=True,
        )
        try:
            existing = json.loads(res.stdout or "[]")
        except json.JSONDecodeError:
            existing = []

        # Replace the axis topics, keep everything else.
        #
        # Merging is wrong here: a repo that carried a stale
        # `platform-linux` from an earlier run would end up with two
        # platform topics, and the site reads the first one it finds.
        # Non-axis topics (`vault`, `golang`, `docker-compose`) are
        # hand-curated, so they are preserved.
        axis_prefixes = ("purpose-", "platform-", "language-")
        preserved = [t for t in existing if not t.startswith(axis_prefixes)]
        merged = sorted(set(preserved) | set(plan[name]))

        # GitHub rejects a colon in a topic name, and the field is an
        # array rather than a comma-separated string.
        cmd = ["gh", "api", "--method", "PUT", f"repos/{OWNER}/{name}/topics"]
        for topic in merged:
            cmd += ["-f", f"names[]={topic}"]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

        if res.returncode == 0:
            ok += 1
            print(f"  ok   {name}: {' '.join(merged)}")
        else:
            failed.append((name, res.stderr.strip()))
            print(f"  FAIL {name}: {res.stderr.strip()}")

    print(f"\n{ok} of {len(plan)} repositories tagged, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
