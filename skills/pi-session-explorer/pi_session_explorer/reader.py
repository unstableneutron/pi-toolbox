# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Parse pi session JSONL files into readable formats.

Usage:
    session-explorer read <session_path> [--mode MODE] [--offset N] [--limit N] [--max-content N]

Modes:
    overview      Session metadata + turn-by-turn summary (default)
    conversation  User and assistant text only (no tool calls/results)
    full          Everything including tool calls and results
    tools         Tool calls and results only
    costs         Cost breakdown per assistant turn
    subagents     Subagent calls: task, agent, model, cost, status, session paths
    diagnostics   Assistant diagnostics such as transport errors
    websocket     OpenAI WebSocket transport latency and continuation details
"""

import json
import sys
import argparse
import io
from pathlib import Path
from contextlib import redirect_stdout
from datetime import datetime

READ_MODES = [
    "overview",
    "conversation",
    "full",
    "tools",
    "costs",
    "subagents",
    "diagnostics",
    "websocket",
]


def parse_args():
    parser = argparse.ArgumentParser(description="Read pi session JSONL files")
    parser.add_argument("session_path", help="Path to the .jsonl session file")
    parser.add_argument(
        "--mode",
        choices=READ_MODES,
        default="overview",
        help="Output mode (default: overview)",
    )
    parser.add_argument(
        "--offset", type=int, default=0, help="Skip first N message turns"
    )
    parser.add_argument(
        "--limit", type=int, default=0, help="Show at most N message turns (0=all)"
    )
    parser.add_argument(
        "--max-content",
        type=int,
        default=2000,
        help="Max chars per content block (default: 2000, 0=unlimited)",
    )
    return parser.parse_args()


def truncate(text: str, max_len: int) -> str:
    if max_len <= 0 or len(text) <= max_len:
        return text
    return text[:max_len] + f"\n... [truncated, {len(text)} chars total]"


def format_timestamp(ts) -> str:
    if not ts:
        return "?"
    try:
        if isinstance(ts, (int, float)):
            dt = datetime.fromtimestamp(ts / 1000)
            return dt.strftime("%H:%M:%S")
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt.strftime("%H:%M:%S")
    except (ValueError, AttributeError, OSError):
        return str(ts)[:8]


def format_duration(ms: int | float) -> str:
    secs = int(ms / 1000)
    if secs < 60:
        return f"{secs}s"
    mins = secs // 60
    secs = secs % 60
    return f"{mins}m{secs}s"


def parse_session(path: str) -> tuple[dict, list[dict], list[dict]]:
    """Parse a session file into (metadata, events, messages)."""
    metadata = {}
    events = []
    messages = []

    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            t = obj.get("type")

            if t == "session":
                metadata = obj
            elif t in ("model_change", "thinking_level_change"):
                events.append(obj)
            elif t == "message":
                messages.append(obj)

    return metadata, events, messages


def extract_subagent_details(msg: dict) -> dict | None:
    """Extract subagent details from a toolResult message."""
    if msg.get("role") != "toolResult" or msg.get("toolName") != "subagent":
        return None
    details = msg.get("details")
    if not details:
        return None
    return details


def extract_turns(messages: list[dict]) -> list[dict]:
    """Convert raw message entries into structured turns."""
    turns = []

    for entry in messages:
        msg = entry.get("message", {})
        role = msg.get("role", "")
        content = msg.get("content", "")
        timestamp = entry.get("timestamp", msg.get("timestamp", ""))

        turn = {
            "role": role,
            "timestamp": timestamp,
            "texts": [],
            "tool_calls": [],
            "thinking": [],
            "is_error": msg.get("isError", False),
        }

        # Extract cost info from assistant messages
        if role == "assistant":
            turn["diagnostics"] = msg.get("diagnostics", [])
            usage = msg.get("usage", {})
            if usage:
                turn["model"] = msg.get("model", "")
                turn["provider"] = msg.get("provider", "")
                turn["usage"] = usage
                turn["stop_reason"] = msg.get("stopReason", "")

        if isinstance(content, str):
            if content.strip():
                turn["texts"].append(content)
        elif isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                item_type = item.get("type", "")

                if item_type == "text" and item.get("text", "").strip():
                    turn["texts"].append(item["text"])
                elif item_type == "toolCall":
                    turn["tool_calls"].append(
                        {
                            "id": item.get("id", ""),
                            "name": item.get("name", ""),
                            "arguments": item.get("arguments", {}),
                        }
                    )
                elif item_type == "thinking":
                    thinking_text = item.get("thinking", "")
                    if thinking_text:
                        turn["thinking"].append(thinking_text)

        # For toolResult messages
        if role == "toolResult":
            turn["tool_call_id"] = msg.get("toolCallId", "")
            turn["tool_name"] = msg.get("toolName", "")
            result_content = msg.get("content", "")
            turn["texts"] = []
            if isinstance(result_content, list):
                for item in result_content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        turn["texts"].append(item.get("text", ""))
            elif isinstance(result_content, str) and result_content.strip():
                turn["texts"].append(result_content)

            # Capture subagent details
            subagent_details = extract_subagent_details(msg)
            if subagent_details:
                turn["subagent_details"] = subagent_details

        turns.append(turn)

    return turns


def format_subagent_summary(details: dict) -> str:
    """Format a compact subagent result summary."""
    mode = details.get("mode", "?")
    results = details.get("results", [])

    parts = []
    total_cost = 0
    total_duration = 0

    for r in results:
        agent = r.get("agent", "?")
        exit_code = r.get("exitCode", -1)
        status_icon = "✓" if exit_code == 0 else "❌"
        model = r.get("model", "")
        usage = r.get("usage", {})
        cost = usage.get("cost", 0)
        total_cost += cost
        progress = r.get("progressSummary", {})
        duration = progress.get("durationMs", 0)
        total_duration += duration
        tool_count = progress.get("toolCount", 0)
        task = r.get("task", "")[:100].replace("\n", " ")

        parts.append(f"  {status_icon} {agent} ({model}): {task}")
        if cost or duration:
            parts.append(
                f"    ${cost:.4f} | {format_duration(duration)} | {tool_count} tools"
            )

    header = f"🔀 SUBAGENT [{mode}] — {len(results)} run(s), ${total_cost:.4f}, {format_duration(total_duration)}"
    return header + "\n" + "\n".join(parts)


def summarize_assistant_diagnostics(turn: dict) -> str | None:
    """Return a compact diagnostic reason for overview rows."""
    diagnostics = turn.get("diagnostics") or []
    if not diagnostics:
        return None

    for diagnostic in diagnostics:
        if diagnostic.get("type") != "openai_websocket_transport":
            continue
        details = diagnostic.get("details", {})
        outcome = details.get("outcome")
        if not outcome:
            continue
        suffix = []
        if "eventCount" in details:
            suffix.append(f"events={details['eventCount']}")
        if "responseIdSeen" in details:
            suffix.append(f"responseIdSeen={details['responseIdSeen']}")
        return f"diagnostic: {outcome}{' (' + ', '.join(suffix) + ')' if suffix else ''}"

    diagnostic_type = diagnostics[0].get("type")
    return f"diagnostic: {diagnostic_type}" if diagnostic_type else None


def print_overview(metadata: dict, events: list[dict], turns: list[dict], args):
    """Print session metadata and a summary of each turn."""
    print("=" * 70)
    print("SESSION OVERVIEW")
    print("=" * 70)
    print(f"  ID:        {metadata.get('id', 'N/A')}")
    print(f"  CWD:       {metadata.get('cwd', 'N/A')}")
    print(f"  Started:   {metadata.get('timestamp', 'N/A')}")
    print(f"  Version:   {metadata.get('version', 'N/A')}")

    for evt in events:
        if evt["type"] == "model_change":
            print(f"  Model:     {evt.get('provider', '')}/{evt.get('modelId', '')}")
        elif evt["type"] == "thinking_level_change":
            print(f"  Thinking:  {evt.get('thinkingLevel', '')}")

    # Cost summary (main session only)
    total_cost = 0
    total_input = 0
    total_output = 0
    for turn in turns:
        usage = turn.get("usage", {})
        cost = usage.get("cost", {})
        total_cost += cost.get("total", 0)
        total_input += usage.get("input", 0)
        total_output += usage.get("output", 0)

    # Subagent cost summary
    subagent_cost = 0
    subagent_count = 0
    for turn in turns:
        details = turn.get("subagent_details")
        if details:
            subagent_count += 1
            for r in details.get("results", []):
                subagent_cost += r.get("usage", {}).get("cost", 0)

    if total_cost > 0:
        print(f"  Session cost: ${total_cost:.4f}")
        print(
            f"  Session tokens: {total_input + total_output:,} (in:{total_input:,} out:{total_output:,})"
        )
    if subagent_cost > 0:
        print(f"  Subagent cost:  ${subagent_cost:.4f} ({subagent_count} invocations)")
        print(f"  TOTAL cost:     ${total_cost + subagent_cost:.4f}")

    user_turns = sum(1 for t in turns if t["role"] == "user")
    assistant_turns = sum(1 for t in turns if t["role"] == "assistant")
    tool_results = sum(1 for t in turns if t["role"] == "toolResult")
    print(
        f"  Turns:     {len(turns)} total ({user_turns} user, {assistant_turns} assistant, {tool_results} tool results)"
    )
    if subagent_count:
        print(f"  Subagent invocations: {subagent_count}")
    print()

    # Turn-by-turn summary
    print("-" * 70)
    print("TURN SUMMARY")
    print("-" * 70)

    turn_num = 0
    for turn in turns:
        role = turn["role"]
        ts = format_timestamp(turn["timestamp"])

        if role == "user":
            turn_num += 1
            if args.offset and turn_num <= args.offset:
                continue
            if args.limit and turn_num > args.offset + args.limit:
                break
            text = " ".join(turn["texts"])[:200].replace("\n", " ")
            print(f"\n[{ts}] 👤 USER #{turn_num}: {text}")

        elif role == "assistant":
            if args.offset and turn_num <= args.offset:
                continue
            if args.limit and turn_num > args.offset + args.limit:
                break

            parts = []
            if turn["texts"]:
                text_preview = turn["texts"][0][:150].replace("\n", " ")
                parts.append(f'"{text_preview}"')
            if turn["tool_calls"]:
                tool_names = [tc["name"] for tc in turn["tool_calls"]]
                parts.append(f"tools: [{', '.join(tool_names)}]")
            diagnostic_summary = summarize_assistant_diagnostics(turn)
            if diagnostic_summary and not parts:
                parts.append(diagnostic_summary)

            usage = turn.get("usage", {})
            cost = usage.get("cost", {})
            cost_str = f" (${cost['total']:.4f})" if cost.get("total") else ""

            summary = " | ".join(parts) if parts else "(empty)"
            print(f"[{ts}] 🤖 ASSISTANT: {summary}{cost_str}")

        elif role == "toolResult":
            if args.offset and turn_num <= args.offset:
                continue
            if args.limit and turn_num > args.offset + args.limit:
                break

            # Subagent results get special formatting
            details = turn.get("subagent_details")
            if details:
                print(f"[{ts}]   {format_subagent_summary(details)}")
            else:
                text = " ".join(turn["texts"])
                preview = text[:100].replace("\n", " ") if text else "(empty)"
                err = " ❌" if turn["is_error"] else ""
                print(f"[{ts}]   ↳ {turn.get('tool_name', '?')}{err}: {preview}")


def print_conversation(turns: list[dict], args):
    """Print only user and assistant text (no tool calls)."""
    print("=" * 70)
    print("CONVERSATION")
    print("=" * 70)

    turn_num = 0
    for turn in turns:
        role = turn["role"]

        if role == "user":
            turn_num += 1
            if args.offset and turn_num <= args.offset:
                continue
            if args.limit and turn_num > args.offset + args.limit:
                break
            ts = format_timestamp(turn["timestamp"])
            print(f"\n{'─' * 50}")
            print(f"👤 USER [{ts}]")
            print(f"{'─' * 50}")
            for text in turn["texts"]:
                print(truncate(text, args.max_content))

        elif role == "assistant" and turn["texts"]:
            if args.offset and turn_num <= args.offset:
                continue
            if args.limit and turn_num > args.offset + args.limit:
                break
            ts = format_timestamp(turn["timestamp"])
            print(f"\n🤖 ASSISTANT [{ts}]")
            for text in turn["texts"]:
                print(truncate(text, args.max_content))

        elif role == "toolResult" and turn.get("subagent_details"):
            if args.offset and turn_num <= args.offset:
                continue
            if args.limit and turn_num > args.offset + args.limit:
                break
            # Show subagent results in conversation view too
            details = turn["subagent_details"]
            print(f"\n{format_subagent_summary(details)}")


def print_full(turns: list[dict], args):
    """Print everything including tool calls and results."""
    print("=" * 70)
    print("FULL SESSION")
    print("=" * 70)

    turn_num = 0
    for turn in turns:
        role = turn["role"]
        ts = format_timestamp(turn["timestamp"])

        if role == "user":
            turn_num += 1
            if args.offset and turn_num <= args.offset:
                continue
            if args.limit and turn_num > args.offset + args.limit:
                break
            print(f"\n{'═' * 60}")
            print(f"👤 USER [{ts}]")
            print(f"{'═' * 60}")
            for text in turn["texts"]:
                print(truncate(text, args.max_content))

        elif role == "assistant":
            if args.offset and turn_num <= args.offset:
                continue
            if args.limit and turn_num > args.offset + args.limit:
                break
            model = turn.get("model", "")
            print(f"\n🤖 ASSISTANT [{ts}]{f' ({model})' if model else ''}")

            if turn["thinking"]:
                for thought in turn["thinking"]:
                    print(f"  💭 THINKING: {truncate(thought, args.max_content)}")

            for text in turn["texts"]:
                print(truncate(text, args.max_content))

            for tc in turn["tool_calls"]:
                args_str = json.dumps(tc["arguments"])
                print(f"\n  🔧 TOOL CALL: {tc['name']}")
                print(f"     {truncate(args_str, args.max_content)}")

        elif role == "toolResult":
            if args.offset and turn_num <= args.offset:
                continue
            if args.limit and turn_num > args.offset + args.limit:
                break

            details = turn.get("subagent_details")
            if details:
                print(f"\n  {format_subagent_summary(details)}")
                # Also show artifact paths for drill-down
                for r in details.get("results", []):
                    ap = r.get("artifactPaths", {})
                    sf = r.get("sessionFile", "")
                    if sf:
                        print(f"    📁 session: {sf}")
                    if ap.get("jsonlPath"):
                        print(f"    📁 artifact jsonl: {ap['jsonlPath']}")
                    if ap.get("outputPath"):
                        print(f"    📁 output: {ap['outputPath']}")
            else:
                err = " ❌ ERROR" if turn["is_error"] else ""
                print(f"\n  ↳ RESULT ({turn.get('tool_name', '?')}){err}:")
                for text in turn["texts"]:
                    print(f"     {truncate(text, args.max_content)}")


def print_tools(turns: list[dict], args):
    """Print only tool calls and their results."""
    print("=" * 70)
    print("TOOL CALLS")
    print("=" * 70)

    turn_num = 0
    tool_num = 0
    for turn in turns:
        if turn["role"] == "user":
            turn_num += 1

        if turn["role"] == "assistant" and turn["tool_calls"]:
            if args.offset and turn_num <= args.offset:
                continue
            if args.limit and turn_num > args.offset + args.limit:
                break
            ts = format_timestamp(turn["timestamp"])
            for tc in turn["tool_calls"]:
                tool_num += 1
                args_str = json.dumps(tc["arguments"])
                print(f"\n[{ts}] #{tool_num} {tc['name']}")
                print(f"  args: {truncate(args_str, args.max_content)}")

        elif turn["role"] == "toolResult":
            if args.offset and turn_num <= args.offset:
                continue
            if args.limit and turn_num > args.offset + args.limit:
                break

            details = turn.get("subagent_details")
            if details:
                print(f"  {format_subagent_summary(details)}")
            else:
                err = " ❌" if turn["is_error"] else " ✓"
                text = " ".join(turn["texts"])
                print(f"  result{err}: {truncate(text, min(args.max_content, 500))}")


def print_costs(turns: list[dict], args):
    """Print cost breakdown per assistant turn."""
    print("=" * 70)
    print("COST BREAKDOWN")
    print("=" * 70)
    print(
        f"{'#':<4} {'Time':<10} {'Model':<30} {'In':>8} {'Out':>8} {'Cache':>8} {'Cost':>10}"
    )
    print("-" * 80)

    total_cost = 0
    turn_num = 0
    assistant_num = 0
    for turn in turns:
        if turn["role"] == "user":
            turn_num += 1
        if turn["role"] != "assistant" or not turn.get("usage"):
            continue

        assistant_num += 1
        if args.offset and turn_num <= args.offset:
            continue
        if args.limit and turn_num > args.offset + args.limit:
            break

        usage = turn["usage"]
        cost = usage.get("cost", {})
        total = cost.get("total", 0)
        total_cost += total
        ts = format_timestamp(turn["timestamp"])
        model = turn.get("model", "?")

        print(
            f"{assistant_num:<4} {ts:<10} {model:<30} "
            f"{usage.get('input', 0):>8,} {usage.get('output', 0):>8,} "
            f"{usage.get('cacheRead', 0):>8,} ${total:>9.4f}"
        )

    # Subagent costs
    subagent_cost = 0
    sub_num = 0
    for turn in turns:
        details = turn.get("subagent_details")
        if not details:
            continue
        for r in details.get("results", []):
            sub_num += 1
            usage = r.get("usage", {})
            cost = usage.get("cost", 0)
            subagent_cost += cost
            model = r.get("model", "?")
            agent = r.get("agent", "?")
            tokens_in = usage.get("input", 0)
            tokens_out = usage.get("output", 0)
            cache = usage.get("cacheRead", 0)
            print(
                f"{'S' + str(sub_num):<4} {'subagent':<10} {agent + '/' + model:<30} "
                f"{tokens_in:>8,} {tokens_out:>8,} "
                f"{cache:>8,} ${cost:>9.4f}"
            )

    print("-" * 80)
    grand_total = total_cost + subagent_cost
    if subagent_cost > 0:
        print(f"{'SESSION':<54} ${total_cost:>9.4f}")
        print(f"{'SUBAGENTS':<54} ${subagent_cost:>9.4f}")
    print(f"{'TOTAL':<54} ${grand_total:>9.4f}")


def _extract_run_id(artifact_paths: dict, result_idx: int) -> tuple[str, int]:
    """Extract (run_id, run_index) from artifact paths.

    Parallel: .../1e458939_reviewer_0.jsonl → ('1e458939', 0)
    Single:   .../07fcb5fe_worker.jsonl     → ('07fcb5fe', 0)
    Missing:                                 → ('', result_idx)
    """
    jsonl_path = artifact_paths.get("jsonlPath", "")
    # Also try other artifact paths if jsonlPath is missing
    if not jsonl_path:
        for key in ("outputPath", "inputPath", "metadataPath"):
            if artifact_paths.get(key):
                jsonl_path = artifact_paths[key]
                break
    if not jsonl_path:
        return "", result_idx

    artifact_name = Path(jsonl_path).stem
    parts = artifact_name.split("_")
    if len(parts) < 2:
        return "", result_idx

    run_id = parts[0]
    run_index = int(parts[-1]) if parts[-1].isdigit() else result_idx
    return run_id, run_index


def resolve_nested_session_dir(session_path: str) -> Path | None:
    """Resolve the nested subagent session directory for a parent session.

    Parent session: .../project/<timestamp_uuid>.jsonl
    Nested dir:     .../project/<timestamp_uuid>/
    """
    p = Path(session_path).expanduser()
    nested_dir = p.parent / p.stem
    return nested_dir if nested_dir.is_dir() else None


def build_nested_session_index(session_path: str) -> dict[tuple[str, int], Path]:
    """Build a lookup dict of (run_id, run_index) → JSONL path.

    Scans the nested session dir once and returns all discovered sessions.
    """
    nested_dir = resolve_nested_session_dir(session_path)
    if not nested_dir:
        return {}

    index: dict[tuple[str, int], Path] = {}
    for run_id_dir in sorted(nested_dir.iterdir()):
        if not run_id_dir.is_dir():
            continue
        run_id = run_id_dir.name
        for sub_dir in sorted(run_id_dir.iterdir()):
            if not sub_dir.is_dir():
                continue
            name = sub_dir.name
            if name.startswith("run-"):
                try:
                    run_idx = int(name.split("-", 1)[1])
                except ValueError:
                    continue
            elif name.startswith("async-"):
                run_idx = 0  # async runs map to index 0
            else:
                continue  # skip unknown subdirs
            jsonls = sorted(sub_dir.glob("*.jsonl"))
            if jsonls:
                index[(run_id, run_idx)] = jsonls[0]
    return index


def print_subagents(messages: list[dict], args):
    """Print detailed subagent information."""
    print("=" * 70)
    print("SUBAGENT RUNS")
    print("=" * 70)

    session_path = args.session_path
    nested_index = build_nested_session_index(session_path)
    sub_num = 0
    invocation_num = 0
    found_any = False

    # Collect subagent calls and their details together
    for i, entry in enumerate(messages):
        msg = entry.get("message", {})
        details = extract_subagent_details(msg)
        if not details:
            continue

        found_any = True
        invocation_num += 1
        mode = details.get("mode", "?")
        results = details.get("results", [])

        # Find the matching subagent tool call (look backwards, stop at first match)
        call_args = {}
        for j in range(i - 1, max(i - 5, -1), -1):
            prev_msg = messages[j].get("message", {})
            prev_content = prev_msg.get("content", [])
            if isinstance(prev_content, list):
                for item in prev_content:
                    if (
                        isinstance(item, dict)
                        and item.get("type") == "toolCall"
                        and item.get("name") == "subagent"
                    ):
                        call_args = item.get("arguments", {})
                        break
                if call_args:
                    break

        print(f"\n{'━' * 60}")
        print(f"INVOCATION #{invocation_num} — mode: {mode}")
        print(f"{'━' * 60}")

        if details.get("runId"):
            print(f"  Run ID:   {details['runId']}")
        if details.get("asyncId"):
            print(f"  Async ID: {details['asyncId']}")
        if details.get("asyncDir"):
            print(f"  Async:    {details['asyncDir']}")

        if call_args.get("chain"):
            print(f"  Chain steps: {len(call_args['chain'])}")
            for step in call_args["chain"]:
                print(
                    f"    → {step.get('agent', '?')}: {str(step.get('task', ''))[:120]}"
                )
        elif call_args.get("tasks"):
            print(f"  Parallel tasks: {len(call_args['tasks'])}")
            for t in call_args["tasks"]:
                print(f"    → {t.get('agent', '?')}: {str(t.get('task', ''))[:120]}")
        elif call_args.get("action"):
            print(f"  Management action: {call_args['action']}")

        total_cost = 0
        total_duration = 0

        if not results:
            content = msg.get("content", "")
            texts = []
            if isinstance(content, list):
                texts = [item.get("text", "") for item in content if isinstance(item, dict)]
            elif isinstance(content, str):
                texts = [content]
            preview = " ".join(texts).strip().replace("\n", " ")
            if preview:
                print(f"  Result:   {truncate(preview, 500)}")
            print("  Runs:     0 (management or async launch result)")
            continue

        for result_idx, r in enumerate(results):
            sub_num += 1
            agent = r.get("agent", "?")
            exit_code = r.get("exitCode", -1)
            status = "✓ completed" if exit_code == 0 else "❌ failed"
            model = r.get("model", "")
            usage = r.get("usage", {})
            cost = usage.get("cost", 0)
            total_cost += cost
            turns_count = usage.get("turns", 0)
            progress = r.get("progressSummary", {})
            duration = progress.get("durationMs", 0)
            total_duration += duration
            tool_count = progress.get("toolCount", 0)
            skills = r.get("skills", [])
            task = r.get("task", "")
            session_file = r.get("sessionFile", "")
            artifact_paths = r.get("artifactPaths", {})

            print(f"\n  ── Run #{sub_num}: {agent} ──")
            print(f"  Status:   {status}")
            print(f"  Model:    {model}")
            print(f"  Task:     {truncate(task.replace(chr(10), ' '), 300)}")
            if skills:
                print(f"  Skills:   {', '.join(skills)}")
            print(f"  Cost:     ${cost:.4f}")
            print(f"  Duration: {format_duration(duration)}")
            print(
                f"  Tokens:   {usage.get('input', 0):,} in / {usage.get('output', 0):,} out / {usage.get('cacheRead', 0):,} cached"
            )
            print(f"  Tools:    {tool_count} calls in {turns_count} turns")

            # Session & artifact paths — resolve nested session dir as fallback
            run_id, run_index = _extract_run_id(artifact_paths, result_idx)

            nested_jsonl = nested_index.get((run_id, run_index)) if run_id else None

            if session_file:
                exists = Path(session_file).exists()
                marker = "" if exists else " (deleted)"
                print(f"  Session:  {session_file}{marker}")

            artifact_jsonl = artifact_paths.get("jsonlPath", "")
            if artifact_jsonl and Path(artifact_jsonl).exists():
                print(f"  JSONL:    {artifact_jsonl}")
            elif nested_jsonl:
                print(f"  JSONL:    {nested_jsonl}")
            elif artifact_jsonl:
                print(f"  JSONL:    {artifact_jsonl} (deleted)")

            if artifact_paths.get("outputPath"):
                exists = Path(artifact_paths["outputPath"]).exists()
                marker = "" if exists else " (deleted)"
                print(f"  Output:   {artifact_paths['outputPath']}{marker}")

        if len(results) > 1:
            print(
                f"\n  Combined: ${total_cost:.4f} | {format_duration(total_duration)}"
            )

    if not found_any:
        print("\n  No subagent invocations found in this session.")


def iter_diagnostics(messages: list[dict], diagnostic_type: str | None = None):
    """Yield assistant diagnostics with their parent message context."""
    for entry in messages:
        msg = entry.get("message", {})
        if msg.get("role") != "assistant":
            continue
        for diagnostic in msg.get("diagnostics", []) or []:
            if diagnostic_type and diagnostic.get("type") != diagnostic_type:
                continue
            yield entry, msg, diagnostic


def _detail(details: dict, key: str, default="-"):
    value = details.get(key)
    return default if value is None else value


def _bytes_summary(details: dict) -> str:
    request_bytes = details.get("requestBytes")
    full_bytes = details.get("fullBytes")
    if request_bytes is None:
        return "-"
    if full_bytes is not None:
        return f"{request_bytes}/{full_bytes}"
    return str(request_bytes)


def _items_summary(details: dict) -> str:
    sent_items = details.get("sentInputItems")
    full_items = details.get("fullInputItems")
    if sent_items is None:
        return "-"
    if full_items is not None:
        return f"{sent_items}/{full_items}"
    return str(sent_items)


def print_diagnostics(messages: list[dict], args):
    """Print all assistant diagnostics in a compact forensic view."""
    print("=" * 70)
    print("SESSION DIAGNOSTICS")
    print("=" * 70)

    found = False
    for idx, (entry, msg, diagnostic) in enumerate(iter_diagnostics(messages), start=1):
        found = True
        details = diagnostic.get("details", {})
        ts = format_timestamp(entry.get("timestamp", msg.get("timestamp", "")))
        print(f"\n#{idx} [{ts}] {diagnostic.get('type', '?')} {msg.get('model', '')}")
        for key in (
            "outcome",
            "requestId",
            "attempts",
            "eventCount",
            "responseIdSeen",
            "continuation",
            "fallback",
            "requestBytes",
            "fullBytes",
            "firstEventMs",
            "responseCreatedMs",
            "completedMs",
        ):
            if key in details:
                print(f"  {key}: {details[key]}")

    if not found:
        print("\n  No assistant diagnostics found in this session.")


def print_websocket(messages: list[dict], args):
    """Print OpenAI WebSocket transport diagnostics for startup/continuation triage."""
    print("=" * 70)
    print("WEBSOCKET DIAGNOSTICS")
    print("=" * 70)
    print(
        f"{'#':<3} {'Time':<8} {'Model':<24} {'Outcome':<48} {'Cont':<18} "
        f"{'Start':>8} {'Created':>8} {'Done':>8} {'Bytes':>14} {'Items':>8}"
    )
    print("-" * 100)

    found = False
    for idx, (entry, msg, diagnostic) in enumerate(
        iter_diagnostics(messages, "openai_websocket_transport"),
        start=1,
    ):
        found = True
        details = diagnostic.get("details", {})
        ts = format_timestamp(entry.get("timestamp", msg.get("timestamp", "")))
        print(
            f"{idx:<3} {ts:<8} {msg.get('model', '-'):<24.24} "
            f"{str(_detail(details, 'outcome')):<48} "
            f"{str(_detail(details, 'continuation')):<18.18} "
            f"{str(_detail(details, 'firstEventMs')):>8} "
            f"{str(_detail(details, 'responseCreatedMs')):>8} "
            f"{str(_detail(details, 'completedMs')):>8} "
            f"{_bytes_summary(details):>14} {_items_summary(details):>8}"
        )
        fallback = details.get("fallback")
        previous = details.get("previousResponseId")
        if fallback or previous:
            suffix = []
            if previous:
                suffix.append(f"previousResponseId={str(previous)[:32]}")
            if fallback:
                suffix.append(f"fallback={fallback}")
            print(f"    {'; '.join(suffix)}")
        timeline = details.get("timeline") or []
        if timeline:
            for event in timeline:
                event_type = event.get("type", "?") if isinstance(event, dict) else "?"
                event_ms = event.get("tMs", "?") if isinstance(event, dict) else "?"
                event_extra = ""
                if isinstance(event, dict) and event.get("eventType"):
                    event_extra = f" {event['eventType']}"
                print(f"    timeline {event_ms}ms {event_type}{event_extra}")

    if not found:
        print("\n  No openai_websocket_transport diagnostics found in this session.")


def run_read_command(args) -> str:
    """Run the reader command and return printable output."""
    path = Path(args.session_path).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"Session file not found: {path}")

    args.session_path = str(path)
    metadata, events, messages = parse_session(args.session_path)
    turns = extract_turns(messages)

    output = io.StringIO()
    with redirect_stdout(output):
        if args.mode == "overview":
            print_overview(metadata, events, turns, args)
        elif args.mode == "conversation":
            print_conversation(turns, args)
        elif args.mode == "full":
            print_full(turns, args)
        elif args.mode == "tools":
            print_tools(turns, args)
        elif args.mode == "costs":
            print_costs(turns, args)
        elif args.mode == "subagents":
            print_subagents(messages, args)
        elif args.mode == "diagnostics":
            print_diagnostics(messages, args)
        elif args.mode == "websocket":
            print_websocket(messages, args)
    return output.getvalue().rstrip()


def main():
    args = parse_args()
    try:
        print(run_read_command(args))
    except FileNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
