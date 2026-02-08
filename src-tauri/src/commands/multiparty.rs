use crate::types::AppState;
use biovault::cli::commands::run_dynamic;
use biovault::messages::models::{FlowParticipant, MessageType};
use biovault::subscriptions;
use chrono::{TimeZone, Utc};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SEQURE_COMMUNICATION_PORT_STRIDE: usize = 1000;

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

fn ensure_flow_subscriptions(
    flow_name: &str,
    session_id: &str,
    participant_emails: &[String],
) -> Result<(), String> {
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let my_email = config.email.clone();
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to resolve SyftBox data dir: {}", e))?;
    let syftsub_path = data_dir.join(".data").join("syft.sub.yaml");

    let mut cfg =
        subscriptions::load(&syftsub_path).unwrap_or_else(|_| subscriptions::default_config());
    let run_path = format!("shared/flows/{}/{}", flow_name, session_id);
    let mut changed = false;

    for peer in participant_emails {
        if peer.trim().is_empty() || peer.eq_ignore_ascii_case(&my_email) {
            continue;
        }

        let rule = subscriptions::Rule {
            action: subscriptions::Action::Allow,
            datasite: Some(peer.clone()),
            path: format!("{}/**", run_path),
        };

        let exists = cfg.rules.iter().any(|existing| {
            existing.action == rule.action
                && existing
                    .datasite
                    .as_deref()
                    .map(|ds| ds.eq_ignore_ascii_case(peer))
                    .unwrap_or(false)
                && existing.path == rule.path
        });

        if !exists {
            cfg.rules.push(rule);
            changed = true;
        }
    }

    if changed {
        subscriptions::save(&syftsub_path, &cfg)
            .map_err(|e| format!("Failed to write syft.sub.yaml: {}", e))?;
    }

    Ok(())
}

/// Get the step output path within a shared flow
/// Structure: {flow_path}/{step_number}-{step_id}/
fn get_step_path(flow_path: &PathBuf, step_number: usize, step_id: &str) -> PathBuf {
    flow_path.join(format!("{}-{}", step_number, step_id))
}

fn get_padded_step_path(flow_path: &PathBuf, step_number: usize, step_id: &str) -> PathBuf {
    flow_path.join(format!("{:02}-{}", step_number, step_id))
}

fn merge_directory_missing_entries(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    if !source_dir.exists() {
        return Ok(());
    }
    fs::create_dir_all(target_dir).map_err(|e| {
        format!(
            "Failed to create merge target {}: {}",
            target_dir.display(),
            e
        )
    })?;

    for entry in fs::read_dir(source_dir).map_err(|e| {
        format!(
            "Failed to read merge source {}: {}",
            source_dir.display(),
            e
        )
    })? {
        let entry = entry.map_err(|e| format!("Failed to read merge entry: {}", e))?;
        let src_path = entry.path();
        let dst_path = target_dir.join(entry.file_name());

        if src_path.is_dir() {
            merge_directory_missing_entries(&src_path, &dst_path)?;
            continue;
        }

        if !dst_path.exists() {
            if let Some(parent) = dst_path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    format!(
                        "Failed to create merge destination parent {}: {}",
                        parent.display(),
                        e
                    )
                })?;
            }
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {}",
                    src_path.display(),
                    dst_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn canonicalize_step_dir_name(flow_path: &PathBuf, step_number: usize, step_id: &str) -> PathBuf {
    let canonical = get_step_path(flow_path, step_number, step_id);
    let padded = get_padded_step_path(flow_path, step_number, step_id);

    // If both exist, reconcile mixed historical layouts by merging padded-only files.
    if canonical.exists() && padded.exists() {
        // Reconcile mixed historical layouts by merging padded-only files.
        let _ = merge_directory_missing_entries(&padded, &canonical);
        let _ = fs::remove_dir_all(&padded);
        return canonical;
    }

    // Preserve existing naming style to avoid creating duplicate step folders.
    if canonical.exists() {
        canonical
    } else if padded.exists() {
        padded
    } else {
        canonical
    }
}

fn reconcile_local_step_dirs(flow_state: &MultipartyFlowState) {
    let Some(work_dir) = flow_state.work_dir.as_ref() else {
        return;
    };
    for (idx, step) in flow_state.steps.iter().enumerate() {
        let _ = canonicalize_step_dir_name(work_dir, idx + 1, &step.id);
    }
}

fn list_step_dirs_for_id(flow_dir: &Path, step_id: &str) -> Vec<PathBuf> {
    let mut matches = Vec::new();
    let suffix = format!("-{}", step_id);
    if let Ok(entries) = fs::read_dir(flow_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.ends_with(&suffix) {
                matches.push(path);
            }
        }
    }
    matches
}

fn has_step_share_marker(flow_dir: &Path, step_id: &str) -> bool {
    list_step_dirs_for_id(flow_dir, step_id)
        .into_iter()
        .any(|dir| dir.join("syft.pub.yaml").exists())
}

/// Get the progress path for coordination
/// Structure: {flow_path}/_progress/
fn get_progress_path(flow_path: &PathBuf) -> PathBuf {
    flow_path.join("_progress")
}

/// Private local step-log path (not synced/shared with other participants).
fn get_private_step_log_path(session_id: &str, step_id: &str) -> Result<PathBuf, String> {
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    let dir = biovault_home
        .join(".biovault")
        .join("multiparty_step_logs")
        .join(session_id);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create private step log directory: {}", e))?;
    Ok(dir.join(format!("{}.log", step_id)))
}

fn append_private_step_log(session_id: &str, step_id: &str, message: &str) {
    let Ok(path) = get_private_step_log_path(session_id, step_id) else {
        return;
    };
    let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "{} {}", Utc::now().to_rfc3339(), message);
}

fn read_tail_lines(path: &PathBuf, lines: usize) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let file =
        fs::File::open(path).map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
    let reader = BufReader::new(file);
    let all_lines: Vec<String> = reader.lines().map_while(Result::ok).collect();
    if all_lines.is_empty() {
        return Ok(String::new());
    }
    let selected: Vec<String> = all_lines
        .into_iter()
        .rev()
        .take(lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Ok(selected.join("\n"))
}

fn count_files_recursive(root: &Path, suffix: &str) -> usize {
    if !root.exists() {
        return 0;
    }
    let mut total = 0usize;
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total += count_files_recursive(&path, suffix);
            continue;
        }
        if suffix.is_empty() {
            total += 1;
            continue;
        }
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(suffix))
            .unwrap_or(false)
        {
            total += 1;
        }
    }
    total
}

fn tcp_port_is_listening(port: u16) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    TcpStream::connect_timeout(&addr.into(), Duration::from_millis(120)).is_ok()
}

fn expected_syqure_peer_ports(
    global_base: usize,
    local_party_id: usize,
    party_count: usize,
) -> Option<Vec<(usize, u16)>> {
    let parties = party_count.max(2);
    // Mirror runtime behavior: each party gets its own communication base.
    let local_base = global_base + local_party_id * SEQURE_COMMUNICATION_PORT_STRIDE;
    let mut expected = Vec::new();
    for remote_id in 0..parties {
        if remote_id == local_party_id {
            continue;
        }
        let port = mpc_comm_port_with_base(local_base, local_party_id, remote_id, parties);
        expected.push((remote_id, u16::try_from(port).ok()?));
    }
    Some(expected)
}

