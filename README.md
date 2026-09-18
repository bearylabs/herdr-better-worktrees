# Herdr Better Worktrees

Git worktrees make it easy to keep several branches checked out at once, but they are much nicer to use when every checkout has a predictable home. Herdr Better Worktrees exists to preserve that layout instead of letting the workspace manager decide where worktrees live. It gives you one fast popup for creating, opening, inspecting, fetching, and safely removing them without hiding the Git operations underneath.

The plugin is built around the canonical embedded-bare layout, where repository metadata and all linked checkouts live together under one portable root:

```text
repo/
  .git        # gitdir: ./.bare
  .bare/      # shared bare repository
  main/       # linked worktree
  topic/      # linked worktree
```

Git remains the source of truth: the manager reads porcelain worktree data, checks every checkout's status, and performs clone, initialization, fetch, creation, and removal through argument-safe Git commands. Herdr only hosts the popup and opens existing checkouts. They open as standalone workspaces by default, while Herdr's nested worktree grouping remains available as an optional mode.

![Herdr Better Worktrees manager menu](assets/worktree-manager.png)

## Install

Requirements: Herdr 0.9+, Node.js 20+, Git, npm, and Linux or macOS.

Install the plugin directly from GitHub:

```bash
herdr plugin install bearylabs/herdr-better-worktrees
```

## Use

Invoke the plugin while the focused pane is inside a canonical root or one of its linked worktrees:

```bash
herdr plugin action invoke herdr-better-worktrees.manage
```

To make it readily accessible, add a keybinding to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "herdr-better-worktrees.manage"
description = "manage canonical worktrees"
```

## Keys

- `↑`/`↓` or `j`/`k`: select
- `Enter`/`o`: open selected worktree in Herdr
- `m`: toggle between a standalone workspace (default) and nested worktree grouping
- `a`: create a worktree in the current canonical repository
- `n`: initialize a new empty repository directly in the canonical layout
- `c`: clone an existing repository directly into the canonical layout
- `d`: remove (clean, unlocked, non-current worktrees only)
- `f`: fetch/prune `origin`
- `r`: refresh
- `Esc`/`q`: close

Worktree creation uses `scripts/new-worktree.sh`: enter a directory name and press `Enter` immediately, or use `Tab` to fill the optional branch and base fields. An omitted branch defaults to the directory name. The script reuses a local branch, tracks a matching remote branch, or creates a branch from the supplied/default base. Branch deletion after removal uses `git branch -d`, never forced deletion.

New project initialization uses `scripts/init-canonical.sh`. Press `n`, enter the new repository's destination and optionally an initial branch, then press `Enter`. The branch defaults to `main`. The helper creates an empty `.bare` repository, writes the `.git` pointer, configures reflogs and relative worktree paths, and adds an unborn linked worktree for the initial branch. The destination follows the same relative, absolute, and home-relative path rules as cloning and must not already exist.

Repository cloning uses `scripts/clone-canonical.sh`. Press `c`, enter the remote URL and, if needed, a destination, then press `Enter`. The destination accepts paths relative to the focused pane, absolute paths such as `/srv/projects/repo`, and home-relative paths such as `~/projects/repo`. An omitted destination defaults to the repository name from the URL. The destination and any missing parent directories are created automatically; the final destination must not already exist. The helper clones directly into `.bare`, writes the `.git` pointer, configures remote refs, reflogs, and relative worktree paths, and checks out the remote's default branch as the first linked worktree. A failed setup removes the new incomplete destination. You can invoke the manager outside a Git repository and press `n` or `c` after root discovery reports that no canonical root was found.

## Herdr workspace modes

The default standalone mode first checks Herdr's workspaces and panes for the selected checkout. If it is already open, the plugin renames and focuses that workspace; otherwise it creates one. Standalone workspaces inherit the name of the workspace from which the manager was opened, and duplicates are prevented. The optional nested mode uses Herdr's native sidebar grouping and labels the worktree with its branch name (or its checkout directory when detached). Toggle the mode with `m` before opening a worktree.

Worktree creation itself deliberately bypasses Herdr so its path policy cannot move checkouts outside the canonical root.

## Inspiration

This plugin was inspired by the [`pi-worktrees` extension in dmmulroy's dotfiles](https://github.com/dmmulroy/.dotfiles).
