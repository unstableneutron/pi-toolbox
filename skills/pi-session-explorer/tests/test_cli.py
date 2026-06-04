from __future__ import annotations

import json
import importlib
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace


def write_sample_session(path: Path) -> None:
    records = [
        {
            "type": "session",
            "version": 3,
            "id": "session-test",
            "timestamp": "2026-06-04T04:18:58.077Z",
            "cwd": "/tmp/project",
        },
        {
            "type": "model_change",
            "provider": "openai-codex",
            "modelId": "gpt-5.5-fast",
        },
        {
            "type": "message",
            "timestamp": "2026-06-04T04:18:59.000Z",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "Reply with exactly FIRST." }],
                "timestamp": 1780546739000,
            },
        },
        {
            "type": "message",
            "timestamp": "2026-06-04T04:19:00.000Z",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "FIRST" }],
                "api": "openai-websocket-responses",
                "provider": "openai-codex",
                "model": "gpt-5.5-fast",
                "usage": {
                    "input": 10,
                    "output": 2,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 12,
                    "cost": {
                        "input": 0.01,
                        "output": 0.02,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "total": 0.03,
                    },
                },
                "stopReason": "stop",
                "diagnostics": [
                    {
                        "type": "openai_websocket_transport",
                        "details": {
                            "outcome": "completed",
                            "requestBytes": 6025,
                            "continuation": "no_continuation",
                            "sentInputItems": 1,
                            "firstEventMs": 1200,
                            "responseCreatedMs": 1449,
                            "completedMs": 2243,
                            "responseIdSeen": True,
                        },
                    }
                ],
            },
        },
        {
            "type": "message",
            "timestamp": "2026-06-04T04:19:01.000Z",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "SECOND" }],
                "api": "openai-websocket-responses",
                "provider": "openai-codex",
                "model": "gpt-5.5-fast",
                "usage": {
                    "input": 11,
                    "output": 2,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 13,
                    "cost": {
                        "input": 0.01,
                        "output": 0.02,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "total": 0.03,
                    },
                },
                "stopReason": "stop",
                "diagnostics": [
                    {
                        "type": "openai_websocket_transport",
                        "details": {
                            "outcome": "completed",
                            "previousResponseId": "resp_previous",
                            "requestBytes": 6107,
                            "continuation": "delta",
                            "sentInputItems": 1,
                            "fullInputItems": 3,
                            "fullBytes": 6322,
                            "firstEventMs": 303,
                            "responseCreatedMs": 346,
                            "completedMs": 1315,
                            "responseIdSeen": True,
                        },
                    }
                ],
            },
        },
    ]
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")


def write_empty_transport_error_session(path: Path) -> None:
    records = [
        {
            "type": "session",
            "version": 3,
            "id": "error-session",
            "timestamp": "2026-06-04T03:09:37.231Z",
            "cwd": "/tmp/project",
        },
        {
            "type": "message",
            "timestamp": "2026-06-04T03:09:38.004Z",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "Do the thing."}],
            },
        },
        {
            "type": "message",
            "timestamp": "2026-06-04T03:14:39.171Z",
            "message": {
                "role": "assistant",
                "content": [],
                "model": "gpt-5.5",
                "usage": {"input": 0, "output": 0, "cost": {"total": 0}},
                "stopReason": "error",
                "diagnostics": [
                    {
                        "type": "openai_websocket_transport",
                        "details": {
                            "outcome": "transport_error",
                            "eventCount": 2,
                            "responseIdSeen": False,
                        },
                    }
                ],
            },
        },
    ]
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")


