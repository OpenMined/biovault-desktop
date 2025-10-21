use crate::types::{JupyterResetResult, JupyterStatus, DEFAULT_JUPYTER_PYTHON};
use biovault::cli::commands::jupyter;
use biovault::data::BioVaultDb;
use std::path::Path;

fn canonicalize_project_path(project_path: &str) -> String {
    Path::new(project_path)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| project_path.to_string())
}

fn load_jupyter_status(project_path: &str) -> Result<JupyterStatus, String> {
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open BioVault database: {}", e))?;
    let canonical = canonicalize_project_path(project_path);

    let env = db
        .get_dev_env(&canonical)
        .map_err(|e| format!("Failed to query Jupyter environment: {}", e))?;

    Ok(env.map_or(
        JupyterStatus {
            running: false,
            port: None,
        },
        |env| JupyterStatus {
            running: env.jupyter_pid.is_some() && env.jupyter_port.is_some(),
            port: env.jupyter_port,
        },
    ))
}

#[tauri::command]
pub fn launch_jupyter(
    project_path: String,
    python_version: Option<String>,
) -> Result<JupyterStatus, String> {
    let version = python_version.unwrap_or_else(|| DEFAULT_JUPYTER_PYTHON.to_string());
    tauri::async_runtime::block_on(jupyter::start(&project_path, &version))
        .map_err(|e| format!("Failed to launch Jupyter: {}", e))?;

    load_jupyter_status(&project_path)
}

#[tauri::command]
pub fn reset_jupyter(
    project_path: String,
    python_version: Option<String>,
) -> Result<JupyterResetResult, String> {
    let version = python_version.unwrap_or_else(|| DEFAULT_JUPYTER_PYTHON.to_string());
    tauri::async_runtime::block_on(jupyter::reset(&project_path, &version))
        .map_err(|e| format!("Failed to reset Jupyter: {}", e))?;

    if let Err(err) = tauri::async_runtime::block_on(jupyter::stop(&project_path)) {
        eprintln!("Warning: Failed to stop Jupyter after reset: {}", err);
    }

    let status = load_jupyter_status(&project_path)?;

    Ok(JupyterResetResult {
        status,
        message: "Jupyter environment rebuilt. The server is stopped.".to_string(),
    })
}

#[tauri::command]
pub fn stop_jupyter(project_path: String) -> Result<JupyterStatus, String> {
    tauri::async_runtime::block_on(jupyter::stop(&project_path))
        .map_err(|e| format!("Failed to stop Jupyter: {}", e))?;

    load_jupyter_status(&project_path)
}

#[tauri::command]
pub fn get_jupyter_status(project_path: String) -> Result<JupyterStatus, String> {
    load_jupyter_status(&project_path)
}
