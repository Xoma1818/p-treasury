//! Фоновая часть: планировщик напоминаний, системные уведомления и значок в трее.
//! Уведомления приходят, пока приложение запущено (в том числе свёрнуто в трей).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use budget_core::reminders::{self, Occurrence};
use budget_core::{auto_import, budget_alerts, habits, money, settings, subscriptions, time};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

use crate::AppState;

/// Как часто проверять напоминания.
const TICK: Duration = Duration::from_secs(20);
/// Больше стольких уведомлений сразу не показываем: вместо них одно общее.
const MAX_SEPARATE: usize = 3;

/// Папку автоимпорта проверяем раз в столько тиков (≈ 5 минут).
const IMPORT_EVERY: u32 = 15;
static TICKS: AtomicU32 = AtomicU32::new(0);

/// Значок в трее создан: только тогда закрытие окна сворачивает его.
static TRAY_READY: AtomicBool = AtomicBool::new(false);

pub fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || loop {
        tick(&app);
        std::thread::sleep(TICK);
    });
}

fn text(o: &Occurrence) -> String {
    match o.amount {
        Some(a) => format!(
            "{}: {} {}",
            o.title,
            money::format_amount(a, o.minor_units, true),
            o.currency_symbol
        ),
        None => o.title.clone(),
    }
}

fn tick(app: &AppHandle) {
    weekly(app);
    budget_limits(app);
    // Тяжёлые дела — со второго тика (≈ 20 с после запуска), когда окно уже
    // загрузило первый экран, и дальше раз в IMPORT_EVERY тиков.
    if TICKS.fetch_add(1, Ordering::Relaxed) % IMPORT_EVERY == 1 {
        scan_folder(app);
        upcoming_payments(app);
        // Папка сохранности раз в день (первый раз — через 20 с после запуска).
        crate::vault::sync(&app.state::<AppState>(), true);
    }
    let state = app.state::<AppState>();
    let due = {
        let mut guard = state.lock_db();
        let Ok(db) = guard.as_mut() else { return };
        let Ok(due) = reminders::due_unnotified(db.conn(), time::now_local()) else {
            return;
        };
        if due.is_empty() {
            return;
        }
        let keys: Vec<_> = due.iter().map(|o| o.key.clone()).collect();
        if reminders::mark_notified(db.conn(), &keys, &time::now_utc()).is_err() {
            return;
        }
        due
    };
    let show = |body: String| {
        // Без службы уведомлений (например, в тестах) просто ничего не показываем.
        let _ = app
            .notification()
            .builder()
            .title("P-Treasury")
            .body(body)
            .show();
    };
    if due.len() <= MAX_SEPARATE {
        due.iter().for_each(|o| show(text(o)));
    } else {
        show(format!(
            "Напоминаний: {}. {} и другие",
            due.len(),
            text(&due[0])
        ));
    }
    let _ = app.emit("reminders-due", due.len());
}

/// Итог прошлой недели — одним уведомлением в понедельник (или при первом запуске после).
fn weekly(app: &AppHandle) {
    let state = app.state::<AppState>();
    let summary = {
        let mut guard = state.lock_db();
        let Ok(db) = guard.as_mut() else { return };
        match habits::weekly_due(db.conn(), time::now_local()) {
            Ok(Some(s)) => s,
            _ => return,
        }
    };
    let _ = app
        .notification()
        .builder()
        .title("P-Treasury")
        .body(habits::weekly_text(&summary))
        .show();
}

/// Расход перевёл категорию бюджета через 80 % или 100 % лимита — по
/// уведомлению на каждый новый порог (отметки в базе, без повторов).
fn budget_limits(app: &AppHandle) {
    let state = app.state::<AppState>();
    let today = time::now_local().date().to_string();
    let alerts = {
        let guard = state.lock_db();
        let Ok(db) = guard.as_ref() else { return };
        match budget_alerts::pending(db.conn(), &today) {
            Ok(a) if !a.is_empty() => a,
            _ => return,
        }
    };
    for a in &alerts {
        let _ = app
            .notification()
            .builder()
            .title("P-Treasury")
            .body(budget_alerts::notify_text(a))
            .show();
    }
    let _ = app.emit("budget-alerts", alerts.len());
}

