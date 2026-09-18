#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: init-canonical.sh <destination> [initial-branch]

Initialize an empty repository in the canonical worktree layout:
  <destination>/.git   -> gitdir: ./.bare
  <destination>/.bare  -> shared bare repository
  <destination>/<initial-branch> -> linked unborn worktree

The initial branch defaults to main. Slashes in its name become dashes in the
checkout directory. The destination must not already exist. Missing parent
folders are created automatically. Relative, absolute, and ~/ paths are
supported. If setup fails, the newly created destination is removed.
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

destination=$1
initial_branch=${2:-main}
if [[ -z "$destination" || "$destination" == "." || "$destination" == ".." ]]; then
  echo "init-canonical: destination must name a new repository directory" >&2
  exit 2
fi
if [[ -z "$initial_branch" || "$initial_branch" == -* ]]; then
  echo "init-canonical: initial branch must be non-empty and must not start with '-': $initial_branch" >&2
  exit 2
fi
if ! git check-ref-format --branch "$initial_branch" >/dev/null 2>&1; then
  echo "init-canonical: invalid initial branch: $initial_branch" >&2
  exit 2
fi
if [[ "$destination" == "~" ]]; then
  destination=$HOME
elif [[ $destination == "~/"* ]]; then
  destination="$HOME/${destination#\~/}"
fi
if [[ -e "$destination" || -L "$destination" ]]; then
  echo "init-canonical: destination already exists: $destination" >&2
  exit 1
fi

mkdir -p -- "$destination"
created=true
cleanup() {
  status=$?
  if [[ $status -ne 0 && ${created:-false} == true ]]; then
    rm -rf -- "$destination"
  fi
  exit "$status"
}
trap cleanup EXIT

git init --bare --initial-branch="$initial_branch" -- "$destination/.bare"
printf '%s\n' 'gitdir: ./.bare' >"$destination/.git"
git -C "$destination" config core.logAllRefUpdates true
git -C "$destination" config worktree.useRelativePaths true

local_directory=${initial_branch//\//-}
if [[ -z "$local_directory" || "$local_directory" == "." || "$local_directory" == ".." ]]; then
  echo "init-canonical: initial branch cannot be used as a checkout directory: $initial_branch" >&2
  exit 1
fi
git -C "$destination" worktree add --orphan -b "$initial_branch" -- "$local_directory"

created=false
trap - EXIT
printf 'Initialized empty canonical repository at %s\n' "$destination" >&2
git -C "$destination" worktree list --verbose
