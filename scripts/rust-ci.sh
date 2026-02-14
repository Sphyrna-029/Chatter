#!/usr/bin/env bash
set -euo pipefail

cargo check --workspace --all-targets --locked
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings -A clippy::uninlined_format_args
cargo test --workspace --all-targets --locked

if [[ -f src/lib.rs ]]; then
  cargo test --doc --locked
else
  echo "Skipping rustdoc tests: no library target found."
fi
