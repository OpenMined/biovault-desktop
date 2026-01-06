#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_FILE="${MANIFEST_FILE:-manifest.xml}"
MANIFEST_URL="${MANIFEST_URL:-}"
MANIFEST_BRANCH="${MANIFEST_BRANCH:-}"
REPO_BIN_DIR="${REPO_BIN_DIR:-$ROOT_DIR/.repo-bin}"
REPO_BIN="${REPO_BIN:-$REPO_BIN_DIR/repo}"
MANIFEST_REPO_DIR="${MANIFEST_REPO_DIR:-$ROOT_DIR/.repo-manifest}"
MANIFEST_BRANCH_DEFAULT=""

cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: ./mods.sh [OPTIONS]

Options:
  (none)              Show repo tree with branch/dirty status
  --init              Initialize repo workspace and sync deps
  --status            Show repo tool status
  --branch [name]     Checkout/create branch in all repos
  checkout <rev> <target>
                      Checkout a revision in a repo or all repos
                      target: repo path, repo name, or "all"
                      --reset: discard local changes before checkout
  --help, -h          Show this help
EOF
}

REPO_CMD=()

require_repo() {
  if command -v repo >/dev/null 2>&1; then
    REPO_CMD=(repo)
    return
  fi

  if command -v brew >/dev/null 2>&1; then
    local brew_prefix
    brew_prefix="$(brew --prefix repo 2>/dev/null || true)"
    if [[ -n "$brew_prefix" && -x "$brew_prefix/bin/repo" ]]; then
      REPO_CMD=("$brew_prefix/bin/repo")
      return
    fi

    if brew install repo >/dev/null 2>&1; then
      brew_prefix="$(brew --prefix repo 2>/dev/null || true)"
      if [[ -n "$brew_prefix" && -x "$brew_prefix/bin/repo" ]]; then
        REPO_CMD=("$brew_prefix/bin/repo")
        return
      fi
      if command -v repo >/dev/null 2>&1; then
        REPO_CMD=(repo)
        return
      fi
    fi
  fi

  if [[ -x "$REPO_BIN" ]]; then
    REPO_CMD=("$REPO_BIN")
    return
  fi

  mkdir -p "$REPO_BIN_DIR"
  if command -v python >/dev/null 2>&1; then
    python - <<'PY'
import pathlib
import urllib.request

dest = pathlib.Path(".repo-bin/repo")
dest.write_bytes(urllib.request.urlopen("https://storage.googleapis.com/git-repo-downloads/repo").read())
dest.chmod(0o755)
PY
  elif command -v curl >/dev/null 2>&1; then
    curl -s https://storage.googleapis.com/git-repo-downloads/repo -o "$REPO_BIN"
    chmod +x "$REPO_BIN"
  else
    echo "repo tool not found. Install from https://github.com/GerritCodeReview/git-repo" >&2
    exit 1
  fi

  if [[ -x "$REPO_BIN" ]]; then
    REPO_CMD=("$REPO_BIN")
    return
  fi

  echo "repo tool not found and auto-download failed. Install from https://github.com/GerritCodeReview/git-repo" >&2
  exit 1
}

resolve_manifest_url() {
  if [[ -n "$MANIFEST_URL" ]]; then
    echo "$MANIFEST_URL"
    return
  fi

  if git -C "$ROOT_DIR" cat-file -e "HEAD:$MANIFEST_FILE" 2>/dev/null; then
    MANIFEST_BRANCH_DEFAULT="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
    echo "file://$ROOT_DIR"
    return
  fi

  if [[ ! -f "$MANIFEST_FILE" ]]; then
    echo "Manifest not found: $MANIFEST_FILE" >&2
    exit 1
  fi

  mkdir -p "$MANIFEST_REPO_DIR"
  if [[ ! -d "$MANIFEST_REPO_DIR/.git" ]]; then
    git -C "$MANIFEST_REPO_DIR" init >/dev/null 2>&1
  fi
  git -C "$MANIFEST_REPO_DIR" checkout -B main >/dev/null 2>&1 || true
  git -C "$MANIFEST_REPO_DIR" config user.email "repo@local" >/dev/null 2>&1 || true
  git -C "$MANIFEST_REPO_DIR" config user.name "repo tool" >/dev/null 2>&1 || true

  mkdir -p "$MANIFEST_REPO_DIR/$(dirname "$MANIFEST_FILE")"
  cp "$MANIFEST_FILE" "$MANIFEST_REPO_DIR/$MANIFEST_FILE"
  git -C "$MANIFEST_REPO_DIR" add "$MANIFEST_FILE" >/dev/null 2>&1
  if ! git -C "$MANIFEST_REPO_DIR" diff --cached --quiet -- "$MANIFEST_FILE"; then
    git -C "$MANIFEST_REPO_DIR" commit -m "Update manifest" >/dev/null 2>&1 || true
  fi

  MANIFEST_BRANCH_DEFAULT="$(git -C "$MANIFEST_REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  echo "file://$MANIFEST_REPO_DIR"
}

