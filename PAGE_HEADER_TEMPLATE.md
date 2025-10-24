# Consistent Page Headers Guide

All screens should follow this pattern for a sleek, consistent UI.

## Basic Structure

Each screen/view should wrap content in a view container:

```html
<div class="view-container">
  <!-- Page Header -->
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">
        <svg><!-- icon --></svg>
        Screen Name
      </h1>
      <p class="page-subtitle">Optional description or additional info</p>
      
      <!-- Optional stats section -->
      <div class="page-stats">
        <div class="stat-badge">
          <svg><!-- icon --></svg>
          <span>Stat Label</span>
        </div>
        <div class="stat-badge">
          <svg><!-- icon --></svg>
          <span>Another Stat</span>
        </div>
      </div>
    </div>

    <!-- Optional action buttons section -->
    <div class="page-header-right">
      <div class="page-header-actions">
        <button class="btn-primary">Action Button</button>
        <button class="btn-secondary">Secondary</button>
      </div>
    </div>
  </header>

  <!-- Main Content -->
  <div class="view-content">
    <!-- Your page content here -->
  </div>
</div>
```

## Examples for Each Screen

### Run Screen
- Icon: play icon
- Title: "Run Analysis"
- Subtitle: "Execute workflows and pipelines"
- Stats: Active pipelines, Total runs
- Actions: Start run button

### Pipelines Screen (active by default)
- Icon: workflow icon
- Title: "Pipelines"
- Subtitle: "Multi-step workflows"
- Stats: Total pipelines count
- Actions: + New Pipeline

### Data Screen
- Icon: database icon
- Title: "Data Management"
- Subtitle: "Upload and manage your datasets"
- Stats: Participants, Files
- Actions: + Import Data, Process Queue

### Results Screen
- Icon: chart icon
- Title: "Analysis Results"
- Subtitle: "View pipeline execution results"
- Stats: Total runs, Success rate
- Actions: Filter/Sort options

## CSS Classes Reference

- `.page-header` - Main header container
- `.page-header-left` - Left section (title/subtitle/stats)
- `.page-header-right` - Right section (actions)
- `.page-title` - Main title with optional icon
- `.page-subtitle` - Smaller descriptive text
- `.page-stats` - Container for stat badges
- `.stat-badge` - Individual stat item
- `.page-header-actions` - Button group
- `.view-container` - Outer wrapper for entire view
- `.view-content` - Scrollable content area

## Colors Used
- Primary: #10b981 (green)
- Text: #1f2937 (dark gray)
- Secondary Text: #6b7280 (medium gray)
- Background: #f8f9fa (light gray)
- Borders: #e5e7eb (subtle border)
- Stat Background: #f3f4f6 (light stat bg)
