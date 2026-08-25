#!/usr/bin/env python3
import json
import subprocess
import sys
from pathlib import Path


def run(command):
    subprocess.run(command, check=True)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: render_keep_intervals.py <keep-json>")

    keep_path = Path(sys.argv[1]).expanduser().resolve()
    data = json.loads(keep_path.read_text("utf-8"))
    source = Path(data["source"]).expanduser()
    output = Path(data["output"]).expanduser()
    intervals = data.get("keep_intervals") or []

    if not source.exists():
        raise SystemExit(f"Source video not found: {source}")
    if not intervals:
        raise SystemExit("No keep_intervals found.")

    filter_parts = []
    for index, item in enumerate(intervals):
        start = float(item["start"])
        end = float(item["end"])
        if end <= start:
            raise SystemExit(f"Invalid interval #{index + 1}: end <= start")
        filter_parts.append(f"[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS[v{index}]")
        filter_parts.append(f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[a{index}]")

    concat_inputs = "".join(f"[v{index}][a{index}]" for index in range(len(intervals)))
    filter_parts.append(f"{concat_inputs}concat=n={len(intervals)}:v=1:a=1[outv][outa]")
    filter_path = keep_path.with_suffix(".ffmpeg-filter.txt")
    filter_path.write_text(";\n".join(filter_parts) + "\n", "utf-8")

    output.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-i",
            str(source),
            "-filter_complex_script",
            str(filter_path),
            "-map",
            "[outv]",
            "-map",
            "[outa]",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )

    run(["ffmpeg", "-v", "error", "-i", str(output), "-f", "null", "-"])
    print(json.dumps({"ok": True, "output": str(output), "intervals": len(intervals)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
