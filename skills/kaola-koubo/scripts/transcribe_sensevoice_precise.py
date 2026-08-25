#!/usr/bin/env python3
"""Local SenseVoice transcription with fine-grained editor timeline output."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path


DEFAULT_RUNTIME = Path(os.environ["SENSEVOICE_PYTHON"]).expanduser() if os.environ.get("SENSEVOICE_PYTHON") else None
DEFAULT_MODEL = os.environ.get("SENSEVOICE_MODEL", "iic/SenseVoiceSmall")
DEFAULT_VAD_MODEL = os.environ.get("SENSEVOICE_VAD_MODEL", "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch")
PUNCTUATION = set("，。、；：？！,.!?;:、")


def ensure_runtime() -> None:
    try:
        import funasr  # noqa: F401
        import torch  # noqa: F401
    except Exception:
        if DEFAULT_RUNTIME and DEFAULT_RUNTIME.exists() and Path(sys.executable).resolve() != DEFAULT_RUNTIME.resolve():
            os.execv(str(DEFAULT_RUNTIME), [str(DEFAULT_RUNTIME), *sys.argv])
        raise


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def ffprobe_duration(path: Path) -> float:
    output = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        text=True,
    ).strip()
    return float(output or 0)


def extract_wav(source: Path, wav_path: Path) -> None:
    run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(wav_path),
        ]
    )


def write_wave_segment(source: Path, target: Path, start_ms: int, end_ms: int, pad_ms: int) -> tuple[int, int]:
    with wave.open(str(source), "rb") as reader:
        rate = reader.getframerate()
        start_frame = max(0, round((start_ms - pad_ms) * rate / 1000))
        end_frame = min(reader.getnframes(), round((end_ms + pad_ms) * rate / 1000))
        reader.setpos(start_frame)
        frames = reader.readframes(max(0, end_frame - start_frame))
        params = reader.getparams()
    with wave.open(str(target), "wb") as writer:
        writer.setparams(params)
        writer.writeframes(frames)
    return round(start_frame * 1000 / rate), round(end_frame * 1000 / rate)


def clean_text(value: str) -> str:
    text = re.sub(r"<\|[^|]+\|>", "", value or "")
    text = re.sub(r"\s+", "", text)
    return text.strip()


def merge_vad_segments(raw_segments: list[list[int]], max_gap_ms: int) -> list[list[int]]:
    merged: list[list[int]] = []
    for item in sorted(raw_segments):
        if not item or len(item) < 2:
            continue
        start, end = int(item[0]), int(item[1])
        if end <= start:
            continue
        if merged and start - merged[-1][1] <= max_gap_ms:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def align_chars(text: str, start_ms: int, end_ms: int, utterance_index: int) -> list[dict]:
    chars = [char for char in text if char.strip()]
    if not chars:
        return []
    duration_ms = max(len(chars) * 80, end_ms - start_ms)
    char_ms = duration_ms / len(chars)
    aligned = []
    for index, char in enumerate(chars):
        char_start = start_ms + char_ms * index
        char_end = start_ms + char_ms * (index + 1)
        aligned.append(
            {
                "text": char,
                "start": round(char_start / 1000, 3),
                "end": round(char_end / 1000, 3),
                "start_01": round(char_start / 1000, 1),
                "end_01": round(char_end / 1000, 1),
                "utterance_index": utterance_index,
                "char_index": index,
            }
        )
    return aligned


def build_edit_segments(chars: list[dict], max_chars: int, max_duration: float) -> list[dict]:
    segments = []
    current: list[dict] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        text = "".join(item["text"] for item in current)
        start = round(max(0.0, current[0]["start"]), 1)
        end = round(max(0.0, current[-1]["end"]), 1)
        if segments and start < segments[-1]["end"]:
            start = segments[-1]["end"]
        if end <= start:
            end = round(start + 0.1, 1)
        segments.append(
            {
                "start": round(start, 1),
                "end": round(end, 1),
                "text": text,
                "char_start": current[0]["char_index"],
                "char_end": current[-1]["char_index"],
                "utterance_index": current[0]["utterance_index"],
            }
        )
        current = []

    for char in chars:
        if current:
            duration = char["end"] - current[0]["start"]
            changed_utterance = char["utterance_index"] != current[0]["utterance_index"]
            if changed_utterance or len(current) >= max_chars or duration >= max_duration:
                flush()
        current.append(char)
        if char["text"] in PUNCTUATION:
            flush()
    flush()
    return segments


def main() -> int:
    ensure_runtime()
    from funasr import AutoModel

    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Local video/audio file")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audio", type=Path)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--vad-model", default=DEFAULT_VAD_MODEL)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--merge-gap-ms", type=int, default=300)
    parser.add_argument("--pad-ms", type=int, default=80)
    parser.add_argument("--max-chars", type=int, default=8)
    parser.add_argument("--max-duration", type=float, default=1.0)
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    if not source.exists():
        parser.error(f"source not found: {source}")
    duration = ffprobe_duration(source)

    with tempfile.TemporaryDirectory(prefix="sensevoice-precise-") as temp_dir:
        temp_root = Path(temp_dir)
        wav_path = args.audio.expanduser().resolve() if args.audio else temp_root / "audio.wav"
        if args.audio and wav_path.exists():
            pass
        else:
            extract_wav(source, wav_path)

        vad_model = AutoModel(model=str(args.vad_model), disable_update=True, device=args.device)
        vad_result = vad_model.generate(input=str(wav_path))
        raw_vad = vad_result[0].get("value", []) if vad_result else []
        vad_segments = merge_vad_segments(raw_vad, args.merge_gap_ms)

        asr_model = AutoModel(model=str(args.model), disable_update=True, device=args.device)
        utterances = []
        all_chars = []
        for utterance_index, (start_ms, end_ms) in enumerate(vad_segments):
            chunk = temp_root / f"utt_{utterance_index:04d}.wav"
            padded_start_ms, padded_end_ms = write_wave_segment(wav_path, chunk, start_ms, end_ms, args.pad_ms)
            result = asr_model.generate(input=str(chunk), language=args.language, use_itn=True, batch_size_s=300)
            text = clean_text(result[0].get("text", "") if result else "")
            if not text:
                continue
            utterance = {
                "start": round(start_ms / 1000, 3),
                "end": round(end_ms / 1000, 3),
                "start_ms": start_ms,
                "end_ms": end_ms,
                "padded_start_ms": padded_start_ms,
                "padded_end_ms": padded_end_ms,
                "text": text,
            }
            utterances.append(utterance)
            all_chars.extend(align_chars(text, start_ms, end_ms, utterance_index))

    edit_segments = build_edit_segments(all_chars, args.max_chars, args.max_duration)
    payload = {
        "engine": "SenseVoiceLocal",
        "model": str(args.model),
        "vad_model": str(args.vad_model),
        "language": args.language,
        "device": args.device,
        "duration": duration,
        "source": str(source),
        "precision": {
            "time_step_seconds": 0.1,
            "method": "fsmn-vad speech ranges + SenseVoice text + per-character interpolation inside each VAD speech range",
        },
        "text": "".join(item["text"] for item in utterances),
        "utterances": utterances,
        "chars": all_chars,
        "segments": edit_segments,
    }

    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
    print(
        json.dumps(
            {
                "ok": True,
                "output": str(output),
                "duration": round(duration, 3),
                "utterances": len(utterances),
                "chars": len(all_chars),
                "segments": len(edit_segments),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