fn wait_for_syqure_proxy_ports(
    session_id: &str,
    step_id: &str,
    global_base: usize,
    local_party_id: usize,
    party_count: usize,
) -> Result<(), String> {
    let timeout_ms = env::var("BV_SYQURE_PROXY_READY_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(45_000)
        .clamp(1_000, 180_000);

    let expected = expected_syqure_peer_ports(global_base, local_party_id, party_count)
        .ok_or_else(|| "Failed to compute expected Syqure peer ports".to_string())?;
    if expected.is_empty() {
        return Ok(());
    }

    append_private_step_log(
        session_id,
        step_id,
        &format!(
            "secure_aggregate tcp expected ports: {}",
            expected
                .iter()
                .map(|(peer, port)| format!("CP{}<->CP{}={}", local_party_id, peer, port))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    );

    let started = Instant::now();
    let mut next_log_ms = 0u64;
    loop {
        let mut pending: Vec<String> = Vec::new();
        for (peer_id, port) in &expected {
            if !tcp_port_is_listening(*port) {
                pending.push(format!("CP{}:{} (for CP{})", local_party_id, port, peer_id));
            }
        }
        if pending.is_empty() {
            append_private_step_log(
                session_id,
                step_id,
                &format!(
                    "secure_aggregate tcp proxy ready in {}ms",
                    started.elapsed().as_millis()
                ),
            );
            return Ok(());
        }

        let elapsed_ms = started.elapsed().as_millis() as u64;
        if elapsed_ms >= timeout_ms {
            let message = format!(
                "secure_aggregate tcp proxy not ready after {}ms; pending listeners: {}",
                elapsed_ms,
                pending.join(", ")
            );
            append_private_step_log(session_id, step_id, &message);
            return Err(message);
        }

        if elapsed_ms >= next_log_ms {
            append_private_step_log(
                session_id,
                step_id,
                &format!(
                    "secure_aggregate waiting for tcp listeners ({}ms): {}",
                    elapsed_ms,
                    pending.join(", ")
                ),
            );
            next_log_ms = elapsed_ms.saturating_add(5_000);
        }

        std::thread::sleep(Duration::from_millis(250));
    }
}

fn syqure_proxy_ready_step_id(step_id: &str) -> String {
    format!("__syqure_proxy_ready_{}", step_id)
}

fn write_syqure_proxy_ready(progress_dir: &PathBuf, role: &str, step_id: &str) {
    let ready_step_id = syqure_proxy_ready_step_id(step_id);
    let shared_status = SharedStepStatus {
        step_id: ready_step_id.clone(),
        role: role.to_string(),
        status: "Completed".to_string(),
        timestamp: Utc::now().timestamp(),
    };

    let status_file = progress_dir.join(format!("{}_{}.json", role, ready_step_id));
    if let Ok(json) = serde_json::to_string_pretty(&shared_status) {
        let _ = fs::write(&status_file, json);
    }

    append_progress_log(progress_dir, "syqure_proxy_ready", Some(step_id), role);
}

fn wait_for_syqure_proxy_cluster_ready(
    flow_name: &str,
    session_id: &str,
    step_id: &str,
    viewer_email: &str,
    participants: &[FlowParticipant],
) -> Result<(), String> {
    let timeout_ms = env::var("BV_SYQURE_PROXY_CLUSTER_READY_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(60_000)
        .clamp(1_000, 300_000);

    let readiness_step_id = syqure_proxy_ready_step_id(step_id);
    let started = Instant::now();
    let mut next_log_ms = 0u64;
    loop {
        let mut pending: Vec<String> = Vec::new();
        for participant in participants {
            if !check_participant_step_complete(
                flow_name,
                session_id,
                viewer_email,
                &participant.email,
                &participant.role,
                &readiness_step_id,
                false,
            ) {
                pending.push(participant.email.clone());
            }
        }

        if pending.is_empty() {
            append_private_step_log(
                session_id,
                step_id,
                &format!(
                    "secure_aggregate proxy readiness sync complete in {}ms",
                    started.elapsed().as_millis()
                ),
            );
            return Ok(());
        }

        let elapsed_ms = started.elapsed().as_millis() as u64;
        if elapsed_ms >= timeout_ms {
            let message = format!(
                "secure_aggregate proxy readiness sync timed out after {}ms; pending peers: {}",
                elapsed_ms,
                pending.join(", ")
            );
            append_private_step_log(session_id, step_id, &message);
            return Err(message);
        }

        if elapsed_ms >= next_log_ms {
            append_private_step_log(
                session_id,
                step_id,
                &format!(
                    "secure_aggregate waiting for peer proxy readiness ({}ms): {}",
                    elapsed_ms,
                    pending.join(", ")
                ),
            );
            next_log_ms = elapsed_ms.saturating_add(5_000);
        }

        std::thread::sleep(Duration::from_millis(250));
    }
}

fn select_step_log_lines(log_text: &str, step_id: &str, lines: usize) -> String {
    let all_lines: Vec<String> = log_text.lines().map(|s| s.to_string()).collect();
    if all_lines.is_empty() {
        return String::new();
    }

    let window = lines.saturating_mul(4);
    let start_index = all_lines.len().saturating_sub(window);
    let tail_window: Vec<String> = all_lines.into_iter().skip(start_index).collect();

    let step_lc = step_id.to_ascii_lowercase();
    let needle_a = format!("step {}", step_lc);
    let needle_b = format!("step '{}'", step_lc);
    let needle_c = format!("step \"{}\"", step_lc);
    let needle_d = format!("{}@", step_lc);
    let needle_e = format!("\"step\":\"{}\"", step_lc);

    let filtered: Vec<String> = tail_window
        .iter()
        .filter_map(|line| {
            let lc = line.to_ascii_lowercase();
            if lc.contains(&needle_a)
                || lc.contains(&needle_b)
                || lc.contains(&needle_c)
                || lc.contains(&needle_d)
                || lc.contains(&needle_e)
            {
                Some(line.clone())
            } else {
                None
            }
        })
        .collect();

    let selected: Vec<String> = if filtered.is_empty() {
        tail_window
            .into_iter()
            .rev()
            .take(lines)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    } else {
        filtered
            .into_iter()
            .rev()
            .take(lines)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    };

    selected.join("\n")
}

fn collect_mpc_tcp_channel_diagnostics(mpc_dir: &Path) -> Vec<MultipartyMpcChannelDiagnostics> {
    let mut channels = Vec::new();
    let Ok(entries) = fs::read_dir(mpc_dir) else {
        return channels;
    };
    for entry in entries.flatten() {
        let channel_dir = entry.path();
        if !channel_dir.is_dir() {
            continue;
        }
        let Some(channel_name) = channel_dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !channel_name.contains("_to_") {
            continue;
        }
        let marker_path = channel_dir.join("stream.tcp");
        let accept_path = channel_dir.join("stream.accept");
        let marker_exists = marker_path.exists();
        let accept_exists = accept_path.exists();
        let request_count = count_files_recursive(&channel_dir, ".request");
        let response_count = count_files_recursive(&channel_dir, ".response");

        let mut marker_port = None::<u16>;
        let mut marker_from = None::<String>;
        let mut marker_to = None::<String>;
        if marker_exists {
            if let Ok(raw) = fs::read_to_string(&marker_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                    marker_port = json
                        .get("port")
                        .and_then(|v| v.as_u64())
                        .and_then(|v| u16::try_from(v).ok());
                    marker_from = json
                        .get("from")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    marker_to = json
                        .get("to")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
            }
        }
        let listener_up = marker_port.map(tcp_port_is_listening);
        let status = if listener_up == Some(true) {
            "connected"
        } else if marker_exists || accept_exists {
            "establishing"
        } else {
            "waiting"
        };

        channels.push(MultipartyMpcChannelDiagnostics {
            channel_id: channel_name.to_string(),
            from_email: marker_from,
            to_email: marker_to,
            port: marker_port,
            marker: marker_exists,
            accept: accept_exists,
            listener_up,
            requests: request_count,
            responses: response_count,
            status: status.to_string(),
        });
    }

    channels.sort_by(|a, b| a.channel_id.cmp(&b.channel_id));
    channels
}

fn collect_mpc_tcp_marker_status(mpc_dir: &Path) -> Vec<String> {
    collect_mpc_tcp_channel_diagnostics(mpc_dir)
        .into_iter()
        .map(|channel| {
            let port_text = channel
                .port
                .map(|p| p.to_string())
                .unwrap_or_else(|| "n/a".to_string());
            let listener = match channel.listener_up {
                Some(true) => "up",
                Some(false) => "down",
                None => "unknown",
            };
            format!(
                "{} marker={} accept={} port={} listener={} requests={} responses={}",
                channel.channel_id,
                if channel.marker { "yes" } else { "no" },
                if channel.accept { "yes" } else { "no" },
                port_text,
                listener,
                channel.requests,
                channel.responses
            )
        })
        .collect()
}

fn short_hotlink_mode(mode: &str) -> &'static str {
    match mode {
        "hotlink_quic_only" => "quic-only",
        "hotlink_quic_pref" => "quic-pref",
        "hotlink_ws_only" => "ws-only",
        _ => "unknown",
    }
}

fn read_hotlink_telemetry(path: &Path) -> Option<HotlinkTelemetrySnapshot> {
    let raw = fs::read_to_string(path).ok()?;
    let v = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    Some(HotlinkTelemetrySnapshot {
        mode: v
            .get("mode")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string(),
        updated_ms: v.get("updated_ms").and_then(|x| x.as_u64()),
        tx_packets: v.get("tx_packets").and_then(|x| x.as_u64()).unwrap_or(0),
        tx_bytes: v.get("tx_bytes").and_then(|x| x.as_u64()).unwrap_or(0),
        tx_quic_packets: v
            .get("tx_quic_packets")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        tx_ws_packets: v.get("tx_ws_packets").and_then(|x| x.as_u64()).unwrap_or(0),
        tx_avg_send_ms: v
            .get("tx_avg_send_ms")
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0),
        rx_packets: v.get("rx_packets").and_then(|x| x.as_u64()).unwrap_or(0),
        rx_bytes: v.get("rx_bytes").and_then(|x| x.as_u64()).unwrap_or(0),
        rx_avg_write_ms: v
            .get("rx_avg_write_ms")
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0),
        ws_fallbacks: v.get("ws_fallbacks").and_then(|x| x.as_u64()).unwrap_or(0),
    })
}

fn hotlink_telemetry_candidates(biovault_home: &Path, email: &str) -> Vec<PathBuf> {
    let datasites_root = biovault_home.join("datasites");
    vec![
        datasites_root
            .join(email)
            .join(".syftbox")
            .join("hotlink_telemetry.json"),
        datasites_root
            .join(email)
            .join("datasites")
            .join(email)
            .join(".syftbox")
            .join("hotlink_telemetry.json"),
        biovault_home
            .join(email)
            .join(".syftbox")
            .join("hotlink_telemetry.json"),
    ]
}

fn resolve_module_directory(
    flow_name: &str,
    module_path: Option<&str>,
    module_ref: Option<&str>,
) -> Option<PathBuf> {
    let biovault_home = biovault::config::get_biovault_home().ok()?;
    let flow_root = biovault_home.join("flows").join(flow_name);

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(path_str) = module_path.map(str::trim).filter(|s| !s.is_empty()) {
        let raw = PathBuf::from(path_str);
        if raw.is_absolute() {
            candidates.push(raw);
        } else {
            candidates.push(flow_root.join(path_str.trim_start_matches("./")));
        }
    }

    if let Some(module_ref) = module_ref.map(str::trim).filter(|s| !s.is_empty()) {
        let raw = PathBuf::from(module_ref);
        if raw.is_absolute() {
            candidates.push(raw);
        } else {
            let trimmed = module_ref.trim_start_matches("./");
            // Handle path-like refs such as "./modules/gen-variants".
            candidates.push(flow_root.join(trimmed));
            // If ref already includes "modules/", avoid duplicating.
            if let Some(stripped) = trimmed.strip_prefix("modules/") {
                candidates.push(flow_root.join("modules").join(stripped));
            } else {
                candidates.push(flow_root.join("modules").join(trimmed));
            }
            // Handle short refs such as "gen_variants".
            candidates.push(flow_root.join("modules").join(module_ref.replace('_', "-")));
        }
    }

    candidates.sort();
    candidates.dedup();
    candidates.into_iter().find(|candidate| candidate.exists())
}

