//! Маленькое окно быстрого ввода: открывается сочетанием клавиш из любой
//! программы (по умолчанию Ctrl+Alt+P) или из меню значка в трее.

use budget_core::settings;
use std::sync::{atomic::Ordering, Mutex, PoisonError};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::AppState;

// Создание WebView2 и скрытие/уничтожение окна выполняются в рабочем потоке,
// последовательно со сменой бюджета. При обращении к окну SQLite не заблокирована.
static LIFECYCLE: Mutex<()> = Mutex::new(());

pub fn is_quick(label: &str) -> bool {
    label == "quick" || label.starts_with("quick-")
}

fn current_label(state: &AppState) -> String {
    match state.budget_generation.load(Ordering::SeqCst) {
        0 => "quick".into(),
        revision => format!("quick-{revision}"),
    }
}

/// Вызывается под замком базы: отложенная запись старого окна не попадёт в новый файл.
pub fn check_budget(state: &AppState, label: &str) -> budget_core::Result<()> {
    if is_quick(label) && label != current_label(state) {
        return Err(budget_core::Error::Validation(
            "Бюджет изменился. Откройте быстрый ввод заново.".into(),
        ));
    }
    Ok(())
}

pub fn request_open(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = open(&app) {
            eprintln!("окно быстрого ввода не открылось: {e}");
        }
    });
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app: &AppHandle, _: &Shortcut, e: ShortcutEvent| {
            if e.state() == ShortcutState::Pressed {
                request_open(app);
            }
        })
        .build()
}

/// Показывает окно (создаёт при первом вызове) поверх остальных.
pub fn open(app: &AppHandle) -> tauri::Result<()> {
    let _session = LIFECYCLE.lock().unwrap_or_else(PoisonError::into_inner);
    let label = current_label(&app.state::<AppState>());
    let w = match app.get_webview_window(&label) {
        Some(w) => w,
        None => {
            let b = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
                .title("Быстрый ввод — Kazna")
                .inner_size(640.0, 230.0)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .center();
            match crate::test_browser_args() {
                Some(args) => b.additional_browser_args(&args),
                None => b,
            }
            .build()?
        }
    };
    w.unminimize()?;
    w.show()?;
    w.set_focus()?;
    // Окно уже открывалось: пусть поле ввода снова получит фокус.
    w.emit("quick-shown", ())?;
    Ok(())
}

pub fn hide(app: &AppHandle, caller: &str) {
    let label = if is_quick(caller) {
        caller.into()
    } else {
        current_label(&app.state::<AppState>())
    };
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.hide();
    }
}

/// При неудаче или выборе текущего файла возвращаем прежний черновик. При
/// замене уничтожаем и DOM, и кеш запросов, даже если окно до этого скрыли.
pub fn during_replacement<T>(
    app: &AppHandle,
    state: &AppState,
    replace: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _session = LIFECYCLE.lock().unwrap_or_else(PoisonError::into_inner);
    let label = current_label(state);
    let Some(w) = app.get_webview_window(&label) else {
        return replace();
    };
    let visible = w.is_visible().map_err(|e| e.to_string())?;
    if visible {
        w.hide().map_err(|e| e.to_string())?;
    }
    let result = replace();
    let cleanup = if label != current_label(state) {
        w.destroy()
    } else if visible {
        w.show()
    } else {
        Ok(())
    };
    if let Err(e) = cleanup {
        eprintln!("не удалось обновить окно быстрого ввода: {e}");
    }
    result
}

/// Сочетание из настроек; пустое — быстрый ввод только из трея.
pub fn saved_hotkey(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let guard = state.lock_db();
    match guard.as_ref() {
        Ok(db) => settings::get(db.conn(), "quick_hotkey")
            .ok()
            .flatten()
            .unwrap_or_else(|| "Ctrl+Alt+P".into()),
        Err(_) => String::new(),
    }
}

/// Заменяет сочетание. Ошибка — если его заняла другая программа.
pub fn register(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    if hotkey.is_empty() {
        return Ok(());
    }
    gs.register(hotkey)
        .map_err(|_| format!("сочетание {hotkey} уже занято другой программой: выберите другое"))
}
