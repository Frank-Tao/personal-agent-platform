"""Synthetic tests for send-mail.py; never opens a network connection."""
import contextlib
import importlib.util
import io
import json
import os
import unittest
from unittest.mock import patch

SCRIPT = os.path.join(os.path.dirname(__file__), "send-mail.py")
spec = importlib.util.spec_from_file_location("send_mail", SCRIPT)
send_mail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(send_mail)


class FakeSMTP:
    message = None

    def __init__(self, *args, **kwargs):
        pass

    def starttls(self, **kwargs):
        pass

    def login(self, *args):
        pass

    def send_message(self, message):
        FakeSMTP.message = message
        return {}

    def quit(self):
        pass


class SendMailTests(unittest.TestCase):
    def test_ai_os_creates_safe_alternative_payloads(self):
        req = {"to": ["a@example.com"], "subject": "Update", "format": "ai-os", "body": (
            "# Weekly plan\n\n**DECIDE: Approve rollout**\n\n"
            "Use **bold** and [docs](https://example.com/a?b=1&c=2).\n"
            "<script>alert('x')</script> [bad](javascript:alert(1))\n\n"
            "- First item\n- Second item\n3. Third item\n\n7. Seventh item\n\nFYI — Details\n\n"
            "• A unicode bullet\n• Another unicode bullet\n\n"
            "Footer identifier ID-42 https://plain.example/path\n")}
        msg = send_mail.build_message(req, req["to"], "bot@example.com")
        self.assertEqual(msg.get_content_type(), "multipart/alternative")
        parts = {part.get_content_type(): part.get_content() for part in msg.walk() if part.get_content_maintype() == "text"}
        plain, html = parts["text/plain"], parts["text/html"]
        self.assertIn("# Weekly plan", plain)
        self.assertIn("- First item\n\n- Second item", plain)
        self.assertIn("&lt;script&gt;", html)
        self.assertIn("<h2", html)
        self.assertRegex(html, r"<h2[^>]*font-weight:700[^>]*>DECIDE: Approve rollout</h2>")
        self.assertIn("<strong>bold</strong>", html)
        self.assertIn('href="https://example.com/a?b=1&amp;c=2"', html)
        self.assertNotIn('href="javascript:', html)
        self.assertIn("javascript:alert(1)", html)
        self.assertRegex(html, r"margin:0 0 14px 0")
        self.assertRegex(html, r'<li value="3"[^>]*>Third item</li>')
        self.assertRegex(html, r'<li value="7"[^>]*>Seventh item</li>')
        self.assertRegex(html, r'<h2[^>]*>FYI — Details</h2>')
        self.assertIn("• A unicode bullet\n\n• Another unicode bullet", plain)
        for preserved in ("First item", "Second item", "Third item", "ID-42", "https://plain.example/path", "Footer"):
            self.assertIn(preserved, plain)
            self.assertIn(preserved, html)

    def test_transport_error_masks_password_without_network(self):
        class FailingSMTP(FakeSMTP):
            def login(self, *args):
                raise RuntimeError("test transport error Sup3rSecretPassw0rd")
        req = {"to": ["a@example.com"], "subject": "s", "body": "- First\n- Second", "format": "ai-os"}
        with patch.object(send_mail, "load_env", return_value={"EMAIL_ADDRESS": "bot@example.com", "EMAIL_PASSWORD": "Sup3rSecretPassw0rd", "EMAIL_SMTP_HOST": "mail.invalid"}), \
             patch.object(send_mail.smtplib, "SMTP", FailingSMTP), \
             patch.object(send_mail.sys, "stdin", io.StringIO(json.dumps(req))), \
             patch.object(send_mail.sys, "stdout", io.StringIO()) as out:
            result = send_mail.main()
        self.assertEqual(result, 1)
        response = json.loads(out.getvalue())
        self.assertFalse(response["ok"])
        self.assertNotIn("Sup3rSecretPassw0rd", out.getvalue())
        self.assertIn("***", response["error"])

    def test_plain_and_ai_os_formatting_is_forwarded_through_fake_smtp(self):
        def run(req):
            FakeSMTP.message = None
            with patch.object(send_mail, "load_env", return_value={"EMAIL_ADDRESS": "bot@example.com", "EMAIL_PASSWORD": "fake", "EMAIL_SMTP_HOST": "mail.invalid"}), \
                 patch.object(send_mail.smtplib, "SMTP", FakeSMTP), \
                 patch.object(send_mail.sys, "stdin", io.StringIO(json.dumps(req))), \
                 patch.object(send_mail.sys, "stdout", io.StringIO()) as out:
                result = send_mail.main()
                return result, json.loads(out.getvalue()), FakeSMTP.message
        plain_result, plain_out, plain_msg = run({"to": ["a@example.com"], "subject": "s", "body": "<b>raw</b>"})
        self.assertEqual((plain_result, plain_out["ok"], plain_msg.get_content_type()), (0, True, "text/plain"))
        self.assertEqual(plain_msg.get_content(), "<b>raw</b>\n")
        html_result, html_out, html_msg = run({"to": ["a@example.com"], "subject": "s", "body": "# Heading", "format": "ai-os"})
        self.assertEqual((html_result, html_out["ok"], html_msg.get_content_type()), (0, True, "multipart/alternative"))


if __name__ == "__main__":
    unittest.main()
