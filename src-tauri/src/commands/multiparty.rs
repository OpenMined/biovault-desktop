use crate::types::AppState;
use biovault::messages::models::{FlowParticipant, MessageType};
use chrono::{TimeZone, Utc};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

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

/// Return candidate flow directories for a participant from this node's perspective.
/// 1) synced datasite path (real remote shape)
/// 2) local sandbox sibling path (single-machine dev fallback)
fn participant_flow_dirs(
    biovault_home: &PathBuf,
    participant_email: &str,
    flow_name: &str,
    session_id: &str,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();

    let synced = biovault_home
        .join("datasites")
        .join(participant_email)
        .join("shared")
        .join("flows")
        .join(flow_name)
        .join(session_id);
    if seen.insert(synced.clone()) {
        dirs.push(synced);
    }

    if let Some(parent) = biovault_home.parent() {
        let sandbox = parent
            .join(participant_email)
            .join("datasites")
            .join(participant_email)
            .join("shared")
            .join("flows")
            .join(flow_name)
            .join(session_id);
        if seen.insert(sandbox.clone()) {
            dirs.push(sandbox);
        }
    }

    dirs
}

/// Append a log entry to progress.json (JSONL format for event streaming)
fn append_progress_log(progress_dir: &PathBuf, event: &str, step_id: Option<&str>, role: &str) {
    let timestamp = Utc::now().to_rfc3339();
    let log_entry = serde_json::json!({
        "timestamp": timestamp,
        "event": event,
        "step_id": step_id,
        "role": role,
    });

    use std::fs::OpenOptions;
    use std::io::Write;
    // Legacy location used by existing tests/diagnostics.
    let legacy_log_file = progress_dir.join("progress.json");
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&legacy_log_file)
    {
        let _ = writeln!(file, "{}", log_entry);
    }

    // Canonical JSONL log stream.
    let log_jsonl_file = progress_dir.join("log.jsonl");
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_jsonl_file)
    {
        let _ = writeln!(file, "{}", log_entry);
    }
}

