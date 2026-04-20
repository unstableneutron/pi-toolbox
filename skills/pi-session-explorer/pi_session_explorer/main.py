from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from .cache import cache_status
from .indexer import run_index
from .queries import run_query_command
from .roots import RootResolutionError, resolve_target_root


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="session-explorer",
        description="Explore many Pi session JSONL files with an indexed workflow.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    index_parser = subparsers.add_parser("index", help="Build or refresh the local index")
    index_parser.add_argument("--root", help="Project root to resolve against Pi sessions")
    index_parser.add_argument("--status", action="store_true", help="Show cache/index status")

    subparsers.add_parser("sessions", help="Show grouped session summaries")

    search_parser = subparsers.add_parser("search", help="Search indexed session content")
    search_parser.add_argument("--value", default="", help="Value to search for")

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

    print(run_query_command(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
