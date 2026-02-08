#!/usr/bin/env python3
"""Live watcher for Syqure multiparty UI runs.

Prints per-peer step status, proxy listener readiness, and hotlink rx/tx deltas.
"""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

STEP_ORDER = ["gen_variants", "build_master", "align_counts", "secure_aggregate"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Watch Syqure multiparty progress.")
    parser.add_argument(
        "--sandbox",
        default="biovault/sandbox",
        help="Sandbox root directory (default: biovault/sandbox).",
    )
    parser.add_argument(
        "--flow",
        default="syqure-flow",
        help="Flow name under shared/flows (default: syqure-flow).",
    )
    parser.add_argument(
        "--participants",
        default="",
        help="Comma-separated participant emails (default: auto-discover *@sandbox.local).",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=2.0,
        help="Refresh interval seconds (default: 2.0).",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Print one snapshot and exit.",
    )
    parser.add_argument(
        "--prefix",
        default="[watch]",
        help="Prefix for output lines.",
    )
    return parser.parse_args()


def role_for_email(email: str) -> str:
    return email.split("@", 1)[0]


def discover_participants(sandbox: Path) -> List[str]:
    emails: List[str] = []
    if not sandbox.exists():
        return emails
    for child in sandbox.iterdir():
        if not child.is_dir():
            continue
        name = child.name
        if "@" not in name:
            continue
        if (child / "datasites" / name).exists():
            emails.append(name)
    return sorted(emails)


def read_json(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def latest_session(sandbox: Path, flow: str, emails: List[str]) -> Optional[str]:
    candidates: List[Tuple[float, str]] = []
    for email in emails:
        flow_root = sandbox / email / "datasites" / email / "shared" / "flows" / flow
        if not flow_root.exists():
            continue
        for session_dir in flow_root.glob("session-*"):
            if not session_dir.is_dir():
                continue
            progress_log = session_dir / "_progress" / "log.jsonl"
            ts = progress_log.stat().st_mtime if progress_log.exists() else session_dir.stat().st_mtime
            candidates.append((ts, session_dir.name))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def parse_step_statuses(progress_log: Path) -> Dict[str, str]:
    statuses: Dict[str, str] = {}
    if not progress_log.exists():
        return statuses
    try:
        lines = progress_log.read_text().splitlines()
    except Exception:
        return statuses
    for line in lines[-500:]:
        try:
            entry = json.loads(line)
        except Exception:
            continue
        step_id = entry.get("step_id")
        event = (entry.get("event") or "").strip()
        if not step_id:
            continue
        if event == "step_started":
            statuses[step_id] = "Running"
        elif event == "step_completed":
            statuses[step_id] = "Completed"
        elif event == "step_shared":
            statuses[step_id] = "Shared"
        elif event == "step_failed":
            statuses[step_id] = "Failed"
        elif event == "syqure_proxy_ready":
            statuses[f"{step_id}.proxy"] = "Ready"
    return statuses


def read_private_step_line(path: Path) -> str:
    if not path.exists():
        return "-"
    try:
        lines = path.read_text().splitlines()
    except Exception:
        return "-"
    if not lines:
        return "-"
    return lines[-1]


def is_listening(port: int) -> bool:
    try:
        proc = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{int(port)}", "-sTCP:LISTEN"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
        lines = [line for line in (proc.stdout or "").splitlines() if line.strip()]
        if proc.returncode == 0 and len(lines) >= 2:
            return True
    except FileNotFoundError:
        pass

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.08)
    try:
        return sock.connect_ex(("127.0.0.1", int(port))) == 0
    except Exception:
        return False
    finally:
        sock.close()


def parse_mpc_channels(session_root: Path, email: str) -> str:
    mpc_root = session_root / "_mpc"
    if not mpc_root.exists():
        return "-"
    parts: List[str] = []
    for channel_dir in sorted(mpc_root.iterdir()):
        if not channel_dir.is_dir() or "_to_" not in channel_dir.name:
            continue
        stream_tcp = read_json(channel_dir / "stream.tcp") or {}
        ports = stream_tcp.get("ports") if isinstance(stream_tcp.get("ports"), dict) else {}
        local_port = ports.get(email) if isinstance(ports, dict) else None
        if local_port is None:
            local_port = stream_tcp.get("port")
        try:
            local_port = int(local_port) if local_port is not None else None
        except Exception:
            local_port = None
        accept_flag = (channel_dir / "stream.accept").read_text().strip() == "1" if (channel_dir / "stream.accept").exists() else False
        listening_flag = is_listening(local_port) if isinstance(local_port, int) else False
        state = f"{'L' if listening_flag else 'x'}{'A' if accept_flag else '-'}"
        parts.append(f"{channel_dir.name}:{state}:{local_port if local_port else '-'}")
    return ", ".join(parts) if parts else "-"


def fmt_bytes(value: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    val = float(value)
    idx = 0
    while val >= 1024.0 and idx < len(units) - 1:
        val /= 1024.0
        idx += 1
    if idx == 0:
        return f"{int(val)}{units[idx]}"
    return f"{val:.1f}{units[idx]}"


def telemetry_line(
    telemetry: Optional[dict],
    prev: Optional[dict],
) -> Tuple[str, Optional[dict]]:
    if not telemetry:
        return "hotlink:-", prev
    tx = int(telemetry.get("tx_bytes") or 0)
    rx = int(telemetry.get("rx_bytes") or 0)
    tx_packets = int(telemetry.get("tx_packets") or 0)
    rx_packets = int(telemetry.get("rx_packets") or 0)
    mode = str(telemetry.get("mode") or "unknown")
    updated_ms = int(telemetry.get("updated_ms") or 0)
    delta_tx = 0
    delta_rx = 0
    delta_t = 0
    if prev:
        delta_tx = max(0, tx - int(prev.get("tx_bytes") or 0))
        delta_rx = max(0, rx - int(prev.get("rx_bytes") or 0))
        delta_t = max(0, updated_ms - int(prev.get("updated_ms") or 0))
    line = (
        f"hotlink:{mode} tx={fmt_bytes(tx)} rx={fmt_bytes(rx)} "
        f"pkts={tx_packets}/{rx_packets} +{fmt_bytes(delta_tx)}/{fmt_bytes(delta_rx)}"
    )
    if delta_t > 0:
        line += f" dt={delta_t}ms"
    return line, {"tx_bytes": tx, "rx_bytes": rx, "updated_ms": updated_ms}


def snapshot(prefix: str, sandbox: Path, flow: str, emails: List[str], prev_tel: Dict[str, dict]) -> Dict[str, dict]:
    session = latest_session(sandbox, flow, emails)
    ts = time.strftime("%H:%M:%S")
    print(f"{prefix} {ts} flow={flow} session={session or '-'}")
    if not session:
        print(f"{prefix} waiting for session-* in {sandbox}")
        return prev_tel

    next_tel: Dict[str, dict] = dict(prev_tel)
    for email in emails:
        role = role_for_email(email)
        session_root = sandbox / email / "datasites" / email / "shared" / "flows" / flow / session
        progress_dir = session_root / "_progress"
        statuses = parse_step_statuses(progress_dir / "log.jsonl")
        steps = []
        for step in STEP_ORDER:
            value = statuses.get(step, "-")
            if step == "secure_aggregate" and statuses.get("secure_aggregate.proxy") == "Ready":
                value = f"{value}+proxy"
            steps.append(f"{step}={value}")
        channel_text = parse_mpc_channels(session_root, email)

        telemetry_path = sandbox / email / "datasites" / email / ".syftbox" / "hotlink_telemetry.json"
        telemetry = read_json(telemetry_path)
        telem_text, telem_state = telemetry_line(telemetry, prev_tel.get(email))
        if telem_state:
            next_tel[email] = telem_state

        private_log = (
            sandbox
            / email
            / ".biovault"
            / "multiparty_step_logs"
            / session
            / "secure_aggregate.log"
        )
        secure_tail = read_private_step_line(private_log)
        print(
            f"{prefix} {role:<10} {' '.join(steps)} | {telem_text} | mpc[{channel_text}]"
        )
        print(f"{prefix} {role:<10} secure_tail: {secure_tail}")

    return next_tel


def main() -> int:
    args = parse_args()
    sandbox = Path(args.sandbox).expanduser().resolve()
    if args.participants.strip():
        emails = [p.strip() for p in args.participants.split(",") if p.strip()]
    else:
        emails = discover_participants(sandbox)

    if not emails:
        print(f"{args.prefix} no participants found under {sandbox}", file=sys.stderr)
        return 1

    prev_tel: Dict[str, dict] = {}
    while True:
        prev_tel = snapshot(args.prefix, sandbox, args.flow, emails, prev_tel)
        if args.once:
            return 0
        time.sleep(max(args.interval, 0.2))


if __name__ == "__main__":
    raise SystemExit(main())
