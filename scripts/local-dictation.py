"""One-shot, stdin-only offline transcription helper for K."""

import ctypes
import gc
import io
import json
import os
import re
import subprocess
import sys
import time
import traceback
import wave

MODEL = os.environ.get("K_DICTATION_MODEL")
MAX_SECONDS = 5 * 60
SAMPLE_RATE = 16_000
# Dictation takes the fastest option that fits in free GPU memory and leaves the rest to other GPU
# work: float16 loads fastest (about 3.9 GB), int8 needs about 2 GB but loads about 2 s slower, and
# below that the CPU is slower still but keeps dictation working.
GPU_FLOAT16_MIN_FREE_MB = 4500
GPU_INT8_MIN_FREE_MB = 2500
# A short spoken prompt retains punctuation without supplying a long text to echo.
PROMPT = "好，我們繼續。"
# Product names often misheard by the recognizer.
GENERAL_HOTWORDS = (
    "DeepSeek", "DeepSeek Harness", "Claude", "Sonnet", "Haiku", "Antigravity", "Grok",
    "Gemma",
)
# Spellings Whisper still writes even with the hotwords; English-only, so no everyday Chinese hits.
GENERAL_REPLACEMENTS = (
    ("Deep Seek", "DeepSeek"), ("Anti-Gravity", "Antigravity"), ("Grog", "Grok"),
)

# Match complete caption phrases sometimes emitted during silence.
_SEP = r"[\s、，,]*"
HALLUCINATION_PATTERNS = (
    rf"請不吝(?:點贊|點讚){_SEP}訂閱{_SEP}轉發{_SEP}打賞支持明鏡與點點欄目",
    r"明鏡(?:與點點欄目|需要您的支持)",
    rf"(?:點贊|點讚){_SEP}訂閱{_SEP}轉發{_SEP}打賞(?:支持)?",
    rf"(?:歡迎|請)(?:(?:點贊|點讚|按讚){_SEP})?訂閱我的頻道",
    r"(?:中文)?字幕由\s*Amara\.org\s*(?:社區|社群)提供",
    r"(?:謝謝|感謝)(?:大家|各位|您)?的?(?:觀看|收看)",
    r"(?:我們)?下(?:期|集)再見",
    r"優優獨播劇場(?:\s*[-—–]+\s*YoYo Television Series Exclusive)?",
)
_PUNCT = r"[\s，、,。！？!?.]*"

# Local Whisper jobs can share this mutex before loading a model on the GPU: whoever
# holds it keeps the GPU, a later dictation uses the CPU instead of waiting, a later batch waits.
# Windows releases it when the holder exits or crashes (WAIT_ABANDONED).
MUTEX_NAME = "Local\\WhisperGpuShared-v1"
WAIT_OBJECT_0 = 0x00000000
WAIT_ABANDONED = 0x00000080


def windows_kernel32():
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    k32.CreateMutexW.restype = wintypes.HANDLE
    k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k32.WaitForSingleObject.restype = wintypes.DWORD
    k32.ReleaseMutex.argtypes = [wintypes.HANDLE]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    return k32


class WindowsGpuMutex:
    """Acquires and releases the shared Windows named GPU mutex."""

    def __init__(self, name=MUTEX_NAME, kernel32=None):
        self.name = name
        self.kernel32 = kernel32
        self.handle = None
        self.acquired = False

    def _k32(self):
        if self.kernel32 is not None:
            return self.kernel32
        if sys.platform == "win32":
            self.kernel32 = windows_kernel32()
            return self.kernel32
        return None

    def acquire(self, timeout_ms=0):
        k32 = self._k32()
        if not k32:
            return False
        if not self.handle:
            self.handle = k32.CreateMutexW(None, False, self.name)
            if not self.handle:
                return False
        res = k32.WaitForSingleObject(self.handle, timeout_ms)
        if res in (WAIT_OBJECT_0, WAIT_ABANDONED):
            self.acquired = True
            return True
        k32.CloseHandle(self.handle)
        self.handle = None
        return False

    def release(self):
        if self.acquired and self.handle:
            k32 = self._k32()
            if k32:
                try:
                    k32.ReleaseMutex(self.handle)
                except Exception:
                    pass
            self.acquired = False
        if self.handle:
            k32 = self._k32()
            if k32:
                try:
                    k32.CloseHandle(self.handle)
                except Exception:
                    pass
            self.handle = None