fn write_progress_state(
    progress_dir: &PathBuf,
    role: &str,
    event: &str,
    step_id: Option<&str>,
    status: &str,
) {
    let state_file = progress_dir.join("state.json");
    let state = serde_json::json!({
        "updated_at": Utc::now().to_rfc3339(),
        "role": role,
        "event": event,
        "step_id": step_id,
        "status": status,
    });
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = fs::write(state_file, json);
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
    /// Pretty JSON preview of the flow step config for UI inspection
    pub code_preview: Option<String>,
    /// Module identifier referenced by `uses`
    pub module_ref: Option<String>,
    /// Optional module source path (if available in flow spec)
    pub module_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[derive(Default)]
pub enum StepStatus {
    #[default]
    Pending,
    WaitingForInputs,
    Ready,
    Running,
    Completed,
    Sharing,
    Shared,
    Failed,
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
            let require_shared = flow_state
                .steps
                .iter()
                .find(|s| s.id == *wait_for_step_id)
                .map(|s| s.shares_output)
                .unwrap_or(false);
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
                        require_shared,
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
    require_shared: bool,
) -> bool {
    let biovault_home = match biovault::config::get_biovault_home() {
        Ok(h) => h,
        Err(_) => return false,
    };

    for progress_file in participant_flow_dirs(
        &biovault_home,
        participant_email,
        flow_name,
        session_id,
    )
    .into_iter()
    .map(|base| {
        base.join("_progress")
            .join(format!("{}_{}.json", participant_role, step_id))
    }) {
        if !progress_file.exists() {
            continue;
        }

        // Read and check the status
        if let Ok(content) = fs::read_to_string(&progress_file) {
            if let Ok(status) = serde_json::from_str::<SharedStepStatus>(&content) {
                if require_shared {
                    if status.status == "Shared" {
                        return true;
                    }
                    continue;
                }
                if status.status == "Shared" || status.status == "Completed" {
                    return true;
                }
            }
        }
    }

    false
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

    let steps = parse_flow_steps(&flow_spec, &my_email, &participant_roles)?;

    // Set up work_dir for the proposer too (same as accept_flow_invitation)
    let work_dir = get_shared_flow_path(&flow_name, &session_id)?;
    fs::create_dir_all(&work_dir).map_err(|e| format!("Failed to create work dir: {}", e))?;

    // Create progress directory
    let progress_dir = get_progress_path(&work_dir);
    let _ = fs::create_dir_all(&progress_dir);

    // Log "joined" event for the proposer
    append_progress_log(&progress_dir, "joined", None, &my_role);

    // Only coordination/progress data is globally shared.
    let all_participant_emails: Vec<String> =
        participant_roles.iter().map(|p| p.email.clone()).collect();
    let _ = create_syft_pub_yaml(&progress_dir, &my_email, &all_participant_emails);
    write_progress_state(&progress_dir, &my_role, "joined", None, "Accepted");

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
    thread_id: Option<String>,
) -> Result<MultipartyFlowState, String> {
    // Check if already accepted with a persisted run.
    // Sessions created by invitation sender may exist in memory without run_id;
    // those must still execute the full accept path so the run card exists.
    {
        let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = sessions.get(&session_id) {
            if existing.run_id.is_some() {
                return Ok(existing.clone());
            }
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

    let mut steps = parse_flow_steps(&flow_spec, &my_email, &participants)?;

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

    // Only coordination/progress data is globally shared.
    let all_participant_emails: Vec<String> =
        participants.iter().map(|p| p.email.clone()).collect();
    let _ = create_syft_pub_yaml(&progress_dir, &my_email, &all_participant_emails);

    // Look up flow_id from database.
    // If missing, import from invitation spec so Join works even when UI state is stale.
    let mut flow_id = {
        let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
        let flows = biovault_db.list_flows().map_err(|e| e.to_string())?;
        flows.iter().find(|f| f.name == flow_name).map(|f| f.id)
    };

    if flow_id.is_none() {
        let imported = super::flows::import_flow_from_json(
            state.clone(),
            super::flows::ImportFlowFromJsonRequest {
                name: flow_name.clone(),
                flow_json: flow_spec.clone(),
                overwrite: false,
            },
        )
        .await
        .map_err(|e| format!("Failed to import flow for invitation acceptance: {}", e))?;
        flow_id = Some(imported.id);
    }

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
        return Err(format!("Flow '{}' is not available locally", flow_name));
    };

    let flow_state = MultipartyFlowState {
        session_id: session_id.clone(),
        flow_name: flow_name.clone(),
        my_role,
        my_email,
        participants,
        steps,
        status: FlowSessionStatus::Accepted,
        thread_id: thread_id.unwrap_or_default(),
        work_dir: Some(work_dir.clone()),
        run_id,
    };

    // Save state to file for persistence
    let state_path = work_dir.join("multiparty.state.json");
    let state_json = serde_json::to_string_pretty(&flow_state)
        .map_err(|e| format!("Failed to serialize state: {}", e))?;
    fs::write(&state_path, state_json).map_err(|e| format!("Failed to write state file: {}", e))?;

    // Log "joined" event to progress.json
    let progress_dir = get_progress_path(&work_dir);
    append_progress_log(&progress_dir, "joined", None, &flow_state.my_role);
    write_progress_state(
        &progress_dir,
        &flow_state.my_role,
        "joined",
        None,
        "Accepted",
    );

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
    pub output_dir: Option<String>,
}

fn normalize_progress_status(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "shared" => "Shared".to_string(),
        "sharing" => "Sharing".to_string(),
        "completed" | "complete" | "success" | "succeeded" | "done" => {
            "Completed".to_string()
        }
        "running" | "in_progress" | "in-progress" => "Running".to_string(),
        "ready" => "Ready".to_string(),
        "waitingforinputs" | "waiting_for_inputs" | "waiting-for-inputs" => {
            "WaitingForInputs".to_string()
        }
        "failed" | "error" => "Failed".to_string(),
        _ => "Pending".to_string(),
    }
}

fn parse_progress_timestamp(value: Option<&serde_json::Value>) -> Option<i64> {
    let value = value?;
    if let Some(ts) = value.as_i64() {
        return Some(ts);
    }
    if let Some(ts) = value.as_u64() {
        return i64::try_from(ts).ok();
    }
    let text = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| dt.timestamp())
}

