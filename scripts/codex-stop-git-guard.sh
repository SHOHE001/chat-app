#!/usr/bin/env bash
set -euo pipefail

# Consume the Stop hook payload even though this guard only needs repository state.
input=$(cat)
: "$input"

root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$root" ]]; then
  exit 0
fi
cd "$root"

git_dir=$(git rev-parse --absolute-git-dir)
allow_marker="$git_dir/codex-allow-unpushed-stop"
if [[ -f "$allow_marker" ]]; then
  rm -f "$allow_marker"
  exit 0
fi

if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  printf '%s\n' '{"continue":false,"stopReason":"Repository changes are not committed. Review, test, commit, and push them before ending the turn. If the user explicitly approved leaving this turn uncommitted, run scripts/allow-unpushed-turn.sh once."}'
  exit 0
fi

branch=$(git branch --show-current)
if [[ -z "$branch" ]]; then
  printf '%s\n' '{"continue":false,"stopReason":"Git is in detached HEAD state. Move the completed work to a branch and push it before ending the turn."}'
  exit 0
fi

if ! upstream=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null); then
  printf '%s\n' '{"continue":false,"stopReason":"The current branch has no upstream. Push it with tracking before ending the turn."}'
  exit 0
fi

if [[ $(git rev-list --count "$upstream..HEAD") -gt 0 ]]; then
  printf '%s\n' '{"continue":false,"stopReason":"Committed changes have not been pushed to GitHub. Push the current branch before ending the turn."}'
  exit 0
fi
