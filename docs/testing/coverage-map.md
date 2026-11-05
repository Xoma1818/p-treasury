# Карта покрытия функций

Составлена 04.11.2026 (тред 31) на ветке PR #66 (0.30.0 + правки проверки). Карта отвечает на вопрос: какие действия есть в каждом разделе и чем каждое проверено.

## Как читать

- **Действие** — команда ядра, которую вызывает кнопка или форма раздела. Раздел включает свои вложенные компоненты, поэтому одна команда может стоять в нескольких разделах. «Общее» — меню, общие формы, быстрый ввод, то, что не принадлежит одному разделу.
- **Тесты ядра** — модули `crates/core`, которые команда вызывает, и число тестов в модуле (`#[test]`, плюс 1, если модуль используется в `crates/core/tests`). Это значит «логика под командой покрыта тестами», а не «проверен каждый вариант».
- **Сквозной тест** — «да», если в прогоне всех сквозных тестов (`e2e/*.test.mjs`, настоящее окно Tauri) команду вызвали хотя бы раз: замер треда 29 по журналу вызовов плюс тесты, добавленные после. «нет» — вызова не было ни разу.
- Таблица собрана скриптом из исходников (`src/lib/api.ts`, импорты экранов, `#[tauri::command]`). Пояснения в столбце «Что делает» взяты из комментариев к командам; где их нет — прочерк.

## Итог

- Команд за кнопками интерфейса: 225.
- Без проверки ни ядром, ни сквозным тестом: одна, `changelog` (окно «Что нового» читает встроенный текст, расчётов нет).
- Ожидаемый результат и обработка ошибок по разделам описаны в `docs/testing/functions-check-2026-11.md` (тред 29) — там же, как проверено вручную.

## Сквозные цепочки «создать → итог → изменить → связанные экраны → отменить → удалить → перезапустить»

| Сущность | Тест | Что сверяется |
|---|---|---|
| Операция | `e2e/chain.test.mjs` | остаток счёта, расход месяца на Главной, расход в отчёте; Ctrl+Z правки и удаления; состояние после перезапуска |
| Чек с возвратом, тема после восстановления, долг по правой кнопке | `e2e/edits.test.mjs` | см. Р1–Р3 в `reliability-2026.md` |
| Перенос через выгрузку CSV/Excel/OFX | `crates/core/tests/export_roundtrip.rs` | доходы, расходы, категории, остатки; повторная загрузка ничего не меняет |

Цепочки для остальных сущностей (счёт, бюджет, напоминание, долг, цель) пока проверены по частям: создание, правка и удаление — в сквозных тестах разделов, отмена и перезапуск — не для каждой.

## Не проверено в облаке

Настоящее окно Windows, системные уведомления, установка обновления, диалоги выбора файла, глобальные клавиши, настоящие выписки банков OTTO. Это проверяется одним прогоном Windows на итоговом коммите и чек-листом `owner-checklist.md`.

## По разделам