fn resolve_step_output_dir_for_base(base: &PathBuf, step_number: usize, step_id: &str) -> Option<PathBuf> {
    let plain = base.join(format!("{}-{}", step_number, step_id));
    if plain.exists() {
        return Some(plain);
    }
    let padded = base.join(format!("{:02}-{}", step_number, step_id));
    if padded.exists() {
        return Some(padded);
    }
    None
}

fn progress_status_rank(status: &str) -> i32 {
    match status {
        "Failed" => 100,
        "Shared" => 90,
        "Completed" => 80,
        "Sharing" => 70,
        "Running" => 60,
        "Ready" => 50,
        "WaitingForInputs" => 40,
        _ => 10, // Pending / unknown
    }
}

fn should_replace_step_status(
    existing: Option<&ParticipantStepStatus>,
    candidate: &ParticipantStepStatus,
) -> bool {
    let Some(existing) = existing else {
        return true;
    };

    let existing_rank = progress_status_rank(&existing.status);
    let candidate_rank = progress_status_rank(&candidate.status);

    if candidate_rank != existing_rank {
        return candidate_rank > existing_rank;
    }

    if candidate.timestamp != existing.timestamp {
        return candidate.timestamp > existing.timestamp;
    }

    // Prefer records that include a usable output path.
    candidate.output_dir.is_some() && existing.output_dir.is_none()
}

