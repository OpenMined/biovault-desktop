// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Signal to shared library code that we're running under the Desktop GUI so any
    // spawned console subprocesses should not create a visible window on Windows.
    std::env::set_var("BIOVAULT_DESKTOP", "1");
    std::env::set_var("BIOVAULT_HIDE_CONSOLE", "1");
    bv_desktop_lib::run()
}
