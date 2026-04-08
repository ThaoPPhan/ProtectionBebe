#!/usr/bin/env python3
"""Local bridge server: STM32 USB serial -> HTTP API + static dashboard."""

from __future__ import annotations

import argparse
import json
import threading
import time
from collections import deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional

import serial
from serial.tools import list_ports


ROOT = Path(__file__).resolve().parent
METRIC_KEYS = ["T_BODY", "HR", "MOVE", "T_AMB", "HUM", "CRY", "FIRE"]


class SharedState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.connected = False
        self.port_name: Optional[str] = None
        self.baudrate = 115200
        self.metrics: Dict[str, Optional[str]] = {k: None for k in METRIC_KEYS}
        self.logs: deque[str] = deque(maxlen=220)
        self.updated_at = time.time()


class SerialBridge:
    def __init__(self, state: SharedState) -> None:
        self.state = state
        self.serial_port: Optional[serial.Serial] = None
        self.reader_thread: Optional[threading.Thread] = None
        self.stop_event = threading.Event()

    def available_ports(self) -> List[str]:
        return [p.device for p in list_ports.comports()]

    def connect(self, port: str, baudrate: int) -> None:
        self.disconnect()
        self.serial_port = serial.Serial(port=port, baudrate=baudrate, timeout=1)
        self.stop_event.clear()

        with self.state.lock:
            self.state.connected = True
            self.state.port_name = port
            self.state.baudrate = baudrate
            self._log_locked(f"Connected to {port} @ {baudrate}")

        self.reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self.reader_thread.start()

    def disconnect(self) -> None:
        self.stop_event.set()

        if self.reader_thread and self.reader_thread.is_alive():
            self.reader_thread.join(timeout=1.5)
        self.reader_thread = None

        if self.serial_port and self.serial_port.is_open:
            self.serial_port.close()
        self.serial_port = None

        with self.state.lock:
            if self.state.connected:
                self._log_locked("Disconnected")
            self.state.connected = False
            self.state.port_name = None

    def send_command(self, command: str) -> None:
        if not self.serial_port or not self.serial_port.is_open:
            raise RuntimeError("STM32 not connected")

        line = f"{command.strip()}\n"
        self.serial_port.write(line.encode("utf-8"))
        with self.state.lock:
            self._log_locked(f"CMD -> {command.strip()}")

    def snapshot(self) -> Dict[str, object]:
        with self.state.lock:
            return {
                "connected": self.state.connected,
                "port": self.state.port_name,
                "baudrate": self.state.baudrate,
                "metrics": dict(self.state.metrics),
                "logs": list(self.state.logs),
                "updatedAt": self.state.updated_at,
            }

    def _read_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                if not self.serial_port or not self.serial_port.is_open:
                    return

                raw = self.serial_port.readline()
                if not raw:
                    continue

                line = raw.decode("utf-8", errors="ignore").strip()
                if not line:
                    continue

                with self.state.lock:
                    self._log_locked(line)
                    self._parse_metric_locked(line)
                    self.state.updated_at = time.time()
            except Exception as exc:  # Keep server alive on transient serial issues
                with self.state.lock:
                    self._log_locked(f"READ_ERR: {exc}")
                time.sleep(0.3)

    def _parse_metric_locked(self, line: str) -> None:
        if ":" not in line:
            return
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if key in METRIC_KEYS:
            self.state.metrics[key] = value

    def _log_locked(self, message: str) -> None:
        ts = time.strftime("%H:%M:%S")
        self.state.logs.append(f"[{ts}] {message}")


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "ProtectionBebeBridge/1.0"

    def _json(self, payload: Dict[str, object], status: int = HTTPStatus.OK) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> Dict[str, object]:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(body.decode("utf-8"))

    def _serve_static(self, rel_path: str) -> None:
        safe = (ROOT / rel_path.lstrip("/")).resolve()
        if ROOT not in safe.parents and safe != ROOT:
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        if not safe.exists() or not safe.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        mime = "text/plain; charset=utf-8"
        if safe.suffix == ".html":
            mime = "text/html; charset=utf-8"
        elif safe.suffix == ".css":
            mime = "text/css; charset=utf-8"
        elif safe.suffix == ".js":
            mime = "application/javascript; charset=utf-8"

        data = safe.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    @property
    def bridge(self) -> SerialBridge:
        return self.server.bridge  # type: ignore[attr-defined]

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/ports":
            self._json({"ports": self.bridge.available_ports()})
            return

        if self.path == "/api/state":
            self._json(self.bridge.snapshot())
            return

        target = "index.html" if self.path in {"/", ""} else self.path
        self._serve_static(target)

    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = self._read_json()
        except Exception:
            self._json({"error": "Invalid JSON"}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            if self.path == "/api/connect":
                port = str(payload.get("port", "")).strip()
                baudrate = int(payload.get("baudrate", 115200))
                if not port:
                    raise ValueError("Port is required")
                self.bridge.connect(port=port, baudrate=baudrate)
                self._json({"ok": True})
                return

            if self.path == "/api/disconnect":
                self.bridge.disconnect()
                self._json({"ok": True})
                return

            if self.path == "/api/command":
                command = str(payload.get("command", "")).strip()
                if not command:
                    raise ValueError("Command is required")
                self.bridge.send_command(command)
                self._json({"ok": True})
                return

            self._json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self._json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def log_message(self, fmt: str, *args: object) -> None:
        # Keep terminal output clean; serial logs are exposed through /api/state.
        return


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ProtectionBebe serial bridge server")
    parser.add_argument("--host", default="0.0.0.0", help="HTTP host bind")
    parser.add_argument("--port", type=int, default=5500, help="HTTP port")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    state = SharedState()
    bridge = SerialBridge(state)

    httpd = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    httpd.bridge = bridge  # type: ignore[attr-defined]

    print(f"Bridge server running on http://{args.host}:{args.port}")
    print("Open the dashboard in browser, then connect STM32 from UI.")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        bridge.disconnect()
        httpd.server_close()


if __name__ == "__main__":
    main()
