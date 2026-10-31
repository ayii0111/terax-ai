//! Append-only sink of the temporary sticky-drag trace (`pointerTrace.ts`).
//!
//! The file lives in the app log directory under a fixed name and the webview supplies only the
//! text; one previous generation is kept, so disk use stays bounded.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "pointer-trace.log";
const PREVIOUS_FILE_NAME: &str = "pointer-trace.1.log";
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_BATCH_BYTES: usize = 1024 * 1024;

#[tauri::command]
pub async fn pointer_trace_append(app: AppHandle, lines: String) -> Result<(), String> {
    if lines.len() > MAX_BATCH_BYTES {
        return Err("pointer trace batch is too large".to_string());
    }
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || append(&dir, &lines, MAX_FILE_BYTES))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

fn append(dir: &Path, lines: &str, max_file_bytes: u64) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = dir.join(FILE_NAME);
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() >= max_file_bytes) {
        fs::rename(&path, dir.join(PREVIOUS_FILE_NAME))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(lines.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_and_keeps_one_previous_generation() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), "first\n", 8).unwrap();
        append(dir.path(), "second\n", 8).unwrap();
        append(dir.path(), "third\n", 8).unwrap();
        append(dir.path(), "fourth\n", 8).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join(PREVIOUS_FILE_NAME)).unwrap(),
            "first\nsecond\n"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join(FILE_NAME)).unwrap(),
            "third\nfourth\n"
        );
    }
}
