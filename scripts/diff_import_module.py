#!/usr/bin/env python3
"""Compare import workflow code in main.js with a proposed module file.

Usage: python scripts/diff_import_module.py [module_path]
If module_path is omitted, defaults to src/import.js.

The script extracts key functions from src/main.js (current working tree) and
compares them with the same functions in the module file. It prints a unified

diff for any differences so we can spot accidental behaviour changes quickly.
"""

import argparse
import difflib
import textwrap
from pathlib import Path
from typing import List

MAIN_PATH = Path("src/main.js")
DEFAULT_MODULE_PATH = Path("src/import.js")

# Ordered list of function signatures that comprise the import workflow.
FUNCTION_SIGNATURES: List[str] = [
    "function renderFiles",
    "function markActivePattern",
    "async function applyPattern",
    "async function updatePatternSuggestions",
    "async function searchFiles",
    "async function updateFileTypeDropdown",
    "async function pickFolder",
    "function updateSelectAllCheckbox",
    "function updateSelectedFileCount",
    "function updateImportButton",
    "function resetImportState",
    "function goToReviewStep",
    "function sortReviewFiles",
    "function setReviewSortField",
    "function updateReviewSortIndicators",
    "function showReviewView",
    "function updateReviewSelectAllCheckbox",
    "function isReviewMetadataComplete",
    "function applyReviewRowState",
    "function updateRowVisibility",
    "function updateReviewSelectionState",
    "function renderReviewTable",
    "async function detectFileTypes",
    "function updateRowInPlace",
    "async function finalizeImport",
]


def extract_function(source: str, signature: str) -> str:
    """Return the function body including signature and braces."""
    idx = source.find(signature)
    if idx == -1:
        raise ValueError(f"Missing signature: {signature}")
    # Find the first opening brace following the signature.
    brace_idx = source.find('{', idx)
    if brace_idx == -1:
        raise ValueError(f"Missing opening brace for {signature}")
    depth = 0
    end = brace_idx
    while end < len(source):
        char = source[end]
        if char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                end += 1  # include closing brace
                break
        end += 1
    else:
        raise ValueError(f"Unbalanced braces for {signature}")
    return source[idx:end]


def normalize(block: str) -> List[str]:
    """Normalize whitespace for a fair diff."""
    dedented = textwrap.dedent(block)
    return [line.lstrip().rstrip() for line in dedented.splitlines()]


def compare_functions(main_src: str, module_src: str, signatures: List[str]) -> bool:
    """Return True if all tracked functions match; otherwise print diffs."""
    all_match = True
    for signature in signatures:
        try:
            main_fn = extract_function(main_src, signature)
        except ValueError as exc:
            print(f"[main] {exc}")
            all_match = False
            continue
        try:
            module_fn = extract_function(module_src, signature)
        except ValueError as exc:
            print(f"[module] {exc}")
            all_match = False
            continue

        main_lines = normalize(main_fn)
        module_lines = normalize(module_fn)
        if main_lines != module_lines:
            all_match = False
            diff = difflib.unified_diff(
                main_lines,
                module_lines,
                fromfile=f"main::{signature}",
                tofile=f"module::{signature}",
                lineterm="",
            )
            print("\n".join(diff))
    return all_match


def main(module_path: Path, baseline_path: Path, signatures: List[str]) -> None:
    main_src = baseline_path.read_text()
    if not module_path.exists():
        print(f"[info] Module file {module_path} does not exist yet.")
        return
    module_src = module_path.read_text()
    if compare_functions(main_src, module_src, signatures):
        print("All tracked functions match.")
    else:
        print("\nDifferences detected.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "module_path",
        nargs="?",
        default=str(DEFAULT_MODULE_PATH),
        help="Path to the module file (default: src/import.js)",
    )
    parser.add_argument(
        "--baseline",
        type=str,
        default=str(MAIN_PATH),
        help="Path to the baseline file to compare against (default: src/main.js)",
    )
    parser.add_argument(
        "--signature",
        action="append",
        dest="signatures",
        help="Function signature to compare. May be repeated. Defaults to import workflow signatures.",
    )
    args = parser.parse_args()
    signatures = args.signatures if args.signatures else FUNCTION_SIGNATURES
    main(Path(args.module_path), Path(args.baseline), signatures)
