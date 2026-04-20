from __future__ import annotations

import argparse


def run_query_command(args: argparse.Namespace) -> str:
    """Bootstrap query command dispatcher."""
    command = args.command
    return f"{command}: bootstrap command wired (query logic not implemented yet)"