### Главная

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `apply_template` | — | templates (4) | да |
| `calendar_month` | — | calendar (3), time (1) | да |
| `changelog` | — | — | нет |
| `check_update` | — | — | да |
| `close_month` | — | month_review (1), time (1) | да |
| `compare_periods` | — | compare (4) | да |
| `complete_reminder` | — | reminders (20) | да |
| `create_goal` | — | goals (3) | да |
| `create_reminder` | — | reminders (20) | да |
| `create_transaction_full` | Новая операция вместе с «Учитывать по месяцам» и тегами (одна отмена). | events (2), transactions (13) | да |
| `create_view` | — | views (1) | да |
| `delete_goal` | — | goals (3) | да |
| `delete_receipt` | — | receipts (5) | нет |
| `delete_reminder` | — | reminders (20) | да |
| `delete_tag` | — | tags (2) | да |
| `delete_transaction` | — | transactions (13) | да |
| `edit_reminder_occurrence` | Один платёж серии: своя сумма и (или) перенос. | reminders (20) | да |
| `explain_balance` | Из чего сложился общий баланс. | explain (2) | да |
| `explain_period` | Доходы или расходы периода по категориям и что не вошло. | explain (2) | да |
| `export_comparison` | — | export (8) | да |
| `export_report` | — | export (8) | да |
| `export_summary` | — | export (8), time (1) | да |
| `forecast` | «Взгляд вперёд»: прогноз на 12 месяцев, со сценарием — и его линия. | forecast (19), month_review (1), time (1) | да |
| `get_reminder` | — | reminders (20), time (1) | да |
| `goal_deposit` | — | goals (3) | да |
| `hide_subscription` | — | subscriptions (2) | да |
| `import_csv` | — | csv_import (9) | да |
| `import_preview` | — | csv_import (9) | да |
| `install_update` | Скачать и поставить обновление | time (1) | нет |
| `invest_month` | — | invest (5) | да |
| `list_transactions` | — | transactions (13) | да |
| `list_views` | — | views (1) | да |
| `merge_tags` | — | tags (2) | да |
| `month_review` | — | month_review (1), time (1) | да |
| `net_worth_history` | Чистые активы по месяцам: `months` последних месяцев или всё время (`None`). | net_worth (2), time (1) | да |
| `period_summary` | — | reports (7) | да |
| `remember_rule` | — | quick (3) | да |
| `rename_tag` | — | tags (2) | да |
| `reopen_month` | — | month_review (1), vault (12) | да |
| `reopen_reminder` | — | reminders (20) | да |
| `report_balances` | — | reports (7) | да |
| `report_by_category` | — | reports (7) | да |
| `report_by_month` | — | reports (7) | да |
| `report_by_tag` | — | tags (2) | да |
| `report_fx` | — | wealth (3) | да |
| `report_period` | — | reports (7) | да |
| `save_bytes` | Сохранить готовый файл, собранный в окне (картинка «Итоги года»). | — | да |
| `set_setting` | — | settings (4) | да |
| `snooze_reminder` | — | reminders (20) | да |
| `spending_vs_usual` | Сравнение с обычным: месяц `month` (текущий — по сегодня). | time (1), usual (3) | да |
| `split_reminder` | «Этот и все следующие»: с платежа `key` серия идёт по `input`. | reminders (20) | нет |
| `template_used` | — | templates (4) | да |
| `totals` | — | accounts (7) | да |
| `update_goal` | — | goals (3) | да |
| `update_reminder` | — | reminders (20) | да |
| `write_import_template` | — | csv_import (9) | да |
| `year_review` | — | time (1), year (2) | да |

### Операции

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `bulk_delete` | — | bulk (3) | да |
| `bulk_set_account` | — | bulk (3) | да |
| `bulk_set_category` | — | bulk (3) | да |
| `bulk_set_payee` | — | bulk (3) | да |
| `bulk_tag` | — | bulk (3) | да |
| `changelog` | — | — | нет |
| `check_update` | — | — | да |
| `create_view` | — | views (1) | да |
| `delete_receipt` | — | receipts (5) | нет |
| `delete_transaction` | — | transactions (13) | да |
| `export_summary` | — | export (8), time (1) | да |
| `export_transactions` | — | export (8), ofx (5), time (1) | да |
| `import_csv` | — | csv_import (9) | да |
| `import_preview` | — | csv_import (9) | да |
| `install_update` | Скачать и поставить обновление | time (1) | нет |
| `list_transactions` | — | transactions (13) | да |
| `list_views` | — | views (1) | да |
| `sum_filtered` | — | transactions (13) | да |
| `sum_selected` | — | transactions (13) | да |
| `write_import_template` | — | csv_import (9) | да |

### Календарь

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `calendar_month` | — | calendar (3), time (1) | да |
| `calendar_range` | — | calendar (3), time (1) | да |
| `complete_reminder` | — | reminders (20) | да |
| `create_note` | — | notes (6) | да |
| `create_reminder` | — | reminders (20) | да |
| `delete_note` | — | notes (6) | да |
| `delete_receipt` | — | receipts (5) | нет |
| `delete_reminder` | — | reminders (20) | да |
| `delete_transaction` | — | transactions (13) | да |
| `edit_reminder_occurrence` | Один платёж серии: своя сумма и (или) перенос. | reminders (20) | да |
| `forecast` | «Взгляд вперёд»: прогноз на 12 месяцев, со сценарием — и его линия. | forecast (19), month_review (1), time (1) | да |
| `get_reminder` | — | reminders (20), time (1) | да |
| `list_notes` | — | notes (6) | да |
| `list_transactions` | — | transactions (13) | да |
| `reopen_reminder` | — | reminders (20) | да |
| `set_reminder_active` | — | reminders (20) | да |
| `snooze_reminder` | — | reminders (20) | да |
| `split_reminder` | «Этот и все следующие»: с платежа `key` серия идёт по `input`. | reminders (20) | нет |
| `update_note` | — | notes (6) | да |
| `update_reminder` | — | reminders (20) | да |