def load_cuda_dll_directories():
    """Keep DLL search additions process-local and scoped to the existing venv."""
    handles = []
    site_packages = os.path.join(os.path.dirname(os.path.dirname(sys.executable)), "Lib", "site-packages")
    for package in ("cublas", "cuda_runtime", "cuda_nvrtc", "cudnn"):
        directory = os.path.join(site_packages, "nvidia", package, "bin")
        if os.path.isdir(directory) and hasattr(os, "add_dll_directory"):
            handles.append(os.add_dll_directory(directory))
    return handles


def read_pcm16_mono_16k(raw):
    # wave reads from BytesIO, accepts legal ancillary RIFF chunks, and never
    # writes the supplied audio to a file.
    with wave.open(io.BytesIO(raw), "rb") as audio:
        if (audio.getcomptype() != "NONE" or audio.getnchannels() != 1 or
                audio.getsampwidth() != 2 or audio.getframerate() != SAMPLE_RATE):
            raise ValueError("WAV must be uncompressed PCM16 mono at 16 kHz")
        frames = audio.getnframes()
        if frames <= 0 or frames > MAX_SECONDS * SAMPLE_RATE:
            raise ValueError("WAV duration must be greater than zero and no longer than five minutes")
        pcm = audio.readframes(frames)
        if len(pcm) != frames * 2:
            raise ValueError("Truncated WAV audio data")
    import numpy as np
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def query_gpu_sample(run_cmd=None):
    """Queries a single utilization and memory.free sample from nvidia-smi."""
    cmd = [
        "nvidia-smi",
        "--query-gpu=utilization.gpu,memory.free",
        "--format=csv,noheader,nounits"
    ]
    if run_cmd:
        stdout = run_cmd(cmd)
    else:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=1,
            check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
        stdout = result.stdout
    line = stdout.strip().splitlines()[0]
    parts = [p.strip().replace("%", "").replace("MiB", "").strip() for p in line.split(",")]
    if len(parts) < 2:
        raise ValueError("Invalid nvidia-smi output format")
    util = int(parts[0])
    free_mb = int(parts[1])
    return util, free_mb


def sample_gpu_load(query_fn=query_gpu_sample, sleep_fn=time.sleep):
    """Takes 3 samples over ~1 second, with per-query and total bounded time."""
    samples = []
    start_time = time.monotonic()
    total_budget = 1.5
    for i in range(3):
        if i > 0:
            elapsed = time.monotonic() - start_time
            if elapsed < 1.0:
                delay = min(0.35, max(0.01, (1.0 - elapsed) / (3 - i)))
                sleep_fn(delay)
            if (time.monotonic() - start_time) > total_budget:
                raise TimeoutError("GPU sampling total budget exceeded")
        util, free_mb = query_fn()
        samples.append((util, free_mb))
    return samples


def evaluate_gpu_compute_type(samples):
    """Evaluates 3 samples: 2 of 3 >= 70% utilization -> CPU; else memory threshold."""
    high_util_count = sum(1 for util, _ in samples if util >= 70)
    if high_util_count >= 2:
        return None
    min_free_mb = min(free_mb for _, free_mb in samples)
    if min_free_mb >= GPU_FLOAT16_MIN_FREE_MB:
        return "float16"
    if min_free_mb >= GPU_INT8_MIN_FREE_MB:
        return "int8_float16"
    return None


