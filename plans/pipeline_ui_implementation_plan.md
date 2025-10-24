# Pipeline UI Implementation Plan

## Overview

Create a pipeline management system in the desktop UI that mirrors the project management functionality. Users will be able to create, edit, and run multi-step pipelines that chain projects together, similar to how `biovault/run_demo_sql.sh` works but via a graphical interface.

## Current Architecture Analysis

### Existing Project UI Pattern (Reference)

- **Location**: Projects tab
- **Features**: Create wizard, editor, preview, validation
- **Storage**: `projects/` folder with `project.yaml` files
- **Wizard Steps**: Details → Inputs → Parameters → Outputs → Preview → Review
- **File**: `src/projects.js` (~1560 lines)

### Current Run Tab

- **Purpose**: Execute individual projects with participant selection
- **Features**: Project selection, participant selection, live logs, run history
- **File**: `src/runs.js` (~360 lines)

### Pipeline YAML Structure (Reference: `biovault/pipeline_sql.yaml`)

```yaml
name: demo-sql
inputs: # Pipeline-level inputs
  samplesheet: File
  data_dir: Directory

steps:
  - id: filter # Unique step identifier
    uses: cli/examples/pipeline/filter-samples # Project path
    with: # Input bindings
      samplesheet: inputs.samplesheet
      data_dir: inputs.data_dir
    publish: # Exposed outputs
      filtered_sheet: File(filtered_samplesheet.csv)

  - id: count
    uses: cli/examples/pipeline/count-lines
    with:
      samplesheet: step.filter.outputs.filtered_sheet
      data_dir: inputs.data_dir
    publish:
      counted_sheet: File(line_counts.csv)
    store: # SQL storage (optional)
      counts_sql:
        kind: sql
        destination: SQL()
        source: counted_sheet
        table_name: pipeline_counts_{run_id}
        key_column: participant_id
```

## Implementation Plan

### Phase 1: Pipeline Management Foundation

#### 1.1 Backend API Commands (Rust)

Add to `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
async fn get_pipelines() -> Result<Vec<Pipeline>, String>

#[tauri::command]
async fn create_pipeline(name: String, directory: Option<String>) -> Result<Pipeline, String>

#[tauri::command]
async fn load_pipeline_editor(pipeline_id: Option<i64>, pipeline_path: Option<String>) -> Result<PipelineEditorPayload, String>

#[tauri::command]
async fn save_pipeline_editor(pipeline_id: Option<i64>, pipeline_path: String, payload: PipelineSpecPayload) -> Result<SavedPipeline, String>

#[tauri::command]
async fn delete_pipeline(pipeline_id: i64) -> Result<(), String>

#[tauri::command]
async fn preview_pipeline_spec(payload: PipelineSpecPayload) -> Result<PipelinePreview, String>

#[tauri::command]
async fn validate_pipeline(pipeline_path: String) -> Result<ValidationResult, String>

#[tauri::command]
async fn run_pipeline(pipeline_id: i64, input_overrides: HashMap<String, String>) -> Result<PipelineRun, String>
```

#### 1.2 Database Schema

Add to migrations:

```sql
CREATE TABLE IF NOT EXISTS pipelines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    pipeline_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id INTEGER NOT NULL,
    status TEXT NOT NULL, -- 'pending', 'running', 'success', 'failed'
    work_dir TEXT NOT NULL,
    results_dir TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (pipeline_id) REFERENCES pipelines(id)
);
```

#### 1.3 Storage Structure

```
$BIOVAULT_HOME/
  pipelines/           # Pipeline YAML files
    demo-sql/
      pipeline.yaml
    my-analysis/
      pipeline.yaml
  runs/                # Execution results
    pipeline_<timestamp>/
      filter/
      count/
      sum/
```

### Phase 2: Pipeline List & Basic UI

#### 2.1 Create Pipelines Tab

Add to `src/templates/run.html`:

```html
<div class="run-tabs">
	<button class="run-tab active" data-tab="execute">Execute Project</button>
	<button class="run-tab" data-tab="pipelines">Pipelines</button>
	<button class="run-tab" data-tab="results">Results</button>
</div>

<div id="pipelines-view" class="run-tab-content" style="display:none;">
	<!-- Pipeline management UI will go here -->
</div>
```

#### 2.2 Pipeline List View

Similar to projects list:

```html
<div class="pipeline-section">
	<h3>Pipelines</h3>
	<div style="display: flex; gap: 10px; margin-bottom: 15px">
		<button id="create-pipeline-btn" class="primary-btn">+ Create New Pipeline</button>
	</div>
	<div id="pipelines-list" class="pipelines-list">
		<!-- Pipeline cards will be rendered here -->
	</div>
</div>
```

