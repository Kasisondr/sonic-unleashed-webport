#!/usr/bin/env python3
"""Fetch the pinned recompiler without resetting an existing checkout."""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
pin = json.loads((ROOT / "upstream-pin.json").read_text())
upstream = ROOT / "upstream"


def git(*args, cwd=upstream, capture=False):
    result = subprocess.run(["git", *args], cwd=cwd, check=True,
                            capture_output=capture, text=True)
    return result.stdout.strip() if capture else None


if not upstream.exists():
    git("clone", "--no-checkout", pin["repository"], str(upstream), cwd=ROOT)
    git("checkout", "--detach", pin["commit"])
elif not (upstream / ".git").exists():
    raise SystemExit("Existing upstream directory is not a Git checkout; preserve it and choose another directory.")
if git("rev-parse", "HEAD", capture=True) != pin["commit"]:
    raise SystemExit("Existing upstream uses a different commit. Refusing to reset it.")
if git("status", "--porcelain", "--untracked-files=no", capture=True):
    raise SystemExit("Existing upstream has local changes. Preserve them before bootstrapping.")
git("submodule", "update", "--init", "--recursive", "tools/XenonRecomp")
xenon = upstream / "tools/XenonRecomp"
if git("rev-parse", "HEAD", cwd=xenon, capture=True) != pin["xenon_recomp_commit"]:
    raise SystemExit("XenonRecomp commit does not match the recorded pin.")
print(f"Verified upstream {pin['commit']} and XenonRecomp {pin['xenon_recomp_commit']}")
