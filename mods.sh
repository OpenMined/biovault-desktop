#!/bin/bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_submodule() {
    local path="$1"
    local indent="$2"
    local prefix="$3"

    if [[ ! -d "$path/.git" && ! -f "$path/.git" ]]; then
        echo -e "${indent}${prefix}${CYAN}${path##*/}/${NC} ${RED}[uninitialized]${NC}"
        return
    fi

    local branch=$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null)
    local dirty=""
    local dirty_color=""

    if [[ -n $(git -C "$path" status --porcelain -uno 2>/dev/null) ]]; then
        dirty=" [dirty]"
        dirty_color="${RED}"
    else
        dirty_color="${GREEN}"
    fi

    local branch_display=""
    if [[ "$branch" == "HEAD" ]]; then
        local tag=$(git -C "$path" describe --tags --exact-match 2>/dev/null)
        if [[ -n "$tag" ]]; then
            branch_display="${YELLOW}($tag)${NC}"
        else
            local short_sha=$(git -C "$path" rev-parse --short HEAD 2>/dev/null)
            branch_display="${YELLOW}(detached: $short_sha)${NC}"
        fi
    else
        branch_display="${BLUE}[$branch]${NC}"
    fi

    echo -e "${indent}${prefix}${CYAN}${path##*/}/${NC} ${branch_display}${dirty_color}${dirty}${NC}"
}

traverse_submodules() {
    local base_path="$1"
    local indent="$2"
    local is_last="$3"

    local submodules=$(git -C "$base_path" config --file .gitmodules --get-regexp path 2>/dev/null | awk '{print $2}' | sort)

    if [[ -z "$submodules" ]]; then
        return
    fi

    local count=$(echo "$submodules" | wc -l | tr -d ' ')
    local i=0

    while IFS= read -r submodule; do
        ((i++))
        local full_path="$base_path/$submodule"
        local name=$(basename "$submodule")

        local current_prefix="├── "
        local next_indent="${indent}│   "
        if [[ $i -eq $count ]]; then
            current_prefix="└── "
            next_indent="${indent}    "
        fi

        print_submodule "$full_path" "$indent" "$current_prefix"
        traverse_submodules "$full_path" "$next_indent" $([[ $i -eq $count ]] && echo 1 || echo 0)
    done <<< "$submodules"
}

root_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
root_dirty=""
if [[ -n $(git status --porcelain -uno 2>/dev/null) ]]; then
    root_dirty=" ${RED}[dirty]${NC}"
fi
echo -e "${CYAN}$(basename "$(pwd)")/${NC} ${BLUE}[$root_branch]${NC}${root_dirty}"

traverse_submodules "." ""

echo ""
echo -e "${GREEN}Legend:${NC}"
echo -e "  ${BLUE}[branch]${NC}     - on branch"
echo -e "  ${YELLOW}(tag)${NC}        - detached at tag"
echo -e "  ${YELLOW}(detached)${NC}   - detached HEAD"
echo -e "  ${RED}[dirty]${NC}      - uncommitted changes"
echo -e "  ${RED}[uninitialized]${NC} - submodule not checked out"