Each pipeline card shows:

- Name
- Number of steps
- Created/updated date
- Actions: Edit, Run, Delete, Open Folder

### Phase 3: Pipeline Creation Wizard

#### 3.1 Wizard Structure (6 steps)

Similar to project wizard but adapted for pipelines:

1. **Pipeline Details**

   - Name
   - Description (optional)
   - Work directory (auto-generated)

2. **Pipeline Inputs**

   - Define pipeline-level inputs (reusable across steps)
   - Type: File, Directory, String
   - Default values (optional)

3. **Add Steps**

   - Select project from dropdown (from database or absolute path)
   - Set step ID (auto-suggest from project name)
   - Configure input bindings:
     - Show project's required inputs
     - Bind to: pipeline inputs, previous step outputs, or literals
     - Validation: type checking
   - Select outputs to publish (default: all)
   - Reorder steps (up/down buttons)

4. **Configure Storage** (Optional)

   - For each step, optionally add SQL store
   - Select which output to store
   - Table name (with {run_id} substitution)
   - Key column

5. **Preview**

   - Show generated pipeline.yaml
   - Validation warnings/errors

6. **Review & Create**
   - Summary of pipeline
   - Step diagram (ASCII)
   - Create button

#### 3.2 Step Configuration Component

```javascript
// Step builder UI
{
  id: "filter",
  projectPath: "/path/to/filter-samples",  // Or project ID
  projectSpec: { /* loaded project.yaml */ },
  bindings: {
    samplesheet: { type: "pipeline_input", value: "inputs.samplesheet" },
    data_dir: { type: "pipeline_input", value: "inputs.data_dir" }
  },
  publishedOutputs: ["filtered_sheet"],
  store: null  // Or { kind: "sql", ... }
}
```

### Phase 4: Pipeline Editor

#### 4.1 Editor Layout

Similar to project editor:

```
┌─────────────────────────────────────────────────────┐
│ ← Back to Pipelines    [Validate] [Save] [Run]     │
├─────────────┬───────────────────────────────────────┤
│             │ Pipeline Details                      │
│   Steps     │  - Name: demo-sql                     │
│   Sidebar   │  - Version: 1.0.0                     │
│             │                                        │
│ □ Filter    │ Pipeline Inputs                       │
│ □ Count     │  - samplesheet: File                  │
│ □ Sum       │  - data_dir: Directory                │
│             │                                        │
│ [+ Add      │ Steps Configuration                   │
│    Step]    │  [Step 1: Filter] [Edit] [↑] [↓] [✕] │
│             │  [Step 2: Count]  [Edit] [↑] [↓] [✕] │
│             │                                        │
│             │ Preview                                │
│             │  <details> pipeline.yaml               │
└─────────────┴───────────────────────────────────────┘
```

#### 4.2 Step Editor Modal

When editing a step:

- Project selection/change
- Input binding UI (dropdown for available sources)
- Output selection checkboxes
- Store configuration (expandable section)

### Phase 5: Pipeline Execution

#### 5.1 Run Pipeline Dialog

When clicking "Run" on a pipeline:

```
┌─────────────────────────────────────────────┐
│ Run Pipeline: demo-sql                      │
├─────────────────────────────────────────────┤
│                                             │
│ Configure Inputs                            │
│                                             │
│ samplesheet (File) *                        │
│ [/path/to/participants.csv] [Browse...]     │
│                                             │
│ data_dir (Directory) *                      │
│ [/path/to/data] [Browse...]                 │
│                                             │
│ Output Location                             │
│ [/biovault/runs/pipeline_20251023...]       │
│                                             │
│               [Cancel] [Run Pipeline]       │
└─────────────────────────────────────────────┘
```

Key features:

- Pre-fill with defaults if specified
- File picker for File inputs
- Directory picker for Directory inputs
- Text input for String inputs
- Output directory (auto-generated, editable)

#### 5.2 Pipeline Execution Flow

```javascript
async function runPipeline(pipelineId, inputValues) {
	// 1. Create pipeline run record
	const run = await invoke('create_pipeline_run', {
		pipelineId,
		inputValues,
	})

	// 2. Navigate to Results tab and show logs
	navigateTo('results')
	showPipelineRunLogs(run.id)

	// 3. Execute pipeline (streams logs)
	await invoke('execute_pipeline_run', { runId: run.id })

	// 4. Refresh results list
	await loadPipelineRuns()
}
```

Backend executes:

