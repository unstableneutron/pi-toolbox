#!/usr/bin/env python3
"""Extract bash-tool invocations from Pi agent session logs.

Produces a deterministic, deduplicated JSONL corpus suitable for checking in
as a regression fixture for the bash-rewrite classifier.

Two input sources are supported:

    --from pi-mono   Pull bash calls from the public
                     https://huggingface.co/datasets/badlogicgames/pi-mono
                     dataset. This is the canonical source for the
                     committed test-fixture corpus — no personal data.

    --from local     Pull bash calls from the user's local Pi session
                     logs at ~/.pi/agent/sessions. Intended for the
                     personal, gitignored validation corpus.

Usage:
    # Refresh the public committed fixture:
    python3 extract-bash-corpus.py --from pi-mono \
        --out ../test-fixtures/bash-corpus.jsonl

    # Build a local validation set from your own session logs:
    python3 extract-bash-corpus.py --from local --days 7 \
        --out ../test-fixtures/bash-corpus.local.jsonl

In both modes the pipeline is:
    1. Pull every toolCall where name == "bash".
    2. Drop empty, multi-line, and over-`--max-bytes` commands.
       (They always fail the classifier's fast-path gate, so they add
       no test signal and just bloat the corpus.)
    3. Run each command through SANITIZERS below as defense-in-depth.
    4. Deduplicate by exact string, sort deterministically.
    5. Write one `{"command": "..."}` object per line.

Requires `duckdb` on PATH for --from pi-mono. The HF dataset is
auto-converted to a single Parquet shard, cached locally.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import time

SECRET_PATTERNS = [
    (r"ghp_[A-Za-z0-9]{20,}", "<REDACTED_GH_TOKEN>"),
    (r"gh[sup]_[A-Za-z0-9]{20,}", "<REDACTED_GH_TOKEN>"),
    (r"github_pat_[A-Za-z0-9_]{20,}", "<REDACTED_GH_TOKEN>"),
    (r"sk-ant-[A-Za-z0-9_\-]{20,}", "<REDACTED_API_KEY>"),
    (r"sk-[A-Za-z0-9]{20,}", "<REDACTED_API_KEY>"),
    (r"xox[baprs]-[A-Za-z0-9\-]{10,}", "<REDACTED_SLACK_TOKEN>"),
    (r"AKIA[0-9A-Z]{16}", "<REDACTED_AWS_KEY>"),
    (r"Bearer\s+[A-Za-z0-9._\-]+", "Bearer <REDACTED>"),
    (
        r"\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b",
        "<REDACTED_JWT>",
    ),
]

PII_PATTERNS = [
    # Email — allow backslash-escaped dots/chars so shell-regex forms like
    # `vince\.chang@airbnb\.com` get caught too.
    (
        r"[A-Za-z0-9._%+\-\\]+@[A-Za-z0-9.\-\\]+\\?\.[A-Za-z]{2,}",
        "<REDACTED_EMAIL>",
    ),
    # ssh user@IP — IPv4 only; the hostname variant is covered by the email regex
    # above for anything with a TLD. Guard against matching pnpm package specs
    # like `@mariozechner+pi-coding-agent@0.67.68_ws` by requiring the host to
    # look like a dotted IP or to contain no digits before the first dot.
    (r"\b[a-z_][a-z0-9_\-]{2,}@(?:\d{1,3}\.){3}\d{1,3}\b", "USER@HOST"),
    # Private IPv4 (10.x, 127.x, 172.16-31.x, 192.168.x).
    (
        r"\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b",
        "<PRIVATE_IP>",
    ),
    # Public IPv4 — catch-all after private redactions. Intentionally runs after
    # the ssh rule so USER@<IP> becomes USER@HOST not USER@<PUBLIC_IP>.
    (r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "<PUBLIC_IP>"),
]

PATH_PATTERNS = [
    (r"/Users/[A-Za-z0-9_.\-]+", "/Users/USER"),
    (r"/home/[A-Za-z0-9_.\-]+", "/home/USER"),
    (r"--Users-[A-Za-z0-9_.\-]+", "--Users-USER"),
    (r"--home-[A-Za-z0-9_.\-]+", "--home-USER"),
    (
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]+Z_[0-9a-f\-]+",
        "<SESSION_ID>",
    ),
]

# Employer-internal project/service/host/codename names. Whole-word replacement.
# Path structure around them is preserved — the classifier cares about shape,
# not identity. Extend as needed.
INTERNAL_NAMES = [
    # Already known from earlier passes.
    "airlab",
    "airbnb-rewrite",
    "treehouse",
    "metagross",
    "aircover",
    "airchat",
    "skipper",
    "signalgateway",
    "clams",
    "scouter",
    "tempo",
    "braintrust",
    "spinnaker",
    "kendall",
    "nerf",
    "sitar",
    # Internal CLIs surfaced in 7-day corpus audit.
    "airinspect",
    "slicer",
    # Internal services / codenames surfaced via com.airbnb.* package paths.
    "gandalf",
    "gandalf-lite",
    "himeji",
    "himejiconfigs",
    "oysterdispatcher",
    "oyster",
    "viaduct",
    "powergrid",
    "jitney",
    "spinaltap",
    "trebuchet",
    # Internal repo/codename identifiers.
    "ergo",
    "twig",
    "pineapple",
    "tools-loop",
    "hep",
]

# Names may appear in three shapes, each needing a different boundary rule:
#   1. Bare word: `airlab`, `clams`  (case-insensitive)
#   2. snake_case neighbour: `svc_metagross`, `metagross_traces`
#   3. CamelCase segment: `ClamsActions`, `CacheJitneyInvalidator`
_NAME_ALT = "|".join(INTERNAL_NAMES)
_NAME_ALT_CAPS = "|".join(n[:1].upper() + n[1:] for n in INTERNAL_NAMES)

INTERNAL_PATTERNS = [
    # Java-style com.airbnb / com/airbnb package paths (leak service + class
    # names). Redact the entire trailing identifier chain.
    (r"com[./]airbnb[./][A-Za-z0-9._/\-]+", "com/airbnb/<internal>"),
    # airbnb-prefixed tool/CLI/package identifiers: airbnb-curl, airbnb-identity,
    # airbnb-sourcegraph-cli, airbnb-auth, airbnb-login-auto-continue, etc.
    (r"(?<![A-Za-z0-9])airbnb-[A-Za-z0-9_\-]+", "airbnb-<internal>"),
    # airbnb_<snake_case> dataset / column / fixture names.
    (r"(?<![A-Za-z0-9])airbnb_[a-z0-9_]+", "airbnb_<internal>"),
    # airbnb.toml (jj config filename).
    (r"\bairbnb\.toml\b", "<internal>.toml"),
    # Bare and snake_case codename occurrences (case-insensitive).
    (
        r"(?i)(?<![A-Za-z0-9])(?:" + _NAME_ALT + r")(?![A-Za-z0-9])",
        "<internal>",
    ),
    # CamelCase-embedded codenames (`ClamsActions`, `CacheJitneyInvalidator`,
    # `RetryTrebuchetOff`, `newTreehouseTestRepo`). Preceded by optional lowercase
    # (the camelCase boundary) and followed by an uppercase letter or non-letter.
    (
        r"(?<![A-Za-z0-9])(?:" + _NAME_ALT_CAPS + r")(?=[A-Z]|[^A-Za-z]|$)",
        "<Internal>",
    ),
    (
        r"(?<=[a-z0-9])(?:" + _NAME_ALT_CAPS + r")(?=[A-Z]|[^A-Za-z]|$)",
        "<Internal>",
    ),
    # Airbnb CDN. Permissive match: tolerate backslash-escaped dots inside
    # shell-regex forms like `https://a0\.muscache\.com/...`.
    (r"(?:[A-Za-z0-9_\-]+\\?\.)*muscache\\?\.com", "<internal-host>"),
    # Any *.musta.ch or bare musta.ch → internal host. Same backslash tolerance.
    (r"(?:[A-Za-z0-9_\-]+\\?\.)*musta\\?\.ch", "<internal-host>"),
    # Internal airbnb.* hostnames.
    (
        r"https?://([A-Za-z0-9.\-]+\.airbnb\.(?:com|tools))(/[A-Za-z0-9._/\-?=&#%]*)?",
        "https://<internal-host>/<path>",
    ),
    (r"(?:[A-Za-z0-9_\-]+\.)+airbnb\.tools", "<internal-host>"),
    (r"\bairbnb\.tools\b", "<internal-host>"),
    # DuckDB / airinspect data-warehouse schema leaks (`FROM core.logs`,
    # `FROM analysis.airbnb_context_logs`, etc.).
    (r"\b(?:analysis|core)\.[a-z][a-z0-9_.]+", "<internal-table>"),
    # Known product/concept names that leak via grep targets, test names, and
    # method references. Match any contiguous PascalCase token that contains
    # these strings. Add terms only when you've verified them in the corpus.
    (
        r"\b[A-Za-z0-9]*(?:HostEarningsProtection|HostEarnings|ClaimEntityTree|"
        r"ClaimEvidence|ClaimItem|HostGuarantee|CheckoutQuote)[A-Za-z0-9]*",
        "<InternalProduct>",
    ),
    # Very long digit runs (claim IDs, listing IDs, flake IDs).
    (r"\b[0-9]{10,}\b", "<INTERNAL_ID>"),
    # Collapse consecutive <internal> placeholders (`airlab/metagross/aircover`
    # → `<internal>/<internal>/<internal>` → `<internal>`).
    (r"(?:<internal>[-_/])+<internal>", "<internal>"),
]

ALL_PATTERNS = [
    (re.compile(pat), repl)
    for pat, repl in SECRET_PATTERNS + PII_PATTERNS + PATH_PATTERNS + INTERNAL_PATTERNS
]


def sanitize(cmd: str) -> str:
    out = cmd
    for pat, repl in ALL_PATTERNS:
        out = pat.sub(repl, out)
    return out


def extract_from(path: pathlib.Path) -> list[str]:
    found: list[str] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return found
    for line in text.splitlines():
        try:
            obj = json.loads(line)
        except Exception:
            continue
        content = obj.get("message", {}).get("content", [])
        if not isinstance(content, list):
            continue
        for c in content:
            if (
                isinstance(c, dict)
                and c.get("type") == "toolCall"
                and c.get("name") == "bash"
            ):
                args = c.get("arguments") or c.get("input") or {}
                cmd = args.get("command")
                if isinstance(cmd, str) and cmd.strip():
                    found.append(cmd)
    return found


PI_MONO_PARQUET_URL = (
    "https://huggingface.co/api/datasets/badlogicgames/pi-mono"
    "/parquet/default/train/0.parquet"
)


def pull_from_pi_mono(cache_dir: pathlib.Path, max_bytes: int, keep_multiline: bool) -> list[str]:
    """Download pi-mono, extract bash commands via duckdb. Returns pre-sanitize list."""
    import shutil
    import subprocess

    if not shutil.which("duckdb"):
        sys.exit("error: --from pi-mono requires `duckdb` on PATH (install via mise / brew).")
    cache_dir.mkdir(parents=True, exist_ok=True)
    parquet_path = cache_dir / "pi-mono-0.parquet"
    if not parquet_path.exists():
        print(f"downloading pi-mono parquet → {parquet_path}", file=sys.stderr)
        import urllib.request

        urllib.request.urlretrieve(PI_MONO_PARQUET_URL, parquet_path)  # noqa: S310

    multiline_filter = "" if keep_multiline else " AND command NOT LIKE '%' || chr(10) || '%'"
    sql = f"""