### Бюджет

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `assign_event` | Отнести операции к событию; без `event_id` — снять отметку. | events (2) | да |
| `close_month` | — | month_review (1), time (1) | да |
| `complete_reminder` | — | reminders (20) | да |
| `create_budget` | — | budgets (11) | да |
| `create_event` | — | events (2) | да |
| `create_reminder` | — | reminders (20) | да |
| `delete_budget` | — | budgets (11) | да |
| `delete_event` | — | events (2) | да |
| `delete_reminder` | — | reminders (20) | да |
| `edit_reminder_occurrence` | Один платёж серии: своя сумма и (или) перенос. | reminders (20) | да |
| `event_candidates` | — | events (2) | да |
| `fill_budget` | Заполнить лимиты по истории; возвращает число заданных лимитов. | budgets (11) | да |
| `get_reminder` | — | reminders (20), time (1) | да |
| `invest_month` | — | invest (5) | да |
| `month_review` | — | month_review (1), time (1) | да |
| `reopen_month` | — | month_review (1), vault (12) | да |
| `reopen_reminder` | — | reminders (20) | да |
| `set_budget_limit` | — | budgets (11) | да |
| `set_budget_note` | — | budgets (11) | да |
| `snooze_reminder` | — | reminders (20) | да |
| `spending_vs_usual` | Сравнение с обычным: месяц `month` (текущий — по сегодня). | time (1), usual (3) | да |
| `split_reminder` | «Этот и все следующие»: с платежа `key` серия идёт по `input`. | reminders (20) | нет |
| `update_event` | — | events (2) | да |
| `update_reminder` | — | reminders (20) | да |

### Отчёты

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `calendar_month` | — | calendar (3), time (1) | да |
| `changelog` | — | — | нет |
| `check_update` | — | — | да |
| `compare_periods` | — | compare (4) | да |
| `create_view` | — | views (1) | да |
| `delete_tag` | — | tags (2) | да |
| `export_comparison` | — | export (8) | да |
| `export_report` | — | export (8) | да |
| `export_summary` | — | export (8), time (1) | да |
| `hide_subscription` | — | subscriptions (2) | да |
| `import_csv` | — | csv_import (9) | да |
| `import_preview` | — | csv_import (9) | да |
| `install_update` | Скачать и поставить обновление | time (1) | нет |
| `list_views` | — | views (1) | да |
| `merge_tags` | — | tags (2) | да |
| `net_worth_history` | Чистые активы по месяцам: `months` последних месяцев или всё время (`None`). | net_worth (2), time (1) | да |
| `period_summary` | — | reports (7) | да |
| `rename_tag` | — | tags (2) | да |
| `report_balances` | — | reports (7) | да |
| `report_by_category` | — | reports (7) | да |
| `report_by_month` | — | reports (7) | да |
| `report_by_tag` | — | tags (2) | да |
| `report_fx` | — | wealth (3) | да |
| `report_period` | — | reports (7) | да |
| `save_bytes` | Сохранить готовый файл, собранный в окне (картинка «Итоги года»). | — | да |
| `write_import_template` | — | csv_import (9) | да |
| `year_review` | — | time (1), year (2) | да |

### Взгляд вперёд

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `create_scenario` | — | forecast (19) | да |
| `delete_scenario` | — | forecast (19) | да |
| `forecast` | «Взгляд вперёд»: прогноз на 12 месяцев, со сценарием — и его линия. | forecast (19), month_review (1), time (1) | да |
| `money_flow` | Поток денег за месяц или год (`kind` = `month` | `year`). | forecast (19) | да |
| `update_scenario` | — | forecast (19) | да |

### Счета

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `create_account` | — | accounts (7) | да |
| `create_asset` | — | assets (2) | да |
| `delete_asset` | — | assets (2) | да |
| `invest_month` | — | invest (5) | да |
| `update_account` | — | accounts (7) | да |
| `update_asset` | — | assets (2) | да |

