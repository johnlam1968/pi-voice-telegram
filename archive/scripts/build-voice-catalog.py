#!/usr/bin/env python3
"""
Parse the MiniMax system-voice catalog markdown
(https://platform.minimaxi.com/docs/faq/system-voice-id.md) into
voices.json for the pi-voice-telegram extension.

The catalog markdown looks like:

    | 81  | 日文       | `Japanese_IntellectualSenior`               | Intellectual Senior       |
    | 82  | 日文       | `Japanese_DecisivePrincess`                 | Decisive Princess         |
    ...

We extract {index, voiceId, voiceName, language (original), languageEn}
for each row. The Chinese -> English label map is hard-coded below; update
it if MiniMax adds a new language family.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Canonical mapping from the catalog's Chinese label to an English label
# the LLM-facing tool can filter on. Order doesn't matter.
LANGUAGE_MAP: dict[str, str] = {
    "中文 (普通话)": "Mandarin",
    "中文 (粤语)": "Cantonese",
    "英文": "English",
    "日文": "Japanese",
    "韩文": "Korean",
    "西班牙文": "Spanish",
    "葡萄牙文": "Portuguese",
    "法文": "French",
    "印尼文": "Indonesian",
    "德文": "German",
    "俄文": "Russian",
    "意大利文": "Italian",
    "阿拉伯文": "Arabic",
    "土耳其文": "Turkish",
    "乌克兰文": "Ukrainian",
    "荷兰文": "Dutch",
    "越南文": "Vietnamese",
    "泰文": "Thai",
    "波兰文": "Polish",
    "罗马尼亚文": "Romanian",
    "希腊文": "Greek",
    "捷克文": "Czech",
    "芬兰文": "Finnish",
    "印地文": "Hindi",
}

# Row pattern: "| <num> | <lang> | `<voiceId>` | <voiceName> |"
# Each voiceId is wrapped in backticks; voiceName is plain text (may
# contain spaces, dashes, parentheses).
ROW_RE = re.compile(
    r"^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*$"
)


def parse_catalog(md_path: Path) -> list[dict[str, str | int]]:
    """Return the list of voice entries from the markdown table."""
    text = md_path.read_text(encoding="utf-8")
    entries: list[dict[str, str | int]] = []
    unknown_languages: set[str] = set()
    for line in text.splitlines():
        m = ROW_RE.match(line)
        if not m:
            continue
        index, lang_key, voice_id, voice_name = (
            int(m.group(1)),
            m.group(2).strip(),
            m.group(3).strip(),
            m.group(4).strip(),
        )
        lang_en = LANGUAGE_MAP.get(lang_key)
        if lang_en is None:
            unknown_languages.add(lang_key)
            lang_en = lang_key  # fall back to the original label
        entries.append(
            {
                "index": index,
                "voiceId": voice_id,
                "voiceName": voice_name,
                "language": lang_en,
                "languageKey": lang_key,
            }
        )
    if unknown_languages:
        print(
            f"warning: unknown language keys (using as-is): {sorted(unknown_languages)}",
            file=sys.stderr,
        )
    return entries


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: build-voice-catalog.py <input.md> <output.json>", file=sys.stderr)
        return 2
    md_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    entries = parse_catalog(md_path)
    # De-dupe by voiceId (defensive — catalog shouldn't have dupes but
    # if it ever does, keep the first).
    seen: set[str] = set()
    deduped: list[dict[str, str | int]] = []
    for e in entries:
        if e["voiceId"] in seen:
            continue
        seen.add(e["voiceId"])
        deduped.append(e)
    payload = {
        "version": "2026-08-17",
        "source": "https://platform.minimaxi.com/docs/faq/system-voice-id",
        "lastUpdated": "2026-08-17",
        "count": len(deduped),
        "voices": deduped,
    }
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {len(deduped)} voices to {out_path}")
    # Sanity check: print a per-language summary.
    by_lang: dict[str, int] = {}
    for e in deduped:
        by_lang[e["language"]] = by_lang.get(e["language"], 0) + 1  # type: ignore[arg-type]
    for lang in sorted(by_lang):
        print(f"  {lang:14s} {by_lang[lang]:3d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