repo_init() {
  local url
  url="$(resolve_manifest_url)"
  local branch="${MANIFEST_BRANCH:-$MANIFEST_BRANCH_DEFAULT}"

  if [[ -n "$branch" ]]; then
    "${REPO_CMD[@]}" init -u "$url" -m "$MANIFEST_FILE" -b "$branch"
  else
    "${REPO_CMD[@]}" init -u "$url" -m "$MANIFEST_FILE"
  fi
}

require_repo_workspace() {
  if [[ ! -d "$ROOT_DIR/.repo" ]]; then
    echo "repo workspace not initialized. Run: ./mods.sh --init" >&2
    exit 1
  fi
}

manifest_paths() {
  if [[ ! -f "$MANIFEST_FILE" ]]; then
    echo "Manifest not found: $MANIFEST_FILE" >&2
    exit 1
  fi

  awk -F'"' '/<project / { for (i = 1; i <= NF; i++) { if ($i == "path") { print $(i + 1); break } } }' "$MANIFEST_FILE" \
    | awk 'NF'
}

print_repo() {
  local path="$1"
  local indent="$2"
  local prefix="$3"

  if [[ ! -d "$path/.git" && ! -f "$path/.git" ]]; then
    echo -e "${indent}${prefix}${CYAN}${path##*/}/${NC} ${RED}[missing]${NC}"
    return
  fi

  if ! git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo -e "${indent}${prefix}${CYAN}${path##*/}/${NC} ${RED}[broken]${NC}"
    return
  fi

  local branch
  branch=$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
  local dirty=""
  local dirty_color=""

  if [[ -n $(git -C "$path" status --porcelain -uno 2>/dev/null || true) ]]; then
    dirty=" [dirty]"
    dirty_color="${RED}"
  else
    dirty_color="${GREEN}"
  fi

  local branch_display=""
  if [[ "$branch" == "HEAD" ]]; then
    local tag
    tag=$(git -C "$path" describe --tags --exact-match 2>/dev/null || true)
    if [[ -n "$tag" ]]; then
      branch_display="${YELLOW}($tag)${NC}"
    else
      local short_sha
      short_sha=$(git -C "$path" rev-parse --short HEAD 2>/dev/null || echo "unknown")
      branch_display="${YELLOW}(detached: $short_sha)${NC}"
    fi
  else
    branch_display="${BLUE}[$branch]${NC}"
  fi

  echo -e "${indent}${prefix}${CYAN}${path##*/}/${NC} ${branch_display}${dirty_color}${dirty}${NC}"
}

show_tree() {
  local root_branch
  root_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  local root_dirty=""
  if [[ -n $(git status --porcelain -uno 2>/dev/null || true) ]]; then
    root_dirty=" ${RED}[dirty]${NC}"
  fi
  echo -e "${CYAN}$(basename "$(pwd)")/${NC} ${BLUE}[$root_branch]${NC}${root_dirty}"

  local python_cmd=""
  if command -v python3 >/dev/null 2>&1; then
    python_cmd="python3"
  elif command -v python >/dev/null 2>&1; then
    python_cmd="python"
  fi

  local print_flat=false
  if [[ -z "$python_cmd" ]]; then
    print_flat=true
  fi

  local tree_lines
  if [[ "$print_flat" == false ]]; then
    if ! tree_lines="$("$python_cmd" - "$MANIFEST_FILE" <<'PY'
import sys
import xml.etree.ElementTree as ET

manifest = sys.argv[1]
tree = ET.parse(manifest)
paths = []
for proj in tree.findall("project"):
    path = proj.get("path") or proj.get("name")
    if path:
        paths.append(path)

path_set = set(paths)
sep = "\x1f"

def parent_of(path: str):
    parts = path.split("/")
    for i in range(len(parts) - 1, 0, -1):
        candidate = "/".join(parts[:i])
        if candidate in path_set:
            return candidate
    return None

children = {}
for path in paths:
    parent = parent_of(path)
    children.setdefault(parent, []).append(path)

def walk(parent, indent=""):
    kids = sorted(children.get(parent, []))
    for idx, child in enumerate(kids):
        last = idx == len(kids) - 1
        prefix = "└── " if last else "├── "
        print(f"{indent}{sep}{prefix}{sep}{child}")
        walk(child, indent + ("    " if last else "│   "))

walk(None)
PY
    )"; then
      print_flat=true
    fi
  fi

  if [[ "$print_flat" == true ]]; then
    manifest_paths | sort | while IFS= read -r path; do
      print_repo "$path" "" "- "
    done
  else
    while IFS=$'\x1f' read -r indent prefix path; do
      [[ -z "$path" ]] && continue
      print_repo "$path" "$indent" "$prefix"
    done <<< "$tree_lines"
  fi

  echo ""
  echo -e "${GREEN}Legend:${NC}"
  echo -e "  ${BLUE}[branch]${NC}     - on branch"
  echo -e "  ${YELLOW}(tag)${NC}        - detached at tag"
  echo -e "  ${YELLOW}(detached)${NC}   - detached HEAD"
  echo -e "  ${RED}[dirty]${NC}      - uncommitted changes"
  echo -e "  ${RED}[missing]${NC}    - repo not checked out"
}

