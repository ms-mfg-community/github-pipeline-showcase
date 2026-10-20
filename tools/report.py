"""Summarize deployment records written by scripts/deploy.mjs.

Deliberately small. This module exists so the repository carries a second CodeQL
language and a second Dependabot ecosystem — see SPEC.md §1.3. It is not meant to grow.

A record is read from disk, or fetched with ``requests`` when the argument is an
``http://`` or ``https://`` URL.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SHORT_DIGEST_LENGTH = 19
FETCH_TIMEOUT_SECONDS = 10


def summarize(record: dict) -> str:
    """Render a one-line summary of a single deployment record."""
    environment = record.get("environment", "unknown")
    outcome = record.get("outcome", "unknown")
    digest = record.get("digest") or ""
    short = digest[:SHORT_DIGEST_LENGTH] if digest else "(no digest)"
    return f"{environment}: {outcome} [{short}]"


def load(path: Path) -> dict:
    """Read a single deployment record from disk."""
    return json.loads(path.read_text(encoding="utf-8"))


def fetch(url: str) -> dict:
    """Read a single deployment record from an http(s) URL.

    ``requests`` is imported here rather than at module level on purpose. It is a runtime
    dependency (tools/requirements.txt) and the dev toolchain (tools/requirements-dev.txt)
    does not install it, so a top-level import would break linting and testing this module
    on a clean checkout.
    """
    import requests

    response = requests.get(url, timeout=FETCH_TIMEOUT_SECONDS)
    response.raise_for_status()
    return response.json()


def read(source: str) -> dict:
    """Read a record from an ``http(s)://`` URL, or from a path on disk."""
    if source.startswith(("http://", "https://")):
        return fetch(source)
    return load(Path(source))


def main(argv: list[str]) -> int:
    """Print a summary line for each deployment record named on the command line."""
    if not argv:
        print("usage: report.py <record.json | https://...> [...]", file=sys.stderr)
        return 2
    for raw in argv:
        print(summarize(read(raw)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
