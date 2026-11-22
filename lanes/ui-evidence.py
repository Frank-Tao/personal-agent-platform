#!/usr/bin/env python3
"""UI evidence: drive a real browser through a list of checks and keep proof.

Usage:   python3 lanes/ui-evidence.py <spec.json> <out-dir>
Needs:   python3 with the `playwright` package and Google Chrome (or Playwright's Chromium).
Output:  <out-dir>/<shot>.png for every check, results.json, and ui-report.md (what was expected, what was seen, PASS or FAIL, which screenshot).
Exit:    0 only when every check passed; 1 when a check failed; 2 when the browser could not run.

The spec (JSON). Use synthetic data only:
{
  "base": "http://localhost:8000",             # where the app runs
  "viewport": [1280, 800],                      # optional
  "requirement": "dark",                        # optional: shown in the report so evidence is traceable to what was asked
  "checks": [
    { "id": "AC1",                              # acceptance item
      "expect": "Settings shows a dark mode switch",     # in words, as a person would say it
      "steps": [ {"goto": "/settings"}, {"click": "text=Dark mode"}, {"fill": ["#name", "Ann"]},
                 {"upload": ["input[type=file]", "/abs/path/synthetic.xlsx"]}, {"press": "Enter"}, {"wait": 500} ],
      "assert": [ {"text": "Dark mode on"}, {"visible": "#dark-switch"}, {"not_text": "Error"} ],
      "shot": "ac1-dark-switch.png", "full_page": true }
  ]
}
"""
import json
import os
import sys
import time


def fail(msg, code=2):
    print(msg, file=sys.stderr)
    sys.exit(code)


def launch(p, browser):
    if browser in ("chrome", "msedge"):
        try:
            return p.chromium.launch(channel=browser)
        except Exception:
            pass
    return p.chromium.launch()


def run_step(page, base, step):
    if "goto" in step:
        url = step["goto"]
        page.goto(url if url.startswith("http") else base.rstrip("/") + "/" + url.lstrip("/"), wait_until="load", timeout=30000)
    elif "click" in step:
        page.click(step["click"], timeout=15000)
    elif "fill" in step:
        page.fill(step["fill"][0], step["fill"][1], timeout=15000)
    elif "upload" in step:
        page.set_input_files(step["upload"][0], step["upload"][1], timeout=15000)
    elif "press" in step:
        page.keyboard.press(step["press"])
    elif "select" in step:
        page.select_option(step["select"][0], step["select"][1], timeout=15000)
    elif "wait" in step:
        page.wait_for_timeout(int(step["wait"]))
    elif "wait_for" in step:
        page.wait_for_selector(step["wait_for"], timeout=15000)
    else:
        raise ValueError("unknown step: %s" % json.dumps(step))


def run_assert(page, a):
    body = page.inner_text("body")
    if "text" in a:
        return a["text"] in body, "text %r %s" % (a["text"], "found" if a["text"] in body else "NOT found")
    if "not_text" in a:
        return a["not_text"] not in body, "text %r %s" % (a["not_text"], "absent" if a["not_text"] not in body else "PRESENT")
    if "visible" in a:
        ok = page.is_visible(a["visible"])
        return ok, "%s %s" % (a["visible"], "visible" if ok else "NOT visible")
    if "count" in a:
        sel, n = a["count"][0], int(a["count"][1])
        got = page.locator(sel).count()
        return got == n, "%s count %d (expected %d)" % (sel, got, n)
    raise ValueError("unknown assertion: %s" % json.dumps(a))


def main():
    if len(sys.argv) != 3:
        fail(__doc__, 2)
    try:
        spec = json.load(open(sys.argv[1]))
    except Exception as e:
        fail("cannot read the spec: %s" % e)
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        fail("the python package 'playwright' is not installed (pip3 install playwright); Chrome must be installed too")
    base = spec.get("base")
    if not base:
        fail("the spec needs a 'base' address")
    vw, vh = (spec.get("viewport") or [1280, 800])[:2]
    results = []
    try:
        with sync_playwright() as p:
            browser = launch(p, spec.get("browser", "chrome"))
            ctx = browser.new_context(viewport={"width": vw, "height": vh})
            for n, chk in enumerate(spec.get("checks", []), 1):
                page = ctx.new_page()
                errors = []
                page.on("pageerror", lambda e, errors=errors: errors.append(str(e)))
                r = {"id": chk.get("id", "check-%d" % n), "expect": chk.get("expect", ""), "steps": chk.get("steps", []), "asserts": [], "shot": None, "passed": True, "error": None, "page_errors": []}
                started = time.time()
                try:
                    for st in chk.get("steps", []):
                        run_step(page, base, st)
                    for a in chk.get("assert", []):
                        ok, msg = run_assert(page, a)
                        r["asserts"].append({"ok": ok, "what": msg})
                        r["passed"] = r["passed"] and ok
                except Exception as e:  # a step that could not run is a failure, with its screenshot
                    r["passed"] = False
                    r["error"] = str(e).split("\n")[0][:300]
                shot = chk.get("shot") or ("%s.png" % r["id"].lower())
                try:
                    page.screenshot(path=os.path.join(out, shot), full_page=bool(chk.get("full_page", True)))
                    r["shot"] = shot
                except Exception as e:
                    r["passed"] = False
                    r["error"] = (r["error"] or "") + " (no screenshot: %s)" % str(e).split("\n")[0][:120]
                r["page_errors"] = errors[:5]
                if errors and spec.get("fail_on_page_error", False):
                    r["passed"] = False
                r["seconds"] = round(time.time() - started, 1)
                results.append(r)
                page.close()
            browser.close()
    except Exception as e:
        fail("the browser could not run: %s" % str(e).split("\n")[0][:300])
    json.dump({"requirement": spec.get("requirement"), "base": base, "results": results}, open(os.path.join(out, "results.json"), "w"), indent=2)
    lines = ["# UI evidence", "", "Requirement: %s" % (spec.get("requirement") or "(not stated)"), "App: %s" % base, "Run: %s" % time.strftime("%Y-%m-%d %H:%M:%S"), ""]
    lines += ["| Item | Expected | Result | Screenshot |", "|---|---|---|---|"]
    for r in results:
        lines.append("| %s | %s | %s | %s |" % (r["id"], r["expect"].replace("|", "/"), "PASS" if r["passed"] else "FAIL", ("[%s](%s)" % (r["shot"], r["shot"])) if r["shot"] else "none"))
    for r in results:
        lines += ["", "## %s: %s" % (r["id"], "PASS" if r["passed"] else "FAIL"), "", "Expected: %s" % r["expect"], "", "Steps: `%s`" % json.dumps(r["steps"])]
        for a in r["asserts"]:
            lines.append("- %s %s" % ("PASS" if a["ok"] else "FAIL", a["what"]))
        if r["error"]:
            lines.append("- ERROR %s" % r["error"])
        if r["page_errors"]:
            lines.append("- page errors seen: %s" % "; ".join(r["page_errors"]))
        if r["shot"]:
            lines += ["", "![%s](%s)" % (r["id"], r["shot"])]
    open(os.path.join(out, "ui-report.md"), "w").write("\n".join(lines) + "\n")
    bad = [r["id"] for r in results if not r["passed"]]
    print("%d of %d checks passed%s" % (len(results) - len(bad), len(results), "; FAILED: " + ", ".join(bad) if bad else ""))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
