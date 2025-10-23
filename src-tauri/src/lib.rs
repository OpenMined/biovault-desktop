use chrono::Local;
use rusqlite::Connection;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    image::Image,
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

// WebSocket bridge for browser development
mod ws_bridge;

// Module declarations
mod commands;
mod types;

// Import types from types module
use types::AppState;

// Import all command functions from command modules
use commands::dependencies::*;
use commands::files::*;
use commands::jupyter::*;
use commands::logs::*;
use commands::messages::{load_biovault_email, *};
use commands::participants::*;
use commands::projects::*;
use commands::runs::*;
use commands::settings::*;
use commands::sql::*;
use commands::syftbox::*;

// BioVault CLI library imports
use biovault::data::BioVaultDb;

fn resolve_biovault_home_path() -> PathBuf {
    if let Ok(home) = biovault::config::get_biovault_home() {
        return home;
    }

    env::var("BIOVAULT_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            dirs::desktop_dir()
                .unwrap_or_else(|| home_dir.join("Desktop"))
                .join("BioVault")
        })
}

fn desktop_log_path() -> PathBuf {
    let base = resolve_biovault_home_path();
    base.join("logs").join("desktop.log")
}

fn log_desktop_event(message: &str) {
    let timestamp = Local::now().format("%Y-%m-%dT%H:%M:%S%:z");
    let log_line = format!("[{}] {}\n", timestamp, message);

    if let Err(err) = (|| -> std::io::Result<()> {
        let log_path = desktop_log_path();
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        file.write_all(log_line.as_bytes())?;
        Ok(())
    })() {
        eprintln!("Failed to write desktop log: {}", err);
    }
}