def gpu_compute_type(query_fn=query_gpu_sample, sleep_fn=time.sleep):
    """Returns GPU compute type that fits, or None if load is high, memory is low, or query fails."""
    try:
        samples = sample_gpu_load(query_fn=query_fn, sleep_fn=sleep_fn)
        return evaluate_gpu_compute_type(samples)
    except Exception as exc:
        sys.stderr.write(f"GPU query failed or format abnormal, using CPU: {type(exc).__name__}: {exc}\n")
        return None


def load_model(device, compute_type):
    from faster_whisper import WhisperModel
    kwargs = {"device": device, "compute_type": compute_type, "local_files_only": True}
    if device == "cpu":
        kwargs["cpu_threads"] = 8
    return WhisperModel(MODEL, **kwargs)


def load_vocabulary(asr_root):
    """Use K names and optionally an explicitly selected local vocabulary folder."""
    if not asr_root:
        return " ".join(GENERAL_HOTWORDS), list(GENERAL_REPLACEMENTS)
    config = os.path.join(asr_root, "config")
    replacements = list(GENERAL_REPLACEMENTS)
    try:
        with open(os.path.join(config, "asr_replacements.json"), encoding="utf-8-sig") as fh:
            replacements += [(row["from"], row["to"]) for row in json.load(fh)["replacements"] if "scope" not in row]
    except FileNotFoundError:
        pass
    return " ".join(GENERAL_HOTWORDS), replacements


_SIMPLIFIED_ONLY = None


def simplified_only_chars():
    """Characters that occur only in Simplified writing, from OpenCC's own character tables.

    Ambiguous ones that are also correct Traditional (干, 后, 里, 面) are left out, so text Whisper
    already wrote in Traditional is never touched (a blanket conversion turns 干擾 into 幹擾).
    """
    global _SIMPLIFIED_ONLY
    if _SIMPLIFIED_ONLY is None:
        import opencc
        directory = os.path.join(os.path.dirname(opencc.__file__), "dictionary")
        simplified, traditional = set(), set()
        with open(os.path.join(directory, "STCharacters.txt"), encoding="utf-8") as fh:
            for line in fh:
                key, _, values = line.rstrip("\n").partition("\t")
                simplified.add(key)
                traditional.update(values.split())
        with open(os.path.join(directory, "TSCharacters.txt"), encoding="utf-8") as fh:
            traditional.update(line.partition("\t")[0] for line in fh)
        _SIMPLIFIED_ONLY = frozenset(simplified - traditional)
    return _SIMPLIFIED_ONLY


def to_traditional(text):
    """Convert Simplified clauses to Taiwan Traditional characters, keeping the speaker's words.

    Clause by clause, so a Traditional clause beside a Simplified one keeps its 干擾. A clause made
    only of shared characters (后面) stays as written. s2tw changes characters only; s2twp would also
    swap vocabulary (支持 to 支援), which rewrites what was actually said.
    """
    simplified = simplified_only_chars()
    if not any(ch in simplified for ch in text):
        return text
    import opencc
    converter = opencc.OpenCC("s2tw")
    parts = re.split(r"([\s，、,。.！？!?；;：:]+)", text)
    return "".join(converter.convert(p) if any(ch in simplified for ch in p) else p for p in parts)


def _close_seam(match):
    """Punctuation around a removed caption: keep one side's mark and any line break or word gap."""
    if match.start() == 0:
        return ""
    around = match.group(1) + match.group(2)
    left, right = match.group(1).strip(), match.group(2).strip()
    mark = (right or left) if match.end() == len(match.string) else (left or right)
    if "\n" in around:
        return mark + "\n"
    return mark or (" " if around.isspace() else "")


def remove_hallucinations(text):
    # Quoted text is the owner dictating copy (「謝謝觀看」); Whisper's made-up lines are never quoted.
    # An unclosed quote protects to the end, since Whisper may drop the closing mark.
    parts = re.split(r"(「[^」]*(?:」|$)|『[^』]*(?:』|$)|“[^”]*(?:”|$)|\"[^\"]*(?:\"|$))", text)
    for i in range(0, len(parts), 2):
        for pattern in HALLUCINATION_PATTERNS:
            parts[i] = re.sub(pattern, "\0", parts[i])
    text = "".join(parts)
    if "\0" not in text:
        return text
    text = re.sub(rf"({_PUNCT})\0(?:{_PUNCT}\0)*({_PUNCT})", _close_seam, text).strip()
    return text if re.search(r"\w", text) else ""


