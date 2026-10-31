"""Shared CLI conventions for the catalogue utilities.

Every script in ``scripts/`` follows the same contract, because an agent calls
them unattended and a human calls them by hand:

===================  =============================================================
``--json``           One JSON object on stdout and nothing else. Progress and
                     warnings go to stderr, so ``| jq`` always works.
``--dry-run``        Perform no writes. ``--dry`` is accepted as an alias.
exit 0               Success.
exit 1               Failure: something is wrong and re-running will not help.
exit 2               A human is needed: a missing credential, or a step that
                     only a dashboard can perform.
===================  =============================================================

There is no interactive prompt anywhere. Values come from ``site.config.json``,
from the environment, or from the command line.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class Flags:
    """Parsed command-line flags."""

    json: bool
    dry_run: bool


def flags(argv: list[str] | None = None) -> Flags:
    """Parse the two flags every script accepts."""
    args = sys.argv[1:] if argv is None else argv
    return Flags(
        json="--json" in args,
        dry_run="--dry-run" in args or "--dry" in args,
    )


def emit_json(payload) -> None:
    """Print one JSON object on stdout."""
    print(json.dumps(payload, indent=2, sort_keys=True))


def note(message: str) -> None:
    """Print progress to stderr, never to stdout."""
    print(message, file=sys.stderr)


def fail(message: str, code: int = 1) -> "NoReturn":  # noqa: F821
    """Report a failure and exit."""
    print(f"✗ {message}", file=sys.stderr)
    raise SystemExit(code)


def needs_human(message: str) -> "NoReturn":  # noqa: F821
    """Report a step that only a person can complete, and exit 2."""
    fail(message, code=2)
