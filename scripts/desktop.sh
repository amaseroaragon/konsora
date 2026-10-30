#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Admite el toolchain local utilizado al preparar este repositorio.
# En otras instalaciones se utiliza el Rust del PATH habitual.
if [[ -x "$repo_root/.tools/cargo/bin/cargo" ]]; then
  export CARGO_HOME="$repo_root/.tools/cargo"
  export RUSTUP_HOME="$repo_root/.tools/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Falta Rust. Consulta los requisitos de Ubuntu en docs/desarrollo.md." >&2
  exit 1
fi

exec npm run tauri --workspace @konsora/desktop -- "$@"
