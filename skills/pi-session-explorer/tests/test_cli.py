from __future__ import annotations

import subprocess
from pathlib import Path


def test_cli_help_lists_bootstrap_commands() -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"

    result = subprocess.run(
        [str(script), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr

    help_text = result.stdout
    for command in ("index", "sessions", "search", "timeline", "tool-calls", "sql"):
        assert command in help_text


def test_cli_index_status_runs_bootstrap_subcommand() -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"

    result = subprocess.run(
        [str(script), "index", "--status"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "index status: bootstrap skeleton" in result.stdout
