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
        let _ = fs::write(bundled_dir.join(".keep"), b"placeholder");
    }

    tauri_build::build()
}