COPY (
  WITH exploded AS (
    SELECT unnest(traces) AS t FROM read_parquet('{parquet_path.as_posix()}')
  ),
  messages AS (
    SELECT json_extract(t, '$.message.content') AS content FROM exploded
    WHERE json_extract_string(t, '$.type') = 'message'
      AND json_extract_string(t, '$.message.content') IS NOT NULL
  ),
  content_items AS (
    SELECT unnest(from_json(content, '["JSON"]')) AS item
    FROM messages WHERE content LIKE '[%'
  ),
  bash_raw AS (
    SELECT coalesce(
      json_extract_string(item, '$.arguments.command'),
      json_extract_string(item, '$.input.command')
    ) AS command
    FROM content_items
    WHERE json_extract_string(item, '$.type') = 'toolCall'
      AND json_extract_string(item, '$.name') = 'bash'
  )
  SELECT DISTINCT command FROM bash_raw
  WHERE command IS NOT NULL AND trim(command) <> ''
    AND length(command) <= {max_bytes}{multiline_filter}
  ORDER BY command
) TO '{cache_dir}/pi-mono-raw.jsonl' (FORMAT JSON);
""".strip()

    subprocess.run(["duckdb", "-c", sql], check=True)
    raw: list[str] = []
    with (cache_dir / "pi-mono-raw.jsonl").open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                raw.append(json.loads(line)["command"])
    return raw


def pull_from_local(
    sessions: pathlib.Path,
    days: float,
    max_bytes: int,
    keep_multiline: bool,
) -> list[str]:
    cutoff = time.time() - days * 86400
    raw: list[str] = []
    files_scanned = 0
    for jsonl in sessions.rglob("*.jsonl"):
        try:
            if jsonl.stat().st_mtime < cutoff:
                continue
        except OSError:
            continue
        files_scanned += 1
        raw.extend(extract_from(jsonl))
    # Apply the same filters as the pi-mono pull so behaviour is consistent.
    filtered: list[str] = []
    for cmd in raw:
        if not keep_multiline and "\n" in cmd:
            continue
        if len(cmd) > max_bytes:
            continue
        filtered.append(cmd)
    print(f"scanned {files_scanned} session files in {sessions}", file=sys.stderr)
    return filtered


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--from",
        dest="source",
        choices=("pi-mono", "local"),
        default="pi-mono",
        help="Corpus source. 'pi-mono' = public HF dataset (default). 'local' = ~/.pi/agent/sessions.",
    )
    parser.add_argument("--days", type=float, default=7, help="local mode only")
    parser.add_argument(
        "--sessions",
        type=pathlib.Path,
        default=pathlib.Path.home() / ".pi/agent/sessions",
        help="local mode only",
    )
    parser.add_argument(
        "--cache-dir",
        type=pathlib.Path,
        default=pathlib.Path("/tmp/pi-mono-cache"),
        help="pi-mono mode: where to cache the downloaded parquet shard",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=2048,
        help="Drop commands longer than this (they always fail our fast-path gate).",
    )
    parser.add_argument("--keep-multiline", action="store_true")
    parser.add_argument(
        "--redact-username",
        action="append",
        default=[],
        help=(
            "Extra username token to redact globally. Defaults to $USER at runtime; "
            "pass additional tokens (e.g. --redact-username badlogic) to cover aliases."
        ),
    )
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()

    import getpass
    username_tokens = {getpass.getuser(), *args.redact_username}
    if args.source == "pi-mono":
        # pi-mono is authored by badlogic (Mario Zechner). Normalizing his
        # public handle to `USER` keeps paths canonical across the two corpora.
        username_tokens.add("badlogic")
    extra = [
        (re.compile(r"(?<![A-Za-z0-9])" + re.escape(u) + r"(?![A-Za-z0-9])"), "USER")
        for u in username_tokens
        if u
    ]
    ALL_PATTERNS[:0] = extra

    if args.source == "pi-mono":
        raw = pull_from_pi_mono(args.cache_dir, args.max_bytes, args.keep_multiline)
    else:
        raw = pull_from_local(args.sessions, args.days, args.max_bytes, args.keep_multiline)

    sanitized = sorted({sanitize(c) for c in raw})
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        for cmd in sanitized:
            f.write(json.dumps({"command": cmd}) + "\n")

    print(
        f"source={args.source}",
        f"  raw bash calls        : {len(raw)}",
        f"  unique after sanitize : {len(sanitized)}",
        f"  output                : {args.out}",
        sep="\n",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
