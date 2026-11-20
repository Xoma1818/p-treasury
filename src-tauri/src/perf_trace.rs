//! Opt-in command timing. Never records financial values or command arguments.
use std::io::Write;
use std::panic::Location;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static LOG_LOCK: Mutex<()> = Mutex::new(());

pub(super) struct Trace {
    path: PathBuf,
    location: &'static Location<'static>,
    started: Instant,
    at_ms: u128,
}

impl Trace {
    pub(super) fn begin(location: &'static Location<'static>) -> Option<Self> {
        let path = std::env::var_os("PTREASURY_PERF_LOG")?;
        if path.is_empty() {
            return None;
        }
        Some(Self {
            path: PathBuf::from(path),
            location,
            started: Instant::now(),
            at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis(),
        })
    }

    // Called only after releasing the database mutex.
    pub(super) fn finish(self, acquired: Instant, finished: Instant) {
        let row = serde_json::json!({
            "at_ms": self.at_ms,
            "location": format!("commands.rs:{}", self.location.line()),
            "lock_wait_ms": acquired.duration_since(self.started).as_secs_f64() * 1000.0,
            "work_ms": finished.duration_since(acquired).as_secs_f64() * 1000.0,
        });
        let Ok(_guard) = LOG_LOCK.lock() else {
            return;
        };
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path)
        {
            let _ = writeln!(file, "{row}");
        }
    }
}
