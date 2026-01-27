use crate::types::{JupyterResetResult, JupyterStatus, DEFAULT_JUPYTER_PYTHON};
use biovault::cli::commands::jupyter;
use biovault::data::BioVaultDb;
use std::path::Path;

fn canonicalize_module_path(module_path: &str) -> String {
    Path::new(module_path)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| module_path.to_string())
}

fn load_jupyter_status(module_path: &str) -> Result<JupyterStatus, String> {
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open BioVault database: {}", e))?;
    let canonical = canonicalize_module_path(module_path);

    let env = db
        .get_dev_env(&canonical)
        .map_err(|e| format!("Failed to query Jupyter environment: {}", e))?;

    Ok(env.map_or(
        JupyterStatus {
            running: false,
            port: None,
            url: None,
            token: None,
        },
        |env| JupyterStatus {
            running: env.jupyter_pid.is_some() && env.jupyter_port.is_some(),
            port: env.jupyter_port,
            url: env.jupyter_url.clone(),
            token: env.jupyter_token.clone(),
        },
    ))
}

#[tauri::command]
pub async fn launch_jupyter(
    module_path: String,
    python_version: Option<String>,
) -> Result<JupyterStatus, String> {
    let version = python_version.unwrap_or_else(|| DEFAULT_JUPYTER_PYTHON.to_string());
    let module_path_clone = module_path.clone();
    let version_clone = version.clone();

    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(jupyter::start(&module_path_clone, &version_clone))
    })
    .await
    .map_err(|e| format!("Failed to launch Jupyter (task join): {}", e))?
    .map_err(|e| format!("Failed to launch Jupyter: {}", e))?;

    load_jupyter_status(&module_path)
}

#[tauri::command]
pub async fn reset_jupyter(
    module_path: String,
    python_version: Option<String>,
) -> Result<JupyterResetResult, String> {
    let version = python_version.unwrap_or_else(|| DEFAULT_JUPYTER_PYTHON.to_string());
    let module_path_clone = module_path.clone();
    let version_clone = version.clone();

    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(jupyter::reset(&module_path_clone, &version_clone))
    })
    .await
    .map_err(|e| format!("Failed to reset Jupyter (task join): {}", e))?
    .map_err(|e| format!("Failed to reset Jupyter: {}", e))?;

    let stop_path = module_path.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(jupyter::stop(&stop_path))
    })
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => crate::desktop_log!("Warning: Failed to stop Jupyter after reset: {}", err),
        Err(join_err) => crate::desktop_log!(
            "Warning: Failed to stop Jupyter after reset (task join): {}",
            join_err
        ),
    }

    let status = load_jupyter_status(&module_path)?;

    Ok(JupyterResetResult {
        status,
        message: "Jupyter environment rebuilt. The server is stopped.".to_string(),
    })
}

#[tauri::command]
pub async fn stop_jupyter(module_path: String) -> Result<JupyterStatus, String> {
    let module_path_clone = module_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(jupyter::stop(&module_path_clone))
    })
    .await
    .map_err(|e| format!("Failed to stop Jupyter (task join): {}", e))?
    .map_err(|e| format!("Failed to stop Jupyter: {}", e))?;

    load_jupyter_status(&module_path)
}

#[tauri::command]
pub fn get_jupyter_status(module_path: String) -> Result<JupyterStatus, String> {
    load_jupyter_status(&module_path)
}