def write_subagent_parent_session(path: Path) -> None:
    nested = path.parent / path.stem / "abcd1234" / "run-0"
    nested.mkdir(parents=True)
    write_sample_session(nested / "session.jsonl")

    records = [
        {
            "type": "session",
            "version": 3,
            "id": "parent-session",
            "timestamp": "2026-06-04T03:00:00.000Z",
            "cwd": "/tmp/project",
        },
        {
            "type": "message",
            "timestamp": "2026-06-04T03:00:01.000Z",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "tc-list",
                        "name": "subagent",
                        "arguments": {"action": "list"},
                    }
                ],
            },
        },
        {
            "type": "message",
            "timestamp": "2026-06-04T03:00:01.100Z",
            "message": {
                "role": "toolResult",
                "toolName": "subagent",
                "toolCallId": "tc-list",
                "content": [{"type": "text", "text": "Executable agents: worker"}],
                "details": {"mode": "management", "results": []},
            },
        },
        {
            "type": "message",
            "timestamp": "2026-06-04T03:00:02.000Z",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "tc-async",
                        "name": "subagent",
                        "arguments": {"tasks": [{"agent": "worker", "task": "Check things"}], "async": True},
                    }
                ],
            },
        },
        {
            "type": "message",
            "timestamp": "2026-06-04T03:00:02.100Z",
            "message": {
                "role": "toolResult",
                "toolName": "subagent",
                "toolCallId": "tc-async",
                "content": [{"type": "text", "text": "Async parallel: [worker] [abcd1234]"}],
                "details": {
                    "mode": "parallel",
                    "runId": "abcd1234",
                    "asyncId": "abcd1234",
                    "asyncDir": "/tmp/pi-subagent/abcd1234",
                    "results": [],
                },
            },
        },
        {
            "type": "message",
            "timestamp": "2026-06-04T03:00:03.000Z",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "tc-done",
                        "name": "subagent",
                        "arguments": {"tasks": [{"agent": "worker", "task": "Check things"}]},
                    }
                ],
            },
        },
        {
            "type": "message",
            "timestamp": "2026-06-04T03:00:03.100Z",
            "message": {
                "role": "toolResult",
                "toolName": "subagent",
                "toolCallId": "tc-done",
                "content": [{"type": "text", "text": "Done"}],
                "details": {
                    "mode": "parallel",
                    "results": [
                        {
                            "agent": "worker",
                            "task": "Check things",
                            "exitCode": 0,
                            "model": "anthropic/claude-sonnet-4-6:medium",
                            "usage": {"input": 10, "output": 5, "cacheRead": 0, "cost": 0.01},
                            "progressSummary": {"durationMs": 1000, "toolCount": 2},
                            "artifactPaths": {"jsonlPath": "/tmp/subagent-artifacts/abcd1234_worker_0.jsonl"},
                        }
                    ],
                },
            },
        },
    ]
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")


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
    for command in ("index", "read", "sessions", "search", "timeline", "tool-calls", "ws", "sql"):
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


