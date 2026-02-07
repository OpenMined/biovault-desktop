# Multiparty Flow UX Plan (v2)

## Overview

Enable 3+ party collaborative flows with step-by-step manual/auto execution control.
Focus: UX for coordination, not computation complexity.

## Key Design Decisions

1. **Proposer assigns roles** - When sending invitation, proposer selects contacts for each role
2. **Execution on Runs tab** - Flow execution UI lives in Runs, not Messages
3. **Messages for invitations only** - Chat shows invitation card with "View in Runs" button
4. **Import vs Join** - Preview flow before joining, then join to participate

## Components

### 1. Simple Test Flow: `biovault/flows/multiparty`

```yaml
apiVersion: syftbox.openmined.org/v1alpha1
kind: Flow
metadata:
  name: multiparty
  version: 0.1.0
spec:
  multiparty: true
  roles:
    - id: contributor1
      description: First data contributor
    - id: contributor2
      description: Second data contributor
    - id: aggregator
      description: Aggregates contributions
  steps:
    - id: generate
      name: Generate Numbers
      roles: [contributor1, contributor2]
      shares_output: false
    - id: share_contribution
      name: Share Contribution
      roles: [contributor1, contributor2]
      shares_output: true
      share_to: [aggregator]
      depends_on: [generate]
    - id: aggregate
      name: Aggregate Sum
      roles: [aggregator]
      depends_on: [share_contribution]
      wait_for_inputs: true
    - id: share_result
      name: Share Results
      roles: [aggregator]
      shares_output: true
      share_to: [contributor1, contributor2]
      depends_on: [aggregate]
```

### 2. Propose Flow UI (Messages)

When user wants to propose a multiparty flow:

1. Open "Propose Flow" modal from Messages or Flows
2. Select a multiparty flow
3. Assign contacts to roles
4. Send invitation

```
┌─────────────────────────────────────────────────┐
│ Propose Multiparty Flow                         │
├─────────────────────────────────────────────────┤
│ Flow: multiparty ▼                              │
│                                                 │
│ Assign Participants to Roles:                   │
│ ┌─────────────────┐  ┌──────────────────────┐   │
│ │ contributor1    │→ │ client1@...        ▼│   │
│ │ contributor2    │→ │ client2@...        ▼│   │
│ │ aggregator      │→ │ Me (proposer)        │   │
│ └─────────────────┘  └──────────────────────┘   │
│                                                 │
│ Message: "Let's run this multiparty flow!"      │
│                                                 │
│        [Cancel]  [Send Invitation]              │
└─────────────────────────────────────────────────┘
```

### 3. Invitation Card (Messages)

Recipients see in chat:

```
┌─────────────────────────────────────────────────┐
│ 🔄 Flow Invitation: multiparty                  │
├─────────────────────────────────────────────────┤
│ From: aggregator@sandbox.local                  │
│ Your role: contributor1                         │
│                                                 │
│ Participants:                                   │
│   👤 client1@... → contributor1 (you)           │
│   👤 client2@... → contributor2                 │
│   👤 aggregator@... → aggregator                │
│                                                 │
│    [View Details]  [Join in Runs →]             │
└─────────────────────────────────────────────────┘
```

### 4. Multiparty Sessions (Runs Tab)

New section at top of Runs tab:

