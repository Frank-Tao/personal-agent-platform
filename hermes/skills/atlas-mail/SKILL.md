---
name: atlas-mail
description: Use when you need to send an email: a report, packet, summary or answer that someone should get by email (in addition to, or instead of, Telegram). Sends from the Atlas mailbox through one command; allowed people get it at once, anything else waits for Frank's release. Never send email any other way.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [email, outbound, communication]
    related_skills: [cockpit, privacy-handoff]
---

# Sending email (Atlas mailbox)

There is one way to send email: this command, run from `~/services/personal-agent-platform`. Do not use SMTP, `mail`, Python, curl or any other tool, and never read or print the mailbox settings in `~/.hermes/.env`.

```bash
cd ~/services/personal-agent-platform
# write the body to a file first (plain text, short bullets), then:
npm run -s work -- mail send --to diane.zhang@outlook.com,diane.zhang@aithrival.com \
  --subject "AI-OS · Wednesday decision packet" --body-file /tmp/packet.txt \
  --by <your roster id> [--project <project id>] --apply
npm run -s work -- mail policy      # who you may write to without approval
```

What happens:
- **Sent now** when every recipient is on the allow-list (Frank, Diane, anyone @aithrival.com, the people Atlas takes mail from), the text does not look private, and fewer than 20 went out in the last hour.
- **Held** otherwise. It shows in Cockpit (Needs you) and goes out only if Frank presses Send. Do not try another way, do not split it to get around the rule, and do not release it yourself (`mail release` is refused from an agent). Say in your reply or hand-off: "email to X is waiting for release (id m-…)".

Rules:
- Telegram stays the main channel. Every Telegram message a scheduled job sends is already copied to the person's email automatically (`work mailcopy`), so **do not email the same text again**. Use this command for things that are not a Telegram message: a longer packet, a document, a note for someone who is not on Telegram.
- Nothing private by email (bank, tax, payslips, health, identity numbers, family legal matters): email leaves this Mac. Private matters go through the privacy-handoff skill.
- Plain text, short, with a clear subject that starts with the project or job name. A footer saying who sent it is added for you.
- If you do not know the address, or whether the person wants it by email, ask in your hand-off instead of guessing.