```bash
bv run pipeline.yaml \
  --set inputs.samplesheet=/path/to/file.csv \
  --set inputs.data_dir=/path/to/data \
  --results-dir /path/to/results
```

#### 5.3 Pipeline Results View

Update Results tab to show both:

- Project runs (existing)
- Pipeline runs (new)

Each pipeline run shows:

- Pipeline name
- Status badge (Running/Success/Failed)
- Number of steps completed
- Execution time
- Work directory
- Actions: View Logs, Open Folder, Delete

### Phase 6: Advanced Features

#### 6.1 Step Validation

- Check that all required inputs are bound
- Type compatibility validation
- Circular dependency detection
- Warn about unused outputs

#### 6.2 SQL Store UI

For each step with store configuration:

```html
<details class="store-config">
	<summary>📦 Store to Database</summary>
	<label>
		Output to store:
		<select>
			<option value="counted_sheet">counted_sheet</option>
		</select>
	</label>
	<label>
		Table name:
		<input value="pipeline_counts_{run_id}" />
	</label>
	<label>
		Key column:
		<input value="participant_id" />
	</label>
</details>
```

#### 6.3 Pipeline Diagram

ASCII visualization in preview:

```
Pipeline: demo-sql
═══════════════════════════════════════

 inputs.samplesheet ─┐
 inputs.data_dir ────┼─→ [Filter] ─→ filtered_sheet ─┐
                     │                                │
                     └─────────────────────────────────┼─→ [Count] ─→ counted_sheet ─→ [Sum]
                                                       │       ↓
                                                       │    (SQL: pipeline_counts_{run_id})
```

#### 6.4 Project Dropdown

When adding a step:

- Show projects from database (registered projects)
- Option to browse for project path (absolute path)
- Display project inputs/outputs after selection
- Validation that project.yaml exists

### Phase 7: File Organization

#### 7.1 Frontend Files (New)

```
src/
  pipelines.js          # Pipeline management module (~1500 lines estimated)
  pipeline-spec-form.js # Step configuration form (~800 lines estimated)
  templates/
    pipelines.html      # Pipeline list and wizard
    pipeline-edit.html  # Pipeline editor view
  css/
    pipelines.css       # Pipeline-specific styles
```

#### 7.2 Backend Files (Modifications)

```
src-tauri/src/
  commands.rs           # Add pipeline commands
  models/
    pipeline.rs         # NEW: Pipeline model
  db.rs                 # Add pipeline tables
```

## MVP Scope (For Initial Implementation)

### Include:

1. ✅ Pipeline list view
2. ✅ Create pipeline wizard (basic 4 steps: Details, Inputs, Steps, Review)
3. ✅ Add/remove/reorder steps
4. ✅ Bind step inputs to pipeline inputs or previous step outputs
5. ✅ Store pipelines as YAML in `pipelines/` folder
6. ✅ Run pipeline with input selection dialog
7. ✅ Basic SQL store configuration (table name, key column)
8. ✅ Pipeline execution via `bv run`
9. ✅ Live logs for pipeline runs
10. ✅ Pipeline run history

### Defer (Post-MVP):

- Advanced validation (type checking)
- Visual pipeline diagram editor
- Step parameter configuration (currently: use project defaults)
- Multiple store destinations (only SQL for now)
- Pipeline templates
- Import/export pipelines
- Pipeline versioning
- Conditional steps
- Parallel execution visualization

## Example User Flow

### Creating a Pipeline

1. User clicks "Create New Pipeline" in Pipelines tab
2. Enters pipeline name: "demo-sql"
3. Adds pipeline inputs:
   - `samplesheet`: File
   - `data_dir`: Directory
4. Adds Step 1:
   - Selects project: `filter-samples` (from dropdown or path)
   - Binds inputs:
     - `samplesheet` → `inputs.samplesheet`
     - `data_dir` → `inputs.data_dir`
   - Publishes: `filtered_sheet`
5. Adds Step 2:
   - Selects project: `count-lines`
   - Binds inputs:
     - `samplesheet` → `step.filter.outputs.filtered_sheet`
     - `data_dir` → `inputs.data_dir`
   - Publishes: `counted_sheet`
   - Configures store:
     - Source: `counted_sheet`
     - Table: `pipeline_counts_{run_id}`
     - Key: `participant_id`
6. Reviews YAML preview
7. Clicks "Create Pipeline"
8. Pipeline saved to `pipelines/demo-sql/pipeline.yaml`

### Running a Pipeline

1. User clicks "Run" on "demo-sql" pipeline
2. Dialog opens with input selection:
   - `samplesheet`: [Browse...] → selects `/data/participants.csv`
   - `data_dir`: [Browse...] → selects `/data`
   - Results dir: auto-filled with `/runs/pipeline_20251023_143022/` (editable)