### Займы и долги

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `add_debt_holiday` | — | debts (20) | да |
| `add_debt_rate_change` | — | debts (20) | да |
| `calc_schedule_doc` | — | loan_export (3), time (1) | да |
| `complete_reminder` | — | reminders (20) | да |
| `create_debt` | — | debts (20) | да |
| `create_note` | — | notes (6) | да |
| `create_reminder` | — | reminders (20) | да |
| `debt_forecast` | — | debts (20), time (1) | да |
| `debt_schedule_doc` | — | debts (20), time (1) | да |
| `debt_versions` | — | debts (20) | да |
| `delete_debt` | — | debts (20) | да |
| `delete_debt_holiday` | — | debts (20) | да |
| `delete_debt_payment` | — | debts (20) | да |
| `delete_debt_rate_change` | — | debts (20) | да |
| `delete_debt_row_amount` | — | debts (20) | да |
| `delete_note` | — | notes (6) | да |
| `delete_reminder` | — | reminders (20) | да |
| `edit_reminder_occurrence` | Один платёж серии: своя сумма и (или) перенос. | reminders (20) | да |
| `export_schedule_pdf` | — | loan_export (3) | да |
| `export_schedule_xlsx` | — | loan_export (3) | да |
| `get_debt` | — | debts (20), time (1) | да |
| `get_reminder` | — | reminders (20), time (1) | да |
| `list_notes` | — | notes (6) | да |
| `pay_debt` | — | debts (20) | да |
| `plan_loan` | — | loan_calc (30) | да |
| `preview_debt_change` | — | debts (20), time (1) | да |
| `preview_debt_terms` | — | debts (20) | да |
| `quote_debt_payment` | — | debts (20) | да |
| `reopen_reminder` | — | reminders (20) | да |
| `set_debt_planned_early` | — | debts (20) | да |
| `set_debt_row_amount` | — | debts (20) | да |
| `set_setting` | — | settings (4) | да |
| `snooze_reminder` | — | reminders (20) | да |
| `split_reminder` | «Этот и все следующие»: с платежа `key` серия идёт по `input`. | reminders (20) | нет |
| `update_debt_info` | — | debts (20) | да |
| `update_debt_terms` | — | debts (20) | да |
| `update_note` | — | notes (6) | да |
| `update_reminder` | — | reminders (20) | да |

### Категории

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `category_rename_apply` | Переименовать выбранные категории по новому списку; одним шагом отмены (Ctrl+Z). | categories (8) | нет |
| `create_category` | — | categories (8) | да |
| `create_rule` | — | rules (2) | да |
| `delete_category` | — | categories (8) | да |
| `delete_tag` | — | tags (2) | да |
| `merge_tags` | — | tags (2) | да |
| `rename_tag` | — | tags (2) | да |
| `report_by_tag` | — | tags (2) | да |
| `update_category` | — | categories (8) | да |

### Заметки

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `complete_reminder` | — | reminders (20) | да |
| `create_note` | — | notes (6) | да |
| `create_reminder` | — | reminders (20) | да |
| `delete_note` | — | notes (6) | да |
| `delete_reminder` | — | reminders (20) | да |
| `edit_reminder_occurrence` | Один платёж серии: своя сумма и (или) перенос. | reminders (20) | да |
| `get_reminder` | — | reminders (20), time (1) | да |
| `list_notes` | — | notes (6) | да |
| `reopen_reminder` | — | reminders (20) | да |
| `snooze_reminder` | — | reminders (20) | да |
| `split_reminder` | «Этот и все следующие»: с платежа `key` серия идёт по `input`. | reminders (20) | нет |
| `update_note` | — | notes (6) | да |
| `update_reminder` | — | reminders (20) | да |