def transcribe(model, audio, vocabulary, on_gpu=True):
    hotwords, replacements = vocabulary
    # faster-whisper budgets hotwords and previous text separately (223 tokens each).
    # Together with control tokens they can exceed Whisper's 448-token context on
    # later windows. Keep hotwords, but do not carry decoded text into the next window.
    # On the GPU, hallucination_silence_threshold (it needs word timestamps) skips a pause Whisper
    # filled with made-up text; it costs nothing there but made a 9 s CPU dictation 60% slower, so the
    # CPU uses the phrase filter to keep transcription latency down.
    pause_check = {"word_timestamps": True, "hallucination_silence_threshold": 2.0} if on_gpu else {}
    segments, _ = model.transcribe(
        audio, beam_size=5, language="zh", vad_filter=True, initial_prompt=PROMPT, hotwords=hotwords,
        condition_on_previous_text=False, no_speech_threshold=0.5, **pause_check,
    )
    text = remove_hallucinations("".join(to_traditional(segment.text) for segment in segments).strip())
    for old, new in replacements:
        text = text.replace(old, new)
    return text


def main(mutex_cls=WindowsGpuMutex, query_fn=query_gpu_sample, sleep_fn=time.sleep):
    # The helper accepts only raw WAV bytes on stdin. No request-provided path,
    # model name or command is interpreted; the trusted parent supplies the
    # offline model path through its process environment.
    # The model is loaded before audio arrives so the parent can start it early (prewarm).
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if not MODEL:
        raise ValueError("K_DICTATION_MODEL is required")
    dll_handles = load_cuda_dll_directories()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    gpu_mutex = mutex_cls()
    acquired = gpu_mutex.acquire(timeout_ms=0)
    compute_type = None

    if acquired:
        compute_type = gpu_compute_type(query_fn=query_fn, sleep_fn=sleep_fn)
        if not compute_type:
            gpu_mutex.release()
    else:
        sys.stderr.write("GPU mutex busy, using CPU\n")

    model = None
    if compute_type:
        try:
            model = load_model("cuda", compute_type)
        except Exception as exc:
            sys.stderr.write(f"GPU load failed, using CPU: {type(exc).__name__}: {exc}\n")
        if model is None:
            # Outside the except block the traceback no longer holds the partial GPU allocations.
            gc.collect()
            gpu_mutex.release()

    on_gpu = model is not None
    if not on_gpu:
        model = load_model("cpu", "int8")

    sys.stderr.write(f"Dictation device={'cuda' if on_gpu else 'cpu'}, compute_type={compute_type if on_gpu else 'int8'}\n")

    vocabulary = load_vocabulary(os.environ.get("K_DICTATION_VOCABULARY_ROOT"))
    raw = sys.stdin.buffer.read()
    if not raw:
        raise ValueError("Empty WAV input")
    audio = read_pcm16_mono_16k(raw)
    try:
        text = transcribe(model, audio, vocabulary, on_gpu)
    except Exception as exc:
        if not on_gpu:
            raise
        sys.stderr.write(f"GPU transcription failed, retrying on CPU: {type(exc).__name__}: {exc}\n")
        text = None

    if text is None:
        model = None  # Free the GPU memory before the slower CPU retry.
        gc.collect()
        gpu_mutex.release()
        text = transcribe(load_model("cpu", "int8"), audio, vocabulary, on_gpu=False)

    sys.stdout.write(json.dumps({"ok": True, "text": text}, ensure_ascii=False) + "\n")
    # Retain the DLL directory handles through model inference.
    _ = dll_handles


if __name__ == "__main__":
    try:
        main()
    except Exception:  # Preserve error location without capturing frame locals or audio.
        traceback.print_exc()
        sys.exit(1)
