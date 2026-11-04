//! Маленькое окно быстрого ввода: открывается сочетанием клавиш из любой
//! программы (по умолчанию Ctrl+Alt+P) или из меню значка в трее.

use budget_core::settings;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::AppState;

pub const LABEL: &str = "quick";

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app: &AppHandle, _: &Shortcut, e: ShortcutEvent| {
            if e.state() == ShortcutState::Pressed {
                if let Err(e) = open(app) {
                    eprintln!("окно быстрого ввода не открылось: {e}");
                }
            }
        })
        .build()
}

/// Показывает окно (создаёт при первом вызове) поверх остальных.
pub fn open(app: &AppHandle) -> tauri::Result<()> {
    let w = match app.get_webview_window(LABEL) {
        Some(w) => w,
        None => {
            let b = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
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

pub fn hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
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