resolve_checkout_targets() {
  local target="$1"
  local -a matches
  matches=()

  if [[ "$target" == "all" ]]; then
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      matches+=("$path")
    done < <(manifest_paths)
    for repo in "${matches[@]}"; do
      printf '%s\n' "$repo"
    done
    return
  fi

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if [[ "$path" == "$target" ]]; then
      matches+=("$path")
    fi
  done < <(manifest_paths)

  if [[ "${#matches[@]}" -eq 0 ]]; then
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      if [[ "$(basename "$path")" == "$target" ]]; then
        matches+=("$path")
      fi
    done < <(manifest_paths)
  fi

  if [[ "${#matches[@]}" -eq 0 ]]; then
    echo "Unknown repo target: $target" >&2
    exit 1
  fi
  if [[ "${#matches[@]}" -gt 1 ]]; then
    echo "Ambiguous repo name '$target'. Use full path:" >&2
    for repo in "${matches[@]}"; do
      printf '  - %s\n' "$repo" >&2
    done
    exit 1
  fi

  for repo in "${matches[@]}"; do
    printf '%s\n' "$repo"
  done
}

do_checkout() {
  local reset=0
  while [[ "${1:-}" == "--reset" ]]; do
    reset=1
    shift
  done

  local rev="${1:-}"
  local target="${2:-}"

  if [[ -z "$rev" || -z "$target" ]]; then
    echo "Usage: ./mods.sh checkout [--reset] <rev> <target>" >&2
    exit 1
  fi

  if [[ "$reset" -eq 1 && "${MODS_ASSUME_YES:-0}" != "1" ]]; then
    echo -e "${RED}WARNING:${NC} This will discard local changes and remove untracked files."
    echo -ne "${YELLOW}Continue? [y/N]: ${NC}"
    read -r confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
      echo -e "${BLUE}Aborted.${NC}"
      exit 0
    fi
  fi

  local repo
  local failures=0
  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    echo -ne "  → $repo: "
    if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo -e "${RED}missing${NC}"
      failures=$((failures + 1))
      continue
    fi

    if [[ "$reset" -eq 1 ]]; then
      git -C "$repo" reset --hard >/dev/null 2>&1 || true
      git -C "$repo" clean -fd >/dev/null 2>&1 || true
    fi

    if [[ "${MODS_FETCH:-1}" != "0" ]]; then
      git -C "$repo" fetch origin --tags >/dev/null 2>&1 || true
    fi

    if git -C "$repo" show-ref --verify --quiet "refs/heads/$rev"; then
      if git -C "$repo" checkout "$rev" >/dev/null 2>&1; then
        echo -e "${GREEN}checked out${NC}"
      else
        echo -e "${RED}failed${NC}"
        failures=$((failures + 1))
      fi
      continue
    fi

    if git -C "$repo" show-ref --verify --quiet "refs/remotes/origin/$rev"; then
      if git -C "$repo" checkout -B "$rev" "origin/$rev" >/dev/null 2>&1; then
        echo -e "${GREEN}checked out${NC}"
      else
        echo -e "${RED}failed${NC}"
        failures=$((failures + 1))
      fi
      continue
    fi

    if git -C "$repo" checkout "$rev" >/dev/null 2>&1; then
      echo -e "${GREEN}checked out${NC}"
    else
      echo -e "${RED}failed${NC}"
      failures=$((failures + 1))
    fi
  done < <(resolve_checkout_targets "$target")

  if [[ "$failures" -ne 0 ]]; then
    exit 1
  fi
}

case "${1:-}" in
  --init)
    require_repo
    repo_init
    "${REPO_CMD[@]}" sync
    ;;
  --status)
    require_repo
    require_repo_workspace
    "${REPO_CMD[@]}" status
    ;;
  --branch)
    require_repo
    require_repo_workspace
    branch="${2:-}"
    if [[ -z "$branch" ]]; then
      echo "Missing branch name" >&2
      exit 1
    fi
    "${REPO_CMD[@]}" forall -c "git checkout -B \"$branch\""
    ;;
  --help|-h)
    usage
    ;;
  checkout)
    do_checkout "${@:2}"
    ;;
  "")
    show_tree
    ;;
  *)
    echo "Unknown option: $1" >&2
    usage >&2
    exit 1
    ;;
esac
