#!/usr/bin/env python3
"""Send one email through the Atlas mailbox (standard library only).

Reads one JSON object on stdin: {"to": ["a@x", ...], "subject": "...", "body": "..."}.
The mailbox settings come from Hermes' env file (EMAIL_ADDRESS, EMAIL_PASSWORD, EMAIL_SMTP_HOST, EMAIL_SMTP_PORT), read here and never
passed on a command line or printed. Writes one JSON line: {"ok": true} or {"ok": false, "error": "..."}; the exit code is 0 only on success.
"""
import html, json, os, re, smtplib, ssl, sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from urllib.parse import urlsplit

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


def _inline(text):
    links = []
    def link(match):
        label, url = match.group(1), match.group(2)
        try:
            scheme = urlsplit(url).scheme.lower()
        except ValueError:
            scheme = ""
        if scheme not in ("http", "https"):
            return match.group(0)
        token = f"\x00LINK{len(links)}\x00"
        links.append(f'<a href="{html.escape(url, quote=True)}" style="color:#2457a7;text-decoration:underline">{html.escape(label)}</a>')
        return token
    text = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, text)
    escaped = html.escape(text, quote=False)
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    for i, rendered in enumerate(links):
        escaped = escaped.replace(f"\x00LINK{i}\x00", rendered)
    return escaped


def _heading(line):
    m = re.match(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$", line)
    if m:
        return m.group(2)
    m = re.match(r"^\s*\*\*(.+)\*\*\s*$", line)
    if m:
        return m.group(1)
    m = re.match(r"^\s*(DECIDE|DO|CONSIDER|FYI)(?:\s*(?:[-–—:]\s*.*)?)\s*$", line, re.I)
    if m:
        return line.strip()
    return None


def _list_item(line):
    m = re.match(r"^\s*[-+*•]\s+(.+)$", line)
    if m:
        return "ul", m.group(1), None
    m = re.match(r"^\s*(\d+)[.)]\s+(.+)$", line)
    return ("ol", m.group(2), m.group(1)) if m else None


def _html_body(body):
    out, paragraph, list_kind = [], [], None
    def flush_paragraph():
        if paragraph:
            out.append('<p style="margin:0 0 16px 0;line-height:1.5">' + _inline(" ".join(paragraph)) + "</p>")
            paragraph.clear()
    def close_list():
        nonlocal list_kind
        if list_kind:
            out.append(f"</{list_kind}>")
            list_kind = None
    for line in body.splitlines():
        if not line.strip():
            flush_paragraph(); close_list(); continue
        heading = _heading(line)
        if heading is not None:
            flush_paragraph(); close_list()
            out.append('<h2 style="font-size:20px;line-height:1.3;margin:22px 0 12px 0;font-weight:700">' + _inline(heading) + "</h2>")
            continue
        item = _list_item(line)
        if item:
            flush_paragraph()
            kind, value, number = item
            if list_kind != kind:
                close_list()
                list_kind = kind
                out.append(f'<{kind} style="padding-left:24px;margin:0 0 16px 0">')
            number_attr = f' value="{number}"' if number is not None else ""
            out.append('<li' + number_attr + ' style="margin:0 0 14px 0;line-height:1.5">' + _inline(value) + "</li>")
            continue
        close_list()
        paragraph.append(line.strip())
    flush_paragraph(); close_list()
    return '<html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#202124">' + "\n".join(out) + "</body></html>"


def _plain_body(body):
    lines = body.splitlines()
    out = []
    previous_item = False
    for line in lines:
        is_item = _list_item(line) is not None
        if is_item and previous_item:
            out.append("")
        out.append(line)
        previous_item = is_item
    return "\n".join(out)


def build_message(req, to, addr):
    m = EmailMessage()
    m["From"] = f"Atlas <{addr}>"
    m["To"] = ", ".join(to)
    m["Subject"] = re.sub(r"[\r\n]+", " ", str(req.get("subject", "")))[:200]
    m["Date"] = formatdate(localtime=True)
    m["Message-ID"] = make_msgid(domain=addr.split("@", 1)[1])
    m["Auto-Submitted"] = "auto-generated"          # a machine-made copy: auto-responders must not answer it
    body = str(req.get("body", ""))[:200_000]
    if req.get("format") == "ai-os":
        m.set_content(_plain_body(body))
        m.add_alternative(_html_body(body), subtype="html")
    else:
        m.set_content(body)
    return m


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
    m = build_message(req, to, addr)
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