### Настройки

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `backup_now` | — | backups (7) | да |
| `changelog` | — | — | нет |
| `check_update` | — | — | да |
| `complete_reminder` | — | reminders (20) | да |
| `create_file` | — | — | да |
| `create_reminder` | — | reminders (20) | да |
| `delete_reminder` | — | reminders (20) | да |
| `edit_reminder_occurrence` | Один платёж серии: своя сумма и (или) перенос. | reminders (20) | да |
| `export_summary` | — | export (8), time (1) | да |
| `forget_file` | — | — | да |
| `get_reminder` | — | reminders (20), time (1) | да |
| `import_csv` | — | csv_import (9) | да |
| `import_preview` | — | csv_import (9) | да |
| `install_update` | Скачать и поставить обновление | time (1) | нет |
| `open_file` | — | — | да |
| `open_folder` | Открыть папку в Проводнике. | money (6), vault (12) | нет |
| `rename_file` | — | — | да |
| `reopen_reminder` | — | reminders (20) | да |
| `restore_backup` | Восстановить из копии; возвращает путь к копии прежних данных. | — | да |
| `set_setting` | — | settings (4) | да |
| `set_vault_dir` | Сменить папку: `None` — вернуть папку по умолчанию | settings (4), vault (12) | да |
| `snooze_reminder` | — | reminders (20) | да |
| `split_reminder` | «Этот и все следующие»: с платежа `key` серия идёт по `input`. | reminders (20) | нет |
| `switch_file` | — | — | да |
| `update_reminder` | — | reminders (20) | да |
| `vault_inspect` | — | vault (12) | да |
| `vault_scan` | Где искать данные с другого компьютера: показанные папки или все известные места. | vault (12) | да |
| `vault_transfer` | Перенести данные из найденной копии или «Всех данных» | settings (4), vault (12) | да |
| `verify_backup` | Проверить восстановление: свежая копия в папке сохранности (`path` пусто) или выбранный фа | backups (7), vault (12) | да |
| `write_import_template` | — | csv_import (9) | да |

### Первый запуск

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `backup_now` | — | backups (7) | да |
| `open_folder` | Открыть папку в Проводнике. | money (6), vault (12) | нет |
| `restore_backup` | Восстановить из копии; возвращает путь к копии прежних данных. | — | да |
| `set_vault_dir` | Сменить папку: `None` — вернуть папку по умолчанию | settings (4), vault (12) | да |
| `vault_inspect` | — | vault (12) | да |
| `vault_scan` | Где искать данные с другого компьютера: показанные папки или все известные места. | vault (12) | да |
| `vault_transfer` | Перенести данные из найденной копии или «Всех данных» | settings (4), vault (12) | да |
| `verify_backup` | Проверить восстановление: свежая копия в папке сохранности (`path` пусто) или выбранный фа | backups (7), vault (12) | да |

### Общее (меню, формы, быстрый ввод)

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `assign_event` | Отнести операции к событию; без `event_id` — снять отметку. | events (2) | да |
| `create_receipt` | — | receipts (5) | да |
| `create_refund` | — | refunds (3) | да |
| `create_template` | — | templates (4) | да |
| `create_transaction_full` | Новая операция вместе с «Учитывать по месяцам» и тегами (одна отмена). | events (2), transactions (13) | да |
| `delete_receipt` | — | receipts (5) | нет |
| `delete_transaction` | — | transactions (13) | да |
| `events_on` | — | events (2) | да |
| `get_receipt` | — | receipts (5) | да |
| `global_search` | — | search (2) | да |
| `list_transactions` | — | transactions (13) | да |
| `list_views` | — | views (1) | да |
| `payee_hints` | — | transactions (13) | да |
| `redo` | — | — | да |
| `refund_info` | — | refunds (3) | да |
| `split_expense` | — | split (2) | да |
| `template_used` | — | templates (4) | да |
| `transaction_defaults` | — | transactions (13) | да |
| `undo` | Отменить последнее действие; возвращает его название (или ничего, если отменять нечего). | — | да |
| `update_receipt` | — | receipts (5) | да |
| `update_refund` | — | refunds (3) | да |
| `update_transaction_full` | — | transactions (13) | да |

### Данные для нескольких экранов (списки, справочники, фон)