fn read_syqure_runner_config(module_dir: &Path) -> Result<(String, String, u64), String> {
    let module_yaml_path = if module_dir.join("module.yaml").exists() {
        module_dir.join("module.yaml")
    } else if module_dir.join("module.yml").exists() {
        module_dir.join("module.yml")
    } else {
        return Err(format!(
            "Missing module.yaml/module.yml in {}",
            module_dir.display()
        ));
    };

    let yaml = fs::read_to_string(&module_yaml_path).map_err(|e| {
        format!(
            "Failed to read module config {}: {}",
            module_yaml_path.display(),
            e
        )
    })?;
    let parsed: serde_yaml::Value =
        serde_yaml::from_str(&yaml).map_err(|e| format!("Invalid module yaml: {}", e))?;

    let runner = parsed
        .get("spec")
        .and_then(|v| v.get("runner"))
        .cloned()
        .unwrap_or(serde_yaml::Value::Null);

    let entrypoint = runner
        .get("entrypoint")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "smpc_aggregate.codon".to_string());

    let syqure_cfg = runner
        .get("syqure")
        .cloned()
        .unwrap_or(serde_yaml::Value::Null);
    let transport = syqure_cfg
        .get("transport")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "file".to_string());
    let poll_ms = syqure_cfg
        .get("poll_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(50);

    Ok((entrypoint, transport, poll_ms))
}

fn is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn mpc_comm_port_with_base(
    base: usize,
    local_pid: usize,
    remote_pid: usize,
    parties: usize,
) -> usize {
    let min_pid = std::cmp::min(local_pid, remote_pid);
    let max_pid = std::cmp::max(local_pid, remote_pid);
    let offset_major = min_pid * parties - min_pid * (min_pid + 1) / 2;
    let offset_minor = max_pid - min_pid;
    base + offset_major + offset_minor
}

fn stable_syqure_port_base_for_run(run_id: &str, party_count: usize) -> Result<usize, String> {
    run_dynamic::prepare_syqure_port_base_for_run(run_id, party_count, None).map_err(|e| {
        format!(
            "Failed to allocate Syqure TCP proxy base port for run '{}': {}",
            run_id, e
        )
    })
}

fn setup_mpc_channel_permissions(
    work_dir: &Path,
    owner_email: &str,
    party_emails: &[String],
    local_party_id: usize,
    tcp_proxy_enabled: bool,
    syqure_port_base: Option<usize>,
) -> Result<(), String> {
    let mpc_root = work_dir.join("_mpc");
    fs::create_dir_all(&mpc_root)
        .map_err(|e| format!("Failed to create mpc root {}: {}", mpc_root.display(), e))?;

    // Root-level permissions so all participants can discover MPC transport logs/channels.
    create_syft_pub_yaml(&mpc_root, owner_email, party_emails)?;

    for (remote_id, remote_email) in party_emails.iter().enumerate() {
        if remote_id == local_party_id {
            continue;
        }
        let channel_dir = mpc_root.join(format!("{}_to_{}", local_party_id, remote_id));
        fs::create_dir_all(&channel_dir).map_err(|e| {
            format!(
                "Failed to create mpc channel {}: {}",
                channel_dir.display(),
                e
            )
        })?;

        // Match CLI flow permissions: sender+receiver can read/write, sender is admin.
        let perms_path = channel_dir.join("syft.pub.yaml");
        if !perms_path.exists() {
            let channel_doc = serde_json::json!({
                "rules": [
                    {
                        "pattern": "**",
                        "access": {
                            "admin": [owner_email],
                            "read": [owner_email, remote_email],
                            "write": [owner_email, remote_email],
                        },
                    },
                ],
            });
            let yaml = serde_yaml::to_string(&channel_doc)
                .map_err(|e| format!("Failed to serialize {}: {}", perms_path.display(), e))?;
            fs::write(&perms_path, yaml)
                .map_err(|e| format!("Failed to write {}: {}", perms_path.display(), e))?;
        }

        if tcp_proxy_enabled {
            let global_base = syqure_port_base
                .ok_or_else(|| "Missing Syqure port base while tcp proxy is enabled".to_string())?;
            let parties = party_emails.len().max(2);
            let port = mpc_comm_port_with_base(global_base, local_party_id, remote_id, parties);
            let from_base = global_base + local_party_id * SEQURE_COMMUNICATION_PORT_STRIDE;
            let to_base = global_base + remote_id * SEQURE_COMMUNICATION_PORT_STRIDE;
            let from_port = mpc_comm_port_with_base(from_base, local_party_id, remote_id, parties);
            let to_port = mpc_comm_port_with_base(to_base, remote_id, local_party_id, parties);
            let marker = serde_json::json!({
                "from": owner_email,
                "to": remote_email,
                "port": port,
                "ports": {
                    owner_email: from_port,
                    remote_email: to_port,
                },
            });
            let marker_path = channel_dir.join("stream.tcp");
            let accept_path = channel_dir.join("stream.accept");
            fs::write(&marker_path, marker.to_string())
                .map_err(|e| format!("Failed to write {}: {}", marker_path.display(), e))?;
            fs::write(&accept_path, "1")
                .map_err(|e| format!("Failed to write {}: {}", accept_path.display(), e))?;
        }
    }

    Ok(())
}

fn maybe_setup_mpc_channels(
    flow_spec: &serde_json::Value,
    work_dir: &Path,
    my_email: &str,
    party_emails: &[String],
    session_id: &str,
) -> Result<Option<usize>, String> {
    let has_mpc = flow_spec.get("spec").and_then(|s| s.get("mpc")).is_some();
    if !has_mpc {
        return Ok(None);
    }

    let party_count = party_emails.len();
    let local_party_id = party_emails
        .iter()
        .position(|email| email.eq_ignore_ascii_case(my_email))
        .unwrap_or(0);

    let tcp_proxy_enabled = env::var("SEQURE_TCP_PROXY")
        .ok()
        .map(|v| is_truthy(&v))
        .or_else(|| env::var("BV_SYQURE_TCP_PROXY").ok().map(|v| is_truthy(&v)))
        .or_else(|| {
            env::var("BV_SYFTBOX_HOTLINK_TCP_PROXY")
                .ok()
                .map(|v| is_truthy(&v))
        })
        .or_else(|| {
            env::var("SYFTBOX_HOTLINK_TCP_PROXY")
                .ok()
                .map(|v| is_truthy(&v))
        })
        .unwrap_or_else(|| flow_has_hotlink_transport(flow_spec));

    let syqure_port_base = if tcp_proxy_enabled {
        Some(stable_syqure_port_base_for_run(session_id, party_count)?)
    } else {
        None
    };

    setup_mpc_channel_permissions(
        work_dir,
        my_email,
        party_emails,
        local_party_id,
        tcp_proxy_enabled,
        syqure_port_base,
    )?;

    Ok(syqure_port_base)
}

