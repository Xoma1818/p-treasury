#!/usr/bin/env bash
# Проверка всего проекта одной командой. Запускается после каждого шага.
#   scripts/check.sh          быстрые проверки: формат, линтеры, все тесты, сборка
#   scripts/check.sh --e2e    плюс сквозные тесты на настоящем окне (нужны tauri-driver и WebKitWebDriver)
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }

step "Rust: формат";            cargo fmt --all -- --check
step "Rust: clippy";            cargo clippy --workspace --all-targets --quiet -- -D warnings
step "Rust: тесты ядра";        cargo test --workspace --quiet
step "UI: типы";                npx tsc --noEmit
step "UI: тесты";               npx vitest run
step "UI: сборка";              npx vite build --logLevel warn

if [[ "${1:-}" == "--e2e" ]]; then
  step "Приложение: сборка со встроенным интерфейсом"
  cargo build -p budget-app --features custom-protocol --quiet
  step "Приложение: сквозные тесты"
  if [[ -z "${DISPLAY:-}" ]] && command -v xvfb-run >/dev/null; then
    xvfb-run -a -s "-screen 0 1280x800x24" node --test --test-concurrency=1 "e2e/*.test.mjs"
  else
    node --test --test-concurrency=1 "e2e/*.test.mjs"
  fi
fi

printf '\n\033[1;32m✓ Все проверки пройдены\033[0m\n'
