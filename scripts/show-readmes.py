#!/usr/bin/env python3
"""Print the README content of the borderline repositories.

Used to decide whether a repo is genuinely empty: a README that carries
real text means the repo documents something, even if it ships no code.
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

CANDIDATES = [
    "Documesh-aws",
    "workflow-test1",
    "rfc",
    "wa2telegram",
    "terraform-confluent-kafka",
    "vault-lxc",
    "vault-raw-viewer",
    "vault-k8s-replication",
    "vault-log-viewer",
    "MauticSmtpBouncesBundle",
    "helm-vault-gcp-kms",
]


def readme(name):
    res = subprocess.run(
        ["gh", "api", f"repos/{OWNER}/{name}/readme"],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        return None
    data = json.loads(res.stdout)
    return base64.b64decode(data["content"]).decode("utf-8", "replace")


args = flags()

if args.json:
    emit_json({name: readme(name) for name in CANDIDATES})
    raise SystemExit(0)

for name in CANDIDATES:
    print("=" * 70)
    print(f"### {name}")
    print("=" * 70)
    body = readme(name)
    if body is None:
        print("(no README)")
    else:
        text = body.strip()
        print(f"({len(text)} chars)")
        print(text[:1200])
    print()
