"""Native Hermes kanban adapter for the feedback-loop sandbox (work/e2e/feedback-loop.ts). TEST DATA ONLY.

It calls Hermes' own kanban command handler in-process (no `hermes` launcher, no dependency sync), so the converter's board calls
get the exact JSON Hermes would give, but only for ONE disposable board inside ONE sandbox root. Every check below fails closed;
the TypeScript side (sandbox.ts nativeRunner) applies the same allowlist first, so a refusal here means something got past it.

  python3 -I hermes_native.py boards create <board>
  python3 -I hermes_native.py --board <board> <list|show|create|edit|link|block> ...

Environment (all required): FEEDBACK_E2E_ROOT, FEEDBACK_E2E_BOARD, FEEDBACK_E2E_REAL_KANBAN_HOME, HERMES_KANBAN_HOME, HERMES_HOME,
HERMES_AGENT_DIR. The worker write fence (HERMES_DELEGATED_CHILD_CONTEXT), when present, is left as it is: it guards the real board
root, and this board is outside that root, so the fence is neither needed nor bypassed.
"""
import argparse
import os
import sys
from pathlib import Path

ACTIONS = {"list", "show", "create", "edit", "link", "block"}


def refuse(why: str) -> "None":
    print(f"hermes-native: refused: {why}", file=sys.stderr)
    sys.exit(97)


def inside(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def main(argv: list[str]) -> int:
    env = os.environ
    for k in ("FEEDBACK_E2E_ROOT", "FEEDBACK_E2E_BOARD", "FEEDBACK_E2E_REAL_KANBAN_HOME", "HERMES_KANBAN_HOME", "HERMES_HOME", "HERMES_AGENT_DIR"):
        if not env.get(k):
            refuse(f"{k} is not set")
    for k in ("HERMES_KANBAN_DB", "HERMES_KANBAN_BOARD", "HERMES_KANBAN_TASK"):
        if env.get(k):
            refuse(f"{k} is set; it would point the handler at a real board")
    root = Path(env["FEEDBACK_E2E_ROOT"]).resolve()
    board = env["FEEDBACK_E2E_BOARD"]
    real = Path(env["FEEDBACK_E2E_REAL_KANBAN_HOME"]).resolve()
    home = Path(env["HERMES_KANBAN_HOME"]).resolve()
    if not (root / "TEST-DATA-ONLY").is_file():
        refuse(f"{root} has no TEST-DATA-ONLY marker")
    if home != root / "hermes" or Path(env["HERMES_HOME"]).resolve() != home:
        refuse("HERMES_KANBAN_HOME and HERMES_HOME must both be <root>/hermes")
    if inside(home, real) or inside(real, home):
        refuse(f"sandbox kanban home {home} overlaps the real one {real}")

    if argv == ["boards", "create", board]:
        pass
    elif len(argv) >= 3 and argv[0] == "--board" and argv[1] == board and argv[2] in ACTIONS:
        pass
    else:
        refuse(f"only `boards create {board}` and `--board {board} {'|'.join(sorted(ACTIONS))}` are allowed, got {argv[:3]}")

    sys.path.insert(0, env["HERMES_AGENT_DIR"])
    from hermes_cli import kanban_db as kb  # noqa: E402
    from hermes_cli.kanban import build_parser, kanban_command  # noqa: E402

    if not inside(kb.boards_root().resolve(), home):
        refuse(f"Hermes resolved the board root to {kb.boards_root()}, outside the sandbox")
    if argv[0] == "--board" and not inside(kb.kanban_db_path(board=board).resolve(), home):
        refuse("the board database resolves outside the sandbox")

    parser = argparse.ArgumentParser(prog="hermes")
    build_parser(parser.add_subparsers(dest="command"))
    return int(kanban_command(parser.parse_args(["kanban", *argv])) or 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
