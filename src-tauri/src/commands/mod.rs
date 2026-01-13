pub mod agent_api;
pub mod datasets;
pub mod dependencies;
pub mod files;
pub mod jupyter;
pub mod key;
pub mod logs;
pub mod messages;
pub mod notifications;
pub mod participants;
pub mod pipelines;
pub mod profiles;
pub mod projects;
pub mod runs;
pub mod sessions;
pub mod settings;
pub mod sql;
pub mod syftbox;

/// Configure a Command to hide the console window on Windows.
/// This prevents black CMD windows from flashing when spawning child processes.
#[cfg(target_os = "windows")]
pub fn hide_console_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
pub fn hide_console_window(_cmd: &mut std::process::Command) {
    // No-op on non-Windows platforms
}
