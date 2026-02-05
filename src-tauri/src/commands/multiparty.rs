use crate::types::AppState;
use biovault::messages::models::{FlowParticipant, MessageType};
use chrono::Utc;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

// File name for shared step status across participants
const SHARED_STATE_FILE: &str = "shared_step_status.json";

/// Get the owner's email from config
fn get_owner_email() -> Result<String, String> {
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    Ok(config.email)
}

/// Get the shared flow path for multiparty sessions
/// Structure: {biovault_home}/datasites/{owner}/shared/flows/{flow_name}/{session_id}/
fn get_shared_flow_path(flow_name: &str, session_id: &str) -> Result<PathBuf, String> {
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    let owner = get_owner_email()?;

    Ok(biovault_home
        .join("datasites")
        .join(&owner)
        .join("shared")
        .join("flows")
        .join(flow_name)
        .join(session_id))
}

/// Get the step output path within a shared flow
/// Structure: {flow_path}/{step_number}-{step_id}/
fn get_step_path(flow_path: &PathBuf, step_number: usize, step_id: &str) -> PathBuf {
    flow_path.join(format!("{}-{}", step_number, step_id))
}

/// Get the progress path for coordination
/// Structure: {flow_path}/_progress/
fn get_progress_path(flow_path: &PathBuf) -> PathBuf {
    flow_path.join("_progress")
}

/// Append a log entry to progress.json (JSONL format for event streaming)
fn append_progress_log(progress_dir: &PathBuf, event: &str, step_id: Option<&str>, role: &str) {
    let log_file = progress_dir.join("progress.json");
    let timestamp = Utc::now().to_rfc3339();
    let log_entry = serde_json::json!({
        "timestamp": timestamp,
        "event": event,
        "step_id": step_id,
        "role": role,
    });

    // Append to JSONL file
    use std::fs::OpenOptions;
    use std::io::Write;
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_file) {
        let _ = writeln!(file, "{}", log_entry.to_string());
    }
}