```
┌─────────────────────────────────────────────────┐
│ Active Multiparty Sessions                      │
├─────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────┐   │
│ │ 🔄 multiparty                             │   │
│ │ Your role: contributor1                   │   │
│ │ Status: 2/4 steps complete                │   │
│ │                     [Open Session]        │   │
│ └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### 5. Session Execution Panel (Runs Tab)

When session is opened:

```
┌─────────────────────────────────────────────────┐
│ 🔄 Multiparty: multiparty                       │
│ Session: session-1234567890                     │
├─────────────────────────────────────────────────┤
│ Participants:                                   │
│   ✅ client1@... (contributor1) - you           │
│   ✅ client2@... (contributor2) - joined        │
│   ✅ aggregator@... (aggregator) - joined       │
├─────────────────────────────────────────────────┤
│ Your Steps:                                     │
│ ┌───────────────────────────────────────────┐   │
│ │ Step 1: Generate Numbers                  │   │
│ │ Status: ✅ Completed                      │   │
│ ├───────────────────────────────────────────┤   │
│ │ Step 2: Share Contribution                │   │
│ │ Status: Ready to share                    │   │
│ │ [📁 View Files] [Share to aggregator →]   │   │
│ └───────────────────────────────────────────┘   │
│                                                 │
│ Other Steps (view only):                        │
│   • Aggregate Sum (aggregator) - Waiting        │
│   • Share Results (aggregator) - Pending        │
└─────────────────────────────────────────────────┘
```

### 6. Step Execution States

```
pending       → waiting for dependencies
ready         → dependencies met, can run
running       → currently executing
completed     → finished, outputs ready
ready_to_share → completed, can share outputs
sharing       → outputs being encrypted/sent
shared        → outputs delivered
waiting_inputs → waiting for other parties
failed        → error occurred
```

### 7. Backend Commands

```rust
// Propose a flow (creates invitation message)
propose_multiparty_flow {
    flow_name: String,
    participants: Vec<{email, role}>,
    message: String,
}

// Accept invitation (joins session)
accept_flow_invitation {
    session_id: String,
    flow_name: String,
    flow_spec: Value,
    participants: Vec<FlowParticipant>,
}

// Get session state
get_multiparty_flow_state { session_id: String }

// Run a step
run_flow_step { session_id: String, step_id: String }

// Share step outputs
share_step_outputs { session_id: String, step_id: String }

// List active sessions
list_multiparty_sessions {}
```

### 8. Implementation Steps

Phase 1: Propose Flow UI

- [ ] Add "Propose Flow" button in Messages (group chat only)
- [ ] Create ProposeFlowModal component
- [ ] Load multiparty flows, show role assignment UI
- [ ] Send invitation via send_message with flow_invitation metadata

Phase 2: Invitation Card Updates

- [ ] Update invitation card to show "Join in Runs" button
- [ ] Navigate to Runs tab on click, open session panel

Phase 3: Runs Tab Integration

- [ ] Add "Active Multiparty Sessions" section
- [ ] List sessions user is participating in
- [ ] Create session execution panel
- [ ] Wire up Run/Share buttons

Phase 4: Polish

- [ ] Real-time status updates between participants
- [ ] Error handling and retry
- [ ] Session completion state

## Test Script

```bash
./dev-three.sh --reset
# Opens 3 BioVault windows:
#   client1@sandbox.local (contributor1)
#   client2@sandbox.local (contributor2)
#   aggregator@sandbox.local (aggregator)

# Manual testing:
# 1. In aggregator window, go to Messages
# 2. Create group chat with client1, client2
# 3. Click "Propose Flow" → select multiparty → assign roles
# 4. Send invitation
# 5. In client1/client2 windows, see invitation → click "Join in Runs"
# 6. Each participant steps through their assigned steps
```

# Multiparty Flow Improvements

## Completed

### UI Basics

- [x] Button visibility - Run buttons only show for Ready steps
- [x] Aggregator doesn't see buttons until their turn
- [x] "Join Flow" → "View Flow" after joining
- [x] Hide "Decline" button once joined
- [x] Preview remains visible after share

### Cross-Client Sync (Partial)

- [x] Poll state files from MPC sharing folder (sandbox fallback)
- [x] Update aggregate step when contributors share (WaitingForInputs → Ready)
- [x] Aggregate reads contributor data (currently from sandbox direct paths)
- [x] Write progress.json when steps complete/share

### Progress & UI (Session 2)

- [x] Progress shows total flow progress: "X/4 steps complete"
- [x] Everyone sees same progress count (4 total steps)
- [x] Shows "Done" when all steps complete
- [x] syft.pub.yaml created when sharing (for SyftBox sync)
- [x] Participant chips show full email with checkbox status
- [x] All participants shown on each step (☑ completed, ☐ pending, greyed = not involved)
- [x] Preview button opens folder in OS file manager
- [x] Activity Log moved to tab (instead of collapsible section)
- [x] Added `roles` field to StepState for frontend

---

## TODO - Remaining Items

### 3. Participant Header - Show Current Stage

- [ ] At top where participant cards are shown
- [ ] Show which step each participant is currently on
- [ ] e.g., "contributor1 - Step 2: Share Contribution"

### 6. Aggregator Reads from Synced Paths (Not Direct)

- [ ] Currently reading from sandbox direct paths (fallback hack)
- [ ] Should read from properly synced SyftBox paths
- [ ] e.g., `{my_home}/datasites/{contributor}/shared/flows/...`
- [ ] This requires SyftBox to be running and syncing

### 7. Run Completion Status

- [ ] When ALL steps complete for ALL participants → mark run as "Done"
- [ ] Currently shows "RUNNING" even when everything is done
- [ ] Update run status badge

### 9. Clickable Participant Bubbles

- [ ] Click participant card → see their current state/view
- [ ] Show their progress through steps
- [ ] "View" buttons should show files they shared with you (if available)

---

## File Paths Reference

**Where contributors write:**

```
{contributor_home}/datasites/{contributor}/shared/flows/{flow}/{session}/{step}/
```

**Where aggregator should read (after SyftBox sync):**

```
{aggregator_home}/datasites/{contributor}/shared/flows/{flow}/{session}/{step}/
```

**syft.pub.yaml structure:**

```yaml
read:
  - aggregator@sandbox.local
