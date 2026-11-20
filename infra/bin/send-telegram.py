#!/usr/bin/env python3
"""Send one Telegram message through Atlas's bot (standard library only).

Reads one JSON object on stdin: {"chat": "<chat id>", "text": "..."}. The bot token comes from Hermes' env file (TELEGRAM_BOT_TOKEN), read here
and never passed on a command line or printed. Writes one JSON line: {"ok": true} or {"ok": false, "error": "..."}; exit code 0 only on success.
"""
import json, os, re, sys, urllib.parse, urllib.request

ENV = os.environ.get("HERMES_ENV") or os.path.join(os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes"), ".env")


def token():
    try:
        for line in open(ENV, encoding="utf-8"):
            m = re.match(r"^\s*TELEGRAM_BOT_TOKEN=(.*)$", line.rstrip("\n"))
            if m:
                return m.group(1).strip().strip("\"'")
    except OSError as e:
        raise SystemExit(json.dumps({"ok": False, "error": f"cannot read {os.path.basename(ENV)}: {e.strerror}"}))
    return None


def main():
    req = json.load(sys.stdin)
    chat, text = str(req.get("chat", "")), str(req.get("text", ""))
    if not re.fullmatch(r"-?\d{4,20}", chat) or not text.strip():
        print(json.dumps({"ok": False, "error": "a chat id and a text are required"})); return 1
    tok = token()
    if not tok:
        print(json.dumps({"ok": False, "error": "TELEGRAM_BOT_TOKEN is not set"})); return 1
    if len(text) > 4000:
        text = text[:3990] + "\n…"
    data = urllib.parse.urlencode({"chat_id": chat, "text": text, "disable_web_page_preview": "true"}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage", data=data), timeout=25) as r:
            body = json.loads(r.read().decode() or "{}")
    except Exception as e:                                # never include the token
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {str(e).replace(tok, '***')[:160]}"})); return 1
    if not body.get("ok"):
        print(json.dumps({"ok": False, "error": str(body.get("description", "Telegram refused it"))[:160]})); return 1
    print(json.dumps({"ok": True})); return 0


if __name__ == "__main__":
    sys.exit(main())