| Действие (команда) | Что делает | Тесты ядра | Сквозной тест |
|---|---|---|---|
| `adjust_balance` | — | accounts (7) | да |
| `app_info` | — | onboarding (2), time (1) | да |
| `archive_account` | — | accounts (7) | да |
| `archive_category` | — | categories (8) | да |
| `auto_cbr_rates` | Курсы ЦБ раз в день сами: при запуске и пока программа открыта | cbr (10) | да |
| `auto_import_dir` | Папка автоимпорта: выбранная в Настройках или «Загрузки». | — | да |
| `auto_import_now` | Проверить папку сейчас (кнопка в Настройках). | auto_import (2) | да |
| `backup_status` | — | backups (7), settings (4), time (1) | да |
| `budget_warnings` | Предупреждения бюджета, которые сейчас в силе: с причиной и периодом. | budget_alerts (3), time (1) | да |
| `calc_loan` | — | loan_calc (30) | нет |
| `category_rename_preview` | Категории с прежними названиями набора по умолчанию (до 0.28) и их новые имена. | categories (8) | да |
| `clear_demo` | Удалить пример и вернуться к мастеру первого запуска | demo (4) | да |
| `clear_invest_month_plan` | — | invest (5) | нет |
| `compare_loans` | — | loan_calc (30) | нет |
| `create_transaction` | — | events (2), transactions (13) | да |
| `cushion` | — | time (1), wealth (3) | да |
| `debt_summary` | — | debts (20), time (1) | да |
| `delete_duplicate` | «Удалить второй» у дубля; отменяется Ctrl+Z. | checks (7) | да |
| `delete_invest_value` | — | invest (5) | да |
| `delete_rate` | — | currencies (4) | да |
| `delete_rule` | — | rules (2) | да |
| `delete_template` | — | templates (4) | да |
| `delete_view` | — | views (1) | да |
| `dismiss_check` | — | checks (7) | да |
| `dismiss_reminder` | — | reminders (20) | нет |
| `finish_onboarding` | — | onboarding (2) | да |
| `forecast_accounts` | Счета, которые входят в прогноз (по умолчанию все быстрые «в общем балансе»). | forecast (19) | да |
| `free_until_income` | «Свободно до дохода» на сегодня (0.27). | free_money (3), time (1) | да |
| `get_budget` | — | budgets (11), time (1) | да |
| `get_settings` | — | settings (4) | да |
| `hide_quick` | Операция записана в окне быстрого ввода: окно прячется, главное обновляет данные. | — | да |
| `import_accept` | — | import_log (13) | да |
| `import_history` | — | import_log (13) | да |
| `import_reject` | — | import_log (13) | нет |
| `import_suggestions` | — | import_log (13) | да |
| `import_undo` | Отменить импорт целиком (Ctrl+Z возвращает его). | import_log (13) | да |
| `inspect_backup` | — | backups (7) | нет |
| `invest_overview` | — | invest (5), time (1) | да |
| `last_week` | — | habits (1), time (1) | да |
| `list_accounts` | — | accounts (7) | да |
| `list_assets` | — | assets (2) | да |
| `list_categories` | — | categories (8) | да |
| `list_checks` | Карточка «Проверьте» за последние 30 дней. | checks (7), time (1) | да |
| `list_currencies` | — | currencies (4) | да |
| `list_debts` | — | debts (20), time (1) | да |
| `list_events` | — | events (2), time (1) | да |
| `list_files` | — | — | да |
| `list_goals` | — | goals (3), time (1) | да |
| `list_rates` | — | currencies (4) | да |
| `list_rules` | — | rules (2) | да |
| `list_scenarios` | — | forecast (19) | да |
| `list_subscriptions` | — | subscriptions (2), time (1) | да |
| `list_tags` | — | tags (2) | да |
| `list_templates` | — | templates (4) | да |
| `load_cbr_rates` | Загрузить официальные курсы ЦБ РФ на дату и записать их к основной валюте | cbr (10) | да |
| `missed_reminders` | Наступившие и не выполненные: окно «Пропущенные напоминания» при запуске. | reminders (20), time (1) | да |
| `month_of` | — | budgets (11) | да |
| `move_transaction` | — | transactions (13) | да |
| `no_spend_streak` | — | habits (1), time (1) | да |
| `open_quick` | — | — | да |
| `pay_reminder` | — | reminders (20), time (1) | нет |
| `quick_parse` | — | quick (3), time (1) | да |
| `rate_on` | — | currencies (4) | нет |
| `reminders_overview` | — | reminders (20), time (1) | да |
| `seed_demo` | «Посмотреть на примере»: заполнить пустую базу пробными данными. | demo (4), time (1) | да |
| `set_forecast_excluded` | — | forecast (19) | да |
| `set_invest_plan` | План на инвестиции: общий на каждый месяц или, с `month`, только на этот месяц. | invest (5) | нет |
| `set_invest_value` | — | invest (5) | нет |
| `set_quick_hotkey` | — | settings (4) | да |
| `set_rate` | — | currencies (4) | да |
| `set_transaction_spread` | — | transactions (13) | нет |
| `set_transaction_tags` | — | tags (2) | нет |
| `suggested_month_review` | — | month_review (1), time (1) | да |
| `undo_state` | — | — | да |
| `update_transaction` | — | transactions (13) | нет |
| `vault_places` | — | — | да |
| `vault_status` | — | — | да |
| `vault_sync` | Обновить папку сейчас (кнопка «Сохранить сейчас»). | — | да |
