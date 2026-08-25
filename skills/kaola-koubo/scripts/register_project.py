#!/usr/bin/env python3
"""Register a local video/transcript pair for the web editor."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path


DATA_DIR = Path(os.environ.get("KOUBO_EDITOR_DATA_DIR", Path.cwd() / ".kaola-koubo")).expanduser().resolve()
PROJECTS_FILE = DATA_DIR / "projects.json"


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-").lower()
    return slug or "project"


def load_projects() -> dict:
    if PROJECTS_FILE.exists():
        return json.loads(PROJECTS_FILE.read_text("utf-8"))
    return {"default": "", "projects": []}


def write_projects(data: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    PROJECTS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")


def make_initial_keep(raw_path: Path, video_path: Path, output_path: Path, keep_path: Path) -> None:
    raw = json.loads(raw_path.read_text("utf-8"))
    intervals = []
    for utterance in raw.get("utterances", []):
        text = (utterance.get("text") or "").strip()
        start = float(utterance.get("start", 0))
        end = float(utterance.get("end", 0))
        if text and end > start:
            intervals.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
                "reason": "初始保留有口播文字的片段；请让 AI 按语义重复/半句规则进一步预剪",
            })
    keep = {
        "duration": raw.get("duration"),
        "source": str(video_path),
        "output": str(output_path),
        "rule": "本文件为初始保留草稿：先保留有口播文字的片段；后续应由 AI 读全文，按语义判断重复试讲、半句和更完整后句。",
        "keep_intervals": intervals,
    }
    keep_path.parent.mkdir(parents=True, exist_ok=True)
    keep_path.write_text(json.dumps(keep, ensure_ascii=False, indent=2), "utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--raw", required=True, type=Path)
    parser.add_argument("--id")
    parser.add_argument("--label")
    parser.add_argument("--keep", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--default", action="store_true")
    args = parser.parse_args()

    video = args.video.expanduser().resolve()
    raw = args.raw.expanduser().resolve()
    if not video.exists():
        parser.error(f"video not found: {video}")
    if not raw.exists():
        parser.error(f"raw transcript not found: {raw}")

    project_id = args.id or slugify(video.stem)
    label = args.label or video.stem
    keep = (args.keep or (DATA_DIR / f"{project_id}_keep.json")).expanduser().resolve()
    output = (args.output or video.with_name(video.stem + "_cut.mp4")).expanduser().resolve()
    if not keep.exists():
        make_initial_keep(raw, video, output, keep)

    data = load_projects()
    projects = [project for project in data.get("projects", []) if project.get("id") != project_id]
    projects.append({
        "id": project_id,
        "label": label,
        "video": str(video),
        "raw": str(raw),
        "keep": str(keep),
        "output": str(output),
    })
    data["projects"] = projects
    if args.default or not data.get("default"):
        data["default"] = project_id
    write_projects(data)
    print(json.dumps({"ok": True, "project": project_id, "projects_file": str(PROJECTS_FILE)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
