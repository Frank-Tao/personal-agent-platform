#!/usr/bin/env python3
"""Send one email through the Atlas mailbox (standard library only).

Reads one JSON object on stdin: {"to": ["a@x", ...], "subject": "...", "body": "..."}.
The mailbox settings come from Hermes' env file (EMAIL_ADDRESS, EMAIL_PASSWORD, EMAIL_SMTP_HOST, EMAIL_SMTP_PORT), read here and never
passed on a command line or printed. Writes one JSON line: {"ok": true} or {"ok": false, "error": "..."}; the exit code is 0 only on success.
"""
import json, os, re, smtplib, ssl, sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

ENV = os.environ.get("HERMES_ENV") or os.path.join(os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes"), ".env")


def load_env(path):
    out = {}
    try:
        for line in open(path, encoding="utf-8"):
            m = re.match(r"^\s*(EMAIL_[A-Z_]+)=(.*)$", line.rstrip("\n"))
            if m:
                out[m.group(1)] = m.group(2).strip().strip("\"'")
    except OSError as e:
        raise SystemExit(json.dumps({"ok": False, "error": f"cannot read {os.path.basename(path)}: {e.strerror}"}))
    return out


def main():
    req = json.load(sys.stdin)
    to = [a for a in req.get("to", []) if isinstance(a, str) and re.fullmatch(r"[^@\s,;<>]+@[^@\s,;<>]+\.[A-Za-z]{2,}", a)]
    if not to:
        print(json.dumps({"ok": False, "error": "no valid recipient"})); return 1
    env = load_env(ENV)
    addr, pw, host = env.get("EMAIL_ADDRESS"), env.get("EMAIL_PASSWORD"), env.get("EMAIL_SMTP_HOST")
    if not (addr and pw and host):
        print(json.dumps({"ok": False, "error": "mailbox settings are incomplete (address, password and SMTP host)"})); return 1
    port = int(env.get("EMAIL_SMTP_PORT") or 587)
    m = EmailMessage()
    m["From"] = f"Atlas <{addr}>"
    m["To"] = ", ".join(to)
    m["Subject"] = re.sub(r"[\r\n]+", " ", str(req.get("subject", "")))[:200]
    m["Date"] = formatdate(localtime=True)
    m["Message-ID"] = make_msgid(domain=addr.split("@", 1)[1])
    m["Auto-Submitted"] = "auto-generated"          # a machine-made copy: auto-responders must not answer it
    m.set_content(str(req.get("body", ""))[:200_000])
    try:
        ctx = ssl.create_default_context()
        if port == 465:
            s = smtplib.SMTP_SSL(host, port, timeout=25, context=ctx)
        else:
            s = smtplib.SMTP(host, port, timeout=25); s.starttls(context=ctx)
        s.login(addr, pw)
        refused = s.send_message(m)
        s.quit()
    except Exception as e:                              # never include the password: only the error type and a short message
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {str(e).replace(pw, '***')[:160]}"})); return 1
    if refused:
        print(json.dumps({"ok": False, "error": f"refused: {', '.join(refused)}"})); return 1
    print(json.dumps({"ok": True})); return 0


if __name__ == "__main__":
    sys.exit(main())
