# BioVault Desktop UI Rebuild Summary

## 🎯 Goal Achieved

Created a **radically simplified, clinic-friendly** interface for creating and configuring pipeline steps. No YAML knowledge required, no Nextflow syntax to memorize.

---

## 📦 What Changed

### 1. Step Editor (`/src/templates/project-edit.html`)

**Before:** Complex tabbed interface with file trees, spec forms, preview panels  
**After:** Single scrollable page with natural language

#### New Interface Structure:

```
┌────────────────────────────────────────┐
│ ← Back   [Jupyter] [VSCode] [Save]    │
├────────────────────────────────────────┤
│ APOL1 Classification                   │
│ ════════════════════════════            │
│                                        │
│ Name: [________________]               │
│ Description: [_________]               │
│                                        │
│ Your Code Files                        │
│ ┌──────────────────────────┐          │
│ │ Drop files or click      │          │
│ └──────────────────────────┘          │
│ ✓ apol1_classifier.py  [×]            │
│ ✓ schema.yaml          [×]            │
│                                        │
│ What files does your code need?       │
│ • genotype_file (VCF)     [Edit] [×]  │
│ • sample_sheet (CSV)      [Edit] [×]  │
│ [+ Add input file]                    │
│                                        │
│ What files does your code create?     │
│ • classified_genotypes    [Edit] [×]  │
│ [+ Add output file]                   │
│                                        │
│ ▸ Settings (optional)                 │
│   Parameters, workflow, template...   │
│                                        │
│ 📁 /Users/.../my-project              │
└────────────────────────────────────────┘
```

#### Key Features:

- ✅ **Giant step name input** at top (32px font)
- ✅ **Natural language headings** ("What files does your code need?")
- ✅ **File drop zone** (visual, drag-and-drop ready)
- ✅ **Simple modals** for adding inputs/outputs/parameters
- ✅ **Jupyter/VSCode** always accessible in header
- ✅ **Settings collapsed** by default (advanced users only)

### 2. Pipeline Step Configuration (`/src/templates/run.html`)

**Before:** Text inputs for bindings like `inputs.samplesheet`  
**After:** Visual dropdown-based configuration

#### Configure Modal Flow:

```
┌─────────────────────────────────────┐
│ Configure Step: quality_filter      │
├─────────────────────────────────────┤
│ ╔═══════════════════════════════╗  │
│ ║ Uses: ./projects/filter       ║  │
│ ╚═══════════════════════════════╝  │
│                                     │
│ Input Bindings                      │
│ ┌─────────────────────────────────┐ │
│ │ samplesheet (File)              │ │
│ │ → inputs.samplesheet            │ │
│ │           [Change] [Clear]      │ │
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ data_dir (Directory)            │ │
│ │ ⚠️ Not configured               │ │
│ │           [Set Binding]         │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ▸ Output Publishing (optional)     │
│ ▸ SQL Storage (optional)           │
│                                     │
│         [Cancel] [Save]             │
└─────────────────────────────────────┘
```

#### Binding Editor (Sub-Modal):

```
┌─────────────────────────────────────┐
│ Bind Input: samplesheet             │
├─────────────────────────────────────┤
│ Get Data From:                      │
│ [Pipeline Input         ▼]          │
│                                     │
│ Which Pipeline Input?               │
│ [samplesheet            ▼]          │
│                                     │
│ ╔═══════════════════════════════╗  │
│ ║ Generated Binding:            ║  │
│ ║ inputs.samplesheet            ║  │
│ ╚═══════════════════════════════╝  │
│                                     │
│         [Cancel] [Set Binding]      │
└─────────────────────────────────────┘
```

#### Supported Binding Types:

1. **Pipeline Input** → `inputs.samplesheet`
2. **Previous Step Output** → `step.filter.outputs.filtered_data`
3. **Literal File** → `File(path/to/file.csv)`
4. **Literal Directory** → `Directory(./data)`

### 3. New CSS Files

**`/src/css/project-editor.css`**