def test_cli_read_overview_ports_session_reader(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"
    session = tmp_path / "session.jsonl"
    write_sample_session(session)

    result = subprocess.run(
        [str(script), "read", str(session), "--mode", "overview"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "SESSION OVERVIEW" in result.stdout
    assert "gpt-5.5-fast" in result.stdout
    assert "Session cost: $0.0600" in result.stdout


def test_cli_read_overview_explains_empty_transport_errors(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"
    session = tmp_path / "session.jsonl"
    write_empty_transport_error_session(session)

    result = subprocess.run(
        [str(script), "read", str(session), "--mode", "overview"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "transport_error" in result.stdout
    assert "events=2" in result.stdout
    assert "responseIdSeen=False" in result.stdout


def test_cli_read_overview_explains_diagnostics_without_usage(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"
    session = tmp_path / "session.jsonl"
    write_empty_transport_error_session(session)
    records = [json.loads(line) for line in session.read_text().splitlines()]
    records[2]["message"].pop("usage")
    session.write_text("\n".join(json.dumps(record) for record in records) + "\n")

    result = subprocess.run(
        [str(script), "read", str(session), "--mode", "overview"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "transport_error" in result.stdout


def test_cli_read_websocket_summarizes_transport_diagnostics(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"
    session = tmp_path / "session.jsonl"
    write_sample_session(session)

    result = subprocess.run(
        [str(script), "read", str(session), "--mode", "websocket"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "WEBSOCKET DIAGNOSTICS" in result.stdout
    assert "no_continuation" in result.stdout
    assert "delta" in result.stdout
    assert "6107/6322" in result.stdout
    assert "1/3" in result.stdout


def test_cli_read_diagnostics_lists_transport_fields(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"
    session = tmp_path / "session.jsonl"
    write_sample_session(session)

    result = subprocess.run(
        [str(script), "read", str(session), "--mode", "diagnostics"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "SESSION DIAGNOSTICS" in result.stdout
    assert "openai_websocket_transport" in result.stdout
    assert "continuation: delta" in result.stdout
    assert "fullBytes: 6322" in result.stdout


def test_cli_read_subagents_numbers_invocations_and_shows_async_metadata(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"
    session = tmp_path / "parent.jsonl"
    write_subagent_parent_session(session)

    result = subprocess.run(
        [str(script), "read", str(session), "--mode", "subagents"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "INVOCATION #1 — mode: management" in result.stdout
    assert "INVOCATION #2 — mode: parallel" in result.stdout
    assert "INVOCATION #3 — mode: parallel" in result.stdout
    assert "Run ID:   abcd1234" in result.stdout
    assert "Async:    /tmp/pi-subagent/abcd1234" in result.stdout
    assert str(session.parent / "parent" / "abcd1234" / "run-0" / "session.jsonl") in result.stdout


def test_cli_ws_scans_session_root_for_websocket_diagnostics(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"
    sessions_root = tmp_path / "sessions"
    project_root = tmp_path / "project"
    session_dir = sessions_root / "--tmp-project--"
    project_root.mkdir()
    session_dir.mkdir(parents=True)
    write_sample_session(session_dir / "2026-06-04T04-18-58-077Z_session-test.jsonl")

    result = subprocess.run(
        [
            str(script),
            "ws",
            "--root",
            str(session_dir),
            "--since",
            "48h",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "WS DIAGNOSTICS SUMMARY" in result.stdout
    assert "total diagnostics: 2" in result.stdout
    assert "delta: 1" in result.stdout
    assert "no_continuation: 1" in result.stdout


def test_cli_ws_scans_arbitrary_jsonl_directory(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"
    scratch_dir = tmp_path / "openai-ws-smoke-sessions"
    scratch_dir.mkdir()
    write_sample_session(scratch_dir / "smoke.jsonl")

    result = subprocess.run(
        [
            str(script),
            "ws",
            "--root",
            str(scratch_dir),
            "--since",
            "48h",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "WS DIAGNOSTICS SUMMARY" in result.stdout
    assert "total diagnostics: 2" in result.stdout


def test_cli_ws_prefers_resolved_project_sessions_over_direct_jsonl_fallback(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    skill_root = Path(__file__).resolve().parents[1]
    if str(skill_root) not in sys.path:
        sys.path.insert(0, str(skill_root))

    main_module = importlib.import_module("pi_session_explorer.main")

    project_root = tmp_path / "project"
    project_root.mkdir()
    write_sample_session(project_root / "local-session.jsonl")
    resolved_session_root = tmp_path / "sessions" / "--tmp-project--"
    resolved_session_root.mkdir(parents=True)

    called = {}

    def fake_resolve_target_root(explicit_root=None):
        assert explicit_root == str(project_root)
        return SimpleNamespace(session_root=resolved_session_root)

    def fake_run_ws_command(args, session_root):
        called["session_root"] = session_root
        return f"selected {session_root}"

    monkeypatch.setattr(main_module, "resolve_target_root", fake_resolve_target_root)
    monkeypatch.setattr(main_module, "run_ws_command", fake_run_ws_command)

    exit_code = main_module.main(["ws", "--root", str(project_root)])

    captured = capsys.readouterr()
    assert exit_code == 0
    assert called["session_root"] == resolved_session_root
    assert f"selected {resolved_session_root}" in captured.out


def test_cli_ws_filters_errors_slow_starts_and_continuations(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"
    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    session = session_dir / "filters.jsonl"
    write_sample_session(session)

    records = [json.loads(line) for line in session.read_text().splitlines()]
    records[3]["message"]["diagnostics"][0]["details"]["outcome"] = "transport_error"
    session.write_text("\n".join(json.dumps(record) for record in records) + "\n")

    errors = subprocess.run(
        [str(script), "ws", "--root", str(session_dir), "--errors"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert errors.returncode == 0, errors.stderr
    assert "total diagnostics: 1" in errors.stdout
    assert "transport_error" in errors.stdout
    assert "delta" not in errors.stdout

    slow = subprocess.run(
        [str(script), "ws", "--root", str(session_dir), "--slow-start-ms", "1000"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert slow.returncode == 0, slow.stderr
    assert "total diagnostics: 1" in slow.stdout
    assert "transport_error" in slow.stdout

    continuation = subprocess.run(
        [str(script), "ws", "--root", str(session_dir), "--continuation"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert continuation.returncode == 0, continuation.stderr
    assert "total diagnostics: 2" in continuation.stdout
    assert "no_continuation: 1" in continuation.stdout
    assert "delta: 1" in continuation.stdout


def test_cli_ws_does_not_truncate_long_outcome_names_in_rows(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "bin" / "session-explorer"
    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    session = session_dir / "long-outcome.jsonl"
    write_sample_session(session)

    records = [json.loads(line) for line in session.read_text().splitlines()]
    records[3]["message"]["diagnostics"][0]["details"][
        "outcome"
    ] = "previous_response_not_found_fallback_succeeded"
    session.write_text("\n".join(json.dumps(record) for record in records) + "\n")

    result = subprocess.run(
        [str(script), "ws", "--root", str(session_dir)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    row = next(line for line in result.stdout.splitlines() if "long-outcome.jsonl" in line)
    assert "previous_response_not_found_fallback_succeeded" in row
