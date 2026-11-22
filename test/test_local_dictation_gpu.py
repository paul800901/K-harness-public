"""Unit tests for GPU mutex and sampling logic in scripts/local-dictation.py."""

import importlib.util
import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

SPEC = importlib.util.spec_from_file_location(
    "local_dictation",
    os.path.join(os.path.dirname(__file__), "..", "scripts", "local-dictation.py")
)
ld = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ld)
SPEECH = SimpleNamespace(duration_after_vad=2.0)


class TestWindowsGpuMutex(unittest.TestCase):
    def test_acquire_success(self):
        k32 = MagicMock()
        k32.CreateMutexW.return_value = 1001
        k32.WaitForSingleObject.return_value = ld.WAIT_OBJECT_0

        mutex = ld.WindowsGpuMutex(name="TestMutex", kernel32=k32)
        acquired = mutex.acquire(timeout_ms=0)

        self.assertTrue(acquired)
        self.assertTrue(mutex.acquired)
        self.assertEqual(mutex.handle, 1001)
        k32.CreateMutexW.assert_called_once_with(None, False, "TestMutex")
        k32.WaitForSingleObject.assert_called_once_with(1001, 0)

    def test_acquire_timeout(self):
        k32 = MagicMock()
        k32.CreateMutexW.return_value = 1002
        k32.WaitForSingleObject.return_value = 0x00000102

        mutex = ld.WindowsGpuMutex(name="TestMutex", kernel32=k32)
        acquired = mutex.acquire(timeout_ms=0)

        self.assertFalse(acquired)
        self.assertFalse(mutex.acquired)
        self.assertIsNone(mutex.handle)
        k32.CloseHandle.assert_called_once_with(1002)

    def test_acquire_abandoned(self):
        k32 = MagicMock()
        k32.CreateMutexW.return_value = 1003
        k32.WaitForSingleObject.return_value = ld.WAIT_ABANDONED

        mutex = ld.WindowsGpuMutex(name="TestMutex", kernel32=k32)
        acquired = mutex.acquire(timeout_ms=0)

        self.assertTrue(acquired)
        self.assertTrue(mutex.acquired)
        self.assertEqual(mutex.handle, 1003)

    def test_release(self):
        k32 = MagicMock()
        k32.CreateMutexW.return_value = 1004
        k32.WaitForSingleObject.return_value = ld.WAIT_OBJECT_0

        mutex = ld.WindowsGpuMutex(name="TestMutex", kernel32=k32)
        mutex.acquire(timeout_ms=0)
        mutex.release()

        self.assertFalse(mutex.acquired)
        self.assertIsNone(mutex.handle)
        k32.ReleaseMutex.assert_called_once_with(1004)
        k32.CloseHandle.assert_called_once_with(1004)


class TestGpuSamplingAndThresholds(unittest.TestCase):
    def test_query_gpu_sample_success(self):
        mock_cmd = MagicMock(return_value="35, 6200\n")
        util, free_mb = ld.query_gpu_sample(run_cmd=mock_cmd)
        self.assertEqual(util, 35)
        self.assertEqual(free_mb, 6200)

    def test_query_gpu_sample_invalid_format(self):
        mock_cmd = MagicMock(return_value="invalid")
        with self.assertRaises(ValueError):
            ld.query_gpu_sample(run_cmd=mock_cmd)

    def test_sample_gpu_load_takes_3_samples(self):
        samples_in = [(10, 5000), (12, 4900), (15, 4800)]
        idx = [0]
        def query_fn():
            s = samples_in[idx[0]]
            idx[0] += 1
            return s
        sleep_calls = []
        samples_out = ld.sample_gpu_load(query_fn=query_fn, sleep_fn=lambda s: sleep_calls.append(s))
        self.assertEqual(samples_out, samples_in)
        self.assertEqual(len(sleep_calls), 2)

    def test_high_utilization_falls_back_to_cpu(self):
        # 2 of 3 >= 70%
        samples = [(72, 8000), (70, 8000), (10, 8000)]
        self.assertIsNone(ld.evaluate_gpu_compute_type(samples))

        # 3 of 3 >= 70%
        samples = [(80, 8000), (85, 8000), (75, 8000)]
        self.assertIsNone(ld.evaluate_gpu_compute_type(samples))

        # Only 1 of 3 >= 70% -> allowed to use GPU if memory suffices
        samples = [(75, 5000), (40, 5000), (30, 5000)]
        self.assertEqual(ld.evaluate_gpu_compute_type(samples), "float16")

    def test_memory_thresholds(self):
        # >= 4500 -> float16
        self.assertEqual(ld.evaluate_gpu_compute_type([(10, 5000), (10, 4600), (10, 4500)]), "float16")

        # >= 2500, < 4500 -> int8_float16
        self.assertEqual(ld.evaluate_gpu_compute_type([(10, 5000), (10, 3000), (10, 2500)]), "int8_float16")

        # < 2500 -> None (fallback to CPU)
        self.assertIsNone(ld.evaluate_gpu_compute_type([(10, 5000), (10, 3000), (10, 2499)]))

    def test_gpu_compute_type_query_failure_returns_none(self):
        def failing_query():
            raise RuntimeError("nvidia-smi error")
        self.assertIsNone(ld.gpu_compute_type(query_fn=failing_query, sleep_fn=lambda _: None))


