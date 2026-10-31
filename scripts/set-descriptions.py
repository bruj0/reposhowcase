#!/usr/bin/env python3
"""Set the GitHub description on every catalogue repo that lacks one.

Descriptions are written from the repository's own contents - its README,
its file tree and its entry points - not from the repository name. The
name of a repo says what it might be; the tree says what it is.

Run with --dry to print the descriptions without touching GitHub.

Usage:
    python3 scripts/set-descriptions.py --dry
    python3 scripts/set-descriptions.py
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

# Every description below was written by reading the repository's own
# README, tree and entry points. Keep the phrasing factual: say what the
# repository contains, not what it aspires to be.
DESCRIPTIONS = {
    "Documesh-aws": (
        "AWS deployment of Documesh - the RAG-assisted document similarity "
        "search service."
    ),
    "codeigniter_demo": (
        "News stand demo built on CodeIgniter, with Bootstrap, PHPMailer and "
        "mPDF."
    ),
    "fullstack_demo": (
        "Laravel fullstack demo with authentication, Bootstrap and a "
        "Docker-ready setup."
    ),
    "hello-machine": (
        "CI test fixture - a shell script and its test, used to exercise a "
        "build pipeline."
    ),
    "infra-for-eks": (
        "Cost-optimized EKS cluster on OpenTofu, with an ALB ingress through "
        "the AWS Load Balancer Controller."
    ),
    "k8s-arbitrage": (
        "Kubernetes arbitrage bot in Go - moves workloads toward cheaper nodes."
    ),
    "lab-reproducer": (
        "Vagrant and Ansible lab that reproduces a Consul and Vault PKI "
        "cluster, with Tavern tests for the control groups."
    ),
    "migration-to-fargate": (
        "Terraform that migrates the Ping-Pong application from EKS to AWS "
        "Fargate on ECS, with the trade-offs written down."
    ),
    "packer-ubuntu": (
        "Packer template that builds minimized Ubuntu 18.04 server images for "
        "Vagrant and VirtualBox."
    ),
    "packer-ubuntu-nginx": (
        "Packer and Kitchen setup that builds an Ubuntu image running Nginx "
        "and tests it end to end."
    ),
    "proxmox-cicd": (
        "Stage 3 of the Proxmox provisioning pipeline - deploys Gitea, the "
        "runner and the supporting applications onto a k3s cluster."
    ),
    "proxmox-k3s": (
        "Stage 2 of the Proxmox provisioning pipeline - turns two cloned VMs "
        "into a working k3s cluster with Cilium, CSI and Cloudflare Tunnel."
    ),
    "proxmox-vms": (
        "Stage 1 of the Proxmox provisioning pipeline - idempotent VM "
        "provisioning that hands off the result to downstream stages."
    ),
    "rfc": (
        "RFC repository. Proposals are filed as issues and discussed before "
        "they are implemented."
    ),
    "terraform-confluent-kafka": (
        "Terraform module for Confluent Cloud - environment, Kafka cluster, "
        "service account and topics."
    ),
    "vagrant-go": (
        "Vagrant setup that compiles and runs a Go toolchain inside a virtual "
        "machine."
    ),
    "vault-decrypt-legacy": (
        "Decrypts Vault storage values with the unseal keys, for Vault data "
        "written before version 1.0."
    ),
    "vault-gcp-debug": (
        "Reproduces the GCP secret engine's service account key exchange, to "
        "debug a Vault auth failure."
    ),
    "vault-lxc": (
        "Runs a HashiCorp Vault cluster on LXD - a Python provisioner, Ansible "
        "roles for init, unseal and PKI, and a disaster recovery layout."
    ),
    "vault-raw-viewer": (
        "HTTP proxy that reads raw values out of Vault and serves them, for "
        "inspecting what a path actually holds."
    ),
    "workflow-test1": (
        "Test fixture for pull-request workflows - verifies that a change made "
        "on a branch reaches the repository through a PR."
    ),
}


def set_description(name, description, dry):
    if dry:
        note(f"[dry] {name}: {description}")
        return True

    res = subprocess.run(
        [
            "gh",
            "api",
            "--method",
            "PATCH",
            f"repos/{OWNER}/{name}",
            "-f",
            f"description={description}",
        ],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        print(f"FAIL {name}: {res.stderr.strip()}", file=sys.stderr)
        return False

    note(f"set  {name}")
    return True


def main():
    args = flags()
    dry = args.dry_run
    catalogue = json.load(open("src/data/repos.json"))

    existing = {
        r["name"]: r["description"] for r in catalogue["repos"] if r["description"].strip()
    }
    missing = [r["name"] for r in catalogue["repos"] if not r["description"].strip()]

    note(f"{len(missing)} repositories without a description, {len(existing)} with one")

    unknown = [n for n in missing if n not in DESCRIPTIONS]
    if unknown:
        print(f"no description written for: {', '.join(unknown)}", file=sys.stderr)
        return 1

    ok = 0
    for name in missing:
        if set_description(name, DESCRIPTIONS[name], dry):
            ok += 1

    if args.json:
        emit_json({"handled": ok, "missing": len(missing), "dry": dry})
        return

    note(f"{ok} of {len(missing)} handled")
    return 0


if __name__ == "__main__":
    sys.exit(main())
