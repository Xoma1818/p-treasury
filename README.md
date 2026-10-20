# Казна — десктопное приложение для личного и семейного бюджета

Стек и устройство описаны в [architecture.md](../architecture/architecture.md), состав функций в [mvp-features.md](../product/mvp-features.md), дизайн в [design/README.md](../design/README.md).

## Состояние

**Этап 0 (каркас) готов:**

- Rust-ядро `crates/core` без зависимостей от UI: SQLite (`rusqlite`, встроенный SQLite с FTS5), режим WAL, внешние ключи.
- Первая миграция `crates/core/migrations/0001_init.sql`: вся схема из раздела 4 архитектуры, включая таблицы версии 2, на которые есть ссылки (`recurring_rules`, `tags`), справочник валют и настройки по умолчанию.
- Миграции: версия в `PRAGMA user_version`, каждая миграция в своей транзакции, копия файла перед обновлением (хранятся последние 10), файл от более новой версии не открывается.
- Деньги: целые минимальные единицы, разбор ввода и формат «1 234,56» (`money.rs` и `src/lib/money.ts` дают одинаковый результат).
- Оболочка Tauri 2 `src-tauri` и интерфейс React + TypeScript: боковое меню в стиле A, пустые разделы, Ctrl+1…9, «Настройки → О программе» с версией приложения и данных.

**Дальше:** этап 1 (счета, валюты и курсы, категории, операции, Главная).

## Как запустить

Нужны Node.js 22+, Rust 1.80+ и [системные зависимости Tauri](https://tauri.app/start/prerequisites/) (на Windows: WebView2 и Microsoft C++ Build Tools).

```bash
npm install
npm run tauri dev      # окно приложения с горячей перезагрузкой
npm run tauri build    # установщик для текущей ОС
```

Проверки (подробно в [TESTING.md](TESTING.md)):

```bash
npm run check        # формат, линтеры, все тесты ядра и UI, сборка
npm run check:e2e    # плюс сквозные тесты на настоящем окне (нужны tauri-driver и WebKitWebDriver)
```

Данные лежат в папке данных ОС: `%APPDATA%\app.kazna.desktop\budget.db` на Windows, `~/Library/Application Support/app.kazna.desktop/` на macOS, `~/.local/share/app.kazna.desktop/` на Linux. Копии перед обновлением: подпапка `backups`.

## Структура

```
crates/core/          ядро на Rust (вся логика и SQL)
  migrations/         нумерованные SQL-миграции
  src/storage/        открытие базы, миграции, резервные копии
  tests/              тесты ядра на настоящем файле SQLite
src-tauri/            окно Tauri и команды для UI (без SQL)
src/                  интерфейс React + TypeScript
e2e/                  сквозные тесты на настоящем окне (WebDriver)
scripts/check.sh      проверка всего проекта одной командой
```

Правило границ: UI вызывает только команды ядра, ядро обращается к базе только через `storage`.

Название «Казна» и иконка взяты из треда дизайна (`design/icons/kazna/`).
