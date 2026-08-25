#!/usr/bin/env python3
"""Local SenseVoice talking-head editor backend."""
from __future__ import annotations

import audioop
import http.server
import json
import math
import os
import re
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
import wave
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
STATIC_DIR = SKILL_DIR / "assets" / "editor" / "static"
DATA_DIR = Path(os.environ.get("KOUBO_EDITOR_DATA_DIR", Path.cwd() / ".kaola-koubo")).expanduser().resolve()
PROJECTS_FILE = DATA_DIR / "projects.json"
WAVEFORM_DIR = DATA_DIR / "waveforms"
RENDER_SCRIPT = SCRIPT_DIR / "render_keep_intervals.py"

render_jobs: dict[str, dict] = {}
waveform_lock = threading.Lock()


def load_projects() -> dict:
    if not PROJECTS_FILE.exists():
        return {"default": "", "projects": []}
    data = json.loads(PROJECTS_FILE.read_text("utf-8"))
    data.setdefault("default", "")
    data.setdefault("projects", [])
    return data


def get_project(project_id: str | None) -> dict:
    data = load_projects()
    if not project_id:
        project_id = data.get("default")
    for project in data.get("projects", []):
        if project.get("id") == project_id:
            return project
    raise KeyError(project_id or "")


def project_path(project_id: str | None, key: str) -> Path:
    project = get_project(project_id)
    value = project.get(key)
    if not value:
        raise KeyError(f"{key} missing")
    return Path(value).expanduser().resolve()


