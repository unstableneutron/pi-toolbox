from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _parse_time(value: object) -> datetime | None:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, timezone.utc)
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _parse_since(value: str) -> timedelta:
    value = value.strip().lower()
    if not value:
        return timedelta(hours=48)
    unit = value[-1]
    amount_text = value[:-1] if unit in {"h", "d"} else value
    try:
        amount = int(amount_text)
    except ValueError:
        return timedelta(hours=48)
    if unit == "d":
        return timedelta(days=amount)
    return timedelta(hours=amount)


def _iter_websocket_diagnostics(session_root: Path):
    for path in sorted(session_root.rglob("*.jsonl")):
        try:
            lines = path.read_text(errors="ignore").splitlines()
        except OSError:
            continue
        for line_number, line in enumerate(lines, start=1):
            if "openai_websocket_transport" not in line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = record.get("message") or {}
            timestamp = _parse_time(record.get("timestamp") or message.get("timestamp"))
            for diagnostic in message.get("diagnostics") or []:
                if diagnostic.get("type") != "openai_websocket_transport":
                    continue
                yield {
                    "path": path,
                    "line": line_number,
                    "timestamp": timestamp,
                    "model": message.get("model") or "-",
                    "details": diagnostic.get("details") or {},
                }


def _startup_ms(details: dict) -> int | float | None:
    value = details.get("responseCreatedMs", details.get("firstEventMs"))
    return value if isinstance(value, (int, float)) else None


def _bytes_summary(details: dict) -> str:
    request_bytes = details.get("requestBytes")
    full_bytes = details.get("fullBytes")
    if request_bytes is None:
        return "-"
    if full_bytes is not None:
        return f"{request_bytes}/{full_bytes}"
    return str(request_bytes)


def run_ws_command(args, session_root: Path) -> str:
    """Summarize OpenAI WebSocket diagnostics across a Pi sessions directory."""
    rows = list(_iter_websocket_diagnostics(session_root))
    latest = max((row["timestamp"] for row in rows if row["timestamp"]), default=None)
    cutoff = latest - _parse_since(args.since) if latest else None

    filtered = []
    for row in rows:
        details = row["details"]
        if cutoff and row["timestamp"] and row["timestamp"] < cutoff:
            continue
        if args.errors and details.get("outcome") == "completed":
            continue
        if args.slow_start_ms and ((_startup_ms(details) or 0) < args.slow_start_ms):
            continue
        if args.continuation and not (details.get("continuation") or details.get("fallback")):
            continue
        filtered.append(row)

    outcomes = Counter(row["details"].get("outcome", "-") for row in filtered)
    continuations = Counter(row["details"].get("continuation", "-") for row in filtered)
    starts = sorted(ms for row in filtered if (ms := _startup_ms(row["details"])) is not None)

    lines = [
        "=" * 70,
        "WS DIAGNOSTICS SUMMARY",
        "=" * 70,
        f"session root: {session_root}",
        f"window latest: {latest.isoformat() if latest else '-'}",
        f"total diagnostics: {len(filtered)}",
    ]
    if outcomes:
        lines.append("outcomes: " + ", ".join(f"{key}: {value}" for key, value in outcomes.items()))
    if continuations:
        lines.append(
            "continuations: " + ", ".join(f"{key}: {value}" for key, value in continuations.items())
        )
    if starts:
        lines.append(f"startup ms: min={starts[0]} p50={starts[len(starts)//2]} max={starts[-1]}")

    lines.extend([
        "",
        f"{'Time':<8} {'Model':<24} {'Outcome':<48} {'Cont':<18} {'Start':>8} {'Bytes':>14} File",
        "-" * 110,
    ])
    for row in filtered[:50]:
        details = row["details"]
        ts = row["timestamp"].strftime("%H:%M:%S") if row["timestamp"] else "?"
        lines.append(
            f"{ts:<8} {row['model']:<24.24} {str(details.get('outcome', '-')):<48} "
            f"{str(details.get('continuation', '-')):<18.18} {str(_startup_ms(details) or '-'):>8} "
            f"{_bytes_summary(details):>14} {row['path'].name}:{row['line']}"
        )
    return "\n".join(lines)
