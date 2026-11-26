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


def seg(text, seek=0, avg_logprob=-0.2, compression_ratio=1.0):
    """A decoded segment that passes Whisper's temperature-0 quality checks unless told otherwise."""
    return SimpleNamespace(text=text, seek=seek, avg_logprob=avg_logprob, compression_ratio=compression_ratio)


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
        model.transcribe.return_value = ([seg("病例裡寫公骨")], SPEECH)
        with patch.object(ld, "dictation_chunks", return_value=["audio"]):
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
                    yield seg("第一段公骨。")
                    if condition_on_previous_text:
                        raise ValueError("The maximum decoding length must be > 0")
                    yield seg("第二段辨識完成。")
                return segments(), SPEECH

        with patch.object(ld, "dictation_chunks", return_value=["audio"]):
            text = ld.transcribe(MultiWindowModel(), "audio", ("肱骨 " * 300, [("公骨", "肱骨")]))
        self.assertEqual(text, "第一段肱骨。第二段辨識完成。")


@unittest.skipUnless(importlib.util.find_spec("faster_whisper"), "requires the offline dictation environment")
class TestDictationChunks(unittest.TestCase):
    def chunks(self, probabilities, samples=None):
        import numpy as np
        audio = np.arange(samples if samples is not None else len(probabilities) * 512, dtype=np.float32)

        def frame_scores(padded_audio):
            np.testing.assert_array_equal(padded_audio[:audio.size], audio)
            self.assertFalse(padded_audio[audio.size:].any())
            return probabilities + [0] * (padded_audio.size // 512 - len(probabilities))

        with patch("faster_whisper.vad.get_vad_model", return_value=frame_scores):
            return audio, ld.dictation_chunks(audio)

    def test_pause_and_soft_ending_keep_the_original_samples(self):
        import numpy as np
        for pause in (16, 32, 47):  # 0.512, 1.024 and 1.504 seconds
            with self.subTest(pause=pause):
                probabilities = [1] * 32 + [0] * pause + [1] * 8
                audio, chunks = self.chunks(probabilities + [0] * 47)
                end = len(probabilities) * 512 + 6400  # includes the 400 ms release margin
                expected = audio[:end] if pause == 16 else np.concatenate((
                    audio[:32 * 512 + 6400], audio[(32 + pause) * 512 - 6400:end],
                ))
                self.assertEqual(len(chunks), 1)
                np.testing.assert_array_equal(chunks[0], expected)

    def test_short_transient_near_stop_is_removed(self):
        import numpy as np
        before_click = [1] * 80 + [0] * 40
        for frames in (1, 2, 3):
            for tail_ms in (700, 200):
                with self.subTest(frames=frames, tail_ms=tail_ms):
                    scores = before_click + [1] * frames
                    samples = len(scores) * 512 + tail_ms * 16
                    audio, chunks = self.chunks(scores + [0] * ((tail_ms * 16 + 511) // 512), samples)
                    self.assertEqual(len(chunks), 1)
                    np.testing.assert_array_equal(chunks[0], audio[:80 * 512 + 6400])

    def test_single_syllable_and_quiet_release_at_eof_keep_every_sample(self):
        import numpy as np
        for scores in ([1] * 12, [1] * 8 + [0.4] * 3 + [0.2] * 4):
            with self.subTest(scores=scores):
                audio, chunks = self.chunks(scores, len(scores) * 512 - 73)
                self.assertEqual(len(chunks), 1)
                np.testing.assert_array_equal(chunks[0], audio)

    def test_long_dictation_splits_at_a_speech_break(self):
        import numpy as np
        audio, chunks = self.chunks([1] * 820 + [0] * 40 + [1] * 100)
        self.assertEqual(len(chunks), 2)
        np.testing.assert_array_equal(chunks[0], audio[:820 * 512 + 6400])
        np.testing.assert_array_equal(chunks[1], audio[860 * 512 - 6400:])

    def test_long_dictation_uses_last_short_pause_without_losing_or_repeating_samples(self):
        import numpy as np
        scores = [1] * 450 + [0] * 6 + [1] * 348 + [0] * 9 + [1] * 150
        audio, chunks = self.chunks(scores)
        split = (450 + 6 + 348) * 512 + 9 * 512 // 2
        self.assertEqual(len(chunks), 2)
        np.testing.assert_array_equal(chunks[0], audio[:split])
        np.testing.assert_array_equal(chunks[1], audio[split:])

    def test_uninterrupted_long_speech_stays_within_window_and_preserves_samples(self):
        import numpy as np
        audio, chunks = self.chunks([1] * 960)
        self.assertEqual(len(chunks), 2)
        self.assertTrue(all(chunk.size <= 29 * ld.SAMPLE_RATE for chunk in chunks))
        np.testing.assert_array_equal(np.concatenate(chunks), audio)

    def test_28_5_seconds_with_short_pause_fit_in_one_decode(self):
        import numpy as np
        audio, chunks = self.chunks([1] * 800 + [0] * 9 + [1] * 82, round(28.5 * ld.SAMPLE_RATE))
        self.assertEqual(len(chunks), 1)
        np.testing.assert_array_equal(chunks[0], audio)

    def test_under_29_seconds_of_kept_audio_uses_one_decode(self):
        _, chunks = self.chunks([1] * 620 + [0] * 40 + [1] * 252)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].size, (620 + 252) * 512 + 2 * 6400)

    def test_unvoiced_audio_has_no_decode_chunk(self):
        _, chunks = self.chunks([0] * 64)
        self.assertEqual(chunks, [])


class TestHallucinationGuard(unittest.TestCase):
    def setUp(self):
        chunks = patch.object(ld, "dictation_chunks", return_value=["audio"])
        chunks.start()
        self.addCleanup(chunks.stop)

    def run_transcribe(self, texts, on_gpu=True):
        model = MagicMock()
        model.transcribe.return_value = ([seg(t) for t in texts], SPEECH)
        return ld.transcribe(model, "audio", ("", []), on_gpu), model.transcribe.call_args.kwargs

    def test_separate_decodes_keep_quoted_and_spoken_copy(self):
        outro = "點擊小鈴鐺，並且記得訂閱我們的頻道，才能收到最新消息。"
        for on_gpu in (False, True):
            model = MagicMock()
            model.transcribe.side_effect = [
                ([seg("請把片尾改成「")], SPEECH),
                ([seg("謝謝觀看」。" + outro)], SPEECH),
            ]
            with patch.object(ld, "dictation_chunks", return_value=["first", "last"]):
                text = ld.transcribe(model, "audio", ("", []), on_gpu)
            self.assertEqual(text, "請把片尾改成「謝謝觀看」。" + outro)
            self.assertEqual([c.args for c in model.transcribe.call_args_list], [("first",), ("last",)])
            self.assertTrue(all(not c.kwargs.get("vad_filter") for c in model.transcribe.call_args_list))

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


class TestWeakWindowRedecode(unittest.TestCase):
    """Synthetic weak-speech and prompt-bias regression fixtures."""

    def decode(self, *results, on_gpu=True):
        import numpy as np
        model = MagicMock()
        model.transcribe.side_effect = [(list(r), SPEECH) for r in results]
        audio = np.arange(3 * ld.SAMPLE_RATE, dtype=np.float32)
        with patch.object(ld, "dictation_chunks", return_value=[audio]):
            text = ld.transcribe(model, audio, ("Gemma ProjectAgent 示範專案", []), on_gpu)
        return text, model.transcribe.call_args_list, audio

    def test_clear_speech_is_decoded_once_at_temperature_zero_with_hotwords(self):
        text, calls, _ = self.decode([seg("請交給 Gemma，再用 ProjectAgent 整理示範專案的資料。")])
        self.assertEqual(text, "請交給 Gemma，再用 ProjectAgent 整理示範專案的資料。")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].kwargs["temperature"], 0.0)
        self.assertEqual(calls[0].kwargs["hotwords"], "Gemma ProjectAgent 示範專案")
        self.assertEqual(calls[0].kwargs["initial_prompt"], ld.PROMPT)

    def test_weak_window_is_heard_again_without_hotwords_or_prompt(self):
        import numpy as np
        for on_gpu in (True, False):
            with self.subTest(on_gpu=on_gpu):
                text, calls, audio = self.decode(
                    [seg("先整理今天的範例文件"), seg("點擊小鈴鐺 訂閱小鈴鐺 按讚小鈴鐺", seek=150, avg_logprob=-1.2),
                     seg("Gemma ProjectAgent 示範專案", seek=210, avg_logprob=-0.4)],
                    [seg("那個", avg_logprob=-0.6), seg("Gemma ProjectAgent 示範專案", seek=60, avg_logprob=-1.3)],
                    on_gpu=on_gpu,
                )
                # The unbiased listen hears 那個, which the first listen never wrote, so the tail is empty.
                self.assertEqual(text, "先整理今天的範例文件")
                self.assertEqual(len(calls), 2)
                np.testing.assert_array_equal(calls[1].args[0], audio[150 * 160:])
                self.assertEqual(calls[1].kwargs["temperature"], 0.0)
                self.assertIsNone(calls[1].kwargs.get("hotwords"))
                self.assertIsNone(calls[1].kwargs.get("initial_prompt"))
                self.assertEqual(calls[1].kwargs.get("word_timestamps", False), on_gpu)

    def test_weak_single_word_stays_when_the_unbiased_decode_hears_it(self):
        text, _, _ = self.decode([seg("示範專案 好，我們繼續。", avg_logprob=-1.14)], [seg("好", avg_logprob=-0.97)])
        self.assertEqual(text, "好")

    def test_words_both_listens_heard_stay_even_when_they_are_hotwords(self):
        text, _, _ = self.decode(
            [seg("交給 Gemma 再用 ProjectAgent 整理示範專案的資料", avg_logprob=-1.05)],
            [seg("交給Gemma再用Project Agent整理示範文件", avg_logprob=-0.45)],
        )
        self.assertEqual(text, "交給Gemma再用Project Agent整理示範文件")  # no replacements in this test

    def test_weak_window_with_no_unbiased_speech_is_empty(self):
        text, _, _ = self.decode([seg("請訂閱、按讚、分享及分享。", avg_logprob=-1.21)], [])
        self.assertEqual(text, "")

    def test_unbiased_text_unrelated_to_the_first_listen_is_dropped(self):
        for first, again in (("河沙", "谢谢大家"), ("採訪", "中文字幕 李宗盛"), ("MING PAO CANADA MANGA", "中文字幕 李宗盛")):
            with self.subTest(first=first):
                text, _, _ = self.decode(
                    [seg("放在桌面上。"), seg(first, seek=2860, avg_logprob=-1.05)], [seg(again, avg_logprob=-0.4)],
                )
                self.assertEqual(text, "放在桌面上。")

    def test_shared_latin_word_counts_and_simplified_matches_traditional(self):
        text, _, _ = self.decode([seg("請交給 gemma 整理", avg_logprob=-1.1)], [seg("交給 Gemma", avg_logprob=-0.5)])
        self.assertEqual(text, "交給 Gemma")
        text, _, _ = self.decode([seg("這週記錄", avg_logprob=-1.1)], [seg("记录", avg_logprob=-0.5)])
        self.assertEqual(text, "記錄")

    def test_confident_repetition_keeps_the_usual_temperature_fallback(self):
        line = "我們明天先確認一下這週的貼文排程，然後把草稿整理好再看。"
        text, calls, _ = self.decode([seg(line * 4, avg_logprob=-0.08, compression_ratio=3.3)], [seg(line * 4)])
        self.assertEqual(text, line * 4)
        self.assertEqual(len(calls), 2)
        self.assertNotIn("temperature", calls[1].kwargs)
        self.assertEqual(calls[1].kwargs["hotwords"], "Gemma ProjectAgent 示範專案")
        self.assertEqual(calls[1].kwargs["initial_prompt"], ld.PROMPT)

if __name__ == "__main__":
    unittest.main()