#[tauri::command]
pub async fn get_all_participant_progress(
    session_id: String,
) -> Result<Vec<ParticipantProgress>, String> {
    let (flow_name, participants, step_meta) = {
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
                .map(|s| (s.id.clone(), s.shares_output))
                .collect::<Vec<_>>(),
        )
    };

    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;

    let mut all_progress = Vec::new();

    for participant in &participants {
        let flow_dirs = participant_flow_dirs(&biovault_home, &participant.email, &flow_name, &session_id);
        let mut steps_by_id: HashMap<String, ParticipantStepStatus> = HashMap::new();

        for (step_idx, (step_id, step_shares_output)) in step_meta.iter().enumerate() {
            let step_number = step_idx + 1;
            for base in &flow_dirs {
                let progress_file = base
                    .join("_progress")
                    .join(format!("{}_{}.json", participant.role, step_id));
                if !progress_file.exists() {
                    continue;
                }
                if let Ok(content) = fs::read_to_string(&progress_file) {
                    if let Ok(status) = serde_json::from_str::<SharedStepStatus>(&content) {
                        let status_normalized = normalize_progress_status(&status.status);
                        let output_dir_candidate =
                            resolve_step_output_dir_for_base(base, step_number, step_id);

                        let expose_outputs = if *step_shares_output {
                            status_normalized == "Shared"
                        } else {
                            status_normalized == "Completed" || status_normalized == "Shared"
                        };
                        let output_dir = if expose_outputs {
                            output_dir_candidate.map(|p| p.to_string_lossy().to_string())
                        } else {
                            None
                        };

                        let candidate = ParticipantStepStatus {
                            step_id: step_id.clone(),
                            status: status_normalized,
                            timestamp: status.timestamp,
                            output_dir,
                        };

                        if should_replace_step_status(steps_by_id.get(step_id), &candidate) {
                            steps_by_id.insert(step_id.clone(), candidate);
                        }
                    }
                }
            }
        }

        // Fallback for flows that publish progress in _progress/state.json (e.g. Syqure flow runs).
        for base in &flow_dirs {
            let state_file = base.join("_progress").join("state.json");
            if !state_file.exists() {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&state_file) {
                if let Ok(state_json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(step_obj) = state_json.get("steps").and_then(|v| v.as_object()) {
                        for (step_idx, (step_id, step_shares_output)) in step_meta.iter().enumerate() {
                            let Some(step_state) = step_obj.get(step_id) else {
                                continue;
                            };
                            let raw_status = step_state
                                .get("status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("pending");
                            let mut status_normalized = normalize_progress_status(raw_status);
                            // Flows with inline `share:` semantics often only report "completed".
                            if *step_shares_output && status_normalized == "Completed" {
                                status_normalized = "Shared".to_string();
                            }

                            let step_number = step_idx + 1;
                            let output_dir_candidate =
                                resolve_step_output_dir_for_base(base, step_number, step_id);
                            let expose_outputs = if *step_shares_output {
                                status_normalized == "Shared" || status_normalized == "Completed"
                            } else {
                                status_normalized == "Completed" || status_normalized == "Shared"
                            };
                            let output_dir = if expose_outputs {
                                output_dir_candidate.map(|p| p.to_string_lossy().to_string())
                            } else {
                                None
                            };
                            let timestamp = parse_progress_timestamp(step_state.get("completed_at"))
                                .or_else(|| parse_progress_timestamp(step_state.get("updated_at")))
                                .or_else(|| parse_progress_timestamp(step_state.get("started_at")))
                                .unwrap_or_else(|| Utc::now().timestamp());

                            let candidate = ParticipantStepStatus {
                                step_id: step_id.clone(),
                                status: status_normalized,
                                timestamp,
                                output_dir,
                            };
                            if should_replace_step_status(steps_by_id.get(step_id), &candidate) {
                                steps_by_id.insert(step_id.clone(), candidate);
                            }
                        }
                    }
                }
            }
        }

        let mut steps = Vec::new();
        for (step_id, _) in &step_meta {
            if let Some(step_status) = steps_by_id.remove(step_id) {
                steps.push(step_status);
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
    let mut seen = HashSet::new();

    let mut push_log = |log: LogEntry| {
        let key = format!(
            "{}|{}|{}|{}",
            log.participant,
            log.event,
            log.step_id.clone().unwrap_or_default(),
            log.timestamp
        );
        if seen.insert(key) {
            all_logs.push(log);
        }
    };

    for participant in &participants {
        for progress_dir in participant_flow_dirs(
            &biovault_home,
            &participant.email,
            &flow_name,
            &session_id,
        )
        .into_iter()
        .map(|base| base.join("_progress"))
        {
            // Try canonical log.jsonl, then legacy progress.json.
            let log_file = {
                let synced_jsonl = progress_dir.join("log.jsonl");
                let synced_legacy = progress_dir.join("progress.json");
                if synced_jsonl.exists() {
                    Some(synced_jsonl)
                } else if synced_legacy.exists() {
                    Some(synced_legacy)
                } else {
                    None
                }
            };

            if let Some(path) = log_file {
                if let Ok(content) = fs::read_to_string(&path) {
                    // JSONL format - one JSON object per line
                    for line in content.lines() {
                        if let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) {
                            push_log(LogEntry {
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

            // Fallback: synthesize events from shared step status files.
            // This keeps the activity log populated even when log.jsonl lags behind.
            if let Ok(entries) = fs::read_dir(&progress_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                        continue;
                    };
                    if name == "state.json"
                        || name == "log.jsonl"
                        || name == "progress.json"
                        || name == "syft.pub.yaml"
                    {
                        continue;
                    }
                    if !name.ends_with(".json") {
                        continue;
                    }
                    if let Ok(content) = fs::read_to_string(&path) {
                        if let Ok(status) = serde_json::from_str::<SharedStepStatus>(&content) {
                            let event = match status.status.as_str() {
                                "Shared" => "step_shared",
                                "Completed" => "step_completed",
                                _ => continue,
                            };
                            let timestamp = Utc
                                .timestamp_opt(status.timestamp, 0)
                                .single()
                                .map(|dt| dt.to_rfc3339())
                                .unwrap_or_default();
                            push_log(LogEntry {
                                participant: participant.email.clone(),
                                role: if status.role.is_empty() {
                                    participant.role.clone()
                                } else {
                                    status.role.clone()
                                },
                                timestamp,
                                event: event.to_string(),
                                step_id: Some(status.step_id.clone()),
                                message: None,
                            });
                        }
                    }
                }
            }
        }
    }

    // Sort by timestamp descending (newest first)
    all_logs.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

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

        // Read contributions from each contributor's synced datasite.
        // Prefer legacy "2-share_contribution/numbers.json" when present, and
        // fall back to "1-generate/numbers.json" (share-as-part-of-step mode).
        for participant in &participants {
            // Skip non-contributors (aggregator doesn't contribute)
            if participant.role == "aggregator" {
                continue;
            }

            let synced_base = biovault_home
                .join("datasites")
                .join(&participant.email)
                .join("shared")
                .join("flows")
                .join(&flow_name)
                .join(&session_id);
            let sandbox_base = biovault_home.parent().map(|parent| {
                parent
                    .join(&participant.email)
                    .join("datasites")
                    .join(&participant.email)
                    .join("shared")
                    .join("flows")
                    .join(&flow_name)
                    .join(&session_id)
            });
            let path_candidates = [
                synced_base.join("1-generate").join("numbers.json"),
                synced_base.join("2-share_contribution").join("numbers.json"),
                sandbox_base
                    .as_ref()
                    .map(|p| p.join("1-generate").join("numbers.json"))
                    .unwrap_or_default(),
                sandbox_base
                    .as_ref()
                    .map(|p| p.join("2-share_contribution").join("numbers.json"))
                    .unwrap_or_default(),
            ];
            let contributor_step_path = match path_candidates.iter().find(|p| p.exists()) {
                Some(path) => path.clone(),
                None => continue, // Skip this contributor if no data found
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
        write_progress_state(
            &progress_dir,
            &flow_state.my_role,
            "step_completed",
            Some(&step_id),
            "Completed",
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
    let (
        output_dir,
        share_to_emails,
        my_email,
        thread_id,
        flow_name,
        step_name,
        participants,
    ) = {
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

        let share_to_emails =
            resolve_share_recipients(&step.share_to, &flow_state.participants, &flow_state.my_email);

        (
            step.output_dir.clone(),
            share_to_emails,
            flow_state.my_email.clone(),
            flow_state.thread_id.clone(),
            flow_state.flow_name.clone(),
            step.name.clone(),
            flow_state.participants.clone(),
        )
    };

    let output_dir = output_dir.ok_or_else(|| "No output directory".to_string())?;

    // Create syft.pub.yaml in output directory to enable SyftBox sync
    create_syft_pub_yaml(&output_dir, &my_email, &share_to_emails)?;

    {
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
            write_progress_state(
                &progress_dir,
                &flow_state.my_role,
                "step_shared",
                Some(&step_id),
                "Shared",
            );
        }

        // Update dependent steps: if all their dependencies are now met, mark them Ready
        update_dependent_steps(flow_state, &step_id);
    }

    // Sharing outputs should also publish a chat artifact message for flow participants.
    if !thread_id.trim().is_empty() {
        let _ = publish_step_outputs_message(
            &session_id,
            &step_id,
            &output_dir,
            &thread_id,
            &flow_name,
            &my_email,
            &step_name,
            &participants,
            true,
        )?;
    }

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

/// Build a map of group name -> list of emails from participants
/// Also builds groups based on common role prefixes (e.g., contributor1, contributor2 -> contributors)
/// Returns (groups, default_to_actual_map) where default_to_actual_map maps default datasite emails to actual participant emails
fn build_group_map_from_participants(
    participants: &[FlowParticipant],
    flow_spec: &serde_json::Value,
) -> (HashMap<String, Vec<String>>, HashMap<String, String>) {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    let mut default_to_actual: HashMap<String, String> = HashMap::new();

    let all_emails: Vec<String> = participants.iter().map(|p| p.email.clone()).collect();
    groups.insert("all".to_string(), all_emails.clone());

    // Build role-based groups first (robust fallback when flow datasite groups are unavailable).
    let mut role_groups: HashMap<String, Vec<String>> = HashMap::new();
    for p in participants {
        role_groups
            .entry(p.role.clone())
            .or_default()
            .push(p.email.clone());

        let base_role = p.role.trim_end_matches(|c: char| c.is_ascii_digit());
        if base_role != p.role {
            let plural_role = format!("{}s", base_role);
            role_groups
                .entry(plural_role)
                .or_default()
                .push(p.email.clone());
        }
    }

    // Parse default datasite list from canonical flow schema.
    let default_datasites: Vec<String> = flow_spec
        .get("spec")
        .and_then(|s| s.get("inputs"))
        .and_then(|i| i.get("datasites"))
        .and_then(|d| d.get("default"))
        .and_then(|arr| arr.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .or_else(|| {
            flow_spec
                .get("spec")
                .and_then(|s| s.get("datasites"))
                .and_then(|d| d.get("all"))
                .and_then(|arr| arr.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
        })
        .unwrap_or_default();

    // Default mapping:
    // 1) direct literal-email matches
    // 2) stable index fallback
    for (i, default_email) in default_datasites.iter().enumerate() {
        if let Some(p) = participants.iter().find(|p| p.email == *default_email) {
            default_to_actual.insert(default_email.clone(), p.email.clone());
        } else if let Some(p) = participants.get(i) {
            default_to_actual.insert(default_email.clone(), p.email.clone());
        }
    }

    // Parse explicit datasite groups from flow spec when available.
    if let Some(spec_groups) = flow_spec
        .get("spec")
        .and_then(|s| s.get("datasites"))
        .and_then(|d| d.get("groups"))
        .and_then(|g| g.as_object())
    {
        for (group_name, group_def) in spec_groups {
            let includes = group_def
                .get("include")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let fallback_group_members = role_groups.get(group_name).cloned().unwrap_or_default();
            let mut resolved_members: Vec<String> = Vec::new();

            for (include_idx, include_item) in includes.iter().enumerate() {
                let Some(token) = include_item.as_str() else {
                    continue;
                };
                let trimmed = token.trim();

                if trimmed == "{datasites[*]}" || trimmed.eq_ignore_ascii_case("all") {
                    resolved_members.extend(all_emails.clone());
                    continue;
                }

                if trimmed.contains('@') {
                    // Either a real email or a default placeholder that already looks like email.
                    let mapped = default_to_actual
                        .get(trimmed)
                        .cloned()
                        .unwrap_or_else(|| trimmed.to_string());
                    resolved_members.push(mapped);
                    continue;
                }

                if trimmed.starts_with("{datasites[") && trimmed.ends_with("]}") {
                    let idx_str = &trimmed["{datasites[".len()..trimmed.len() - 2];
                    if let Ok(idx) = idx_str.parse::<usize>() {
                        if let Some(default_email) = default_datasites.get(idx) {
                            if let Some(actual) = default_to_actual.get(default_email) {
                                resolved_members.push(actual.clone());
                                continue;
                            }
                        }
                    }
                }

                if let Some(mapped_group) = role_groups.get(trimmed) {
                    resolved_members.extend(mapped_group.clone());
                    continue;
                }

                // Ambiguous include token; preserve ordering against role-group fallback.
                if let Some(member) = fallback_group_members.get(include_idx) {
                    resolved_members.push(member.clone());
                }
            }

            if !resolved_members.is_empty() {
                resolved_members.sort();
                resolved_members.dedup();
                groups.insert(group_name.clone(), resolved_members);
            }
        }
    }

    // Merge role groups where spec groups did not define them.
    for (role, members) in role_groups {
        groups.entry(role).or_insert(members);
    }

    if let Some(contributors) = groups.get("contributors").cloned() {
        groups.insert("clients".to_string(), contributors);
    }

    println!(
        "[Multiparty] build_group_map_from_participants: groups={:?}, default_to_actual={:?}",
        groups, default_to_actual
    );

    (groups, default_to_actual)
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

fn resolve_share_recipients(
    raw_targets: &[String],
    participants: &[FlowParticipant],
    my_email: &str,
) -> Vec<String> {
    let mut resolved: HashSet<String> = HashSet::new();

    for target in raw_targets {
        let t = target.trim();
        if t.is_empty() {
            continue;
        }

        if t.eq_ignore_ascii_case("all") || t == "{datasites[*]}" || t == "*" {
            for p in participants {
                resolved.insert(p.email.clone());
            }
            continue;
        }

        if t == "{datasite.current}" {
            resolved.insert(my_email.to_string());
            continue;
        }

        if t.contains('@') {
            resolved.insert(t.to_string());
            continue;
        }

        if t.starts_with("{datasites[") && t.ends_with("]}") {
            let idx_str = &t["{datasites[".len()..t.len() - 2];
            if let Ok(idx) = idx_str.parse::<usize>() {
                if let Some(p) = participants.get(idx) {
                    resolved.insert(p.email.clone());
                }
            }
            continue;
        }

        if let Some(p) = participants.iter().find(|p| p.role == t) {
            resolved.insert(p.email.clone());
            continue;
        }

        let singular = t.trim_end_matches('s');
        for p in participants {
            let role = p.role.as_str();
            let role_singular = role.trim_end_matches(|c: char| c.is_ascii_digit());
            if role == t
                || role_singular == singular
                || (t == "clients"
                    && (role.starts_with("client") || role.starts_with("contributor")))
            {
                resolved.insert(p.email.clone());
            }
        }
    }

    resolved.into_iter().collect()
}

/// Get targets as a list of group names/emails
/// Handles both original YAML structure (run.targets) and converted FlowSpec (runs_on)
fn get_step_targets(step: &serde_json::Value) -> Vec<String> {
    // Try converted FlowSpec structure first (runs_on)
    if let Some(runs_on) = step.get("runs_on") {
        match runs_on {
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

    // Fallback to original YAML structure (run.targets)
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

    // Barrier steps
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

    Vec::new()
}

fn parse_flow_steps(
    flow_spec: &serde_json::Value,
    my_email: &str,
    participants: &[FlowParticipant],
) -> Result<Vec<StepState>, String> {
    let steps = flow_spec
        .get("spec")
        .and_then(|s| s.get("steps"))
        .and_then(|s| s.as_array())
        .ok_or_else(|| "Invalid flow spec: missing steps".to_string())?;

    // Build groups from participants (not from flow spec, which loses group info)
    // Also get default-to-actual email mapping for resolved targets
    let (groups, default_to_actual) = build_group_map_from_participants(participants, flow_spec);
    println!(
        "[Multiparty] parse_flow_steps: my_email={}, groups={:?}",
        my_email, groups
    );
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
        let my_action = if !targets.is_empty() {
            // Check if my email is in the targets (handles both direct emails and group names)
            targets.iter().any(|target| {
                // Check if it's a direct email match
                if target == my_email {
                    return true;
                }
                // Check if it's a group name and I'm in that group
                if let Some(group_members) = groups.get(target) {
                    if group_members.contains(&my_email.to_string()) {
                        return true;
                    }
                }
                // Check if target is a default datasite email that maps to my email
                // (handles case where runs_on was resolved to default emails)
                if let Some(actual_email) = default_to_actual.get(target) {
                    if actual_email == my_email {
                        return true;
                    }
                }
                false
            })
        } else if is_barrier {
            // Barrier applies to everyone - they all wait
            true
        } else {
            false
        };

        // Check for share block (canonical schema)
        let share_to = extract_share_to(step);
        let shares_output = !share_to.is_empty() || step.get("share").is_some();

        // Resolve targets to actual participant emails
        let mut target_emails: Vec<String> = targets
            .iter()
            .flat_map(|target| {
                // Check if it's a group name
                if let Some(group_members) = groups.get(target) {
                    group_members.clone()
                } else if let Some(actual_email) = default_to_actual.get(target) {
                    // Target is a default datasite email, map to actual participant
                    vec![actual_email.clone()]
                } else {
                    // It's a direct email or unknown - keep as is
                    vec![target.clone()]
                }
            })
            .collect();
        target_emails.sort();
        target_emails.dedup();

        let module_ref = step
            .get("uses")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let module_path = module_ref.as_ref().and_then(|module_id| {
            flow_spec
                .get("spec")
                .and_then(|s| s.get("modules"))
                .and_then(|m| m.get(module_id))
                .and_then(|m| m.get("source"))
                .and_then(|s| s.get("path"))
                .and_then(|p| p.as_str())
                .map(|s| s.to_string())
        });
        let code_preview = serde_yaml::to_string(step).ok();

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
            code_preview,
            module_ref,
            module_path,
        });
    }

    Ok(result)
}

fn publish_step_outputs_message(
    session_id: &str,
    step_id: &str,
    output_dir: &PathBuf,
    thread_id: &str,
    flow_name: &str,
    my_email: &str,
    step_name: &str,
    participants: &[FlowParticipant],
    send_message: bool,
) -> Result<serde_json::Value, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

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
    let mut group_participants: Vec<String> =
        participants.iter().map(|p| p.email.clone()).collect();
    if !group_participants.iter().any(|e| e == &my_email) {
        group_participants.push(my_email.to_string());
    }
    group_participants.sort();
    group_participants.dedup();

    // Create message body
    let body = format!(
        "📊 Results from step '{}' are ready!\n\n{} file(s) attached. Click to download.",
        step_name,
        results_data.len()
    );

    if !send_message || thread_id.trim().is_empty() || recipients.is_empty() {
        return Ok(serde_json::json!({
            "success": true,
            "files_shared": results_data.len(),
            "recipients": recipients,
        }));
    }

    // Load config and message system
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;

    let (db, sync) = biovault::cli::commands::messages::init_message_system(&config)
        .map_err(|e| format!("Failed to init message system: {}", e))?;

    // Send to each recipient (or to the thread if group chat)
    for recipient in &recipients {
        let mut msg = biovault::messages::models::Message::new(
            my_email.to_string(),
            recipient.clone(),
            body.clone(),
        );

        msg.subject = Some(format!("Flow Results: {} - {}", flow_name, step_name));
        msg.thread_id = Some(thread_id.to_string());

        msg.metadata = Some(serde_json::json!({
            "group_chat": {
                "participants": group_participants,
                "is_group": true
            },
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
    }

    Ok(serde_json::json!({
        "success": true,
        "files_shared": results_data.len(),
        "recipients": recipients,
    }))
}

/// Share step outputs to the chat thread so all participants can see and download
#[tauri::command]
pub async fn share_step_outputs_to_chat(
    state: tauri::State<'_, AppState>,
    session_id: String,
    step_id: String,
) -> Result<serde_json::Value, String> {
    // If the step has not been shared yet, share it first.
    // `share_step_outputs` already posts one results message when a thread is present.
    let should_share_first = {
        let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        let flow_state = sessions
            .get(&session_id)
            .ok_or_else(|| "Flow session not found".to_string())?;
        let step = flow_state
            .steps
            .iter()
            .find(|s| s.id == step_id)
            .ok_or_else(|| "Step not found".to_string())?;
        match step.status {
            StepStatus::Completed => true,
            StepStatus::Shared => false,
            _ => {
                return Err("Step must be completed/shared before posting to chat".to_string());
            }
        }
    };

    if should_share_first {
        share_step_outputs(state.clone(), session_id.clone(), step_id.clone()).await?;
    }

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

    // If we just shared, do not duplicate the chat message.
    publish_step_outputs_message(
        &session_id,
        &step_id,
        &output_dir,
        &thread_id,
        &flow_name,
        &my_email,
        &step_name,
        &participants,
        !should_share_first,
    )
}
