#!/usr/bin/env bash
set -euo pipefail

if ! command -v cargo-deny >/dev/null 2>&1; then
  echo "cargo-deny is required. Install with: cargo install cargo-deny --locked" >&2
  exit 1
fi

if ! command -v cargo-audit >/dev/null 2>&1; then
  echo "cargo-audit is required. Install with: cargo install cargo-audit --locked" >&2
  exit 1
fi

cargo deny check advisories bans licenses sources
cargo audit --ignore RUSTSEC-2025-0141