fn flow_has_hotlink_transport(flow_spec: &serde_json::Value) -> bool {
    let modules = flow_spec
        .get("spec")
        .and_then(|s| s.get("modules"))
        .and_then(|m| m.as_object());
    let Some(modules) = modules else {
        return false;
    };
    for (_name, module_def) in modules {
        let source_path = module_def
            .get("source")
            .and_then(|s| s.get("path"))
            .and_then(|p| p.as_str());
        if let Some(path) = source_path {
            let module_dir_candidates = resolve_module_directory_from_flow_spec(path);
            for module_dir in module_dir_candidates {
                if let Ok((_, transport, _)) = read_syqure_runner_config(&module_dir) {
                    if transport.eq_ignore_ascii_case("hotlink") {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn resolve_module_directory_from_flow_spec(source_path: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let biovault_home = match biovault::config::get_biovault_home() {
        Ok(h) => h,
        Err(_) => return candidates,
    };
    let flows_root = biovault_home.join("flows");
    if let Ok(entries) = fs::read_dir(&flows_root) {
        for entry in entries.flatten() {
            let flow_dir = entry.path();
            if flow_dir.is_dir() {
                let trimmed = source_path.trim_start_matches("./");
                let candidate = flow_dir.join(trimmed);
                if candidate.exists() {
                    candidates.push(candidate);
                }
            }
        }
    }
    candidates
}

fn read_module_output_path(module_dir: &Path, output_name: &str) -> Option<String> {
    let yaml_path = if module_dir.join("module.yaml").exists() {
        module_dir.join("module.yaml")
    } else if module_dir.join("module.yml").exists() {
        module_dir.join("module.yml")
    } else {
        return None;
    };
    let yaml = fs::read_to_string(&yaml_path).ok()?;
    let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).ok()?;
    let outputs = parsed.get("spec")?.get("outputs")?.as_sequence()?;
    for output in outputs {
        let name = output.get("name")?.as_str()?;
        if name == output_name {
            return output
                .get("path")
                .and_then(|p| p.as_str())
                .map(|s| s.to_string())
                .or_else(|| Some(format!("{}.json", output_name)));
        }
    }
    None
}

fn resolve_share_source_output(
    flow_spec: &serde_json::Value,
    source_step_id: &str,
    share_name: &str,
) -> Option<String> {
    let steps = flow_spec.get("spec")?.get("steps")?.as_array()?;
    for step in steps {
        let id = step.get("id")?.as_str()?;
        if id != source_step_id {
            continue;
        }
        let share = step.get("share")?.get(share_name)?;
        let source = share.get("source")?.as_str()?;
        if let Some(output_name) = source.strip_prefix("self.outputs.") {
            return Some(output_name.to_string());
        }
    }
    None
}

fn resolve_with_bindings(
    with_bindings: &HashMap<String, serde_json::Value>,
    flow_spec: &serde_json::Value,
    flow_name: &str,
    session_id: &str,
    my_email: &str,
    biovault_home: &Path,
    step_numbers_by_id: &HashMap<String, usize>,
    all_steps: &[StepState],
    work_dir: &Path,
    participants: &[FlowParticipant],
) -> Result<Vec<String>, String> {
    let mut step_args: Vec<String> = Vec::new();
    let (groups, _) = build_group_map_from_participants(participants, flow_spec);

    for (input_name, binding_value) in with_bindings {
        let (ref_str, only_group, without_group) = parse_binding_value(binding_value);
        let ref_str = match ref_str {
            Some(r) => r,
            None => continue,
        };

        if let Some(group) = only_group {
            if !is_email_in_group(my_email, &group, &groups) {
                continue;
            }
        }
        if let Some(group) = without_group {
            if is_email_in_group(my_email, &group, &groups) {
                continue;
            }
        }

        let is_url_list = ref_str.ends_with(".url_list");
        let base_ref = if is_url_list {
            ref_str.trim_end_matches(".url_list")
        } else {
            &ref_str
        };

        let resolved = resolve_single_binding(
            base_ref,
            is_url_list,
            flow_spec,
            flow_name,
            session_id,
            my_email,
            biovault_home,
            step_numbers_by_id,
            all_steps,
            work_dir,
            input_name,
        )?;

        if let Some(path) = resolved {
            step_args.push(format!("--{}", input_name));
            step_args.push(path);
        }
    }

    Ok(step_args)
}

fn parse_binding_value(
    value: &serde_json::Value,
) -> (Option<String>, Option<String>, Option<String>) {
    match value {
        serde_json::Value::String(s) => (Some(s.clone()), None, None),
        serde_json::Value::Object(obj) => {
            let ref_str = obj
                .get("value")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let only = obj
                .get("only")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let without = obj
                .get("without")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            (ref_str, only, without)
        }
        _ => (None, None, None),
    }
}

fn is_email_in_group(email: &str, group_name: &str, groups: &HashMap<String, Vec<String>>) -> bool {
    if let Some(members) = groups.get(group_name) {
        members.iter().any(|m| m.eq_ignore_ascii_case(email))
    } else {
        false
    }
}

fn resolve_single_binding(
    base_ref: &str,
    is_url_list: bool,
    flow_spec: &serde_json::Value,
    flow_name: &str,
    session_id: &str,
    my_email: &str,
    biovault_home: &Path,
    step_numbers_by_id: &HashMap<String, usize>,
    all_steps: &[StepState],
    work_dir: &Path,
    input_name: &str,
) -> Result<Option<String>, String> {
    let parts: Vec<&str> = base_ref.split('.').collect();
    if parts.len() < 4 || parts[0] != "step" {
        return Ok(Some(base_ref.to_string()));
    }

    let source_step_id = parts[1];
    let ref_type = parts[2];
    let ref_name = parts[3];

    let source_step_number = step_numbers_by_id.get(source_step_id).copied().unwrap_or(1);

    let source_module_ref = all_steps
        .iter()
        .find(|s| s.id == source_step_id)
        .and_then(|s| s.module_ref.as_deref());
    let source_module_path = all_steps
        .iter()
        .find(|s| s.id == source_step_id)
        .and_then(|s| s.module_path.as_deref());

    let file_name = match ref_type {
        "outputs" => {
            let module_dir =
                resolve_module_directory(flow_name, source_module_path, source_module_ref);
            module_dir
                .and_then(|dir| read_module_output_path(&dir, ref_name))
                .unwrap_or_else(|| format!("{}.json", ref_name))
        }
        "share" => {
            let output_name = resolve_share_source_output(flow_spec, source_step_id, ref_name)
                .unwrap_or_else(|| ref_name.to_string());
            let module_dir =
                resolve_module_directory(flow_name, source_module_path, source_module_ref);
            module_dir
                .and_then(|dir| read_module_output_path(&dir, &output_name))
                .unwrap_or_else(|| format!("{}.txt", ref_name))
        }
        _ => return Ok(Some(base_ref.to_string())),
    };

    let source_target_emails: Vec<String> = all_steps
        .iter()
        .find(|s| s.id == source_step_id)
        .map(|s| s.target_emails.clone())
        .unwrap_or_default();

    if is_url_list {
        let manifest_dir = work_dir
            .join(format!("{}-{}", source_step_number, source_step_id))
            .join("_manifests");
        let _ = fs::create_dir_all(&manifest_dir);
        let manifest_path = manifest_dir.join(format!("{}.manifest.txt", input_name));

        let mut manifest_lines = Vec::new();
        for target_email in &source_target_emails {
            if let Some(path) = find_participant_step_file(
                &biovault_home.to_path_buf(),
                my_email,
                target_email,
                flow_name,
                session_id,
                source_step_number,
                source_step_id,
                &file_name,
            ) {
                manifest_lines.push(format!("{}\t{}", target_email, path.display()));
            }
        }

        if manifest_lines.is_empty() {
            return Ok(None);
        }
        fs::write(&manifest_path, manifest_lines.join("\n"))
            .map_err(|e| format!("Failed to write manifest: {}", e))?;
        Ok(Some(manifest_path.to_string_lossy().to_string()))
    } else {
        let source_email = if ref_type == "share" {
            source_target_emails
                .first()
                .cloned()
                .unwrap_or_else(|| my_email.to_string())
        } else {
            my_email.to_string()
        };
        let path = find_participant_step_file(
            &biovault_home.to_path_buf(),
            my_email,
            &source_email,
            flow_name,
            session_id,
            source_step_number,
            source_step_id,
            &file_name,
        );
        Ok(path.map(|p| p.to_string_lossy().to_string()))
    }
}

fn find_participant_step_file(
    biovault_home: &PathBuf,
    viewer_email: &str,
    participant_email: &str,
    flow_name: &str,
    session_id: &str,
    step_number: usize,
    step_id: &str,
    file_name: &str,
) -> Option<PathBuf> {
    participant_flow_dirs_for_viewer(
        biovault_home,
        viewer_email,
        participant_email,
        flow_name,
        session_id,
    )
    .into_iter()
    .find_map(|base| {
        resolve_step_output_dir_for_base(&base, step_number, step_id)
            .map(|dir| dir.join(file_name))
            .filter(|path| path.exists())
    })
}

fn find_sandbox_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|ancestor| ancestor.file_name().and_then(|n| n.to_str()) == Some("sandbox"))
        .map(|ancestor| ancestor.to_path_buf())
}

/// Return candidate flow directories for a participant from this viewer's perspective.
/// 1) synced datasite path (what this viewer has received)
/// 2) optional local sandbox sibling path, only for the viewer's own datasite
fn participant_flow_dirs_for_viewer(
    biovault_home: &PathBuf,
    viewer_email: &str,
    participant_email: &str,
    flow_name: &str,
    session_id: &str,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    let mut push_dir = |candidate: PathBuf| {
        if seen.insert(candidate.clone()) {
            dirs.push(candidate);
        }
    };

    // Primary: current BioVault home layout.
    push_dir(
        biovault_home
            .join("datasites")
            .join(participant_email)
            .join("shared")
            .join("flows")
            .join(flow_name)
            .join(session_id),
    );

    // Fallback: derive from sandbox root if BIOVAULT_HOME points deeper than expected.
    if let Some(sandbox_root) = find_sandbox_root(biovault_home) {
        push_dir(
            sandbox_root
                .join(viewer_email)
                .join("datasites")
                .join(participant_email)
                .join("shared")
                .join("flows")
                .join(flow_name)
                .join(session_id),
        );
    }

    // Legacy local-sandbox sibling fallback for viewer's own datasite.
    if viewer_email == participant_email {
        if let Some(parent) = biovault_home.parent() {
            push_dir(
                parent
                    .join(participant_email)
                    .join("datasites")
                    .join(participant_email)
                    .join("shared")
                    .join("flows")
                    .join(flow_name)
                    .join(session_id),
            );
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
    // Flow runtime owns `_progress/state.json` with a structured `steps` map.
    // Do not overwrite that shape with multiparty event snapshots.
    if let Ok(existing) = fs::read_to_string(&state_file) {
        if let Ok(existing_json) = serde_json::from_str::<serde_json::Value>(&existing) {
            if existing_json.get("steps").is_some() {
                return;
            }
        }
    }

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
    #[serde(default)]
    pub input_overrides: HashMap<String, String>,
    #[serde(default)]
    pub flow_spec: Option<serde_json::Value>,
    #[serde(default)]
    pub syqure_port_base: Option<usize>,
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
    #[serde(default)]
    pub with_bindings: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MultipartyStepDiagnostics {
    pub session_id: String,
    pub step_id: String,
    pub flow_name: String,
    pub local_email: String,
    pub generated_at_ms: u64,
    pub channels: Vec<MultipartyMpcChannelDiagnostics>,
    pub peers: Vec<MultipartyPeerTelemetryDiagnostics>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MultipartyMpcChannelDiagnostics {
    pub channel_id: String,
    pub from_email: Option<String>,
    pub to_email: Option<String>,
    pub port: Option<u16>,
    pub marker: bool,
    pub accept: bool,
    pub listener_up: Option<bool>,
    pub requests: usize,
    pub responses: usize,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MultipartyPeerTelemetryDiagnostics {
    pub email: String,
    pub telemetry_present: bool,
    pub mode: String,
    pub mode_short: String,
    pub status: String,
    pub updated_ms: Option<u64>,
    pub age_ms: Option<u64>,
    pub tx_packets: u64,
    pub tx_bytes: u64,
    pub tx_quic_packets: u64,
    pub tx_ws_packets: u64,
    pub tx_avg_send_ms: f64,
    pub rx_packets: u64,
    pub rx_bytes: u64,
    pub rx_avg_write_ms: f64,
    pub ws_fallbacks: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct HotlinkTelemetrySnapshot {
    mode: String,
    updated_ms: Option<u64>,
    tx_packets: u64,
    tx_bytes: u64,
    tx_quic_packets: u64,
    tx_ws_packets: u64,
    tx_avg_send_ms: f64,
    rx_packets: u64,
    rx_bytes: u64,
    rx_avg_write_ms: f64,
    ws_fallbacks: u64,
}

static FLOW_SESSIONS: Lazy<Mutex<HashMap<String, MultipartyFlowState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Update dependent steps: if all their dependencies are now completed/shared, mark them Ready
fn update_dependent_steps(flow_state: &mut MultipartyFlowState, completed_step_id: &str) {
    let mut steps_to_ready: HashSet<String> = HashSet::new();

    for step in &flow_state.steps {
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
            .all(|dep_id| is_dependency_complete(flow_state, dep_id));

        if all_deps_met {
            steps_to_ready.insert(step.id.clone());
        }
    }

    for step in &mut flow_state.steps {
        if steps_to_ready.contains(&step.id) {
            step.status = StepStatus::Ready;
        }
    }
}

/// Refresh local actionable step statuses from current dependency state.
/// This is needed for collaborative sessions where dependencies may complete on
/// remote participants between UI polls.
fn refresh_step_statuses(flow_state: &mut MultipartyFlowState) {
    let mut ready_step_ids: Vec<String> = Vec::new();

    for step in &flow_state.steps {
        if !step.my_action {
            continue;
        }
        if step.is_barrier {
            // Barrier progression is handled by update_barrier_steps based on
            // cross-participant completion, not generic dependency refresh.
            continue;
        }
        if step.status != StepStatus::Pending && step.status != StepStatus::WaitingForInputs {
            continue;
        }

        let all_deps_met = step
            .depends_on
            .iter()
            .all(|dep_id| is_dependency_complete(flow_state, dep_id));
        if all_deps_met {
            ready_step_ids.push(step.id.clone());
        }
    }

    for step_id in ready_step_ids {
        if let Some(step) = flow_state.steps.iter_mut().find(|s| s.id == step_id) {
            if step.status == StepStatus::Pending || step.status == StepStatus::WaitingForInputs {
                step.status = StepStatus::Ready;
            }
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
        if !step.is_barrier {
            continue;
        }
        if step.status != StepStatus::WaitingForInputs && step.status != StepStatus::Ready {
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
                        &flow_state.my_email,
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

    // Third pass: update steps that depend on completed barriers/dependencies.
    let mut steps_to_ready: HashSet<String> = HashSet::new();
    for step in &flow_state.steps {
        if step.status == StepStatus::Pending && step.my_action {
            let deps_complete = step
                .depends_on
                .iter()
                .all(|dep| is_dependency_complete(flow_state, dep));
            if deps_complete {
                steps_to_ready.insert(step.id.clone());
            }
        }
    }
    for step in &mut flow_state.steps {
        if steps_to_ready.contains(&step.id) {
            step.status = StepStatus::Ready;
        }
    }
}

/// Check if a specific participant has completed a specific step
fn check_participant_step_complete(
    flow_name: &str,
    session_id: &str,
    viewer_email: &str,
    participant_email: &str,
    participant_role: &str,
    step_id: &str,
    require_shared: bool,
) -> bool {
    let biovault_home = match biovault::config::get_biovault_home() {
        Ok(h) => h,
        Err(_) => return false,
    };

    let flow_dirs = participant_flow_dirs_for_viewer(
        &biovault_home,
        viewer_email,
        participant_email,
        flow_name,
        session_id,
    );

    let mut saw_completed_without_share = false;

    for base in &flow_dirs {
        let progress_file = base
            .join("_progress")
            .join(format!("{}_{}.json", participant_role, step_id));
        if !progress_file.exists() {
            continue;
        }

        // Read and check the status
        if let Ok(content) = fs::read_to_string(&progress_file) {
            if let Ok(status) = serde_json::from_str::<SharedStepStatus>(&content) {
                let normalized = normalize_progress_status(&status.status);
                if require_shared {
                    if normalized == "Shared" {
                        return true;
                    }
                    if normalized == "Completed" {
                        saw_completed_without_share = true;
                    }
                    continue;
                }
                if normalized == "Shared" || normalized == "Completed" {
                    return true;
                }
            }
        }
    }

    // Fallback for flows that only emit _progress/state.json.
    for base in &flow_dirs {
        let state_file = base.join("_progress").join("state.json");
        if !state_file.exists() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&state_file) else {
            continue;
        };
        let Ok(state_json) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let Some(step_state) = state_json
            .get("steps")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.get(step_id))
        else {
            continue;
        };

        let normalized = normalize_progress_status(
            step_state
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("pending"),
        );
        if require_shared {
            if normalized == "Shared" {
                return true;
            }
            if normalized == "Completed" {
                saw_completed_without_share = true;
            }
        } else if normalized == "Shared" || normalized == "Completed" {
            return true;
        }
    }

    // Treat syft.pub.yaml as definitive shared evidence when status files lag.
    if require_shared
        && flow_dirs
            .iter()
            .any(|base| has_step_share_marker(base, step_id))
    {
        return true;
    }

    if require_shared && saw_completed_without_share {
        return false;
    }

    false
}

/// Returns true when a dependency step can be treated as complete for this session.
/// This handles both local and cross-participant dependencies.
fn is_dependency_complete(flow_state: &MultipartyFlowState, dep_step_id: &str) -> bool {
    let Some(dep_step) = flow_state.steps.iter().find(|s| s.id == dep_step_id) else {
        // Unknown dependency should not block execution.
        return true;
    };

    if matches!(dep_step.status, StepStatus::Completed | StepStatus::Shared) {
        return true;
    }

    if dep_step.target_emails.is_empty() {
        return false;
    }

    // For shared-output dependencies (e.g., step.share...), require Shared.
    // Otherwise Completed or Shared is sufficient.
    let require_shared = dep_step.shares_output;

    dep_step.target_emails.iter().all(|target_email| {
        if let Some(participant) = flow_state
            .participants
            .iter()
            .find(|p| &p.email == target_email)
        {
            check_participant_step_complete(
                &flow_state.flow_name,
                &flow_state.session_id,
                &flow_state.my_email,
                &participant.email,
                &participant.role,
                dep_step_id,
                require_shared,
            )
        } else {
            false
        }
    })
}

fn is_step_terminal_for_success(step: &StepState) -> bool {
    if step.shares_output {
        step.status == StepStatus::Shared
    } else {
        matches!(step.status, StepStatus::Completed | StepStatus::Shared)
    }
}

fn collect_terminal_run_update(flow_state: &mut MultipartyFlowState) -> Option<(String, i64)> {
    let run_id = flow_state.run_id?;

    if flow_state
        .steps
        .iter()
        .any(|s| s.status == StepStatus::Failed)
    {
        if flow_state.status != FlowSessionStatus::Failed {
            flow_state.status = FlowSessionStatus::Failed;
            return Some(("failed".to_string(), run_id));
        }
        return None;
    }

    for step in &flow_state.steps {
        if is_step_terminal_for_success(step) {
            continue;
        }

        if step.is_barrier {
            return None;
        }

        if step.target_emails.is_empty() {
            if step.my_action {
                return None;
            }
            continue;
        }

        let require_shared = step.shares_output;
        let all_targets_done = step.target_emails.iter().all(|target_email| {
            flow_state
                .participants
                .iter()
                .find(|p| p.email.eq_ignore_ascii_case(target_email))
                .map(|participant| {
                    check_participant_step_complete(
                        &flow_state.flow_name,
                        &flow_state.session_id,
                        &flow_state.my_email,
                        &participant.email,
                        &participant.role,
                        &step.id,
                        require_shared,
                    )
                })
                .unwrap_or(false)
        });
        if !all_targets_done {
            return None;
        }
    }

    if matches!(
        flow_state.status,
        FlowSessionStatus::Completed | FlowSessionStatus::Failed
    ) {
        return None;
    }

    flow_state.status = FlowSessionStatus::Completed;
    Some(("success".to_string(), run_id))
}

fn apply_terminal_run_update(app_state: &AppState, terminal_update: Option<(String, i64)>) {
    let Some((status, run_id)) = terminal_update else {
        return;
    };
    if let Ok(biovault_db) = app_state.biovault_db.lock() {
        let _ = biovault_db.update_flow_run_status(run_id, &status, true);
    }
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
    if let Err(err) = ensure_flow_subscriptions(&flow_name, &session_id, &all_participant_emails) {
        eprintln!(
            "[Multiparty] Warning: failed to add flow subscriptions: {}",
            err
        );
    }
    let _ = create_syft_pub_yaml(&progress_dir, &my_email, &all_participant_emails);
    write_progress_state(&progress_dir, &my_role, "joined", None, "Accepted");

    let syqure_port_base = maybe_setup_mpc_channels(
        &flow_spec,
        &work_dir,
        &my_email,
        &all_participant_emails,
        &session_id,
    )?;

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
        input_overrides: HashMap::new(),
        flow_spec: Some(flow_spec.clone()),
        syqure_port_base,
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
    input_overrides: Option<HashMap<String, String>>,
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
    if let Err(err) = ensure_flow_subscriptions(&flow_name, &session_id, &all_participant_emails) {
        eprintln!(
            "[Multiparty] Warning: failed to add flow subscriptions: {}",
            err
        );
    }
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

    let input_overrides = input_overrides.unwrap_or_default();

    // Create run entry in database
    let run_id = if let Some(fid) = flow_id {
        let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
        let metadata = serde_json::json!({
            "type": "multiparty",
            "session_id": session_id,
            "my_role": my_role,
            "participants": participants,
            "input_overrides": input_overrides.clone(),
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

    let syqure_port_base = maybe_setup_mpc_channels(
        &flow_spec,
        &work_dir,
        &my_email,
        &all_participant_emails,
        &session_id,
    )?;

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
        input_overrides,
        flow_spec: Some(flow_spec.clone()),
        syqure_port_base,
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
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Option<MultipartyFlowState>, String> {
    let (snapshot, terminal_update) = {
        let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        if let Some(flow_state) = sessions.get_mut(&session_id) {
            reconcile_local_step_dirs(flow_state);
            // Pull dependency-driven readiness from synced participant progress.
            refresh_step_statuses(flow_state);
            // Check if any WaitingForInputs steps can now proceed
            update_barrier_steps(flow_state);
            let terminal_update = collect_terminal_run_update(flow_state);
            (Some(flow_state.clone()), terminal_update)
        } else {
            (None, None)
        }
    };

    apply_terminal_run_update(state.inner(), terminal_update);
    Ok(snapshot)
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
        "completed" | "complete" | "success" | "succeeded" | "done" => "Completed".to_string(),
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

fn resolve_step_output_dir_for_base(
    base: &PathBuf,
    step_number: usize,
    step_id: &str,
) -> Option<PathBuf> {
    let canonical = canonicalize_step_dir_name(base, step_number, step_id);
    if canonical.exists() {
        return Some(canonical);
    }
    let padded = get_padded_step_path(base, step_number, step_id);
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
    let (flow_name, my_email, participants, step_meta) = {
        let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        let flow_state = sessions
            .get(&session_id)
            .ok_or_else(|| "Flow session not found".to_string())?;
        (
            flow_state.flow_name.clone(),
            flow_state.my_email.clone(),
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
        let flow_dirs = participant_flow_dirs_for_viewer(
            &biovault_home,
            &my_email,
            &participant.email,
            &flow_name,
            &session_id,
        );
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
                        for (step_idx, (step_id, step_shares_output)) in
                            step_meta.iter().enumerate()
                        {
                            let Some(step_state) = step_obj.get(step_id) else {
                                continue;
                            };
                            let raw_status = step_state
                                .get("status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("pending");
                            let mut status_normalized = normalize_progress_status(raw_status);
                            if *step_shares_output
                                && status_normalized == "Completed"
                                && has_step_share_marker(base, step_id)
                            {
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
                            let timestamp =
                                parse_progress_timestamp(step_state.get("completed_at"))
                                    .or_else(|| {
                                        parse_progress_timestamp(step_state.get("updated_at"))
                                    })
                                    .or_else(|| {
                                        parse_progress_timestamp(step_state.get("started_at"))
                                    })
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

        // Final fallback: infer status from on-disk step output directories when
        // status files are missing/lagging on a peer view.
        for (step_idx, (step_id, step_shares_output)) in step_meta.iter().enumerate() {
            if steps_by_id.contains_key(step_id) {
                continue;
            }
            let step_number = step_idx + 1;
            for base in &flow_dirs {
                let Some(output_dir_path) =
                    resolve_step_output_dir_for_base(base, step_number, step_id)
                else {
                    continue;
                };

                // Ignore placeholder dirs that have no real output payload yet.
                let has_payload = fs::read_dir(&output_dir_path)
                    .ok()
                    .map(|entries| {
                        entries.flatten().any(|entry| {
                            let path = entry.path();
                            if !path.is_file() {
                                return false;
                            }
                            path.file_name()
                                .and_then(|n| n.to_str())
                                .map(|name| name != "syft.pub.yaml")
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);
                if !has_payload {
                    continue;
                }

                let is_shared = output_dir_path.join("syft.pub.yaml").exists();
                let inferred_status = if *step_shares_output {
                    if is_shared {
                        "Shared"
                    } else {
                        "Completed"
                    }
                } else {
                    "Completed"
                };

                let inferred_ts = fs::metadata(&output_dir_path)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|mtime| mtime.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .and_then(|d| i64::try_from(d.as_secs()).ok())
                    .unwrap_or_else(|| Utc::now().timestamp());

                let candidate = ParticipantStepStatus {
                    step_id: step_id.clone(),
                    status: inferred_status.to_string(),
                    timestamp: inferred_ts,
                    output_dir: Some(output_dir_path.to_string_lossy().to_string()),
                };
                if should_replace_step_status(steps_by_id.get(step_id), &candidate) {
                    steps_by_id.insert(step_id.clone(), candidate);
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
    let (flow_name, my_email, participants) = {
        let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        let flow_state = sessions
            .get(&session_id)
            .ok_or_else(|| "Flow session not found".to_string())?;
        (
            flow_state.flow_name.clone(),
            flow_state.my_email.clone(),
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
        for progress_dir in participant_flow_dirs_for_viewer(
            &biovault_home,
            &my_email,
            &participant.email,
            &flow_name,
            &session_id,
        )
        .into_iter()
        .map(|base| base.join("_progress"))
        {
            // Read canonical log.jsonl and legacy progress.json (both may exist
            // and contain useful events).
            let log_candidates = [
                progress_dir.join("log.jsonl"),
                progress_dir.join("progress.json"),
            ];
            for path in log_candidates.into_iter().filter(|p| p.exists()) {
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
                                    .or_else(|| entry.get("step").and_then(|s| s.as_str()))
                                    .and_then(|s| {
                                        let trimmed = s.trim();
                                        if trimmed.is_empty()
                                            || trimmed.eq_ignore_ascii_case("null")
                                            || trimmed.eq_ignore_ascii_case("undefined")
                                        {
                                            None
                                        } else {
                                            Some(trimmed.to_string())
                                        }
                                    }),
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
pub async fn get_multiparty_step_diagnostics(
    session_id: String,
    step_id: String,
) -> Result<MultipartyStepDiagnostics, String> {
    let (flow_name, my_email, participants) = {
        let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        let flow_state = sessions
            .get(&session_id)
            .ok_or_else(|| "Flow session not found".to_string())?;
        (
            flow_state.flow_name.clone(),
            flow_state.my_email.clone(),
            flow_state.participants.clone(),
        )
    };

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;

    let mut channels = Vec::new();
    for base in participant_flow_dirs_for_viewer(
        &biovault_home,
        &my_email,
        &my_email,
        &flow_name,
        &session_id,
    ) {
        let mpc_dir = base.join("_mpc");
        if !mpc_dir.exists() {
            continue;
        }
        channels = collect_mpc_tcp_channel_diagnostics(&mpc_dir);
        if !channels.is_empty() {
            break;
        }
    }

    let mut all_emails: BTreeSet<String> = participants
        .iter()
        .map(|p| p.email.clone())
        .filter(|e| !e.trim().is_empty())
        .collect();
    all_emails.insert(my_email.clone());

    let mut peers = Vec::new();
    for email in all_emails {
        let mut peer = MultipartyPeerTelemetryDiagnostics {
            email: email.clone(),
            telemetry_present: false,
            mode: "unknown".to_string(),
            mode_short: "unknown".to_string(),
            status: "pending".to_string(),
            updated_ms: None,
            age_ms: None,
            tx_packets: 0,
            tx_bytes: 0,
            tx_quic_packets: 0,
            tx_ws_packets: 0,
            tx_avg_send_ms: 0.0,
            rx_packets: 0,
            rx_bytes: 0,
            rx_avg_write_ms: 0.0,
            ws_fallbacks: 0,
        };
        for path in hotlink_telemetry_candidates(&biovault_home, &email) {
            if let Some(snapshot) = read_hotlink_telemetry(&path) {
                peer.telemetry_present = true;
                peer.mode = snapshot.mode.clone();
                peer.mode_short = short_hotlink_mode(&snapshot.mode).to_string();
                peer.updated_ms = snapshot.updated_ms;
                peer.tx_packets = snapshot.tx_packets;
                peer.tx_bytes = snapshot.tx_bytes;
                peer.tx_quic_packets = snapshot.tx_quic_packets;
                peer.tx_ws_packets = snapshot.tx_ws_packets;
                peer.tx_avg_send_ms = snapshot.tx_avg_send_ms;
                peer.rx_packets = snapshot.rx_packets;
                peer.rx_bytes = snapshot.rx_bytes;
                peer.rx_avg_write_ms = snapshot.rx_avg_write_ms;
                peer.ws_fallbacks = snapshot.ws_fallbacks;
                break;
            }
        }
        peer.age_ms = peer
            .updated_ms
            .map(|updated| now_ms.saturating_sub(updated));
        peer.status = if peer.telemetry_present {
            if peer.age_ms.unwrap_or(0) <= 15_000 {
                "connected".to_string()
            } else {
                "stale".to_string()
            }
        } else {
            "pending".to_string()
        };
        peers.push(peer);
    }
    peers.sort_by(|a, b| a.email.cmp(&b.email));

    Ok(MultipartyStepDiagnostics {
        session_id,
        step_id,
        flow_name,
        local_email: my_email,
        generated_at_ms: now_ms,
        channels,
        peers,
    })
}

#[tauri::command]
pub async fn get_multiparty_step_logs(
    state: tauri::State<'_, AppState>,
    session_id: String,
    step_id: String,
    lines: Option<usize>,
) -> Result<String, String> {
    let (run_id, work_dir, flow_name, my_email) = {
        let sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        let flow_state = sessions
            .get(&session_id)
            .ok_or_else(|| "Flow session not found".to_string())?;
        (
            flow_state.run_id,
            flow_state.work_dir.clone(),
            flow_state.flow_name.clone(),
            flow_state.my_email.clone(),
        )
    };

    let lines = lines.unwrap_or(200).clamp(20, 2000);
    let mut sections: Vec<String> = Vec::new();

    // 1) Private per-step logs (local-only, never synced).
    let private_log_path = get_private_step_log_path(&session_id, &step_id)?;
    if private_log_path.exists() {
        let private_tail = read_tail_lines(&private_log_path, lines)?;
        if !private_tail.trim().is_empty() {
            sections.push(format!("[Private Step Log]\n{}", private_tail));
        }
    }

    // 1b) Progress event stream for this local participant (JSONL under shared _progress).
    // This captures step_started/step_completed/step_shared even when execution was backend-driven.
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    let mut progress_candidates: Vec<PathBuf> = Vec::new();
    for base in participant_flow_dirs_for_viewer(
        &biovault_home,
        &my_email,
        &my_email,
        &flow_name,
        &session_id,
    ) {
        progress_candidates.push(base.join("_progress").join("log.jsonl"));
        progress_candidates.push(base.join("_progress").join("progress.json"));
    }
    progress_candidates.sort();
    progress_candidates.dedup();
    for progress_path in progress_candidates {
        if !progress_path.exists() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&progress_path) {
            let mut matched: Vec<String> = Vec::new();
            let mut unscoped: Vec<String> = Vec::new();
            for line in content.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                let entry_step = entry
                    .get("step_id")
                    .or_else(|| entry.get("step"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let timestamp = entry
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let role = entry.get("role").and_then(|v| v.as_str()).unwrap_or("");
                let event = entry.get("event").and_then(|v| v.as_str()).unwrap_or("");
                let message = entry.get("message").and_then(|v| v.as_str()).unwrap_or("");
                let mut rendered = format!("{} [{}] {}", timestamp, role, event);
                if !message.is_empty() {
                    rendered.push_str(": ");
                    rendered.push_str(message);
                }
                if entry_step == step_id {
                    matched.push(rendered);
                } else if entry_step.is_empty() {
                    unscoped.push(rendered);
                }
            }
            if !matched.is_empty() {
                let selected: Vec<String> = matched
                    .into_iter()
                    .rev()
                    .take(lines)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                sections.push(format!(
                    "[Progress Log: {}]\n{}",
                    progress_path.display(),
                    selected.join("\n")
                ));
                break;
            } else if !unscoped.is_empty() {
                let selected: Vec<String> = unscoped
                    .into_iter()
                    .rev()
                    .take(lines)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                sections.push(format!(
                    "[Progress Log (unscoped): {}]\n{}",
                    progress_path.display(),
                    selected.join("\n")
                ));
                break;
            }
        }
    }

    // 1c) Local MPC transport diagnostics (important for secure_aggregate visibility).
    for base in participant_flow_dirs_for_viewer(
        &biovault_home,
        &my_email,
        &my_email,
        &flow_name,
        &session_id,
    ) {
        let mpc_dir = base.join("_mpc");
        if !mpc_dir.exists() {
            continue;
        }

        let transport_log = mpc_dir.join("file_transport.log");
        if transport_log.exists() {
            let transport_tail = read_tail_lines(&transport_log, lines)?;
            if !transport_tail.trim().is_empty() {
                sections.push(format!(
                    "[MPC Transport Log: {}]\n{}",
                    transport_log.display(),
                    transport_tail
                ));
            }
        }

        let request_count = count_files_recursive(&mpc_dir, ".request");
        let response_count = count_files_recursive(&mpc_dir, ".response");
        if request_count > 0 || response_count > 0 {
            sections.push(format!(
                "[MPC File Progress]\nrequests={} responses={}",
                request_count, response_count
            ));
        }

        let tcp_status = collect_mpc_tcp_marker_status(&mpc_dir);
        if !tcp_status.is_empty() {
            sections.push(format!(
                "[MPC TCP Proxy Status: {}]\n{}",
                mpc_dir.display(),
                tcp_status.join("\n")
            ));
        }
    }

    // 2) Fallback to flow.log (run-local execution log), filtered by step id.
    let mut log_candidates: Vec<PathBuf> = Vec::new();
    if let Some(wd) = work_dir {
        log_candidates.push(wd.join("flow.log"));
    }
    if let Some(run_id) = run_id {
        let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
        if let Some(run) = biovault_db
            .get_flow_run(run_id)
            .map_err(|e| e.to_string())?
        {
            if let Some(results_dir) = run.results_dir.as_ref() {
                log_candidates.push(PathBuf::from(results_dir).join("flow.log"));
            }
            log_candidates.push(PathBuf::from(run.work_dir).join("flow.log"));
        }
    }
    log_candidates.sort();
    log_candidates.dedup();

    for log_path in log_candidates {
        if !log_path.exists() {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&log_path) {
            let selected = select_step_log_lines(&text, &step_id, lines);
            if !selected.trim().is_empty() {
                sections.push(format!("[Run Log: {}]\n{}", log_path.display(), selected));
                break;
            }
        }
    }

    if step_id == "secure_aggregate" {
        if let Ok(desktop_log) = env::var("BIOVAULT_DESKTOP_LOG_FILE") {
            let desktop_log_path = PathBuf::from(desktop_log);
            if desktop_log_path.exists() {
                let raw_tail = read_tail_lines(&desktop_log_path, lines.saturating_mul(6))?;
                if !raw_tail.trim().is_empty() {
                    let filtered: Vec<String> = raw_tail
                        .lines()
                        .filter(|line| {
                            let lc = line.to_ascii_lowercase();
                            lc.contains("syqure")
                                || lc.contains("hotlink")
                                || lc.contains("tcp proxy")
                                || lc.contains("sequre_transport")
                                || lc.contains("sequre_communication_port")
                        })
                        .map(|line| line.to_string())
                        .collect();
                    if !filtered.is_empty() {
                        let selected: Vec<String> = filtered
                            .into_iter()
                            .rev()
                            .take(lines)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect();
                        sections.push(format!(
                            "[Desktop Syqure Log: {}]\n{}",
                            desktop_log_path.display(),
                            selected.join("\n")
                        ));
                    }
                }
            }
        }
    }

    if sections.is_empty() {
        return Ok("No run logs available yet.".to_string());
    }

    Ok(sections.join("\n\n"))
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
    state: tauri::State<'_, AppState>,
    session_id: String,
    step_id: String,
) -> Result<StepState, String> {
    let (
        work_dir,
        step_number,
        step_numbers_by_id,
        flow_name,
        my_email,
        my_role,
        participants,
        module_path,
        module_ref,
        with_bindings,
        flow_spec,
        syqure_port_base,
        all_steps_snapshot,
    ) = {
        let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
        let flow_state = sessions
            .get_mut(&session_id)
            .ok_or_else(|| "Flow session not found".to_string())?;

        // Get step info and check if it can run
        let (step_deps, step_status, is_my_action, module_path, module_ref, with_bindings) = {
            let step = flow_state
                .steps
                .iter()
                .find(|s| s.id == step_id)
                .ok_or_else(|| "Step not found".to_string())?;
            (
                step.depends_on.clone(),
                step.status.clone(),
                step.my_action,
                step.module_path.clone(),
                step.module_ref.clone(),
                step.with_bindings.clone(),
            )
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

        // Always validate dependencies before running (including cross-participant deps).
        for dep_id in &step_deps {
            if !is_dependency_complete(flow_state, dep_id) {
                return Err(format!(
                    "Cannot run step '{}': dependency '{}' is not satisfied yet",
                    step_id, dep_id
                ));
            }
        }

        // Get step number (1-indexed) for path construction
        let step_number = flow_state
            .steps
            .iter()
            .position(|s| s.id == step_id)
            .map(|i| i + 1)
            .unwrap_or(0);

        let step_numbers_by_id = flow_state
            .steps
            .iter()
            .enumerate()
            .map(|(i, s)| (s.id.clone(), i + 1))
            .collect::<HashMap<_, _>>();

        let all_steps_snapshot = flow_state.steps.clone();

        let step = flow_state
            .steps
            .iter_mut()
            .find(|s| s.id == step_id)
            .ok_or_else(|| "Step not found".to_string())?;

        step.status = StepStatus::Running;
        append_private_step_log(&session_id, &step_id, "step_started");
        if let Some(ref work_dir) = flow_state.work_dir {
            let progress_dir = get_progress_path(work_dir);
            let _ = fs::create_dir_all(&progress_dir);
            append_progress_log(
                &progress_dir,
                "step_started",
                Some(&step_id),
                &flow_state.my_role,
            );
            write_progress_state(
                &progress_dir,
                &flow_state.my_role,
                "step_started",
                Some(&step_id),
                "Running",
            );
        }

        (
            flow_state.work_dir.clone(),
            step_number,
            step_numbers_by_id,
            flow_state.flow_name.clone(),
            flow_state.my_email.clone(),
            flow_state.my_role.clone(),
            flow_state.participants.clone(),
            module_path,
            module_ref,
            with_bindings,
            flow_state.flow_spec.clone(),
            flow_state.syqure_port_base,
            all_steps_snapshot,
        )
    };

    // Step output path: {flow_path}/{step_number}-{step_id}/
    let step_output_dir = work_dir
        .as_ref()
        .map(|d| canonicalize_step_dir_name(d, step_number, &step_id));

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
                synced_base
                    .join("2-share_contribution")
                    .join("numbers.json"),
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
    } else if module_ref.is_some() || module_path.is_some() {
        // ---- Generic module execution path (replaces all hardcoded step handlers) ----
        let output_dir = step_output_dir
            .as_ref()
            .ok_or_else(|| "No output directory".to_string())?;
        let module_dir =
            resolve_module_directory(&flow_name, module_path.as_deref(), module_ref.as_deref())
                .ok_or_else(|| {
                    format!("Failed to resolve module directory for step '{}'", step_id)
                })?;

        let biovault_home = biovault::config::get_biovault_home()
            .map_err(|e| format!("Failed to get BioVault home: {}", e))?;

        let flow_spec_ref = flow_spec
            .as_ref()
            .ok_or_else(|| "Flow spec not stored in session state".to_string())?;

        let step_args = resolve_with_bindings(
            &with_bindings,
            flow_spec_ref,
            &flow_name,
            &session_id,
            &my_email,
            &biovault_home,
            &step_numbers_by_id,
            &all_steps_snapshot,
            work_dir.as_ref().ok_or("No work directory")?,
            &participants,
        )?;

        append_private_step_log(
            &session_id,
            &step_id,
            &format!(
                "generic_execute: module={} args={:?}",
                module_dir.display(),
                step_args
            ),
        );

        let party_emails: Vec<String> = participants.iter().map(|p| p.email.clone()).collect();

        let dynamic_ctx = run_dynamic::DynamicExecutionContext {
            current_datasite: Some(my_email.clone()),
            datasites_override: Some(party_emails.clone()),
            syftbox_data_dir: Some(biovault_home.to_string_lossy().to_string()),
            run_id: Some(session_id.clone()),
            flow_name: Some(flow_name.clone()),
            syqure_port_base,
            tauri_context: true,
        };

        let party_id_idx = party_emails
            .iter()
            .position(|e| e == &my_email)
            .unwrap_or(0);
        append_private_step_log(
            &session_id,
            &step_id,
            &format!(
                "syqure_coordination: session_id={} party_id={}/{} email={} port_base={} backend={} module_dir={} diag_file=/tmp/biovault-syqure-diag-{}-p{}.log",
                session_id,
                party_id_idx,
                party_emails.len(),
                my_email,
                syqure_port_base.map(|b| b.to_string()).unwrap_or_else(|| "none".to_string()),
                env::var("BV_SYFTBOX_BACKEND").unwrap_or_else(|_| "unset".to_string()),
                module_dir.display(),
                session_id,
                party_id_idx,
            ),
        );

        eprintln!("[tauri-trace] run_flow_step calling execute_dynamic step={} party={}/{} pid={} thread={:?}",
            step_id, party_id_idx, party_emails.len(), std::process::id(), std::thread::current().id());
        let run_result = run_dynamic::with_execution_context(
            dynamic_ctx,
            run_dynamic::execute_dynamic(
                &module_dir.to_string_lossy(),
                step_args,
                false,
                false,
                Some(output_dir.to_string_lossy().to_string()),
                run_dynamic::RunSettings::default(),
            ),
        )
        .await
        .map_err(|e| format!("Step '{}' failed: {}", step_id, e));
        eprintln!(
            "[tauri-trace] execute_dynamic returned step={} party={} result={:?}",
            step_id,
            party_id_idx,
            run_result.as_ref().map(|_| "ok").map_err(|e| e.clone())
        );

        if let Err(err) = run_result {
            append_private_step_log(&session_id, &step_id, &format!("step_failed: {}", err));

            let mut sessions = FLOW_SESSIONS.lock().map_err(|e| e.to_string())?;
            let mut terminal_update = None;
            if let Some(flow_state) = sessions.get_mut(&session_id) {
                if let Some(step) = flow_state.steps.iter_mut().find(|s| s.id == step_id) {
                    step.status = StepStatus::Failed;
                }
                flow_state.status = FlowSessionStatus::Failed;
                if let Some(ref work_dir) = flow_state.work_dir {
                    let progress_dir = get_progress_path(work_dir);
                    let _ = fs::create_dir_all(&progress_dir);
                    let shared_status = SharedStepStatus {
                        step_id: step_id.clone(),
                        role: flow_state.my_role.clone(),
                        status: "Failed".to_string(),
                        timestamp: Utc::now().timestamp(),
                    };
                    let status_file =
                        progress_dir.join(format!("{}_{}.json", flow_state.my_role, step_id));
                    if let Ok(json) = serde_json::to_string_pretty(&shared_status) {
                        let _ = fs::write(&status_file, json);
                    }
                    append_progress_log(
                        &progress_dir,
                        "step_failed",
                        Some(&step_id),
                        &flow_state.my_role,
                    );
                    write_progress_state(
                        &progress_dir,
                        &flow_state.my_role,
                        "step_failed",
                        Some(&step_id),
                        "Failed",
                    );
                }
                terminal_update = collect_terminal_run_update(flow_state);
            }
            drop(sessions);
            apply_terminal_run_update(state.inner(), terminal_update);
            return Err(err);
        }
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
    append_private_step_log(&session_id, &step_id, "step_completed");

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

    let terminal_update = collect_terminal_run_update(flow_state);

    drop(sessions);
    apply_terminal_run_update(state.inner(), terminal_update);

    Ok(completed_step)
}

#[tauri::command]
pub async fn share_step_outputs(
    state: tauri::State<'_, AppState>,
    session_id: String,
    step_id: String,
) -> Result<(), String> {
    let (output_dir, share_to_emails, my_email, thread_id, flow_name, step_name, participants) = {
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
        append_private_step_log(&session_id, &step_id, "step_sharing_started");

        let share_to_emails = resolve_share_recipients(
            &step.share_to,
            &flow_state.participants,
            &flow_state.my_email,
        );

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

    let terminal_update = {
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
        append_private_step_log(&session_id, &step_id, "step_shared");

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
        collect_terminal_run_update(flow_state)
    };

    apply_terminal_run_update(state.inner(), terminal_update);

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

    if !groups.contains_key("contributors") {
        let inferred_contributors: Vec<String> = participants
            .iter()
            .filter(|p| {
                let role = p.role.to_ascii_lowercase();
                role.starts_with("client") || role.starts_with("contributor")
            })
            .map(|p| p.email.clone())
            .collect();
        if !inferred_contributors.is_empty() {
            groups.insert("contributors".to_string(), inferred_contributors.clone());
            groups
                .entry("clients".to_string())
                .or_insert(inferred_contributors);
        }
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

/// Extract share recipients from step.share[*].read.
/// Accepts both:
/// - share.<name>.permissions.read (canonical flow schema)
/// - share.<name>.read (flattened schema variants)
fn extract_share_to(step: &serde_json::Value) -> Vec<String> {
    let mut share_to = Vec::new();

    if let Some(share_block) = step.get("share").and_then(|s| s.as_object()) {
        for (_share_name, share_def) in share_block {
            let read_arr = share_def
                .get("permissions")
                .and_then(|perms| perms.get("read"))
                .and_then(|r| r.as_array())
                .or_else(|| share_def.get("read").and_then(|r| r.as_array()));

            if let Some(read_arr) = read_arr {
                for reader in read_arr {
                    if let Some(target) = reader.as_str() {
                        if !share_to.iter().any(|existing| existing == target) {
                            share_to.push(target.to_string());
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

fn collect_step_refs_from_value(value: &serde_json::Value, refs: &mut HashSet<String>) {
    match value {
        serde_json::Value::String(text) => {
            let mut offset = 0usize;
            while let Some(found) = text[offset..].find("step.") {
                let start = offset + found + 5; // skip `step.`
                let remainder = &text[start..];
                let dep_id: String = remainder
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                    .collect();
                if !dep_id.is_empty() {
                    refs.insert(dep_id);
                }
                offset = start;
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_step_refs_from_value(item, refs);
            }
        }
        serde_json::Value::Object(map) => {
            for v in map.values() {
                collect_step_refs_from_value(v, refs);
            }
        }
        _ => {}
    }
}

fn extract_with_step_dependencies(
    step: &serde_json::Value,
    known_step_ids: &HashSet<String>,
) -> Vec<String> {
    let mut refs: HashSet<String> = HashSet::new();
    if let Some(with_block) = step.get("with") {
        collect_step_refs_from_value(with_block, &mut refs);
    }
    let mut deps: Vec<String> = refs
        .into_iter()
        .filter(|id| known_step_ids.contains(id))
        .collect();
    deps.sort();
    deps
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
    let known_step_ids: HashSet<String> = steps
        .iter()
        .filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    let mut result = Vec::new();

    for (step_index, step) in steps.iter().enumerate() {
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

        let explicit_depends_on: Vec<String> = step
            .get("depends_on")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let inferred_depends_on = extract_with_step_dependencies(step, &known_step_ids);
        let mut depends_set: HashSet<String> = HashSet::new();
        for dep in explicit_depends_on
            .into_iter()
            .chain(inferred_depends_on.into_iter())
        {
            if dep != id {
                depends_set.insert(dep);
            }
        }
        let mut depends_on: Vec<String> = depends_set.into_iter().collect();

        // Check if this is a barrier step
        let is_barrier = step.get("barrier").is_some();
        let barrier_wait_for = step
            .get("barrier")
            .and_then(|b| b.get("wait_for"))
            .and_then(|w| w.as_str())
            .map(|s| s.to_string());

        // Some imported FlowSpec variants flatten `with` references and lose explicit
        // dependency links. Keep UI sequencing stable by falling back to previous-step
        // ordering when no dependencies are present.
        if depends_on.is_empty() && !is_barrier && step_index > 0 {
            if let Some(prev_step_id) = steps
                .get(step_index - 1)
                .and_then(|s| s.get("id"))
                .and_then(|v| v.as_str())
            {
                if prev_step_id != id {
                    depends_on.push(prev_step_id.to_string());
                }
            }
        }
        depends_on.sort();
        depends_on.dedup();

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

        let with_bindings: HashMap<String, serde_json::Value> = step
            .get("with")
            .and_then(|w| w.as_object())
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();

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
            with_bindings,
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
        for entry in fs::read_dir(output_dir).map_err(|e| e.to_string())? {
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
    if !group_participants.iter().any(|e| e == my_email) {
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
