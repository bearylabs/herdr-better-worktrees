#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "Usage: new-worktree.sh <local-dir> [branch] [base]" >&2
  exit 2
fi
local_dir=$1
branch=${2:-$local_dir}
base=${3:-}

if [[ -z "$local_dir" || "$local_dir" == "." || "$local_dir" == ".." || "$local_dir" == */* ]]; then
  echo "local-dir must name one direct child of the repository root" >&2
  exit 2
fi
if ! git check-ref-format --branch "$branch" >/dev/null 2>&1; then
  echo "invalid branch name: $branch" >&2
  exit 2
fi
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
[[ ${common_dir##*/} == ".bare" ]] || { echo "shared Git directory is not .bare: $common_dir" >&2; exit 1; }
root=${common_dir%/.bare}
[[ $(git -C "$root" rev-parse --is-bare-repository) == true ]] || { echo "canonical root is not backed by a bare repository" >&2; exit 1; }
[[ ! -e "$root/$local_dir" ]] || { echo "destination already exists: $root/$local_dir" >&2; exit 1; }

remote=${WORKTREE_REMOTE:-origin}
has_remote=false
if git -C "$root" remote get-url "$remote" >/dev/null 2>&1; then
  git -C "$root" fetch --prune "$remote"
  has_remote=true
fi

if git -C "$root" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$root" worktree add -- "$local_dir" "$branch"
elif [[ $has_remote == true ]] && git -C "$root" show-ref --verify --quiet "refs/remotes/$remote/$branch"; then
  git -C "$root" worktree add --track -b "$branch" -- "$local_dir" "$remote/$branch"
else
  if [[ -z "$base" && $has_remote == true ]]; then
    base=$(git -C "$root" symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null || true)
  fi
  if [[ -z "$base" ]]; then
    if git -C "$root" show-ref --verify --quiet refs/heads/main; then
      base=main
    elif git -C "$root" show-ref --verify --quiet refs/heads/master; then
      base=master
    fi
  fi
  [[ -n "$base" ]] || { echo "no default base found; pass base explicitly" >&2; exit 1; }
  git -C "$root" rev-parse --verify --quiet "$base^{commit}" >/dev/null || { echo "base does not resolve to a commit: $base" >&2; exit 1; }
  git -C "$root" worktree add --no-track -b "$branch" -- "$local_dir" "$base"
fi
