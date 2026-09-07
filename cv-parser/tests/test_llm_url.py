import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_url import chat_endpoint


class ChatURLTests(unittest.TestCase):
    def test_remote_url_forms(self):
        for base in ("http://model:8088", "http://model:8088/", "http://model:8088/v1",
                     "http://model:8088/v1/chat/completions/"):
            with self.subTest(base=base):
                self.assertEqual(chat_endpoint(base), "http://model:8088/v1/chat/completions")
        self.assertEqual(chat_endpoint("https://api/v1/agents/extractor"),
                         "https://api/v1/agents/extractor/chat/completions")

    def test_rejects_credentials_and_non_http(self):
        for base in ("", "ftp://model", "http://user:secret@model", "http://model?api_key=secret"):
            with self.subTest(base=base), self.assertRaises(ValueError):
                chat_endpoint(base)
