from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from .cache import cache_status
from .indexer import run_index
from .queries import run_query_command
from .reader import READ_MODES, run_read_command
from .roots import RootResolutionError, resolve_target_root
from .websocket import run_ws_command


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="session-explorer",
        description="Explore many Pi session JSONL files with an indexed workflow.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    index_parser = subparsers.add_parser("index", help="Build or refresh the local index")
    index_parser.add_argument("--root", help="Project root to resolve against Pi sessions")
    index_parser.add_argument("--status", action="store_true", help="Show cache/index status")

    read_parser = subparsers.add_parser("read", help="Read one Pi session JSONL")
    read_parser.add_argument("session_path", help="Path to the .jsonl session file")
    read_parser.add_argument("--mode", choices=READ_MODES, default="overview")
    read_parser.add_argument("--offset", type=int, default=0, help="Skip first N user turns")
    read_parser.add_argument("--limit", type=int, default=0, help="Limit user turns (0=all)")
    read_parser.add_argument(
        "--max-content",
        type=int,
        default=2000,
        help="Max chars per content block (0=unlimited)",
    )

    subparsers.add_parser("sessions", help="Show grouped session summaries")

    search_parser = subparsers.add_parser("search", help="Search indexed session content")
    search_parser.add_argument("--value", default="", help="Value to search for")

    ws_parser = subparsers.add_parser("ws", help="Summarize WebSocket diagnostics")
    ws_parser.add_argument("--root", help="Project root or directory of session JSONLs")
    ws_parser.add_argument(
        "--since",
        default="48h",
        help="Time window such as 48h or 7d, relative to the latest diagnostic in the scan",
    )
    ws_parser.add_argument("--errors", action="store_true", help="Show only non-completed outcomes")
    ws_parser.add_argument(
        "--slow-start-ms",
        type=int,
        default=0,
        help="Show only diagnostics with slow responseCreatedMs/firstEventMs",
    )
    ws_parser.add_argument(
        "--continuation",
        action="store_true",
        help="Show only diagnostics with continuation/fallback metadata",
    )

    subparsers.add_parser("timeline", help="Show a timeline view")
    subparsers.add_parser("tool-calls", help="Show tool-call-focused view")

    sql_parser = subparsers.add_parser("sql", help="Run ad-hoc SQL (escape hatch)")
    sql_parser.add_argument("--query", default="", help="SQL query text")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "index":
        try:
            resolved_root = resolve_target_root(explicit_root=args.root)
        except RootResolutionError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

        if args.status:
            print(cache_status(resolved_root))
            return 0

        print(run_index())
        return 0

    if args.command == "read":
        try:
            print(run_read_command(args))
        except FileNotFoundError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        return 0

    if args.command == "ws":
        direct_root = Path(args.root).expanduser().resolve() if args.root else None
        try:
            resolved_root = resolve_target_root(explicit_root=args.root)
        except RootResolutionError as exc:
            if direct_root and direct_root.is_dir() and any(direct_root.rglob("*.jsonl")):
                print(run_ws_command(args, direct_root))
                return 0
            print(f"error: {exc}", file=sys.stderr)
            return 2
        print(run_ws_command(args, resolved_root.session_root))
        return 0

    print(run_query_command(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