```

---

## Priority Order (Remaining)

1. **Run completion status** - UX polish (show "Done" badge)
2. **Participant stage indicator** - UX enhancement
3. **Clickable participant cards** - UX enhancement
4. **Synced paths for aggregator** - When SyftBox is running

---

## Implementation Progress (Feb 2026)

### Problem: Empty Steps After Main Merge

After merging code from main, multiparty flows broke with empty steps. Root cause: data structure mismatch between YAML and Rust.

### Data Structure Issue

| Format                  | Structure                                     | Problem                   |
| ----------------------- | --------------------------------------------- | ------------------------- |
| **FlowFileSpec** (YAML) | `spec.datasites.groups` with role definitions | Full group info           |
| **FlowSpec** (Rust)     | `datasites: Vec<String>` flat list            | Groups lost in conversion |

### Fixes Applied to `src-tauri/src/commands/multiparty.rs`

#### 1. Build Groups from Participants (not flow spec)

```rust
fn build_group_map_from_participants(
    participants: &[FlowParticipant],
    flow_spec: &serde_json::Value,
) -> (HashMap<String, Vec<String>>, HashMap<String, String>)
```

Creates:

- `"all"` → all participant emails
- `"contributor1"`, `"contributor2"`, `"aggregator"` → role-based groups
- `"contributors"` → plural group from `contributorN` roles
- `"clients"` → alias for contributors
- `default_to_actual` map → position-based email mapping

#### 2. Check `runs_on` First (FlowSpec format)

```rust
fn get_step_targets(step: &serde_json::Value) -> Vec<String> {
    // Try FlowSpec format first
    if let Some(runs_on) = step.get("runs_on") { ... }
    // Fallback to YAML format
    if let Some(run) = step.get("run") { ... }
}
```

#### 3. Default-to-Actual Email Mapping

The flow spec has default emails like `client1@sandbox.local`, but actual participants may have different emails. Fixed by mapping by position:

```rust
// Map default datasite email to actual participant email
if i < default_datasites.len() {
    default_to_actual.insert(default_datasites[i].clone(), p.email.clone());
}
```

#### 4. Updated `my_action` Logic

```rust
let my_action = targets.iter().any(|target| {
    if target == my_email { return true; }
    if let Some(group_members) = groups.get(target) {
        if group_members.contains(&my_email.to_string()) { return true; }
    }
    // Check default-to-actual mapping
    if let Some(actual_email) = default_to_actual.get(target) {
        if actual_email == my_email { return true; }
    }
    false
})
```

### Test Command

```bash
./test-scenario.sh --pipelines-multiparty --interactive
```

### Current Status

- ✅ Code compiles without warnings
- ✅ Groups built from participants correctly
- ✅ `runs_on` field handled properly
- ✅ Default email → actual email mapping works
- 🔄 Testing multiparty execution flow
- ⏳ SyftBox sync (syft.pub.yaml/syft.sub.yaml) data transfer

### Goal: Unified Flow Syntax

All flows should use same syntax as `syqure-distributed`:

- Data moves via SyftBox sync, not shell scripts
- No separate code paths for single vs multiparty
- Steps target groups like `clients`, `aggregator`
