use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
pub fn test_notification(app: AppHandle) -> Result<(), String> {
    crate::desktop_log!("🔔 Test notification command called");

    let notifier = app.notification();

    // Request permission (no-op on platforms that don't need it)
    match notifier.request_permission() {
        Ok(permission) => {
            crate::desktop_log!("🔔 Notification permission: {:?}", permission);
        }
        Err(e) => {
            crate::desktop_log!("⚠️ Failed to request permission: {}", e);
        }
    }

    crate::desktop_log!("🔔 Attempting to show notification...");

    let result = notifier
        .builder()
        .title("BioVault Notification Test")
        .body("If you see this, native notifications are working.")
        .show();

    match &result {
        Ok(_) => crate::desktop_log!("✅ Notification shown successfully"),
        Err(e) => crate::desktop_log!("❌ Failed to show notification: {}", e),
    }

    result.map_err(|e| format!("Failed to show notification: {}", e))
}

#[tauri::command]
pub fn test_notification_applescript() -> Result<(), String> {
    crate::desktop_log!("🔔 Test AppleScript notification");

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let script = r#"display notification "If you see this, AppleScript notifications work! 🎉" with title "BioVault" subtitle "Notification Test""#;

        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("Failed to execute osascript: {}", e))?;

        if output.status.success() {
            crate::desktop_log!("✅ AppleScript notification sent");
            Ok(())
        } else {
            let error = String::from_utf8_lossy(&output.stderr);
            crate::desktop_log!("❌ AppleScript failed: {}", error);
            Err(format!("AppleScript error: {}", error))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("AppleScript notifications only work on macOS".to_string())
    }
}
