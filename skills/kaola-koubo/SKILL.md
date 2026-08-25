---
name: kaola-koubo
description: Use local SenseVoice and a bundled web editor to transcribe local speech videos, semantically pre-cut repeated or unfinished口播 attempts, expose word-level transcript editing with 0.01s waveform precision, and render keep-interval video edits. Use when the user asks to cut口播, remove stumbles, edit video by transcript, process a local talking-head or screen-recorded speech video, or prepare this editor for another AI using only local transcription.
---

# Kaola 口播剪辑器

Use the scripts and bundled UI in this Skill folder. Resolve relative paths from the folder containing this `SKILL.md`. Use local transcription only. Do not copy user videos, raw transcripts, or rendered outputs into the repository.

## Workflow

1. Transcribe the local video with SenseVoice:
   ```bash
   python3 skills/kaola-koubo/scripts/transcribe_sensevoice_precise.py /absolute/path/video.mp4 --output .kaola-koubo/<project>_raw.json
   ```
2. Register the video in the editor:
   ```bash
   python3 skills/kaola-koubo/scripts/register_project.py --video /absolute/path/video.mp4 --raw .kaola-koubo/<project>_raw.json --id <project> --label "<label>" --default
   ```
3. Read `.kaola-koubo/<project>_raw.json` yourself before the first cut. The initial keep file only keeps voiced transcript spans; it is not the final edit.
4. Update `.kaola-koubo/<project>_keep.json` by semantic judgment, then start the UI:
   ```bash
   python3 skills/kaola-koubo/scripts/server.py 8767
   ```
5. Open `http://127.0.0.1:8767/`, review the transcript editor and waveform, then render from the UI or run:
   ```bash
   python3 skills/kaola-koubo/scripts/render_keep_intervals.py .kaola-koubo/<project>_keep.json
   ```

## Pre-cut rules

- Prefer the later attempt when two nearby lines express the same point and the later line is fuller, smoother, or more decisive.
- Cut earlier fragments when the speaker starts a sentence, abandons it, then restarts with similar meaning.
- Treat near-repetition semantically, not as exact string matching; wording may differ.
- Remove abrupt filler words, stray single characters, and visibly broken syntax when removing them keeps the sentence natural.
- Preserve meaning over aggressiveness. If cutting a word makes the surrounding sentence choppy, keep a slightly wider phrase.
- Keep normal rhythm but remove long blank pauses. In the UI, pauses of about 0.5s or more are shown as editable pause tokens.

## Precision rules

- Use the transcript for semantic decisions and the waveform for cut boundaries.
- The UI exposes 0.01s waveform bins. When consonants or first syllables are clipped, expand the interval by tiny steps around the waveform onset.
- Do not fix leaked audio by changing transcript text; fix it by adjusting keep intervals.
- Avoid half-kept words. If a selected phrase leaves a stray character, merge the character into the cut or restore the full word.
- Preview jump-cut mode should stay enabled while checking cuts.

## Repository hygiene

- Keep user media outside Git. `.gitignore` excludes common video/audio formats and generated data.
- Commit this Skill folder, plugin metadata, and repository docs only.
- Before publishing, run a text search for external transcription references and a file search for media files.