- Clean GitHub-inspired design
- White on light gray (#fafafa)
- Green accent color (#10b981)
- Responsive layout

**`/src/css/configure-step.css`**

- Modal styling for step configuration
- Binding editor styles
- Publish/store list styles
- Collapsible sections

---

## 🔧 Technical Implementation

### Files Modified:

1. **`src/projects.js`** (~700 lines changed)

   - Added `renderSimpleProjectEditor()`
   - Added `setupSimpleEditorHandlers()`
   - Added `renderFilesList()`, `renderIOList()`, `renderParametersList()`
   - Added modal handlers for I/O and parameters
   - Simplified state management (removed complex tree/spec state)

2. **`src/pipelines.js`** (~200 lines added)

   - Added `showVisualConfigModal()`
   - Added `renderStepBindingsList()`
   - Added binding editor with dropdown logic
   - Added publish/store editors
   - Added `escapeHtml()` helper

3. **`src/templates/project-edit.html`** (complete rewrite)

   - New single-page layout
   - Removed all complex tab navigation
   - Added file drop zone
   - Simple I/O modals

4. **`src/templates/run.html`** (added modals)

   - Configure step modal
   - Binding editor sub-modal
   - Publish output sub-modal
   - SQL store sub-modal

5. **`src/styles.css`**
   - Added imports for new CSS files

---

## 📊 Data Flow

### Step Editor → project.yaml

**User Fills Form:**

```
Name: APOL1 Classification
Files: apol1_classifier.py, schema.yaml
Inputs:
  - genotype_file (File, VCF format)
Outputs:
  - classified_genotypes (File, CSV format)
```

**Generates:**

```yaml
name: apol1-classification
author: clinic@example.com
workflow: workflow.nf
template: dynamic-nextflow
version: 1.0.0

assets:
  - apol1_classifier.py
  - schema.yaml

inputs:
  - name: genotype_file
    type: File
    format: vcf

outputs:
  - name: classified_genotypes
    type: File
    format: csv
```

### Pipeline Config → pipeline.yaml

**User Configures Step:**

```
Step: filter_quality
Binding: samplesheet
  Source: Pipeline Input
  Input: samplesheet
```

**Generates:**

```yaml
steps:
  - id: filter_quality
    uses: ./projects/quality-filter
    with:
      samplesheet: inputs.samplesheet
      data_dir: inputs.data_dir
```

---

## ✅ Alignment with BioVault System

### Project Types ✓

- `File`, `Directory`, `String`, `Bool`, `Integer`, `Float`
- Optional types: `File?`, `Directory?`
- Format specifications for files

### Pipeline Bindings ✓

- `inputs.<name>` for pipeline inputs
- `step.<id>.outputs.<name>` for step outputs
- `File(<path>)` for literal files
- `Directory(<path>)` for literal directories

### SQL Stores ✓

- `kind: sql`
- `destination: SQL()`
- `source:` reference to output
- `table_name:` with `{run_id}` substitution
- `key_column:` for PRIMARY KEY

---

## 🎨 Design Principles Applied

### For Non-Technical Users:

1. **Natural Language**

   - "What files does your code need?" not "Configure input specifications"
   - "Your Code Files" not "Assets"
   - "Get Data From" not "Binding source reference"

2. **Visual Feedback**

   - Green checkmarks for configured items
   - Yellow warnings for unconfigured (`⚠️ Not configured`)
   - Real-time preview of generated bindings

3. **Progressive Disclosure**

   - Advanced options collapsed
   - Only show what's needed
   - "Settings (optional)" instead of forcing configuration

4. **No Syntax**
   - Dropdowns instead of text inputs
   - Type selectors instead of typing `File`, `Directory`
   - Click "Add" not write YAML

### For Developers:

1. **Quick Access**

   - Jupyter/VSCode buttons always in header
   - Open folder link readily available

2. **Still Powerful**
   - All advanced options available (just hidden)
   - Can edit raw YAML if needed
   - Supports all BioVault features

---

## 🚀 User Experience Flow

### Clinic Creates a New Step:

1. **Navigate:** Pipeline → Add Step → Create New Project
2. **Name it:** "APOL1 Classification"
3. **Upload code:** Drag `apol1_classifier.py` into drop zone
4. **Define inputs:**
   - Click "+ Add input file"
   - Name: "genotype_file", Format: "VCF"
   - Save
5. **Define outputs:**
   - Click "+ Add output file"
   - Name: "classified_genotypes", Format: "CSV"
   - Save
6. **Save:** Click "Save Step" in header
7. **Done!** Valid project.yaml created automatically

### Clinic Configures Step in Pipeline:

1. **Click "Configure"** on step in pipeline
2. **For each input:**
   - Click "Set Binding"
   - Select "Previous Step Output" from dropdown
   - Pick the step: "quality_filter"
   - Pick the output: "filtered_samples"
   - See preview: `step.quality_filter.outputs.filtered_samples`
   - Click "Set Binding"
3. **Optional:** Add SQL storage
   - Expand "SQL Storage (optional)"
   - Click "+ Add SQL Store"
   - Fill simple form
4. **Save:** Click "Save Configuration"
5. **Done!** Valid pipeline.yaml updated

**No YAML. No Nextflow. Just forms and dropdowns.**

---

## 🔍 Testing Checklist

- [ ] Open existing step → form populates correctly
- [ ] Add input → modal opens, saves, displays in list
- [ ] Add output → modal opens, saves, displays in list
- [ ] Add parameter → modal opens, saves, displays in list
- [ ] Click Jupyter → launches Jupyter
- [ ] Click VSCode → opens in VSCode
- [ ] Save step → generates valid project.yaml
- [ ] Configure step bindings → modal opens
- [ ] Set binding with dropdown → generates correct syntax
- [ ] Add publish output → saves to step config
- [ ] Add SQL store → saves to step config
- [ ] Save configuration → updates pipeline.yaml

---

## 📝 Next Steps

1. Test in actual app
2. Handle file upload (currently placeholder)
3. Add validation messages
4. Add keyboard shortcuts (Cmd+S to save)
5. Add auto-save draft to localStorage
6. Polish animations and transitions

---

## 💡 Key Insight

The breakthrough was realizing **clinics don't write workflows** - they have Python/R scripts and need to **wrap them**. The UI should feel like:

- "Upload your code" ✅
- "Tell us what files it needs" ✅
- "Tell us what files it creates" ✅
- "Done!" ✅

NOT:

- "Configure Nextflow DSL2 workflow specification" ❌
- "Define type-safe input bindings" ❌
- "Implement parameterized outputs" ❌

The system handles all the complex Nextflow/YAML generation behind the scenes.
