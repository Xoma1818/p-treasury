# P-Treasury

Десктопное приложение для личного и семейного бюджета: счета, операции в нескольких валютах, бюджет на месяц, отчёты и сравнение периодов, займы и долги с калькулятором, инвестиции (инвест-копилка), календарь, напоминания, заметки, сводка в Excel, курсы ЦБ РФ. Работает на компьютере (основная платформа Windows), данные хранятся локально в одном файле, без облака и регистрации.

Текущая версия: **0.11.0** (что нового в [CHANGELOG.md](CHANGELOG.md)). Установщик для Windows собирается на GitHub; выпуски с автообновлением публикуются в [p-treasury-releases](https://github.com/Xoma1818/p-treasury-releases/releases) (первый выпуск ждёт токена, см. [docs/releasing.md](docs/releasing.md)). Ручная проверка владельцем — по [списку](docs/testing/owner-checklist.md).

## Документация

Каждая тема описана в одном месте.

| Тема | Документ | Что внутри |
|---|---|---|
| Продукт | [docs/product/mvp-features.md](docs/product/mvp-features.md) | Состав MVP, версий 2 и 3, сценарии использования |
| Архитектура | [docs/architecture/architecture.md](docs/architecture/architecture.md) | Стек (Tauri 2, React + TypeScript, SQLite), модули, схема базы, этапы разработки |
| Дизайн | [docs/design/README.md](docs/design/README.md) | Тема «Тёмный графит» (светлая по кнопке), карта экранов, макеты, логотип, [снимки экранов](docs/design/screens/) |
| Разработка | [docs/development.md](docs/development.md) | Как запустить и собрать, структура кода, что сделано по этапам |
| Тестирование | [docs/testing/README.md](docs/testing/README.md) | Как устроены проверки, найденные ошибки, [отчёт итогового теста](docs/testing/final-test-report.md), [ручная проверка](docs/testing/owner-checklist.md) |
| Выпуски | [docs/releasing.md](docs/releasing.md) | Версии, ветки, CHANGELOG, как выходит выпуск с установщиком, правила репозитория |
| Исследование | [docs/research/competitors-and-ideas.md](docs/research/competitors-and-ideas.md) | Похожие приложения и 51 идея с версиями |
| Инвестиции | [docs/research/investments.md](docs/research/investments.md) | Исследование раздела «Инвестиции» и выбранный вариант «Инвест-копилка» |
| История | [docs/history/reviews-2026-10-20.md](docs/history/reviews-2026-10-20.md) | Ревизия и сверка документов перед разработкой (архив) |

## Быстрый старт

```bash
npm install
npm run tauri dev    # окно приложения
npm run check        # все проверки
```

Подробности и установщик для Windows: [docs/development.md](docs/development.md).
