"""One-shot transcription for dsh-voice.

Usage:
  python asr_once.py <audio-file> [--model large-v3] [--device cuda]
                     [--compute-type float16] [--hotwords "..."] [--prompt "..."]

Prints a single JSON line on stdout: {"text": "...", "language": "zh", "duration": 3.4}
Diagnostics go to stderr so callers can parse stdout safely.

Accuracy notes:
  - large-v3 is markedly better than small/medium on Chinese short utterances.
  - `hotwords` biases proper nouns (names, product names) without being echoed back
    as aggressively as `initial_prompt`; both are supported here.
  - temperature=0 + beam search keeps decoding deterministic for short clips.
"""
import argparse
import json
import os
import re
import sys
import tempfile

SILK_HEAD = b"#!SILK_V3"

DEFAULT_HOTWORDS = (
    "哈喽，哈喽哈喽，雨晶，霍霍，岁阳，昔涟，舒黎，DeepSeek，DSH，GPT-SoVITS，"
    "语音气泡，语音消息，插件，麦克风，浏览器，聊天框，截图，"
    "会话，语音识别，转写，刷新，上下文，模型，显存"
)

CJK = re.compile(r"[\u3400-\u9fff]")
FULL_WIDTH = {",": "，", ".": "。", "?": "？", "!": "！", ":": "：", ";": "；"}
SPACE_BETWEEN_CJK = re.compile(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])")
INITIAL_PROMPT = "以下是普通话的句子。对话内容涉及插件、会话、语音气泡和语音识别。"


def normalize_zh(text):
    """Prefer Chinese punctuation where the model emitted ASCII marks after hanzi."""
    out = []
    for index, char in enumerate(text):
        previous = text[index - 1] if index > 0 else ""
        if char in FULL_WIDTH and (previous == "" or CJK.match(previous)):
            out.append(FULL_WIDTH[char])
        else:
            out.append(char)
    return SPACE_BETWEEN_CJK.sub("", "".join(out)).strip()


def is_silk(path):
    """QQ 语音条是 SILK_V3（可能带 0x02 前缀），ffmpeg 解不了。"""
    try:
        with open(path, "rb") as handle:
            head = handle.read(16)
    except OSError:
        return False
    return head.startswith(SILK_HEAD) or (len(head) > 1 and head[0] == 2 and head[1:].startswith(SILK_HEAD))


def prepare_audio(path):
    """SILK 先转成临时 wav；其它格式原样返回。返回 (路径, 需要清理的临时文件或 None)。"""
    if not is_silk(path):
        return path, None
    try:
        import pysilk
    except ImportError as exc:  # pragma: no cover - 环境缺失时给出可读错误
        raise RuntimeError("收到 SILK 语音，但环境缺 pysilk（pip install pysilk-mod）") from exc
    with open(path, "rb") as handle:
        data = handle.read()
    wav = pysilk.decode(data, to_wav=True, sample_rate=24000)
    fd, temp = tempfile.mkstemp(prefix="silk-", suffix=".wav")
    os.close(fd)
    with open(temp, "wb") as handle:
        handle.write(wav)
    return temp, temp


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--models-dir", default=r"D:\AI\models\whisper")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--hotwords", default=DEFAULT_HOTWORDS)
    parser.add_argument("--prompt", default=INITIAL_PROMPT)
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--no-vad", action="store_true")
    args = parser.parse_args()
    audio_path, temp_path = prepare_audio(args.audio)
    try:
        return transcribe(args, audio_path)
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass


def transcribe(args, audio_path):
    from faster_whisper import WhisperModel

    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        download_root=args.models_dir,
    )

    kwargs = {
        "language": args.language,
        "beam_size": args.beam_size,
        "temperature": 0.0,
        "condition_on_previous_text": False,
        "without_timestamps": True,
        "vad_filter": not args.no_vad,
        "vad_parameters": {"min_silence_duration_ms": 300},
    }
    if args.hotwords:
        kwargs["hotwords"] = args.hotwords
    if args.prompt:
        kwargs["initial_prompt"] = args.prompt

    segments, info = model.transcribe(audio_path, **kwargs)
    parts = []
    for seg in segments:
        piece = seg.text.strip()
        if piece:
            parts.append(piece)
    text = normalize_zh("".join(parts))
    print(json.dumps({
        "text": text,
        "language": info.language,
        "duration": float(info.duration),
        "model": args.model,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - report to caller as JSON
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        sys.exit(1)