def safe_download_name(name: str, fallback: str) -> str:
    name = re.sub(r'[\x00-\x1f\x7f"\\/]+', "_", name or fallback).strip(" .")
    return name or fallback


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D401
        return

    def send_data(self, code: int, data, ctype: str = "application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path
        query = urllib.parse.parse_qs(url.query)
        project_id = query.get("project", [None])[0]

        if path in ("/", "/index.html"):
            return self.serve_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
        if path.startswith("/static/"):
            file_path = STATIC_DIR / path[len("/static/") :]
            ctype = {
                "style.css": "text/css; charset=utf-8",
                "app.js": "application/javascript; charset=utf-8",
            }.get(file_path.name, "application/octet-stream")
            return self.serve_file(file_path, ctype)
        if path == "/api/projects":
            data = load_projects()
            projects = []
            for project in data.get("projects", []):
                available = all(Path(project.get(key, "")).expanduser().exists() for key in ("video", "raw", "keep"))
                output = Path(project.get("output", "")).expanduser()
                projects.append({
                    "id": project.get("id"),
                    "label": project.get("label") or project.get("id"),
                    "video": Path(project.get("video", "")).name,
                    "available": available,
                    "has_output": output.exists(),
                })
            return self.send_data(200, json.dumps({"default": data.get("default"), "projects": projects}, ensure_ascii=False))
        try:
            if path == "/api/raw":
                return self.serve_file(project_path(project_id, "raw"), "application/json; charset=utf-8")
            if path == "/api/keep":
                return self.serve_file(project_path(project_id, "keep"), "application/json; charset=utf-8")
            if path == "/api/video":
                return self.serve_video(project_path(project_id, "video"))
            if path == "/api/output":
                return self.serve_video(project_path(project_id, "output"))
            if path == "/api/waveform":
                return self.serve_waveform(project_path(project_id, "video"))
            if path == "/api/segment":
                return self.serve_segment(query)
            if path == "/api/render/status":
                job_id = query.get("job", [None])[0]
                return self.send_data(200, json.dumps(render_jobs.get(job_id, {"status": "unknown"}), ensure_ascii=False))
        except KeyError:
            return self.send_data(400, json.dumps({"error": "unknown or incomplete project"}, ensure_ascii=False))
        except FileNotFoundError as exc:
            return self.send_data(404, json.dumps({"error": str(exc)}, ensure_ascii=False))

        self.send_data(404, '{"error":"not found"}')

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            return self.send_data(400, '{"error":"invalid json"}')

        if url.path == "/api/keep":
            project_id = data.get("project")
            keep_path = project_path(project_id, "keep")
            keep = data.get("keep") if isinstance(data.get("keep"), dict) else data
            existing = {}
            if keep_path.exists():
                existing = json.loads(keep_path.read_text("utf-8"))
            merged = {**existing, **{k: v for k, v in keep.items() if k != "project"}}
            keep_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), "utf-8")
            return self.send_data(200, json.dumps({"ok": True, "path": str(keep_path)}, ensure_ascii=False))

        if url.path == "/api/render":
            job_id = uuid.uuid4().hex[:12]
            render_jobs[job_id] = {"status": "running", "phase": "submitted", "log": ""}
            threading.Thread(target=self.run_render, args=(job_id, data.get("project")), daemon=True).start()
            return self.send_data(200, json.dumps({"job": job_id}, ensure_ascii=False))

        self.send_data(404, '{"error":"not found"}')

    def run_render(self, job_id: str, project_id: str | None):
        started = time.time()
        try:
            keep_path = project_path(project_id, "keep")
            output = project_path(project_id, "output")
            render_jobs[job_id]["phase"] = f"rendering {output.name}"
            result = subprocess.run(
                [sys.executable, str(RENDER_SCRIPT), str(keep_path)],
                cwd=str(DATA_DIR),
                capture_output=True,
                text=True,
            )
            render_jobs[job_id] = {
                "status": "done" if result.returncode == 0 else "error",
                "returncode": result.returncode,
                "output": output.name,
                "elapsed": round(time.time() - started, 1),
                "log": (result.stdout or "") + (result.stderr or ""),
            }
        except Exception as exc:  # noqa: BLE001
            render_jobs[job_id] = {"status": "error", "elapsed": round(time.time() - started, 1), "log": str(exc)}

    def serve_file(self, file_path: Path, ctype: str):
        if not file_path.exists():
            raise FileNotFoundError(file_path)
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def serve_video(self, file_path: Path):
        if not file_path.exists():
            raise FileNotFoundError(file_path)
        size = file_path.stat().st_size
        range_header = self.headers.get("Range")
        start, end = 0, size - 1
        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if match:
                start = int(match.group(1) or 0)
                end = min(int(match.group(2) or end), end)
        length = end - start + 1
        self.send_response(206 if range_header else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if range_header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with file_path.open("rb") as file:
            file.seek(start)
            remaining = length
            try:
                while remaining > 0:
                    chunk = file.read(min(262144, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    def serve_waveform(self, source: Path):
        step = 0.01
        WAVEFORM_DIR.mkdir(parents=True, exist_ok=True)
        stat = source.stat()
        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", source.stem)
        cache = WAVEFORM_DIR / f"{safe_name}_{stat.st_size}_{int(stat.st_mtime)}_0p01.json"
        with waveform_lock:
            if not cache.exists():
                cache.write_text(json.dumps(build_waveform(source, step), ensure_ascii=False), "utf-8")
        return self.serve_file(cache, "application/json; charset=utf-8")

    def serve_segment(self, query: dict):
        source = project_path(query.get("project", [None])[0], "video")
        start = float(query.get("start", [0])[0])
        end = float(query.get("end", [0])[0])
        if not math.isfinite(start) or not math.isfinite(end) or end <= start:
            return self.send_data(400, '{"error":"invalid segment range"}')
        name = safe_download_name(query.get("name", [f"segment_{start:.2f}-{end:.2f}.mp4"])[0], "segment.mp4")
        with tempfile.NamedTemporaryFile(prefix="koubo-segment-", suffix=".mp4", delete=False) as temp:
            temp_path = Path(temp.name)
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(start), "-to", str(end), "-i", str(source), "-c", "copy", str(temp_path)],
                check=True,
            )
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{urllib.parse.quote(name)}")
            self.send_header("Content-Length", str(temp_path.stat().st_size))
            self.end_headers()
            with temp_path.open("rb") as file:
                self.wfile.write(file.read())
        finally:
            temp_path.unlink(missing_ok=True)


def build_waveform(source: Path, step: float) -> dict:
    with tempfile.NamedTemporaryFile(prefix="koubo-waveform-", suffix=".wav", delete=False) as temp:
        wav_path = Path(temp.name)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", str(wav_path)],
            check=True,
        )
        bins = []
        with wave.open(str(wav_path), "rb") as reader:
            rate = reader.getframerate()
            width = reader.getsampwidth()
            frames_per_bin = max(1, int(rate * step))
            index = 0
            while True:
                chunk = reader.readframes(frames_per_bin)
                if not chunk:
                    break
                bins.append({
                    "t": round(index * step, 3),
                    "rms": round(audioop.rms(chunk, width) / 32768, 5),
                    "peak": round(audioop.max(chunk, width) / 32768, 5),
                })
                index += 1
        max_rms = max((item["rms"] for item in bins), default=1) or 1
        max_peak = max((item["peak"] for item in bins), default=1) or 1
        previous = 0
        for item in bins:
            item["rms_n"] = round(item["rms"] / max_rms, 4)
            item["peak_n"] = round(item["peak"] / max_peak, 4)
            item["delta"] = round(abs(item["rms_n"] - previous), 4)
            previous = item["rms_n"]
        return {"source": str(source), "step": step, "bins": bins, "method": "ffmpeg 16k mono PCM; RMS/peak waveform"}
    finally:
        wav_path.unlink(missing_ok=True)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    address_family = socket.AF_INET

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def main():
    port = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8767))
    DATA_DIR.mkdir(exist_ok=True)
    with Server(("127.0.0.1", port), Handler) as server:
        print(f"SenseVoice 口播剪辑器: http://127.0.0.1:{port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