3. Clicks "Run Pipeline"
4. UI navigates to Results tab
5. Shows live logs as pipeline executes:
   - Step 1: Filter... ✓
   - Step 2: Count... ✓ (Stored to SQL: pipeline_counts_20251023_143022)
   - Step 3: Sum... ✓
6. Pipeline completes, status shows "Success"
7. User can:
   - Open results folder
   - View detailed logs
   - Query SQL table via SQL tab

## Technical Considerations

### State Management

- Pipeline editor state (similar to project editor)
- Step configuration state (array of step objects)
- Input binding state (mapping of input names to sources)
- Validation state (errors/warnings)

### Validation

- Client-side: basic structure, required fields
- Server-side: `bv pipeline validate` command
- Real-time validation as user builds pipeline

### File Watching

- Watch pipeline.yaml for external changes (similar to project.yaml)
- Reload editor if file changes externally

### Error Handling

- Project not found
- Invalid input bindings
- Type mismatches (warning only for MVP)
- Execution failures (show in logs)

### Performance

- Lazy load project specs (only when selected)
- Cache project list
- Stream logs (don't load entire log file)

## Testing Strategy

### Manual Testing Checklist

- [ ] Create pipeline with 2+ steps
- [ ] Edit existing pipeline
- [ ] Delete pipeline
- [ ] Run pipeline with File input
- [ ] Run pipeline with Directory input
- [ ] View pipeline run logs
- [ ] Delete pipeline run
- [ ] Configure SQL store
- [ ] Verify SQL data after pipeline run
- [ ] Reorder pipeline steps
- [ ] Remove pipeline step
- [ ] Handle missing project path
- [ ] Handle invalid input bindings

### Test Cases

1. **Simple 2-step pipeline**: filter → count
2. **3-step pipeline with SQL**: filter → count → sum (with SQL store on count)
3. **Pipeline with all input types**: File, Directory, String
4. **Pipeline editing**: modify existing pipeline, add/remove steps
5. **Error scenarios**: invalid project path, missing inputs, failed execution

## Implementation Sequence

### Week 1: Foundation

1. Database schema and migrations
2. Rust backend commands (CRUD operations)
3. Pipeline storage structure

### Week 2: UI Basics

4. Pipelines tab and list view
5. Create pipeline wizard (basic 3 steps)
6. Pipeline YAML generation

### Week 3: Pipeline Building

7. Step addition UI
8. Input binding UI
9. Step reordering and removal

### Week 4: Execution

10. Run pipeline dialog
11. Pipeline execution backend
12. Live logs integration

### Week 5: Polish

13. SQL store configuration UI
14. Pipeline editor (edit existing)
15. Validation and error handling

### Week 6: Testing & Refinement

16. End-to-end testing
17. Bug fixes
18. Documentation

## Open Questions & Decisions Needed

1. **Project Selection**:

   - Should we only allow registered projects (from database)?
   - Or also allow absolute paths to project folders?
   - **Recommendation**: Support both, with dropdown for registered + browse for paths

2. **Pipeline Input Defaults**:

   - Should pipeline inputs support default values?
   - **Recommendation**: Yes, for convenience (pre-fill run dialog)

3. **Step Parameters**:

   - Should we expose project parameters in step configuration?
   - **Recommendation**: Defer to post-MVP, use project defaults for now

4. **Validation Strictness**:

   - Should type mismatches block pipeline creation?
   - **Recommendation**: Show warnings but allow creation (rely on `bv validate`)

5. **Results Directory**:

   - Auto-generate or let user choose every time?
   - **Recommendation**: Auto-generate with option to override

6. **Pipeline Versioning**:
   - Track pipeline.yaml versions in database?
   - **Recommendation**: Defer to post-MVP, file-based only for now

## Success Criteria

1. ✅ User can replicate `run_demo_sql.sh` functionality entirely via UI
2. ✅ Pipeline creation workflow is intuitive (similar to project creation)
3. ✅ Pipeline runs execute successfully with proper logging
4. ✅ SQL store writes data to database correctly
5. ✅ Pipeline YAML files are human-readable and editable
6. ✅ No regressions in existing project or run functionality

## Notes

- This design heavily mirrors the existing project UI patterns for consistency
- The step-by-step wizard approach reduces cognitive load for complex pipeline creation
- File-based storage (YAML) maintains compatibility with CLI workflows
- SQL store integration enables data persistence without manual SQL commands
- MVP scope is deliberately limited to core functionality, deferring advanced features
