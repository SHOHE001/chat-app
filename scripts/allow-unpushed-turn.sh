#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
git_dir=$(git -C "$root" rev-parse --absolute-git-dir)
touch "$git_dir/codex-allow-unpushed-stop"
echo "One uncommitted/unpushed Codex Stop check may now pass."