/// Create syft.pub.yaml in output directory to enable SyftBox sync
/// This allows recipients to read the shared outputs via their synced datasites
fn create_syft_pub_yaml(
    output_dir: &PathBuf,
    owner_email: &str,
    read_emails: &[String],
) -> Result<(), String> {
    let perm_path = output_dir.join("syft.pub.yaml");

    // Don't overwrite if exists
    if perm_path.exists() {
        return Ok(());
    }

    let doc = serde_json::json!({
        "rules": [
            {
                "pattern": "**",
                "access": {
                    "admin": [owner_email],
                    "read": read_emails,
                    "write": Vec::<String>::new(),
                },
            },
        ],
    });

    let yaml = serde_yaml::to_string(&doc)
        .map_err(|e| format!("Failed to serialize syft.pub.yaml: {}", e))?;

    fs::write(&perm_path, yaml).map_err(|e| format!("Failed to write syft.pub.yaml: {}", e))?;

    println!(
        "[Multiparty] Created syft.pub.yaml at {:?} with read access for: {:?}",
        perm_path, read_emails
    );

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SharedStepStatus {
    pub step_id: String,
    pub role: String,
    pub status: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultipartyFlowState {
    pub session_id: String,
    pub flow_name: String,
    pub my_role: String,
    pub my_email: String,
    pub participants: Vec<FlowParticipant>,
    pub steps: Vec<StepState>,
    pub status: FlowSessionStatus,
    pub thread_id: String,
    pub work_dir: Option<PathBuf>,
    #[serde(default)]
    pub run_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum FlowSessionStatus {
    Invited,
    Accepted,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepState {
    pub id: String,
    pub name: String,
    pub description: String,
    pub auto_run: bool,
    pub status: StepStatus,
    pub my_action: bool,
    pub shares_output: bool,
    pub share_to: Vec<String>,
    pub depends_on: Vec<String>,
    pub output_dir: Option<PathBuf>,
    pub outputs_shared: bool,
    /// Target groups/emails that execute this step (group names)
    pub targets: Vec<String>,
    /// Resolved target emails (for UI participant display)
    pub target_emails: Vec<String>,
    /// Whether this is a barrier step (waits for others)
    pub is_barrier: bool,
    /// What step this barrier waits for
    pub barrier_wait_for: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum StepStatus {
    Pending,
    WaitingForInputs,
    Ready,
    Running,
    Completed,
    Sharing,
    Shared,
    Failed,
}

impl Default for StepStatus {
    fn default() -> Self {
        StepStatus::Pending
    }
}

static FLOW_SESSIONS: Lazy<Mutex<HashMap<String, MultipartyFlowState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Update dependent steps: if all their dependencies are now completed/shared, mark them Ready
fn update_dependent_steps(flow_state: &mut MultipartyFlowState, completed_step_id: &str) {
    // Collect step statuses first to avoid borrow issues
    let step_statuses: std::collections::HashMap<String, StepStatus> = flow_state
        .steps
        .iter()
        .map(|s| (s.id.clone(), s.status.clone()))
        .collect();

    for step in &mut flow_state.steps {
        // Only update steps that are Pending and have this step as a dependency
        if step.status != StepStatus::Pending {
            continue;
        }
        if !step.depends_on.contains(&completed_step_id.to_string()) {
            continue;
        }
        if !step.my_action {
            continue;
        }

        // Check if all dependencies are now satisfied
        let all_deps_met = step
            .depends_on
            .iter()
            .all(|dep_id| match step_statuses.get(dep_id) {
                Some(StepStatus::Completed) | Some(StepStatus::Shared) => true,
                _ => false,
            });

        if all_deps_met {
            step.status = StepStatus::Ready;
        }
    }
}

/// Update barrier steps when their wait_for condition is satisfied
fn update_barrier_steps(flow_state: &mut MultipartyFlowState) {
    let flow_name = flow_state.flow_name.clone();
    let session_id = flow_state.session_id.clone();
    let participants = flow_state.participants.clone();

    // First pass: check barrier steps
    let mut barriers_to_complete: Vec<String> = Vec::new();

    for step in &flow_state.steps {
        if step.status != StepStatus::WaitingForInputs || !step.is_barrier {
            continue;
        }

        // Check if the barrier's wait_for step is complete by all targets
        if let Some(ref wait_for_step_id) = step.barrier_wait_for {
            // Get the target emails for this barrier from target_emails
            let barrier_targets: Vec<String> = step.target_emails.clone();

            // Check if all barrier targets have completed the waited-for step
            let all_complete = barrier_targets.iter().all(|target_email| {
                // Find the participant for this target
                if let Some(participant) = participants.iter().find(|p| &p.email == target_email) {
                    // Check progress file for this participant's waited-for step
                    check_participant_step_complete(
                        &flow_name,
                        &session_id,
                        &participant.email,
                        &participant.role,
                        wait_for_step_id,
                    )
                } else {
                    false
                }
            });

            if all_complete {
                barriers_to_complete.push(step.id.clone());
            }
        }
    }

    // Second pass: mark completed barriers
    for step in &mut flow_state.steps {
        if barriers_to_complete.contains(&step.id) {
            step.status = StepStatus::Completed;
        }
    }

    // Third pass: update steps that depend on completed barriers
    let completed_step_ids: Vec<String> = flow_state
        .steps
        .iter()
        .filter(|s| s.status == StepStatus::Completed || s.status == StepStatus::Shared)
        .map(|s| s.id.clone())
        .collect();

    for step in &mut flow_state.steps {
        if step.status == StepStatus::Pending && step.my_action {
            // Check if all dependencies are complete
            let deps_complete = step
                .depends_on
                .iter()
                .all(|dep| completed_step_ids.contains(dep));
            if deps_complete {
                step.status = StepStatus::Ready;
            }
        }
    }
}

/// Check if a specific participant has completed a specific step
fn check_participant_step_complete(
    flow_name: &str,
    session_id: &str,
    participant_email: &str,
    participant_role: &str,
    step_id: &str,
) -> bool {
    let biovault_home = match biovault::config::get_biovault_home() {
        Ok(h) => h,
        Err(_) => return false,
    };

    // Check synced path first
    let synced_progress_file = biovault_home
        .join("datasites")
        .join(participant_email)
        .join("shared")
        .join("flows")
        .join(flow_name)
        .join(session_id)
        .join("_progress")
        .join(format!("{}_{}.json", participant_role, step_id));

    // Fallback to sandbox path
    let sandbox_progress_file = biovault_home.parent().map(|parent| {
        parent
            .join(participant_email)
            .join("datasites")
            .join(participant_email)
            .join("shared")
            .join("flows")
            .join(flow_name)
            .join(session_id)
            .join("_progress")
            .join(format!("{}_{}.json", participant_role, step_id))
    });

    let progress_file = if synced_progress_file.exists() {
        synced_progress_file
    } else if let Some(ref sandbox_file) = sandbox_progress_file {
        if sandbox_file.exists() {
            sandbox_file.clone()
        } else {
            return false;
        }
    } else {
        return false;
    };

    // Read and check the status
    if let Ok(content) = fs::read_to_string(&progress_file) {
        if let Ok(status) = serde_json::from_str::<SharedStepStatus>(&content) {
            return status.status == "Shared" || status.status == "Completed";
        }
    }

    false
}

/// Get a simplified role name from email for progress file naming
fn get_role_from_email(email: &str) -> String {
    // Extract username part before @
    email.split('@').next().unwrap_or(email).to_string()
}

#[tauri::command]
pub async fn send_flow_invitation(
    _state: tauri::State<'_, AppState>,
    thread_id: String,
    flow_name: String,
    flow_spec: serde_json::Value,
    participant_roles: Vec<FlowParticipant>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();

    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let my_email = config.email.clone();

    let my_role = participant_roles
        .iter()
        .find(|p| p.email == my_email)
        .map(|p| p.role.clone())
        .unwrap_or_else(|| "organizer".to_string());

    let steps = parse_flow_steps(&flow_spec, &my_email)?;

    // Set up work_dir for the proposer too (same as accept_flow_invitation)
    let work_dir = get_shared_flow_path(&flow_name, &session_id)?;
    fs::create_dir_all(&work_dir).map_err(|e| format!("Failed to create work dir: {}", e))?;

    // Create progress directory
    let progress_dir = get_progress_path(&work_dir);
    let _ = fs::create_dir_all(&progress_dir);

    // Create syft.pub.yaml for cross-participant progress syncing
    let all_participant_emails: Vec<String> =
        participant_roles.iter().map(|p| p.email.clone()).collect();
    let _ = create_syft_pub_yaml(&work_dir, &my_email, &all_participant_emails);

    let flow_state = MultipartyFlowState {
        session_id: session_id.clone(),
        flow_name: flow_name.clone(),
        my_role,
        my_email: my_email.clone(),
        participants: participant_roles.clone(),
        steps,
        status: FlowSessionStatus::Accepted,
        thread_id: thread_id.clone(),
        work_dir: Some(work_dir),
        run_id: None,
    };

    {
        let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        sessions.insert(session_id.clone(), flow_state);
    }

    let _message_type = MessageType::FlowInvitation {
        flow_name,
        session_id: session_id.clone(),
        participants: participant_roles,
        flow_spec,
    };

    Ok(session_id)
}

#[tauri::command]
pub async fn accept_flow_invitation(
    state: tauri::State<'_, AppState>,
    session_id: String,
    flow_name: String,
    flow_spec: serde_json::Value,
    participants: Vec<FlowParticipant>,
    auto_run_all: bool,
) -> Result<MultipartyFlowState, String> {
    // Check if already accepted
    {
        let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = sessions.get(&session_id) {
            return Ok(existing.clone());
        }
    }

    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let my_email = config.email.clone();

    let my_role = participants
        .iter()
        .find(|p| p.email == my_email)
        .map(|p| p.role.clone())
        .ok_or_else(|| "You are not a participant in this flow".to_string())?;

    let mut steps = parse_flow_steps(&flow_spec, &my_email)?;

    if auto_run_all {
        for step in &mut steps {
            step.auto_run = true;
        }
    }

    // Create work directory in shared datasite path for cross-client syncing
    // Structure: {datasite}/shared/flows/{flow_name}/{session_id}/
    let work_dir = get_shared_flow_path(&flow_name, &session_id)?;

    fs::create_dir_all(&work_dir).map_err(|e| format!("Failed to create work dir: {}", e))?;

    // Create progress directory for coordination
    let progress_dir = get_progress_path(&work_dir);
    fs::create_dir_all(&progress_dir)
        .map_err(|e| format!("Failed to create progress dir: {}", e))?;

    // Create syft.pub.yaml for the flow work directory and progress directory
    // All participants need read access to sync shared data
    let all_participant_emails: Vec<String> =
        participants.iter().map(|p| p.email.clone()).collect();
    let _ = create_syft_pub_yaml(&work_dir, &my_email, &all_participant_emails);
    let _ = create_syft_pub_yaml(&progress_dir, &my_email, &all_participant_emails);

    // Look up flow_id from database
    let flow_id = {
        let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
        let flows = biovault_db.list_flows().map_err(|e| e.to_string())?;
        flows.iter().find(|f| f.name == flow_name).map(|f| f.id)
    };

    // Create run entry in database
    let run_id = if let Some(fid) = flow_id {
        let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
        let metadata = serde_json::json!({
            "type": "multiparty",
            "session_id": session_id,
            "my_role": my_role,
            "participants": participants,
        });
        let run_id = biovault_db
            .create_flow_run_with_metadata(
                fid,
                &work_dir.to_string_lossy(),
                Some(&work_dir.to_string_lossy()),
                Some(&metadata.to_string()),
            )
            .map_err(|e| format!("Failed to create run entry: {}", e))?;
        Some(run_id)
    } else {
        None
    };

    let flow_state = MultipartyFlowState {
        session_id: session_id.clone(),
        flow_name: flow_name.clone(),
        my_role,
        my_email,
        participants,
        steps,
        status: FlowSessionStatus::Accepted,
        thread_id: String::new(),
        work_dir: Some(work_dir.clone()),
        run_id,
    };

    // Save state to file for persistence
    let state_path = work_dir.join("multiparty.state.json");
    let state_json = serde_json::to_string_pretty(&flow_state)
        .map_err(|e| format!("Failed to serialize state: {}", e))?;
    fs::write(&state_path, state_json).map_err(|e| format!("Failed to write state file: {}", e))?;

    {
        let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        sessions.insert(session_id, flow_state.clone());
    }

    Ok(flow_state)
}

#[tauri::command]
pub async fn get_multiparty_flow_state(
    session_id: String,
) -> Result<Option<MultipartyFlowState>, String> {
    let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;

    if let Some(flow_state) = sessions.get_mut(&session_id) {
        // Check if any WaitingForInputs steps can now proceed
        update_barrier_steps(flow_state);
        Ok(Some(flow_state.clone()))
    } else {
        Ok(None)
    }
}

/// Get progress status for all participants by reading their shared progress files
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParticipantProgress {
    pub email: String,
    pub role: String,
    pub steps: Vec<ParticipantStepStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParticipantStepStatus {
    pub step_id: String,
    pub status: String,
    pub timestamp: i64,
}

#[tauri::command]
pub async fn get_all_participant_progress(
    session_id: String,
) -> Result<Vec<ParticipantProgress>, String> {
    let (flow_name, participants, step_ids) = {
        let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        let flow_state = sessions
            .get(&session_id)
            .ok_or_else(|| "Flow session not found".to_string())?;
        (
            flow_state.flow_name.clone(),
            flow_state.participants.clone(),
            flow_state
                .steps
                .iter()
                .map(|s| s.id.clone())
                .collect::<Vec<_>>(),
        )
    };

    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;

    let mut all_progress = Vec::new();

    for participant in &participants {
        let mut steps = Vec::new();

        for step_id in &step_ids {
            // Try synced location first
            let synced_path = biovault_home
                .join("datasites")
                .join(&participant.email)
                .join("shared")
                .join("flows")
                .join(&flow_name)
                .join(&session_id)
                .join("_progress")
                .join(format!("{}_{}.json", participant.role, step_id));

            // Fallback to sandbox location
            let sandbox_path = biovault_home.parent().map(|parent| {
                parent
                    .join(&participant.email)
                    .join("datasites")
                    .join(&participant.email)
                    .join("shared")
                    .join("flows")
                    .join(&flow_name)
                    .join(&session_id)
                    .join("_progress")
                    .join(format!("{}_{}.json", participant.role, step_id))
            });

            let progress_file = if synced_path.exists() {
                Some(synced_path)
            } else if let Some(ref sp) = sandbox_path {
                if sp.exists() {
                    Some(sp.clone())
                } else {
                    None
                }
            } else {
                None
            };

            if let Some(path) = progress_file {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(status) = serde_json::from_str::<SharedStepStatus>(&content) {
                        steps.push(ParticipantStepStatus {
                            step_id: step_id.clone(),
                            status: status.status,
                            timestamp: status.timestamp,
                        });
                    }
                }
            }
        }

        all_progress.push(ParticipantProgress {
            email: participant.email.clone(),
            role: participant.role.clone(),
            steps,
        });
    }

    Ok(all_progress)
}

/// Get progress log entries from all participants (JSONL format)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub participant: String,
    pub role: String,
    pub timestamp: String,
    pub event: String,
    pub step_id: Option<String>,
    pub message: Option<String>,
}

#[tauri::command]
pub async fn get_participant_logs(session_id: String) -> Result<Vec<LogEntry>, String> {
    let (flow_name, participants) = {
        let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        let flow_state = sessions
            .get(&session_id)
            .ok_or_else(|| "Flow session not found".to_string())?;
        (
            flow_state.flow_name.clone(),
            flow_state.participants.clone(),
        )
    };

    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;

    let mut all_logs = Vec::new();

    for participant in &participants {
        // Try synced location first
        let synced_path = biovault_home
            .join("datasites")
            .join(&participant.email)
            .join("shared")
            .join("flows")
            .join(&flow_name)
            .join(&session_id)
            .join("_progress")
            .join("progress.json");

        // Fallback to sandbox location
        let sandbox_path = biovault_home.parent().map(|parent| {
            parent
                .join(&participant.email)
                .join("datasites")
                .join(&participant.email)
                .join("shared")
                .join("flows")
                .join(&flow_name)
                .join(&session_id)
                .join("_progress")
                .join("progress.json")
        });

        let log_file = if synced_path.exists() {
            Some(synced_path)
        } else if let Some(ref sp) = sandbox_path {
            if sp.exists() {
                Some(sp.clone())
            } else {
                None
            }
        } else {
            None
        };

        if let Some(path) = log_file {
            if let Ok(content) = fs::read_to_string(&path) {
                // JSONL format - one JSON object per line
                for line in content.lines() {
                    if let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) {
                        all_logs.push(LogEntry {
                            participant: participant.email.clone(),
                            role: participant.role.clone(),
                            timestamp: entry
                                .get("timestamp")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string(),
                            event: entry
                                .get("event")
                                .and_then(|e| e.as_str())
                                .unwrap_or("")
                                .to_string(),
                            step_id: entry
                                .get("step_id")
                                .and_then(|s| s.as_str())
                                .map(|s| s.to_string()),
                            message: entry
                                .get("message")
                                .and_then(|m| m.as_str())
                                .map(|m| m.to_string()),
                        });
                    }
                }
            }
        }
    }

    // Sort by timestamp
    all_logs.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    Ok(all_logs)
}

#[tauri::command]
pub async fn set_step_auto_run(
    session_id: String,
    step_id: String,
    auto_run: bool,
) -> Result<(), String> {
    let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
    let state = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Flow session not found".to_string())?;

    let step = state
        .steps
        .iter_mut()
        .find(|s| s.id == step_id)
        .ok_or_else(|| "Step not found".to_string())?;

    step.auto_run = auto_run;
    Ok(())
}

#[tauri::command]
pub async fn run_flow_step(
    _state: tauri::State<'_, AppState>,
    session_id: String,
    step_id: String,
) -> Result<StepState, String> {
    let (work_dir, step_number) = {
        let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        let flow_state = sessions
            .get_mut(&session_id)
            .ok_or_else(|| "Flow session not found".to_string())?;

        // Get step info and check if it can run
        let (step_deps, step_status, is_my_action) = {
            let step = flow_state
                .steps
                .iter()
                .find(|s| s.id == step_id)
                .ok_or_else(|| "Step not found".to_string())?;
            (step.depends_on.clone(), step.status.clone(), step.my_action)
        };

        if !is_my_action {
            return Err("This step is not your action".to_string());
        }

        if step_status != StepStatus::Ready && step_status != StepStatus::Pending {
            return Err(format!(
                "Step is not ready to run (status: {:?})",
                step_status
            ));
        }

        // Only check local dependencies if step is not already marked Ready
        // (If step is Ready, it was validated by update_barrier_steps via shared progress files)
        if step_status != StepStatus::Ready {
            for dep_id in &step_deps {
                let dep_step = flow_state.steps.iter().find(|s| s.id == *dep_id);

                if let Some(dep) = dep_step {
                    match dep.status {
                        StepStatus::Completed | StepStatus::Shared => {
                            // Dependency satisfied
                        }
                        _ => {
                            return Err(format!(
                                "Cannot run step '{}': dependency '{}' not completed (status: {:?})",
                                step_id, dep_id, dep.status
                            ));
                        }
                    }
                }
            }
        }

        let step = flow_state
            .steps
            .iter_mut()
            .find(|s| s.id == step_id)
            .ok_or_else(|| "Step not found".to_string())?;

        step.status = StepStatus::Running;

        // Get step number (1-indexed) for path construction
        let step_number = flow_state
            .steps
            .iter()
            .position(|s| s.id == step_id)
            .map(|i| i + 1)
            .unwrap_or(0);

        (flow_state.work_dir.clone(), step_number)
    };

    // Step output path: {flow_path}/{step_number}-{step_id}/
    let step_output_dir = work_dir
        .as_ref()
        .map(|d| get_step_path(d, step_number, &step_id));

    if let Some(ref dir) = step_output_dir {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create output dir: {}", e))?;
    }

    if step_id == "generate" {
        let output_file = step_output_dir
            .as_ref()
            .map(|d| d.join("numbers.json"))
            .ok_or_else(|| "No output directory".to_string())?;

        let numbers: Vec<i32> = (0..5).map(|_| rand::random::<i32>() % 100 + 1).collect();
        let sum: i32 = numbers.iter().sum();

        let result = serde_json::json!({
            "session_id": session_id,
            "numbers": numbers,
            "sum": sum
        });

        fs::write(&output_file, serde_json::to_string_pretty(&result).unwrap())
            .map_err(|e| format!("Failed to write output: {}", e))?;
    } else if step_id == "share_contribution" {
        // Copy numbers.json from generate step to this step's output folder
        let generate_output = work_dir
            .as_ref()
            .map(|d| get_step_path(d, 1, "generate").join("numbers.json"))
            .ok_or_else(|| "No work directory".to_string())?;

        let share_output = step_output_dir
            .as_ref()
            .map(|d| d.join("numbers.json"))
            .ok_or_else(|| "No output directory".to_string())?;

        if generate_output.exists() {
            fs::copy(&generate_output, &share_output)
                .map_err(|e| format!("Failed to copy numbers to share folder: {}", e))?;
        } else {
            return Err(format!(
                "Generate output not found at {:?}",
                generate_output
            ));
        }
    } else if step_id == "share_result" {
        // Copy result.json from aggregate step to this step's output folder
        let aggregate_output = work_dir
            .as_ref()
            .map(|d| get_step_path(d, 3, "aggregate").join("result.json"))
            .ok_or_else(|| "No work directory".to_string())?;

        let share_output = step_output_dir
            .as_ref()
            .map(|d| d.join("result.json"))
            .ok_or_else(|| "No output directory".to_string())?;

        if aggregate_output.exists() {
            fs::copy(&aggregate_output, &share_output)
                .map_err(|e| format!("Failed to copy result to share folder: {}", e))?;
        } else {
            // Aggregator might run share_result before aggregate is done - just create empty placeholder
            let placeholder = serde_json::json!({
                "status": "pending",
                "message": "Waiting for aggregation to complete"
            });
            fs::write(
                &share_output,
                serde_json::to_string_pretty(&placeholder).unwrap(),
            )
            .map_err(|e| format!("Failed to write placeholder: {}", e))?;
        }
    } else if step_id == "aggregate" {
        // Get flow state to find contributors
        let (flow_name, participants) = {
            let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
            let flow_state = sessions
                .get(&session_id)
                .ok_or_else(|| "Flow session not found".to_string())?;
            (
                flow_state.flow_name.clone(),
                flow_state.participants.clone(),
            )
        };

        let biovault_home = biovault::config::get_biovault_home()
            .map_err(|e| format!("Failed to get BioVault home: {}", e))?;

        let output_file = step_output_dir
            .as_ref()
            .map(|d| d.join("result.json"))
            .ok_or_else(|| "No output directory".to_string())?;

        let mut all_numbers: Vec<i32> = Vec::new();
        let mut contributions: Vec<serde_json::Value> = Vec::new();

        // Read contributions from each contributor's synced datasite
        // Path: {biovault_home}/datasites/{contributor_email}/shared/flows/{flow_name}/{session_id}/2-share_contribution/numbers.json
        // In sandbox mode, also check: {sandbox_root}/{contributor_email}/datasites/{contributor_email}/...
        for participant in &participants {
            // Skip non-contributors (aggregator doesn't contribute)
            if participant.role == "aggregator" {
                continue;
            }

            // Try synced location first
            let synced_path = biovault_home
                .join("datasites")
                .join(&participant.email)
                .join("shared")
                .join("flows")
                .join(&flow_name)
                .join(&session_id)
                .join("2-share_contribution")
                .join("numbers.json");

            // Fallback to sandbox location (for dev/test mode)
            let sandbox_path = biovault_home.parent().map(|parent| {
                parent
                    .join(&participant.email)
                    .join("datasites")
                    .join(&participant.email)
                    .join("shared")
                    .join("flows")
                    .join(&flow_name)
                    .join(&session_id)
                    .join("2-share_contribution")
                    .join("numbers.json")
            });

            let contributor_step_path = if synced_path.exists() {
                synced_path
            } else if let Some(ref sp) = sandbox_path {
                if sp.exists() {
                    sp.clone()
                } else {
                    continue; // Skip this contributor if no data found
                }
            } else {
                continue;
            };

            if let Ok(content) = fs::read_to_string(&contributor_step_path) {
                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(nums) = data.get("numbers").and_then(|n| n.as_array()) {
                        for n in nums {
                            if let Some(i) = n.as_i64() {
                                all_numbers.push(i as i32);
                            }
                        }
                        contributions.push(serde_json::json!({
                            "from": participant.email,
                            "data": data
                        }));
                    }
                }
            }
        }

        let total_sum: i32 = all_numbers.iter().sum();

        let result = serde_json::json!({
            "session_id": session_id,
            "contributions": contributions,
            "all_numbers": all_numbers,
            "total_sum": total_sum,
            "count": all_numbers.len()
        });

        fs::write(&output_file, serde_json::to_string_pretty(&result).unwrap())
            .map_err(|e| format!("Failed to write output: {}", e))?;
    }

    let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
    let flow_state = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Flow session not found".to_string())?;

    let step = flow_state
        .steps
        .iter_mut()
        .find(|s| s.id == step_id)
        .ok_or_else(|| "Step not found".to_string())?;

    step.status = StepStatus::Completed;
    step.output_dir = step_output_dir.clone();

    // Save step status to shared _progress folder for cross-client syncing
    if let Some(ref work_dir) = flow_state.work_dir {
        let progress_dir = get_progress_path(work_dir);
        let _ = fs::create_dir_all(&progress_dir);
        let shared_status = SharedStepStatus {
            step_id: step_id.clone(),
            role: flow_state.my_role.clone(),
            status: "Completed".to_string(),
            timestamp: Utc::now().timestamp(),
        };
        let status_file = progress_dir.join(format!("{}_{}.json", flow_state.my_role, step_id));
        if let Ok(json) = serde_json::to_string_pretty(&shared_status) {
            let _ = fs::write(&status_file, json);
        }
        // Also append to progress.json log
        append_progress_log(
            &progress_dir,
            "step_completed",
            Some(&step_id),
            &flow_state.my_role,
        );
    }

    let completed_step = step.clone();

    // Update dependent steps: if all their dependencies are now met, mark them Ready
    update_dependent_steps(flow_state, &step_id);

    Ok(completed_step)
}

#[tauri::command]
pub async fn share_step_outputs(
    _state: tauri::State<'_, AppState>,
    session_id: String,
    step_id: String,
) -> Result<(), String> {
    let (output_dir, share_to_emails, my_email, _thread_id) = {
        let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        let flow_state = sessions
            .get_mut(&session_id)
            .ok_or_else(|| "Flow session not found".to_string())?;

        let step = flow_state
            .steps
            .iter_mut()
            .find(|s| s.id == step_id)
            .ok_or_else(|| "Step not found".to_string())?;

        if step.status != StepStatus::Completed {
            return Err("Step must be completed before sharing".to_string());
        }

        if !step.shares_output {
            return Err("This step does not share outputs".to_string());
        }

        step.status = StepStatus::Sharing;

        let share_to_emails: Vec<String> = step
            .share_to
            .iter()
            .filter_map(|role| {
                flow_state
                    .participants
                    .iter()
                    .find(|p| &p.role == role)
                    .map(|p| p.email.clone())
            })
            .collect();

        (
            step.output_dir.clone(),
            share_to_emails,
            flow_state.my_email.clone(),
            flow_state.thread_id.clone(),
        )
    };

    let output_dir = output_dir.ok_or_else(|| "No output directory".to_string())?;

    // Create syft.pub.yaml in output directory to enable SyftBox sync
    create_syft_pub_yaml(&output_dir, &my_email, &share_to_emails)?;

    let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
    let flow_state = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Flow session not found".to_string())?;

    let step = flow_state
        .steps
        .iter_mut()
        .find(|s| s.id == step_id)
        .ok_or_else(|| "Step not found".to_string())?;

    step.status = StepStatus::Shared;
    step.outputs_shared = true;

    // Save step status to shared _progress folder for cross-client syncing
    if let Some(ref work_dir) = flow_state.work_dir {
        let progress_dir = get_progress_path(work_dir);
        let _ = fs::create_dir_all(&progress_dir);
        let shared_status = SharedStepStatus {
            step_id: step_id.clone(),
            role: flow_state.my_role.clone(),
            status: "Shared".to_string(),
            timestamp: Utc::now().timestamp(),
        };
        let status_file = progress_dir.join(format!("{}_{}.json", flow_state.my_role, step_id));
        if let Ok(json) = serde_json::to_string_pretty(&shared_status) {
            let _ = fs::write(&status_file, json);
        }
        // Also append to progress.json log
        append_progress_log(
            &progress_dir,
            "step_shared",
            Some(&step_id),
            &flow_state.my_role,
        );
    }

    // Update dependent steps: if all their dependencies are now met, mark them Ready
    update_dependent_steps(flow_state, &step_id);

    Ok(())
}

#[tauri::command]
pub async fn get_step_output_files(
    session_id: String,
    step_id: String,
) -> Result<Vec<String>, String> {
    let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
    let flow_state = sessions
        .get(&session_id)
        .ok_or_else(|| "Flow session not found".to_string())?;

    let step = flow_state
        .steps
        .iter()
        .find(|s| s.id == step_id)
        .ok_or_else(|| "Step not found".to_string())?;

    let output_dir = step
        .output_dir
        .as_ref()
        .ok_or_else(|| "No output directory".to_string())?;

    let mut files = Vec::new();
    if output_dir.exists() {
        for entry in fs::read_dir(output_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            files.push(entry.path().to_string_lossy().to_string());
        }
    }

    Ok(files)
}

#[tauri::command]
pub async fn receive_flow_step_outputs(
    _state: tauri::State<'_, AppState>,
    session_id: String,
    step_id: String,
    from_role: String,
    files: HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
    let flow_state = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Flow session not found".to_string())?;

    // Find step number
    let step_number = flow_state
        .steps
        .iter()
        .position(|s| s.id == step_id)
        .map(|i| i + 1)
        .unwrap_or(0);

    // Create inputs directory: {flow_path}/_inputs/{step_number}-{step_id}/{from_role}/
    let inputs_dir = flow_state
        .work_dir
        .as_ref()
        .map(|d| {
            d.join("_inputs")
                .join(format!("{}-{}", step_number, step_id))
                .join(&from_role)
        })
        .ok_or_else(|| "No work directory".to_string())?;

    fs::create_dir_all(&inputs_dir).map_err(|e| format!("Failed to create inputs dir: {}", e))?;

    for (filename, content) in files {
        let file_path = inputs_dir.join(&filename);
        fs::write(&file_path, content)
            .map_err(|e| format!("Failed to write file {}: {}", filename, e))?;
    }

    for step in &mut flow_state.steps {
        if step.status == StepStatus::WaitingForInputs {
            step.status = StepStatus::Ready;
        }
    }

    Ok(())
}

/// Build a map of group name -> list of emails from spec.datasites.groups
fn build_group_map(flow_spec: &serde_json::Value) -> HashMap<String, Vec<String>> {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();

    // Get spec.datasites.all as the full list
    let all_datasites: Vec<String> = flow_spec
        .get("spec")
        .and_then(|s| s.get("datasites"))
        .and_then(|d| d.get("all"))
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    groups.insert("all".to_string(), all_datasites.clone());

    // Parse spec.datasites.groups
    if let Some(spec_groups) = flow_spec
        .get("spec")
        .and_then(|s| s.get("datasites"))
        .and_then(|d| d.get("groups"))
        .and_then(|g| g.as_object())
    {
        for (group_name, group_def) in spec_groups {
            let mut members = Vec::new();

            // Handle "include" array
            if let Some(includes) = group_def.get("include").and_then(|i| i.as_array()) {
                for item in includes {
                    if let Some(email) = item.as_str() {
                        members.push(email.to_string());
                    }
                }
            }

            groups.insert(group_name.clone(), members);
        }
    }

    groups
}

/// Check if an email belongs to a target group
fn is_email_in_targets(
    email: &str,
    targets: &serde_json::Value,
    groups: &HashMap<String, Vec<String>>,
) -> bool {
    match targets {
        serde_json::Value::String(target_str) => {
            // Target is a group name
            if let Some(group_members) = groups.get(target_str) {
                return group_members.contains(&email.to_string());
            }
            // Or direct email match
            target_str == email
        }
        serde_json::Value::Array(target_arr) => {
            // Target is an array of group names or emails
            for item in target_arr {
                if let Some(target_str) = item.as_str() {
                    if let Some(group_members) = groups.get(target_str) {
                        if group_members.contains(&email.to_string()) {
                            return true;
                        }
                    }
                    if target_str == email {
                        return true;
                    }
                }
            }
            false
        }
        _ => false,
    }
}

/// Extract share_to emails from step.share[*].permissions.read
fn extract_share_to(step: &serde_json::Value) -> Vec<String> {
    let mut share_to = Vec::new();

    if let Some(share_block) = step.get("share").and_then(|s| s.as_object()) {
        for (_share_name, share_def) in share_block {
            if let Some(perms) = share_def.get("permissions") {
                if let Some(read_arr) = perms.get("read").and_then(|r| r.as_array()) {
                    for reader in read_arr {
                        if let Some(email) = reader.as_str() {
                            if !share_to.contains(&email.to_string()) {
                                share_to.push(email.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    share_to
}

/// Get targets as a list of group names/emails
fn get_step_targets(step: &serde_json::Value) -> Vec<String> {
    if let Some(run) = step.get("run") {
        if let Some(targets) = run.get("targets") {
            match targets {
                serde_json::Value::String(s) => return vec![s.clone()],
                serde_json::Value::Array(arr) => {
                    return arr
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect();
                }
                _ => {}
            }
        }
    }
    // Barrier steps don't have run.targets
    if step.get("barrier").is_some() {
        if let Some(barrier) = step.get("barrier") {
            if let Some(targets) = barrier.get("targets") {
                match targets {
                    serde_json::Value::String(s) => return vec![s.clone()],
                    serde_json::Value::Array(arr) => {
                        return arr
                            .iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect();
                    }
                    _ => {}
                }
            }
        }
    }
    Vec::new()
}

fn parse_flow_steps(
    flow_spec: &serde_json::Value,
    my_email: &str,
) -> Result<Vec<StepState>, String> {
    let steps = flow_spec
        .get("spec")
        .and_then(|s| s.get("steps"))
        .and_then(|s| s.as_array())
        .ok_or_else(|| "Invalid flow spec: missing steps".to_string())?;

    let groups = build_group_map(flow_spec);
    let mut result = Vec::new();

    for step in steps {
        let id = step
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let name = step
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&id)
            .to_string();

        let description = step
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let depends_on: Vec<String> = step
            .get("depends_on")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        // Check if this is a barrier step
        let is_barrier = step.get("barrier").is_some();
        let barrier_wait_for = step
            .get("barrier")
            .and_then(|b| b.get("wait_for"))
            .and_then(|w| w.as_str())
            .map(|s| s.to_string());

        // Determine if my email is in the targets for this step
        let targets = get_step_targets(step);
        let my_action = if let Some(run) = step.get("run") {
            if let Some(run_targets) = run.get("targets") {
                is_email_in_targets(my_email, run_targets, &groups)
            } else {
                false
            }
        } else if is_barrier {
            // Barrier applies to everyone - they all wait
            true
        } else {
            false
        };

        // Check for share block (canonical schema)
        let share_to = extract_share_to(step);
        let shares_output = !share_to.is_empty() || step.get("share").is_some();

        // Resolve targets to actual emails
        let target_emails: Vec<String> = targets
            .iter()
            .flat_map(|target| {
                // Check if it's a group name
                if let Some(group_members) = groups.get(target) {
                    group_members.clone()
                } else {
                    // It's a direct email
                    vec![target.clone()]
                }
            })
            .collect();

        // Determine initial status
        let initial_status = if is_barrier {
            // Barrier steps start as WaitingForInputs
            StepStatus::WaitingForInputs
        } else if depends_on.is_empty() && my_action {
            StepStatus::Ready
        } else {
            StepStatus::Pending
        };

        result.push(StepState {
            id,
            name,
            description,
            auto_run: false,
            status: initial_status,
            my_action,
            shares_output,
            share_to,
            depends_on,
            output_dir: None,
            outputs_shared: false,
            targets,
            target_emails,
            is_barrier,
            barrier_wait_for,
        });
    }

    Ok(result)
}

/// Share step outputs to the chat thread so all participants can see and download
#[tauri::command]
pub async fn share_step_outputs_to_chat(
    state: tauri::State<'_, AppState>,
    session_id: String,
    step_id: String,
) -> Result<serde_json::Value, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    // First, share the step outputs (creates syft.pub.yaml)
    share_step_outputs(state.clone(), session_id.clone(), step_id.clone()).await?;

    // Get the flow state info
    let (output_dir, thread_id, flow_name, my_email, step_name, participants) = {
        let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        let flow_state = sessions
            .get(&session_id)
            .ok_or_else(|| "Flow session not found".to_string())?;

        let step = flow_state
            .steps
            .iter()
            .find(|s| s.id == step_id)
            .ok_or_else(|| "Step not found".to_string())?;

        (
            step.output_dir.clone(),
            flow_state.thread_id.clone(),
            flow_state.flow_name.clone(),
            flow_state.my_email.clone(),
            step.name.clone(),
            flow_state.participants.clone(),
        )
    };

    let output_dir = output_dir.ok_or_else(|| "No output directory".to_string())?;

    // Read output files and encode as base64
    let mut results_data: Vec<serde_json::Value> = vec![];
    if output_dir.exists() {
        for entry in fs::read_dir(&output_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_file() {
                let file_name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                // Skip syft.pub.yaml
                if file_name == "syft.pub.yaml" {
                    continue;
                }

                let content = fs::read(&path)
                    .map_err(|e| format!("Failed to read file {}: {}", file_name, e))?;

                let base64_content = STANDARD.encode(&content);

                let is_text = file_name.ends_with(".csv")
                    || file_name.ends_with(".tsv")
                    || file_name.ends_with(".txt")
                    || file_name.ends_with(".json")
                    || file_name.ends_with(".yaml")
                    || file_name.ends_with(".yml");

                results_data.push(serde_json::json!({
                    "file_name": file_name,
                    "content_base64": base64_content,
                    "size_bytes": content.len(),
                    "is_text": is_text,
                }));
            }
        }
    }

    if results_data.is_empty() {
        return Err("No output files to share".to_string());
    }

    // Get all participant emails except self for recipients
    let recipients: Vec<String> = participants
        .iter()
        .filter(|p| p.email != my_email)
        .map(|p| p.email.clone())
        .collect();

    // Create message body
    let body = format!(
        "📊 Results from step '{}' are ready!\n\n{} file(s) attached. Click to download.",
        step_name,
        results_data.len()
    );

    // Load config and message system
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;

    let (db, sync) = biovault::cli::commands::messages::init_message_system(&config)
        .map_err(|e| format!("Failed to init message system: {}", e))?;

    // Send to each recipient (or to the thread if group chat)
    let mut sent_message = None;
    for recipient in &recipients {
        let mut msg =
            biovault::messages::models::Message::new(my_email.clone(), recipient.clone(), body.clone());

        msg.subject = Some(format!("Flow Results: {} - {}", flow_name, step_name));
        msg.thread_id = Some(thread_id.clone());

        msg.metadata = Some(serde_json::json!({
            "flow_results": {
                "flow_name": flow_name,
                "session_id": session_id,
                "step_id": step_id,
                "step_name": step_name,
                "sender": my_email,
                "files": results_data,
            }
        }));

        db.insert_message(&msg)
            .map_err(|e| format!("Failed to store message: {}", e))?;

        // Try to sync/send via RPC
        let _ = sync.send_message(&msg.id);

        if sent_message.is_none() {
            sent_message = Some(msg);
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "files_shared": results_data.len(),
        "recipients": recipients,
    }))
}
