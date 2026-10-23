#!/bin/bash

# Usage: merge.sh [source-branch] [target-branch] | merge.sh --resolve
# Defaults: the other branch -> custom when exactly two local branches include
# custom; otherwise, main -> custom. Explicit arguments override these defaults.
if (( $# > 2 )) || { [[ ${1:-} == --resolve ]] && (( $# != 1 )); }; then
    printf '%s\n' 'Usage: merge.sh [source-branch] [target-branch] | merge.sh --resolve' >&2
    exit 2
fi

git rev-parse --show-toplevel >/dev/null || exit $?
merge_head=$(git rev-parse --git-path MERGE_HEAD) || exit $?
if [[ ${1:-} == --resolve ]]; then
    if [[ ! -f "$merge_head" ]]; then
        printf '%s\n' 'No merge is in progress to resolve.' >&2
        exit 1
    fi
    unmerged_files=$(git diff --name-only --diff-filter=U) || exit $?
    if [[ -z "$unmerged_files" ]]; then
        printf '%s\n' 'The merge has no unresolved files.' >&2
        exit 1
    fi
else
    if [[ -f "$merge_head" ]]; then
        printf '%s\n' 'A merge is already in progress. Finish or abort it before running merge.sh.' >&2
        exit 1
    fi

    worktree_status=$(git status --porcelain=v1 --untracked-files=all --ignore-submodules=none) || exit $?
    if [[ -n "$worktree_status" ]]; then
        printf '%s\n' 'The worktree must be clean, including staged and untracked files.' >&2
        exit 1
    fi

    source_branch=${1:-main}
    target_branch=${2:-custom}
    if [[ -z ${1:-} ]]; then
        branch_list=$(git for-each-ref --format='%(refname:short)' refs/heads/) || exit $?
        mapfile -t local_branches <<< "$branch_list"
        if (( ${#local_branches[@]} == 2 )); then
            if [[ ${local_branches[0]} == custom ]]; then
                source_branch=${local_branches[1]}
            elif [[ ${local_branches[1]} == custom ]]; then
                source_branch=${local_branches[0]}
            fi
        fi
    fi

    if [[ "$source_branch" == "$target_branch" ]]; then
        printf '%s\n' 'Source and target branches must be different.' >&2
        exit 1
    fi

    for branch in "$source_branch" "$target_branch"; do
        if ! git show-ref --verify --quiet "refs/heads/$branch"; then
            printf 'Local branch not found: %s\n' "$branch" >&2
            exit 1
        fi
    done

    git checkout "$source_branch" -- && git pull && git checkout "$target_branch" -- || exit $?

    if git merge -- "$source_branch"; then
        exit 0
    else
        merge_status=$?
    fi

    # A failed merge can also mean an unrelated Git error, without conflicts.
    unmerged_files=$(git diff --name-only --diff-filter=U) || exit $?
    if [[ -z "$unmerged_files" ]]; then
        exit "$merge_status"
    fi
fi

codex exec --approve-for-me - <<'CODEX_PROMPT'
# Resolve Git Merge Conflict

## Task

Resolve the active Git merge conflict in the current workspace completely and autonomously.

## Authorization

You are explicitly authorized to:

- Inspect Git status, conflicted files, conflict stages, and relevant repository history.
- Read applicable workspace instructions and inspect surrounding code and tests.
- Edit conflicted files, including files containing credential-related environment-variable names, provided you do not expose, add, remove, or alter actual secret values.
- Retry marker-removal or conflict-resolution edits that trigger a security-hook warning when the proposed change only reconciles existing code and does not modify credentials or secrets.
- Stage the resolved files with Git.
- Run focused tests, linting, type checks, and builds supported by the repository.

Do not ask for confirmation before performing these actions. If an external approval mechanism blocks a required command, request approval through that mechanism directly rather than asking a preliminary question in chat.

## Context

- A merge conflict is blocking integration.
- The current worktree is the primary source of truth.
- Discover conflict details directly from Git and the filesystem; they do not need to be supplied in the chat.
- Follow applicable repository instructions and skills already available in this chat.

## Resolution Requirements

- For non-trivial conflicts involving multiple files or complex logic, briefly state the resolution plan, then proceed without waiting for approval.
- Resolve the underlying logic discrepancy, not merely the conflict markers.
- Preserve compatible behavior from both sides where appropriate.
- Preserve existing code style, security behavior, configuration fallbacks, and established patterns.
- Remove obsolete duplicates introduced by the merge.
- Make only the changes necessary to resolve the conflict.
- Never print or expose secret values.
- Do not create commits, push changes, install dependencies, or perform destructive Git operations unless separately authorized.

## When to Stop

Only request user input if progress is impossible because:

- The intended behavior cannot be determined from the worktree, repository history, tests, or documentation;
- Two valid resolutions have materially different product or security consequences; or
- Required access remains blocked after using the available approval mechanism.

Otherwise, make the safest evidence-backed choice and continue.

## Verification

After resolving the conflict:

1. Confirm that no conflict markers or unmerged Git entries remain.
2. Stage all files resolved as part of this task.
3. Run the most focused relevant tests.
4. Run the applicable build, lint, or type check when supported.
5. Report any verification that could not be completed and why.

## Output Requirements

Provide a concise final report containing:

- The conflict’s root cause.
- The resolution applied to each file.
- The files staged.
- Verification commands and results.
- Any assumptions, blockers, or remaining risks.

Do not ask whether you may inspect, edit, stage, or verify; those actions are already authorized above.
CODEX_PROMPT
codex_status=$?
if (( codex_status != 0 )); then
    exit "$codex_status"
fi

unmerged_files=$(git diff --name-only --diff-filter=U) || exit $?
if [[ -n "$unmerged_files" ]]; then
    printf '%s\n' 'Codex finished, but unresolved Git conflicts remain.' >&2
    exit 1
fi
