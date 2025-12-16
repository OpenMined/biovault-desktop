use std::fs;
use std::path::PathBuf;

fn main() {
    // Ensure bundled resources directory exists so glob in tauri.conf.json always matches.
    let bundled_dir: PathBuf = ["resources", "bundled"].iter().collect();
    let _ = fs::create_dir_all(&bundled_dir);
    if bundled_dir
        .read_dir()
        .map(|mut it| it.next().is_none())
        .unwrap_or(false)
    {
        // Note: glob patterns like `resources/**` and `resources/*` often do not match dotfiles.
        // Use a non-dot placeholder filename to satisfy bundler globs on all platforms.
        let _ = fs::write(bundled_dir.join("placeholder.txt"), b"placeholder");
    }

    // Ensure templates resource path exists as a directory.
    // On Windows with `core.symlinks=false`, the repo's `resources/templates` symlink may be checked out as a plain file.
    // Tauri expects this to be a directory when bundling resources.
    let templates_dir: PathBuf = ["resources", "templates"].iter().collect();
    if let Ok(meta) = fs::symlink_metadata(&templates_dir) {
        if meta.file_type().is_file() {
            let _ = fs::remove_file(&templates_dir);
        }
    }
    let _ = fs::create_dir_all(&templates_dir);
    if templates_dir
        .read_dir()
        .map(|mut it| it.next().is_none())
        .unwrap_or(false)
    {
        // Note: glob patterns like `resources/templates/*` often do not match dotfiles.
        let _ = fs::write(templates_dir.join("placeholder.txt"), b"placeholder");
    }

    // Extract biovault-beaver version from submodule's __init__.py
    let beaver_init_path: PathBuf = [
        "..",
        "biovault",
        "biovault-beaver",
        "python",
        "src",
        "beaver",
        "__init__.py",
    ]
    .iter()
    .collect();

    let beaver_version = if beaver_init_path.exists() {
        fs::read_to_string(&beaver_init_path)
            .ok()
            .and_then(|content| {
                // Look for __version__ = "X.Y.Z"
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("__version__") {
                        // Extract version from: __version__ = "0.1.26"
                        if let Some(start) = trimmed.find('"') {
                            if let Some(end) = trimmed[start + 1..].find('"') {
                                return Some(trimmed[start + 1..start + 1 + end].to_string());
                            }
                        }
                    }
                }
                None
            })
            .unwrap_or_else(|| "0.1.30".to_string()) // Fallback
    } else {
        "0.1.30".to_string() // Fallback if submodule not present
    };

    // Make version available to Rust code
    println!("cargo:rustc-env=BEAVER_VERSION={}", beaver_version);

    // Rerun if beaver __init__.py changes
    println!("cargo:rerun-if-changed=../biovault/biovault-beaver/python/src/beaver/__init__.py");

    // Windows defaults to a small thread stack reserve (commonly 1MB), which can overflow during
    // PQXDH/Kyber crypto operations (e.g. when sending an encrypted message). Increase the stack
    // reserve for the desktop executable to prevent STATUS_STACK_OVERFLOW crashes.
    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-arg-bin=bv-desktop=/STACK:8388608");

    tauri_build::build()
}