/// Накануне регулярного платежа (подписка, связь) — одно уведомление.
fn upcoming_payments(app: &AppHandle) {
    let state = app.state::<AppState>();
    let today = time::now_local().date().to_string();
    let body = {
        let guard = state.lock_db();
        let Ok(db) = guard.as_ref() else { return };
        match subscriptions::due_unnotified(db.conn(), &today) {
            Ok(due) if !due.is_empty() => subscriptions::reminder_text(&due, &today),
            _ => return,
        }
    };
    let _ = app
        .notification()
        .builder()
        .title("P-Treasury")
        .body(body)
        .show();
}

/// Папка автоимпорта: выбранная в Настройках или «Загрузки».
pub fn import_dir(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<AppState>();
    let chosen = state
        .lock_db()
        .as_ref()
        .ok()
        .and_then(|db| settings::get(db.conn(), "auto_import_dir").ok().flatten())
        .filter(|d| !d.trim().is_empty());
    chosen
        .map(PathBuf::from)
        .or_else(|| app.path().download_dir().ok())
}

/// Новые CSV по шаблону в папке автоимпорта — сразу в операции, с уведомлением.
fn scan_folder(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (on, origin) = {
        let guard = state.lock_db();
        let Ok(db) = guard.as_ref() else { return };
        let on = settings::get(db.conn(), "auto_import")
            .ok()
            .flatten()
            .as_deref()
            == Some("1");
        (on, db.path().to_path_buf())
    };
    let Some(dir) = on.then(|| import_dir(app)).flatten() else {
        return;
    };
    let result = {
        let mut guard = state.lock_db();
        let Ok(db) = guard.as_mut() else { return };
        // Между замками могли открыть другой бюджет: в нём автоимпорт и папка свои.
        if db.path() != origin {
            return;
        }
        match auto_import::scan(db.conn_mut(), &dir) {
            Ok(r) if !r.files.is_empty() => r,
            _ => return,
        }
    };
    let errors = result.files.iter().filter(|f| f.error.is_some()).count();
    let mut body = format!("Импорт из папки: добавлено операций — {}", result.added);
    let linked: usize = result.files.iter().map(|f| f.linked).sum();
    let suggested: usize = result.files.iter().map(|f| f.suggested).sum();
    if linked > 0 {
        body.push_str(&format!(", связано с вашими записями — {linked}"));
    }
    if suggested > 0 {
        body.push_str(&format!(", проверьте совпадения — {suggested}"));
    }
    if errors > 0 {
        body.push_str(&format!(", файлов с ошибкой — {errors}"));
    }
    let _ = app
        .notification()
        .builder()
        .title("P-Treasury")
        .body(body)
        .show();
    let _ = app.emit("auto-import", &result);
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
    let add = MenuItem::with_id(app, "add", "Добавить операцию", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "Быстрый ввод", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &add, &quick, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("P-Treasury")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => show_main(app),
            "add" => {
                show_main(app);
                let _ = app.emit("tray-add-transaction", ());
            }
            "quick" => {
                let _ = crate::quick_window::open(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    TRAY_READY.store(true, Ordering::SeqCst);
    Ok(())
}

/// Закрыть окно или свернуть в трей — по настройке «сворачивать в трей при закрытии».
pub fn hide_instead_of_close(window: &WebviewWindow) -> bool {
    if !TRAY_READY.load(Ordering::SeqCst) {
        return false;
    }
    let state = window.state::<AppState>();
    let guard = state.lock_db();
    let Ok(db) = guard.as_ref() else { return false };
    matches!(settings::get(db.conn(), "close_to_tray"), Ok(Some(v)) if v == "1")
}
