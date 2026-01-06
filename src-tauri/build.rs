use std::env;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

fn ensure_placeholder_dir(dir: &Path, placeholder_name: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let is_empty = dir
        .read_dir()
        .map(|mut it| it.next().is_none())
        .unwrap_or(true);
    if is_empty {
        fs::write(dir.join(placeholder_name), b"placeholder")?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn resolve_link_like_dir(start: &Path, max_depth: usize) -> Option<PathBuf> {
    let mut current = start.to_path_buf();

    for _ in 0..max_depth {
        if current.is_dir() {
            return Some(current);
        }

        let meta = fs::symlink_metadata(&current).ok()?;

        // Follow real symlinks if present.
        if meta.file_type().is_symlink() {
            let link = fs::read_link(&current).ok()?;
            current = if link.is_absolute() {
                link
            } else {
                current.parent()?.join(link)
            };
            continue;
        }

        // On Windows without symlink support, git checks out symlinks as plain text files
        // containing the target path. Follow those too.
        if meta.is_file() {
            let raw = fs::read_to_string(&current).ok()?;
            let target = raw.trim();
            if target.is_empty() {
                return None;
            }
            let target_path = PathBuf::from(target);
            current = if target_path.is_absolute() {
                target_path
            } else {
                current.parent()?.join(target_path)
            };
            continue;
        }

        return None;
    }

    None
}

#[cfg(target_os = "windows")]
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = dst_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn materialize_windows_templates_dir(manifest_dir: &Path) -> io::Result<()> {
    let templates_path = manifest_dir.join("resources").join("templates");
    if templates_path.is_dir() {
        return Ok(());
    }

    // Resolve the current link/symlink chain to an actual directory to copy from.
    // Prefer starting from the templates path itself, then fall back to known repo targets.
    let source_dir = resolve_link_like_dir(&templates_path, 8)
        .or_else(|| {
            resolve_link_like_dir(&manifest_dir.join("..").join("..").join("templates-dev"), 8)
        })
        .or_else(|| {
            resolve_link_like_dir(
                &manifest_dir
                    .join("..")
                    .join("biovault")
                    .join("biovault-beaver")
                    .join("notebooks"),
                1,
            )
        });

    // Remove link-like file/symlink so we can create a real directory for bundling.
    if fs::symlink_metadata(&templates_path).is_ok() {
        let _ = fs::remove_file(&templates_path);
        let _ = fs::remove_dir_all(&templates_path);
    }
    fs::create_dir_all(&templates_path)?;

    if let Some(src) = source_dir {
        // Copy actual templates into the materialized directory so Tauri bundling works on Windows.
        // If copy fails, keep the directory (and a placeholder below) so builds don't hard-fail.
        let _ = copy_dir_recursive(&src, &templates_path);
    }

    ensure_placeholder_dir(&templates_path, "placeholder.txt")?;
    Ok(())
}

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"));

    // Ensure bundled resources directory exists so glob in tauri.conf.json always matches.
    let bundled_dir = manifest_dir.join("resources").join("bundled");
    ensure_placeholder_dir(&bundled_dir, "placeholder.txt")
        .expect("failed to ensure resources/bundled");

    // Ensure templates resource path exists as a directory.
    // On Windows with `core.symlinks=false`, the repo's `resources/templates` symlink may be checked out as a plain file.
    // Tauri expects this to be a directory when bundling resources.
    #[cfg(target_os = "windows")]
    materialize_windows_templates_dir(&manifest_dir)
        .expect("failed to materialize resources/templates for Windows bundling");

    // Extract biovault-beaver version from its __init__.py (workspace layout).
    let mut beaver_init_path = manifest_dir
        .parent()
        .expect("src-tauri has a parent")
        .join("biovault-beaver/python/src/beaver/__init__.py");

    if let Ok(path) = env::var("BIOVAULT_BEAVER_DIR") {
        beaver_init_path = PathBuf::from(path).join("python/src/beaver/__init__.py");
    } else if let Ok(root) = env::var("WORKSPACE_ROOT") {
        beaver_init_path = PathBuf::from(root).join("biovault-beaver/python/src/beaver/__init__.py");
    }

    if !beaver_init_path.exists() {
        let legacy = manifest_dir
            .parent()
            .expect("src-tauri has a parent")
            .join("biovault/biovault-beaver/python/src/beaver/__init__.py");
        if legacy.exists() {
            beaver_init_path = legacy;
        }
    }

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
        "0.1.30".to_string() // Fallback if beaver repo isn't available
    };

    // Make version available to Rust code
    println!("cargo:rustc-env=BEAVER_VERSION={}", beaver_version);

    // Rerun if beaver __init__.py changes
    println!("cargo:rerun-if-changed={}", beaver_init_path.display());
    println!("cargo:rerun-if-env-changed=BV_SYFTBOX_DEFAULT_BACKEND");

    // Windows defaults to a small thread stack reserve (commonly 1MB), which can overflow during
    // PQXDH/Kyber crypto operations (e.g. when sending an encrypted message). Increase the stack
    // reserve for the desktop executable to prevent STATUS_STACK_OVERFLOW crashes.
    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-arg-bin=bv-desktop=/STACK:8388608");

    if let Ok(default_backend) = env::var("BV_SYFTBOX_DEFAULT_BACKEND") {
        println!(
            "cargo:rustc-env=BV_SYFTBOX_DEFAULT_BACKEND={}",
            default_backend
        );
    }

    tauri_build::build()
}
