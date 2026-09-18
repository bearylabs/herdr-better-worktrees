#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: clone-canonical.sh <url> [destination]

Clone a repository directly into the canonical worktree layout:
  <destination>/.git   -> gitdir: ./.bare
  <destination>/.bare  -> shared bare repository
  <destination>/<default-branch> -> linked worktree

When destination is omitted, it defaults to the repository name from the URL.
The destination must not already exist. The destination and missing parent
folders are created automatically. Relative destinations are resolved from the
current directory; absolute paths and ~/ paths are supported. If setup fails,
the newly created destination is removed.
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

url=$1
destination=${2:-}
if [[ -z "$destination" ]]; then
  repository_name=${url%/}
  repository_name=${repository_name##*/}
  repository_name=${repository_name##*:}
  repository_name=${repository_name%.git}
  destination=$repository_name
fi
if [[ -z "$url" || "$url" == -* ]]; then
  echo "clone-canonical: URL must be non-empty and must not start with '-': $url" >&2
  exit 2
fi
if [[ -z "$destination" || "$destination" == "." || "$destination" == ".." ]]; then
  echo "clone-canonical: could not infer a valid destination; provide one explicitly" >&2
  exit 2
fi
if [[ "$destination" == "~" ]]; then
  destination=$HOME
elif [[ $destination == "~/"* ]]; then
  destination="$HOME/${destination#\~/}"
fi
if [[ -e "$destination" || -L "$destination" ]]; then
  echo "clone-canonical: destination already exists: $destination" >&2
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

git clone --bare -- "$url" "$destination/.bare"
printf '%s\n' 'gitdir: ./.bare' >"$destination/.git"
git -C "$destination" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C "$destination" config core.logAllRefUpdates true
git -C "$destination" config worktree.useRelativePaths true
git -C "$destination" fetch --prune origin
git -C "$destination" remote set-head origin --auto

default_ref=$(git -C "$destination" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
if [[ -z "$default_ref" ]]; then
  echo "clone-canonical: remote has no default branch with a commit" >&2
  exit 1
fi
default_branch=${default_ref#origin/}
local_directory=${default_branch//\//-}
if [[ -z "$local_directory" || "$local_directory" == "." || "$local_directory" == ".." ]]; then
  echo "clone-canonical: remote default branch cannot be used as a checkout directory: $default_branch" >&2
  exit 1
fi

git -C "$destination" worktree add -- "$local_directory" "$default_branch"
git -C "$destination/$local_directory" branch --set-upstream-to="origin/$default_branch" "$default_branch"
created=false
trap - EXIT

printf 'Cloned canonical repository to %s\n' "$destination" >&2
git -C "$destination" worktree list --verbose
