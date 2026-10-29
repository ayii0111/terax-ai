//! Installed Nerd Font bytes for the terminal's symbol fallback.
//!
//! WKWebView does not expose fonts the user installed (`~/Library/Fonts`,
//! `/Library/Fonts`) to web content, so a Nerd Font that CoreText lists is
//! still invisible to the terminal canvas and private-use prompt icons draw as
//! boxes. The webview registers these bytes as a `FontFace` instead. Only
//! regular faces of families named like a Nerd Font are read, from the fixed
//! font directories, so the command cannot be steered to any other file.

use std::path::{Path, PathBuf};

use tauri::ipc::Response;

const MAX_FAMILIES: usize = 32;
const MAX_FAMILY_LEN: usize = 64;
const MAX_FONT_BYTES: u64 = 32 * 1024 * 1024;
const EXTENSIONS: [&str; 2] = ["ttf", "otf"];

/// `Hack Nerd Font Mono` -> `HackNerdFontMono-Regular`, the Nerd Fonts file
/// naming. Anything but a plain Nerd Font family name is rejected.
pub fn regular_file_stem(family: &str) -> Option<String> {
    if family.is_empty()
        || family.len() > MAX_FAMILY_LEN
        || !family.contains("Nerd Font")
        || !family
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ')
    {
        return None;
    }
    Some(format!("{}-Regular", family.replace(' ', "")))
}

/// The first family, in the caller's order, with a regular face in `dirs`.
pub fn find_regular_face(dirs: &[PathBuf], families: &[String]) -> Option<PathBuf> {
    families
        .iter()
        .take(MAX_FAMILIES)
        .filter_map(|family| regular_file_stem(family))
        .find_map(|stem| {
            dirs.iter().find_map(|dir| {
                EXTENSIONS
                    .iter()
                    .map(|ext| dir.join(format!("{stem}.{ext}")))
                    .find(|path| path.is_file())
            })
        })
}

/// TrueType, OpenType/CFF and Apple `true` signatures.
pub fn is_font_data(bytes: &[u8]) -> bool {
    matches!(
        bytes.get(..4),
        Some([0, 1, 0, 0]) | Some(b"OTTO") | Some(b"true")
    )
}

fn read_font(path: &Path) -> Option<Vec<u8>> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FONT_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    is_font_data(&bytes).then_some(bytes)
}

fn font_dirs() -> Vec<PathBuf> {
    if !cfg!(target_os = "macos") {
        // WebKitGTK and WebView2 already see installed fonts.
        return Vec::new();
    }
    let mut dirs = Vec::with_capacity(2);
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("Library/Fonts"));
    }
    dirs.push(PathBuf::from("/Library/Fonts"));
    dirs
}

/// Raw bytes of the first installed regular face among `families`; an empty
/// body when none is installed or the platform needs no fallback.
#[tauri::command]
pub async fn terminal_nerd_font(families: Vec<String>) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = find_regular_face(&font_dirs(), &families)
            .and_then(|path| read_font(&path))
            .unwrap_or_default();
        Response::new(bytes)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_nerd_font_families_to_regular_file_stems() {
        assert_eq!(
            regular_file_stem("Hack Nerd Font Mono").as_deref(),
            Some("HackNerdFontMono-Regular")
        );
        assert_eq!(
            regular_file_stem("MesloLGS Nerd Font").as_deref(),
            Some("MesloLGSNerdFont-Regular")
        );
    }

    #[test]
    fn rejects_names_that_could_reach_other_files() {
        let too_long = format!("{} Nerd Font", "X".repeat(MAX_FAMILY_LEN));
        for family in [
            "",
            "Menlo",
            "../Nerd Font",
            "Nerd Font/../../etc/passwd",
            "Hack.Nerd Font",
            "Hack\\Nerd Font",
            &too_long,
        ] {
            assert_eq!(regular_file_stem(family), None, "{family}");
        }
    }

    #[test]
    fn picks_the_first_listed_family_that_is_installed() {
        let user = tempfile::tempdir().unwrap();
        let system = tempfile::tempdir().unwrap();
        std::fs::write(system.path().join("HackNerdFont-Regular.ttf"), b"x").unwrap();
        std::fs::write(user.path().join("MesloLGSNerdFont-Regular.otf"), b"x").unwrap();
        let dirs = [user.path().to_path_buf(), system.path().to_path_buf()];
        let families = |names: &[&str]| names.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        assert_eq!(
            find_regular_face(
                &dirs,
                &families(&["FiraCode Nerd Font", "Hack Nerd Font", "MesloLGS Nerd Font"])
            ),
            Some(system.path().join("HackNerdFont-Regular.ttf"))
        );
        assert_eq!(
            find_regular_face(&dirs, &families(&["MesloLGS Nerd Font"])),
            Some(user.path().join("MesloLGSNerdFont-Regular.otf"))
        );
        assert_eq!(
            find_regular_face(&dirs, &families(&["Iosevka Nerd Font"])),
            None
        );
    }

    #[test]
    fn accepts_only_font_signatures() {
        assert!(is_font_data(&[0, 1, 0, 0, 9]));
        assert!(is_font_data(b"OTTO...."));
        assert!(!is_font_data(b"#!/bin/sh"));
        assert!(!is_font_data(&[0, 1]));
    }
}
