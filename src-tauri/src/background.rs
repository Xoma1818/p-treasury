//! Фоновая часть: планировщик напоминаний, системные уведомления и значок в трее.
//! Уведомления приходят, пока приложение запущено (в том числе свёрнуто в трей).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use budget_core::reminders::{self, Occurrence};
use budget_core::{money, settings, time};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

use crate::AppState;

/// Как часто проверять напоминания.
const TICK: Duration = Duration::from_secs(20);
/// Больше стольких уведомлений сразу не показываем: вместо них одно общее.
const MAX_SEPARATE: usize = 3;

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
    let state = app.state::<AppState>();
    let due = {
        let Ok(mut guard) = state.db.lock() else {
            return;
        };
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
            .title("Казна")
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
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &add, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Казна")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => show_main(app),
            "add" => {
                show_main(app);
                let _ = app.emit("tray-add-transaction", ());
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
    let Ok(guard) = state.db.lock() else {
        return false;
    };
    let Ok(db) = guard.as_ref() else { return false };
    matches!(settings::get(db.conn(), "close_to_tray"), Ok(Some(v)) if v == "1")
}