fn init_db(conn: &Connection) -> Result<(), rusqlite::Error> {
    // NOTE: Files and Participants tables are managed by CLI via biovault.db
    // Desktop only manages its own tables: projects, runs, run_participants

    conn.execute(
        "CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            author TEXT NOT NULL,
            workflow TEXT NOT NULL,
            template TEXT NOT NULL,
            project_path TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            work_dir TEXT NOT NULL,
            participant_count INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS run_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            participant_id INTEGER NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id)
        )",
        [],
    )?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();

    // Desktop app defaults to Desktop/BioVault if not specified via env or args
    // Priority: 1) command-line args, 2) BIOVAULT_HOME env var, 3) Desktop/BioVault
    let biovault_home = args
        .iter()
        .position(|arg| arg == "--biovault-config")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .or_else(|| std::env::var("BIOVAULT_HOME").ok().map(PathBuf::from))
        .or_else(|| {
            // Desktop app defaults to Desktop/BioVault only if nothing else specified
            let home_dir = dirs::home_dir()?;
            let desktop_dir = dirs::desktop_dir().unwrap_or_else(|| home_dir.join("Desktop"));
            Some(desktop_dir.join("BioVault"))
        });

    // Only set BIOVAULT_HOME if it's not already set by the environment
    // This allows virtualenvs or external tools to specify the location
    if std::env::var("BIOVAULT_HOME").is_err() {
        if let Some(home) = &biovault_home {
            std::env::set_var("BIOVAULT_HOME", home);
        }
    }

    // Initialize shared BioVaultDb (handles files/participants)
    // This automatically creates the directory via get_biovault_home() if needed
    let biovault_db = BioVaultDb::new().expect("Failed to initialize BioVault database");

    // Get the actual biovault_home_dir that was used (for window title)
    let biovault_home_dir =
        biovault::config::get_biovault_home().expect("Failed to get BioVault home directory");

    log_desktop_event(&format!(
        "Desktop logging initialised. Log file: {}",
        desktop_log_path().display()
    ));

    let email = load_biovault_email(&Some(biovault_home_dir.clone()));
    let window_title = format!("BioVault - {}", email);

    // Desktop DB for runs/projects (keep separate for now)
    let db_path = biovault_home_dir.join("biovault.db");
    let conn = Connection::open(&db_path).expect("Could not open database");
    init_db(&conn).expect("Could not initialize database");

    let queue_processor_paused = Arc::new(AtomicBool::new(false)); // Start running

    let app_state = AppState {
        db: Mutex::new(conn),
        biovault_db: Arc::new(Mutex::new(biovault_db)),
        queue_processor_paused: queue_processor_paused.clone(),
    };

    // Spawn background queue processor (using library)
    let paused_flag = queue_processor_paused.clone();
    let biovault_db_for_processor = app_state.biovault_db.clone();

    std::thread::spawn(move || {
        loop {
            // Check if paused
            if !paused_flag.load(Ordering::SeqCst) {
                // Get pending files - lock only briefly
                let pending_files = {
                    match biovault_db_for_processor.lock() {
                        Ok(db) => biovault::data::get_pending_files(&db, 10).ok(),
                        Err(_) => None,
                    }
                    // Lock is released here automatically
                };

                if let Some(files) = pending_files {
                    if !files.is_empty() {
                        let mut processed = 0;
                        let mut errors = 0;

                        for file in &files {
                            // Lock briefly to mark as processing
                            let marked = {
                                match biovault_db_for_processor.lock() {
                                    Ok(db) => biovault::data::update_file_status(
                                        &db,
                                        file.id,
                                        "processing",
                                        None,
                                    )
                                    .is_ok(),
                                    Err(_) => false,
                                }
                            };

                            if !marked {
                                continue;
                            }

                            // Process file WITHOUT holding lock (expensive I/O operations)
                            let hash_result = biovault::data::hash_file(&file.file_path);

                            match hash_result {
                                Ok(hash) => {
                                    // Detect and analyze file WITHOUT holding lock
                                    let metadata = if file.data_type.as_deref() == Some("Unknown")
                                        || file.data_type.is_none()
                                    {
                                        // Detect file type first
                                        if let Ok(detected) =
                                            biovault::data::detect_genotype_metadata(
                                                &file.file_path,
                                            )
                                        {
                                            if detected.data_type == "Genotype" {
                                                // It's a genotype - analyze it fully
                                                biovault::data::analyze_genotype_file(
                                                    &file.file_path,
                                                )
                                                .ok()
                                            } else {
                                                Some(detected)
                                            }
                                        } else {
                                            None
                                        }
                                    } else if file.data_type.as_deref() == Some("Genotype") {
                                        // Already known to be genotype - analyze it
                                        biovault::data::analyze_genotype_file(&file.file_path).ok()
                                    } else {
                                        None
                                    };

                                    // Lock briefly to update DB with results
                                    match biovault_db_for_processor.lock() {
                                        Ok(db) => {
                                            if biovault::data::update_file_from_queue(
                                                &db,
                                                file.id,
                                                &hash,
                                                metadata.as_ref(),
                                            )
                                            .is_ok()
                                            {
                                                let _ = biovault::data::update_file_status(
                                                    &db, file.id, "complete", None,
                                                );
                                                processed += 1;
                                            }
                                        }
                                        Err(_) => continue,
                                    }
                                }
                                Err(e) => {
                                    // Lock briefly to mark error
                                    let error_msg = format!("{}", e);
                                    if let Ok(db) = biovault_db_for_processor.lock() {
                                        let _ = biovault::data::update_file_status(
                                            &db,
                                            file.id,
                                            "error",
                                            Some(&error_msg),
                                        );
                                    }
                                    errors += 1;
                                }
                            }
                        }

                        // Only log if files were actually processed
                        if processed > 0 {
                            eprintln!(
                                "✅ Queue processor: processed {} files ({} errors)",
                                processed, errors
                            );
                        }
                    }
                }
            }

            // Wait 2 seconds before next check
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(app_state)
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                biovault::cli::commands::check::set_homebrew_install_logger(|message| {
                    log_desktop_event(message);
                });
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&window_title);

                // Handle window close event - minimize to tray instead of quitting
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            }

            // Create system tray menu
            let show = MenuItemBuilder::with_id("show", "Show").build(app)?;

            // Check current autostart status
            use tauri_plugin_autostart::ManagerExt;
            let autolaunch = app.autolaunch();
            let is_enabled = autolaunch.is_enabled().unwrap_or(false);

            let autostart_item = CheckMenuItemBuilder::with_id("autostart", "Start on Startup")
                .checked(is_enabled)
                .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[&show, &autostart_item, &quit])
                .build()?;

            // Clone the autostart item for use in the event handler
            let autostart_item_clone = autostart_item.clone();

            // Load tray icon from embedded PNG
            let icon_bytes = include_bytes!("../icons/icon.png");
            let img = image::load_from_memory(icon_bytes)
                .map_err(|e| format!("Failed to decode tray icon: {}", e))?;
            let rgba = img.to_rgba8();
            let (width, height) = rgba.dimensions();
            let icon = Image::new_owned(rgba.into_raw(), width, height);

            // Create tray icon
            let _tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "autostart" => {
                            use tauri_plugin_autostart::ManagerExt;
                            let autolaunch = app.autolaunch();
                            match autolaunch.is_enabled() {
                                Ok(enabled) => {
                                    let result = if enabled {
                                        autolaunch.disable()
                                    } else {
                                        autolaunch.enable()
                                    };
                                    if let Err(e) = result {
                                        eprintln!("Failed to toggle autostart: {}", e);
                                    } else {
                                        // Update the menu item checkbox
                                        let _ = autostart_item_clone.set_checked(!enabled);
                                    }
                                    // Emit event to update UI
                                    let _ = app.emit("autostart-changed", ());
                                }
                                Err(e) => eprintln!("Failed to check autostart status: {}", e),
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Start WebSocket bridge for browser development if enabled
            if std::env::var("DEV_WS_BRIDGE").is_ok() {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = ws_bridge::start_ws_server(app_handle, 3333).await {
                        eprintln!("❌ Failed to start WebSocket server: {}", e);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Files commands
            search_txt_files,
            suggest_patterns,
            extract_ids_for_files,
            get_extensions,
            is_directory,
            import_files,
            import_files_with_metadata,
            import_files_pending,
            process_queue,
            pause_queue_processor,
            resume_queue_processor,
            get_queue_processor_status,
            get_files,
            delete_file,
            delete_files_bulk,
            detect_file_types,
            analyze_file_types,
            // Participants commands
            get_participants,
            delete_participant,
            delete_participants_bulk,
            // Messages commands
            list_message_threads,
            get_thread_messages,
            send_message,
            sync_messages,
            mark_thread_as_read,
            delete_thread,
            delete_message,
            // Projects commands
            import_project,
            get_projects,
            delete_project,
            delete_project_folder,
            create_project,
            get_available_project_examples,
            get_default_project_path,
            load_project_editor,
            save_project_editor,
            // Jupyter commands
            launch_jupyter,
            stop_jupyter,
            get_jupyter_status,
            reset_jupyter,
            // Runs commands
            start_analysis,
            execute_analysis,
            get_runs,
            get_run_logs,
            get_run_logs_tail,
            get_run_logs_full,
            delete_run,
            // SQL commands
            sql_list_tables,
            sql_get_table_schema,
            sql_run_query,
            sql_export_query,
            // Settings commands
            get_settings,
            save_settings,
            get_app_version,
            open_folder,
            show_in_folder,
            get_config_path,
            check_is_onboarded,
            complete_onboarding,
            reset_all_data,
            get_autostart_enabled,
            set_autostart_enabled,
            // Logs commands
            get_command_logs,
            clear_command_logs,
            // Dependencies commands
            check_dependencies,
            check_single_dependency,
            get_saved_dependency_states,
            save_custom_path,
            update_saved_dependency_states,
            check_brew_installed,
            install_brew,
            check_command_line_tools_installed,
            install_dependency,
            install_dependencies,
            // SyftBox commands
            open_url,
            syftbox_request_otp,
            syftbox_submit_otp,
            check_syftbox_auth,
            get_syftbox_config_info,
            get_syftbox_state,
            start_syftbox_client,
            stop_syftbox_client
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