class TestModelLoadFallback(unittest.TestCase):
    def test_load_model_device_kwargs(self):
        # Mock faster_whisper WhisperModel to verify kwargs without loading real model
        with patch.dict("sys.modules", {"faster_whisper": MagicMock()}):
            import faster_whisper
            mock_cls = faster_whisper.WhisperModel

            # CPU
            ld.load_model("cpu", "int8")
            mock_cls.assert_called_with(
                ld.MODEL,
                device="cpu",
                compute_type="int8",
                local_files_only=True,
                cpu_threads=8
            )

            # CUDA
            ld.load_model("cuda", "float16")
            mock_cls.assert_called_with(
                ld.MODEL,
                device="cuda",
                compute_type="float16",
                local_files_only=True
            )


@unittest.skipUnless(os.environ.get("K_TEST_SCRATCH"), "run through test/local-dictation.test.mjs for a scratch folder")
class TestSharedVocabulary(unittest.TestCase):
    def setUp(self):
        self.root = os.path.join(os.environ["K_TEST_SCRATCH"], "dictation-vocabulary")
        os.makedirs(os.path.join(self.root, "config"), exist_ok=True)

    def write(self, name, payload):
        with open(os.path.join(self.root, "config", name), "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)

    def test_only_k_names_are_hotwords_and_clinic_scoped_replacements_are_skipped(self):
        self.write("clinical_terms.json", {"terms": [{"canonical": "肱骨", "asr_hotword": True}]})
        self.write("asr_replacements.json", {"replacements": [
            {"from": "公骨", "to": "肱骨"},
            {"from": "病例", "to": "病歷", "scope": "clinic"},
        ]})
        hotwords, replacements = ld.load_vocabulary(self.root)
        self.assertEqual(hotwords, " ".join(ld.GENERAL_HOTWORDS))
        self.assertEqual(replacements, [*ld.GENERAL_REPLACEMENTS, ("公骨", "肱骨")])

    def test_missing_shared_files_leave_only_k_words(self):
        hotwords, replacements = ld.load_vocabulary(os.path.join(self.root, "absent"))
        self.assertEqual(hotwords, " ".join(ld.GENERAL_HOTWORDS))
        self.assertEqual(replacements, list(ld.GENERAL_REPLACEMENTS))

    def test_transcribe_passes_hotwords_and_applies_replacements(self):
        model = MagicMock()
        model.transcribe.return_value = ([MagicMock(text="病例裡寫公骨")], SPEECH)
        text = ld.transcribe(model, "audio", ("Opus 肱骨", [("公骨", "肱骨")]))
        self.assertEqual(text, "病例裡寫肱骨")
        self.assertEqual(model.transcribe.call_args.kwargs["hotwords"], "Opus 肱骨")
        self.assertEqual(model.transcribe.call_args.kwargs["initial_prompt"], ld.PROMPT)

    def test_long_dictation_does_not_accumulate_history_beside_hotwords(self):
        # Model a lazy multi-window decode: the failure occurs while consuming segments,
        # not when transcribe returns its iterator. A separate archived probe exercised
        # the real installed library/decoder; that probe is not part of npm test.
        class MultiWindowModel:
            def transcribe(self, audio, *, condition_on_previous_text=True, **kwargs):
                def segments():
                    yield MagicMock(text="第一段公骨。")
                    if condition_on_previous_text:
                        raise ValueError("The maximum decoding length must be > 0")
                    yield MagicMock(text="第二段辨識完成。")
                return segments(), SPEECH

        text = ld.transcribe(MultiWindowModel(), "audio", ("肱骨 " * 300, [("公骨", "肱骨")]))
        self.assertEqual(text, "第一段肱骨。第二段辨識完成。")


class TestHallucinationGuard(unittest.TestCase):
    def run_transcribe(self, texts, on_gpu=True):
        model = MagicMock()
        model.transcribe.return_value = ([MagicMock(text=t) for t in texts], SPEECH)
        return ld.transcribe(model, "audio", ("", []), on_gpu), model.transcribe.call_args.kwargs

    def test_whole_caption_line_is_dropped_in_simplified_or_traditional(self):
        for line in ("请不吝点赞 订阅 转发 打赏支持明镜与点点栏目", "中文字幕由 Amara.org 社群提供", "謝謝觀看。"):
            self.assertEqual(self.run_transcribe([line])[0], "", line)

    def test_caption_inside_real_speech_removes_only_that_span(self):
        cases = {
            "我們先看這個，歡迎訂閱我的頻道，然後再說。": "我們先看這個，然後再說。",
            "我們先看這個歡迎訂閱我的頻道然後再說": "我們先看這個然後再說",
            "前面是真的，中文字幕由Amara.org社區提供，後面也是真的。": "前面是真的，後面也是真的。",
            "優優獨播劇場，然後是治療紀錄。": "然後是治療紀錄。",
            "好，就這樣。謝謝觀看。": "好，就這樣。",
            "真的嗎？！\n謝謝觀看。\n下一段": "真的嗎？！\n下一段",
            "Claude 謝謝觀看 Opus": "Claude Opus",
            "前面「引用」，謝謝觀看。": "前面「引用」。",
        }
        for spoken, expected in cases.items():
            self.assertEqual(self.run_transcribe([spoken])[0], expected, spoken)

    def test_real_talk_about_social_posts_and_captions_stays(self):
        for spoken in (
            "這篇貼文按讚分享數很低",
            "這篇按讚、分享、訂閱數都很低。",
            "請不吝指教，我們下週再討論網站欄目。",
            "我們的字幕由工作室製作，社群提供的照片另外處理。",
            "記得訂閱我們的頻道",
            "字幕翻譯：改成繁體中文",
            "這次字幕校對：小王，配圖交給小李。",
            "請把影片結尾改成「謝謝觀看」。",
            "這句「歡迎訂閱我的頻道」要放在貼文最後。",
            "片尾改成「我們下期再見。」",
            "字幕寫「中文字幕由 Amara.org 社群提供。」",
            "結尾用「歡迎訂閱我的頻道，謝謝觀看。」",
            "請把影片結尾改成「謝謝觀看",
            "請把影片結尾改成『謝謝觀看",
            "請把影片結尾改成“謝謝觀看",
            "請把影片結尾改成\"謝謝觀看",
            "真的嗎？！好啊。\n下一段",
        ):
            self.assertEqual(self.run_transcribe([spoken])[0], spoken, spoken)

    def test_only_simplified_clauses_convert(self):
        self.assertEqual(self.run_transcribe(["这个软件后面再说，干擾後續的皇后"])[0], "這個軟件後面再說，干擾後續的皇后")
        self.assertEqual(self.run_transcribe(["這裡沒有干擾，软體設定等等再看。"])[0], "這裡沒有干擾，軟體設定等等再看。")
        self.assertEqual(self.run_transcribe(["這裡沒有干擾.软體設定"])[0], "這裡沒有干擾.軟體設定")

    def test_pause_check_runs_on_gpu_only(self):
        _, kwargs = self.run_transcribe(["好"])
        self.assertEqual(kwargs["hallucination_silence_threshold"], 2.0)
        self.assertTrue(kwargs["word_timestamps"])
        _, kwargs = self.run_transcribe(["好"], on_gpu=False)
        self.assertNotIn("hallucination_silence_threshold", kwargs)
        self.assertNotIn("word_timestamps", kwargs)

if __name__ == "__main__":
    unittest.main()
