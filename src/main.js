const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;

let selectedFolder = null;
let currentFiles = [];
let currentPattern = '';
let fileParticipantIds = {}; // Maps file path to participant ID
let selectedFiles = new Set(); // Set of selected file paths

function getFileExtension() {
  const select = document.getElementById('file-type-select');
  if (select.value === 'custom') {
    const customInput = document.getElementById('custom-ext-input');
    let ext = customInput.value.trim();
    if (ext.startsWith('*.')) {
      ext = ext.substring(1);
    }
    return ext;
  }
  return select.value;
}

function patternToRegex(pattern) {
  if (!pattern || !pattern.includes('{id}')) return null;

  let regex = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{id\\\}/g, '(\\d+)')
    .replace(/\\\*/g, '.*');

  return new RegExp(regex);
}

function extractIdFromPath(path, pattern) {
  const filename = path.split('/').pop();
  const regex = patternToRegex(pattern);

  if (!regex) return null;

  const match = filename.match(regex);
  if (match && match[1]) {
    const idStart = match.index + match[0].indexOf(match[1]);
    return { id: match[1], start: idStart, length: match[1].length };
  }
  return null;
}

function highlightPattern(path, pattern) {
  const filename = path.split('/').pop();
  const dir = path.substring(0, path.lastIndexOf('/') + 1);

  const result = extractIdFromPath(path, pattern);

  if (result) {
    const before = filename.substring(0, result.start);
    const highlighted = filename.substring(result.start, result.start + result.length);
    const after = filename.substring(result.start + result.length);

    return `<span style="color: #666;">${dir}</span>${before}<span class="highlight">${highlighted}</span>${after}`;
  }

  return `<span style="color: #666;">${dir}</span>${filename}`;
}

function renderFiles() {
  const fileList = document.getElementById('file-list');
  fileList.innerHTML = '';

  if (currentFiles.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No files found';
    fileList.appendChild(li);
    return;
  }

  currentFiles.forEach(file => {
    const li = document.createElement('li');

    // Checkbox column
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'file-checkbox';
    checkbox.checked = selectedFiles.has(file);
    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedFiles.add(file);
      } else {
        selectedFiles.delete(file);
      }
      updateSelectAllCheckbox();
      updateImportButton();
    });

    // File path column with highlighting
    const pathDiv = document.createElement('div');
    pathDiv.className = 'file-path';
    pathDiv.innerHTML = highlightPattern(file, currentPattern);

    // Participant ID input column
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'participant-id-input';
    input.placeholder = 'Enter ID';

    // Extract ID if pattern exists
    const extracted = extractIdFromPath(file, currentPattern);
    if (extracted && extracted.id) {
      input.value = extracted.id;
      input.classList.add('extracted');
      fileParticipantIds[file] = extracted.id;
    } else {
      input.value = fileParticipantIds[file] || '';
      if (fileParticipantIds[file]) {
        input.classList.add('manual');
      }
    }

    // Update map when user edits
    input.addEventListener('input', (e) => {
      const value = e.target.value.trim();
      if (value) {
        fileParticipantIds[file] = value;
        input.classList.remove('extracted');
        input.classList.add('manual');
      } else {
        delete fileParticipantIds[file];
        input.classList.remove('manual');
        input.classList.remove('extracted');
      }
      updateImportButton();
    });

    li.appendChild(checkbox);
    li.appendChild(pathDiv);
    li.appendChild(input);
    fileList.appendChild(li);
  });

  document.getElementById('file-count').textContent = currentFiles.length;
  updateSelectAllCheckbox();
  updateImportButton();
}

async function updatePatternSuggestions() {
  if (currentFiles.length === 0) return;

  const suggestions = await invoke('suggest_patterns', { files: currentFiles });
  const container = document.getElementById('pattern-suggestions');
  container.innerHTML = '';

  suggestions.forEach(sugg => {
    const btn = document.createElement('button');
    btn.className = 'pattern-btn';
    btn.textContent = sugg.pattern;
    btn.title = sugg.description;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pattern-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('custom-pattern').value = sugg.pattern;
      currentPattern = sugg.pattern;
      renderFiles();
      updateImportButton();
    });
    container.appendChild(btn);
  });
}

async function searchFiles() {
  if (!selectedFolder) return;

  const extension = getFileExtension();
  currentFiles = await invoke('search_txt_files', { path: selectedFolder, extension });
  currentPattern = '';

  renderFiles();
  await updatePatternSuggestions();
}

async function updateFileTypeDropdown() {
  if (!selectedFolder) return;

  const extensions = await invoke('get_extensions', { path: selectedFolder });
  const select = document.getElementById('file-type-select');

  select.innerHTML = '';

  extensions.forEach(ext => {
    const option = document.createElement('option');
    option.value = ext.extension;
    option.textContent = `${ext.extension} (${ext.count})`;
    select.appendChild(option);
  });

  const customOption = document.createElement('option');
  customOption.value = 'custom';
  customOption.textContent = 'Custom...';
  select.appendChild(customOption);

  if (extensions.length > 0) {
    select.value = extensions[0].extension;
  }
}

async function pickFolder() {
  const selected = await open({
    directory: true,
    multiple: false
  });

  if (selected) {
    selectedFolder = selected;
    document.getElementById('selected-path').textContent = selected;
    await updateFileTypeDropdown();
    await searchFiles();
  }
}

function updateSelectAllCheckbox() {
  const selectAllCheckbox = document.getElementById('select-all-files');
  if (currentFiles.length === 0) {
    selectAllCheckbox.checked = false;
    return;
  }
  selectAllCheckbox.checked = currentFiles.every(file => selectedFiles.has(file));
}

function updateImportButton() {
  const btn = document.getElementById('import-btn');

  // Check if any files are selected and all selected files have participant IDs
  const selectedFilesArray = Array.from(selectedFiles);
  const hasSelection = selectedFilesArray.length > 0;
  const allSelectedHaveIds = hasSelection && selectedFilesArray.every(file => fileParticipantIds[file]);

  btn.disabled = !allSelectedHaveIds;
}

let selectedParticipantsForDelete = [];

async function loadParticipants() {
  try {
    const participants = await invoke('get_participants');
    const tbody = document.getElementById('participants-table');
    tbody.innerHTML = '';
    selectedParticipantsForDelete = [];

    participants.forEach(p => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><input type="checkbox" class="participant-checkbox" data-id="${p.id}" /></td>
        <td>${p.id}</td>
        <td>${p.participant_id}</td>
        <td>${p.created_at}</td>
      `;
      tbody.appendChild(row);
    });

    document.querySelectorAll('.participant-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const id = parseInt(e.target.dataset.id);
        if (e.target.checked) {
          if (!selectedParticipantsForDelete.includes(id)) {
            selectedParticipantsForDelete.push(id);
          }
        } else {
          selectedParticipantsForDelete = selectedParticipantsForDelete.filter(x => x !== id);
        }
        updateDeleteParticipantsButton();
      });
    });

    document.getElementById('participant-count').textContent = participants.length;
    updateDeleteParticipantsButton();
  } catch (error) {
    console.error('Error loading participants:', error);
  }
}

function updateDeleteParticipantsButton() {
  const btn = document.getElementById('delete-selected-participants-btn');
  if (selectedParticipantsForDelete.length > 0) {
    btn.style.display = 'block';
    btn.textContent = `Delete Selected (${selectedParticipantsForDelete.length})`;
  } else {
    btn.style.display = 'none';
  }
}

let selectedFilesForDelete = [];

async function loadFiles() {
  try {
    const files = await invoke('get_files');
    const tbody = document.getElementById('files-table');
    tbody.innerHTML = '';
    selectedFilesForDelete = [];

    files.forEach(f => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><input type="checkbox" class="file-checkbox" data-id="${f.id}" /></td>
        <td>${f.id}</td>
        <td>${f.participant_name}</td>
        <td class="truncate" title="${f.file_path}">${f.file_path}</td>
        <td style="font-family: monospace; font-size: 11px;" title="${f.file_hash}">${f.file_hash.substring(0, 16)}...</td>
        <td>${f.created_at}</td>
        <td>${f.updated_at}</td>
      `;
      tbody.appendChild(row);
    });

    document.querySelectorAll('.file-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const id = parseInt(e.target.dataset.id);
        if (e.target.checked) {
          if (!selectedFilesForDelete.includes(id)) {
            selectedFilesForDelete.push(id);
          }
        } else {
          selectedFilesForDelete = selectedFilesForDelete.filter(x => x !== id);
        }
        updateDeleteFilesButton();
      });
    });

    document.getElementById('files-count').textContent = files.length;
    updateDeleteFilesButton();
  } catch (error) {
    console.error('Error loading files:', error);
  }
}

function updateDeleteFilesButton() {
  const btn = document.getElementById('delete-selected-files-btn');
  if (selectedFilesForDelete.length > 0) {
    btn.style.display = 'block';
    btn.textContent = `Delete Selected (${selectedFilesForDelete.length})`;
  } else {
    btn.style.display = 'none';
  }
}

function showImportResults(result) {
  const tbody = document.getElementById('import-results-table');
  tbody.innerHTML = '';

  result.imported_files.forEach(f => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${f.id}</td>
      <td>${f.participant_name}</td>
      <td class="truncate" title="${f.file_path}">${f.file_path}</td>
      <td style="font-family: monospace; font-size: 11px;" title="${f.file_hash}">${f.file_hash.substring(0, 16)}...</td>
      <td>${f.created_at}</td>
    `;
    tbody.appendChild(row);
  });

  document.getElementById('import-results-count').textContent = result.imported_files.length;
  document.getElementById('import-results-message').textContent = result.message;

  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('import-results-view').classList.add('active');
}

async function importFiles() {
  if (selectedFiles.size === 0) return;

  const btn = document.getElementById('import-btn');
  btn.disabled = true;
  btn.textContent = 'Importing...';

  try {
    // Build file-to-ID mapping for selected files only
    const filesToImport = Array.from(selectedFiles);
    const fileIdMap = {};
    filesToImport.forEach(file => {
      const participantId = fileParticipantIds[file];
      if (participantId) {
        fileIdMap[file] = participantId;
      }
    });

    const result = await invoke('import_files', {
      files: filesToImport,
      pattern: currentPattern,
      fileIdMap: fileIdMap
    });

    if (result.success) {
      await loadParticipants();
      await loadFiles();
      showImportResults(result);
    } else {
      const updateConflicts = confirm(
        `${result.message}\nDo you want to update the files with conflicts?`
      );

      if (updateConflicts) {
        alert('Update functionality coming soon');
      }
    }
  } catch (error) {
    alert(`Error: ${error}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import Files';
  }
}

async function loadProjects() {
  try {
    const projects = await invoke('get_projects');
    const container = document.getElementById('projects-list');

    if (projects.length === 0) {
      container.innerHTML = '<p style="color: #666;">No projects imported yet.</p>';
      return;
    }

    container.innerHTML = '';
    projects.forEach(project => {
      const card = document.createElement('div');
      card.className = 'project-card';
      card.innerHTML = `
        <div class="project-info">
          <h3>${project.name}</h3>
          <p><strong>Author:</strong> ${project.author}</p>
          <p><strong>Workflow:</strong> ${project.workflow}</p>
          <p><strong>Template:</strong> ${project.template}</p>
          <p><strong>Path:</strong> ${project.project_path}</p>
          <p><strong>Created:</strong> ${project.created_at}</p>
        </div>
        <div style="display: flex; gap: 10px;">
          <button class="open-folder-btn" data-path="${project.project_path}">Open Folder</button>
          <button class="delete-btn" data-project-id="${project.id}">Delete</button>
        </div>
      `;
      container.appendChild(card);
    });

    document.querySelectorAll('.project-card .open-folder-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        try {
          await invoke('open_folder', { path: e.target.dataset.path });
        } catch (error) {
          alert(`Error opening folder: ${error}`);
        }
      });
    });

    document.querySelectorAll('.project-card .delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const projectId = parseInt(e.target.dataset.projectId);
        if (confirm('Are you sure you want to delete this project? This will remove all files.')) {
          try {
            await invoke('delete_project', { projectId });
            await loadProjects();
          } catch (error) {
            alert(`Error deleting project: ${error}`);
          }
        }
      });
    });
  } catch (error) {
    console.error('Error loading projects:', error);
  }
}

async function importProject(overwrite = false) {
  const input = document.getElementById('project-url-input');
  const url = input.value.trim();

  if (!url) {
    alert('Please enter a GitHub URL');
    return;
  }

  console.log('Import button clicked, URL:', url);

  const btn = document.getElementById('import-project-btn');
  btn.disabled = true;
  btn.textContent = 'Importing...';

  try {
    console.log('Calling invoke with:', { url, overwrite });
    const result = await invoke('import_project', { url, overwrite });
    console.log('Import successful:', result);
    input.value = '';
    await loadProjects();
    alert('Project imported successfully!');
  } catch (error) {
    console.error('Import error:', error);
    const errorStr = String(error);
    if (errorStr.includes('already exists')) {
      const shouldOverwrite = confirm(`${errorStr}\n\nDo you want to overwrite it?`);
      if (shouldOverwrite) {
        btn.disabled = false;
        btn.textContent = 'Import';
        await importProject(true);
        return;
      }
    } else {
      alert(`Error importing project: ${errorStr}`);
    }
  } finally {
    console.log('Import finally block');
    btn.disabled = false;
    btn.textContent = 'Import';
  }
}

let selectedParticipants = [];
let selectedProject = null;

async function loadRunParticipants() {
  try {
    const participants = await invoke('get_participants');
    const container = document.getElementById('run-participants-list');
    container.innerHTML = '';

    participants.forEach(p => {
      const item = document.createElement('div');
      item.className = 'selection-item';
      item.dataset.id = p.id;
      item.innerHTML = `
        <input type="checkbox" id="part-${p.id}" />
        <label for="part-${p.id}">${p.participant_id}</label>
      `;

      item.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') {
          const checkbox = item.querySelector('input');
          checkbox.checked = !checkbox.checked;
        }

        const participantId = parseInt(item.dataset.id);
        if (item.querySelector('input').checked) {
          if (!selectedParticipants.includes(participantId)) {
            selectedParticipants.push(participantId);
          }
          item.classList.add('selected');
        } else {
          selectedParticipants = selectedParticipants.filter(id => id !== participantId);
          item.classList.remove('selected');
        }
        updateRunButton();
      });

      container.appendChild(item);
    });
  } catch (error) {
    console.error('Error loading participants:', error);
  }
}

async function loadRunProjects() {
  try {
    const projects = await invoke('get_projects');
    const container = document.getElementById('run-projects-list');
    container.innerHTML = '';

    projects.forEach(p => {
      const item = document.createElement('div');
      item.className = 'selection-item';
      item.dataset.id = p.id;
      item.innerHTML = `<strong>${p.name}</strong> - ${p.workflow}`;

      item.addEventListener('click', () => {
        document.querySelectorAll('#run-projects-list .selection-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        selectedProject = parseInt(item.dataset.id);
        updateRunButton();
      });

      container.appendChild(item);
    });
  } catch (error) {
    console.error('Error loading projects:', error);
  }
}

function updateRunButton() {
  const btn = document.getElementById('run-btn');
  btn.disabled = selectedParticipants.length === 0 || selectedProject === null;
}

async function loadRuns() {
  try {
    const runs = await invoke('get_runs');
    const container = document.getElementById('runs-list');

    if (runs.length === 0) {
      container.innerHTML = '<p style="color: #666;">No runs yet.</p>';
      return;
    }

    container.innerHTML = '';
    runs.forEach(run => {
      const card = document.createElement('div');
      card.className = `run-card ${run.status}`;
      card.style.cursor = 'pointer';
      card.dataset.runId = run.id;
      card.dataset.projectName = run.project_name;

      let statusBadge;
      if (run.status === 'success') {
        statusBadge = '<span style="background: #28a745; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">Success</span>';
      } else if (run.status === 'failed') {
        statusBadge = '<span style="background: #dc3545; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">Failed</span>';
      } else {
        statusBadge = '<span style="background: #ffc107; color: black; padding: 4px 8px; border-radius: 4px; font-size: 12px;">Running</span>';
      }

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: start;">
          <div class="run-info">
            <h3>${run.project_name} ${statusBadge}</h3>
            <p><strong>Participants:</strong> ${run.participant_count}</p>
            <p><strong>Work Directory:</strong> ${run.work_dir}</p>
            <p><strong>Created:</strong> ${run.created_at}</p>
          </div>
          <div style="display: flex; gap: 10px;">
            <button class="open-folder-btn" data-path="${run.work_dir}">Open Folder</button>
            <button class="delete-btn" data-run-id="${run.id}">Delete</button>
          </div>
        </div>
      `;

      // Make card clickable to show logs
      card.addEventListener('click', async (e) => {
        // Don't trigger if clicking buttons
        if (e.target.tagName === 'BUTTON') return;
        await showRunLogs(run.id, run.project_name, run.work_dir);
      });

      container.appendChild(card);
    });

    document.querySelectorAll('.open-folder-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        try {
          await invoke('open_folder', { path: e.target.dataset.path });
        } catch (error) {
          alert(`Error opening folder: ${error}`);
        }
      });
    });

    document.querySelectorAll('.run-card .delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const runId = parseInt(e.target.dataset.runId);
        if (confirm('Are you sure you want to delete this run? This will remove all files and the database entry.')) {
          try {
            await invoke('delete_run', { runId });

            // Hide log viewer if it's showing logs for the deleted run
            if (currentLogRunId === runId) {
              document.getElementById('log-viewer').style.display = 'none';
              currentLogRunId = null;
              currentLogWorkDir = null;
            }

            await loadRuns();
          } catch (error) {
            alert(`Error deleting run: ${error}`);
          }
        }
      });
    });
  } catch (error) {
    console.error('Error loading runs:', error);
  }
}

let currentRunLogListeners = [];

let currentLogRunId = null;
let currentLogWorkDir = null;

async function showRunLogs(runId, projectName, workDir = null) {
  const logViewer = document.getElementById('log-viewer');
  const logContent = document.getElementById('log-content');
  const logRunName = document.getElementById('log-run-name');
  const shareBtn = document.getElementById('share-logs-btn');

  currentLogRunId = runId;
  currentLogWorkDir = workDir;

  logViewer.style.display = 'block';
  logContent.textContent = 'Loading logs...';
  logRunName.textContent = `(${projectName})`;

  // Show share button if we have a work dir
  if (workDir) {
    shareBtn.style.display = 'block';
  } else {
    shareBtn.style.display = 'none';
  }

  try {
    const logs = await invoke('get_run_logs', { runId });
    logContent.textContent = logs;
    logContent.scrollTop = logContent.scrollHeight;
  } catch (error) {
    logContent.textContent = `Error loading logs: ${error}`;
  }
}

async function runAnalysis() {
  if (selectedParticipants.length === 0 || selectedProject === null) return;

  const btn = document.getElementById('run-btn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    // First, create the run record
    const result = await invoke('start_analysis', {
      participantIds: selectedParticipants,
      projectId: selectedProject
    });

    // Navigate to Results tab BEFORE starting execution
    navigateTo('runs');
    await loadRuns();

    // Show log viewer and set it up
    const logViewer = document.getElementById('log-viewer');
    const logContent = document.getElementById('log-content');
    const logRunName = document.getElementById('log-run-name');
    const shareBtn = document.getElementById('share-logs-btn');

    logViewer.style.display = 'block';
    logContent.textContent = '';
    logContent.dataset.runId = result.run_id;
    logRunName.textContent = '';
    shareBtn.style.display = 'block';

    currentLogRunId = result.run_id;
    currentLogWorkDir = result.work_dir;

    // Load initial log content
    try {
      const initialLogs = await invoke('get_run_logs', { runId: result.run_id });
      logContent.textContent = initialLogs + '\n';
      logContent.scrollTop = logContent.scrollHeight;
    } catch (error) {
      logContent.textContent = 'Initializing...\n';
    }

    // Clean up old listeners
    currentRunLogListeners.forEach(unlisten => unlisten());
    currentRunLogListeners = [];

    // Set up event listeners for logs
    const unlisten = await window.__TAURI__.event.listen('log-line', (event) => {
      logContent.textContent += event.payload + '\n';
      logContent.scrollTop = logContent.scrollHeight;
    });

    const unlistenComplete = await window.__TAURI__.event.listen('analysis-complete', async (event) => {
      logContent.textContent += `\n=== Analysis ${event.payload} ===\n`;
      await loadRuns();
      unlisten();
      unlistenComplete();
      currentRunLogListeners = [];
    });

    currentRunLogListeners = [unlisten, unlistenComplete];

    // Use setTimeout to ensure UI updates before starting execution
    setTimeout(() => {
      invoke('execute_analysis', { runId: result.run_id })
        .catch(error => {
          logContent.textContent += `\nError: ${error}\n`;
          console.error('Analysis failed:', error);
        });
    }, 100);

  } catch (error) {
    alert(`Error: ${error}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Analysis';
  }
}

async function loadSettings() {
  try {
    const settings = await invoke('get_settings');
    document.getElementById('setting-docker').value = settings.docker_path || '';
    document.getElementById('setting-java').value = settings.java_path || '';
    document.getElementById('setting-syftbox').value = settings.syftbox_path || '';
    document.getElementById('setting-biovault').value = settings.biovault_path || '';
    document.getElementById('setting-email').value = settings.email || '';
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

async function saveSettings() {
  const settings = {
    docker_path: document.getElementById('setting-docker').value,
    java_path: document.getElementById('setting-java').value,
    syftbox_path: document.getElementById('setting-syftbox').value,
    biovault_path: document.getElementById('setting-biovault').value,
    email: document.getElementById('setting-email').value,
  };

  try {
    await invoke('save_settings', { settings });
    alert('Settings saved successfully!');
  } catch (error) {
    alert(`Error saving settings: ${error}`);
  }
}

async function resetSettings() {
  if (confirm('Are you sure you want to reset all settings to defaults?')) {
    document.getElementById('setting-docker').value = '/usr/local/bin/docker';
    document.getElementById('setting-java').value = '/usr/bin/java';
    document.getElementById('setting-syftbox').value = '/usr/local/bin/syftbox';
    document.getElementById('setting-biovault').value = 'bv';
    document.getElementById('setting-email').value = '';
  }
}

function navigateTo(viewName) {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`${viewName}-view`).classList.add('active');

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${viewName}"]`)?.classList.add('active');

  if (viewName === 'participants') {
    loadParticipants();
  } else if (viewName === 'files') {
    loadFiles();
  } else if (viewName === 'projects') {
    loadProjects();
  } else if (viewName === 'run') {
    selectedParticipants = [];
    selectedProject = null;
    document.getElementById('select-all-participants').checked = false;
    loadRunParticipants();
    loadRunProjects();
    updateRunButton();
  } else if (viewName === 'runs') {
    loadRuns();
  } else if (viewName === 'settings') {
    loadSettings();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  loadParticipants();
  loadFiles();
  loadProjects();

  document.querySelectorAll('.home-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nav = btn.dataset.nav;
      navigateTo(nav);
    });
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      navigateTo(targetTab);
    });
  });

  document.getElementById('done-btn').addEventListener('click', () => {
    navigateTo('home');
  });

  document.getElementById('close-logs-btn').addEventListener('click', () => {
    document.getElementById('log-viewer').style.display = 'none';
  });

  document.getElementById('share-logs-btn').addEventListener('click', async () => {
    if (currentLogWorkDir) {
      const logPath = currentLogWorkDir + '/run.log';
      try {
        await invoke('open_folder', { path: currentLogWorkDir });
      } catch (error) {
        alert(`Error opening folder: ${error}`);
      }
    }
  });

  document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
  document.getElementById('reset-settings-btn').addEventListener('click', resetSettings);

  document.getElementById('select-all-participants-table').addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('.participant-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.checked = e.target.checked;
      const id = parseInt(checkbox.dataset.id);
      if (e.target.checked) {
        if (!selectedParticipantsForDelete.includes(id)) {
          selectedParticipantsForDelete.push(id);
        }
      } else {
        selectedParticipantsForDelete = selectedParticipantsForDelete.filter(x => x !== id);
      }
    });
    updateDeleteParticipantsButton();
  });

  document.getElementById('delete-selected-participants-btn').addEventListener('click', async () => {
    if (selectedParticipantsForDelete.length === 0) return;

    if (confirm(`Are you sure you want to delete ${selectedParticipantsForDelete.length} participant(s)? This will also delete all associated files and run records.`)) {
      try {
        for (const id of selectedParticipantsForDelete) {
          await invoke('delete_participant', { participantId: id });
        }
        await loadParticipants();
        await loadFiles();
      } catch (error) {
        alert(`Error deleting participants: ${error}`);
      }
    }
  });

  document.getElementById('select-all-files-table').addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('.file-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.checked = e.target.checked;
      const id = parseInt(checkbox.dataset.id);
      if (e.target.checked) {
        if (!selectedFilesForDelete.includes(id)) {
          selectedFilesForDelete.push(id);
        }
      } else {
        selectedFilesForDelete = selectedFilesForDelete.filter(x => x !== id);
      }
    });
    updateDeleteFilesButton();
  });

  document.getElementById('delete-selected-files-btn').addEventListener('click', async () => {
    if (selectedFilesForDelete.length === 0) return;

    if (confirm(`Are you sure you want to delete ${selectedFilesForDelete.length} file(s)?`)) {
      try {
        for (const id of selectedFilesForDelete) {
          await invoke('delete_file', { fileId: id });
        }
        await loadFiles();
      } catch (error) {
        alert(`Error deleting files: ${error}`);
      }
    }
  });

  document.getElementById('pick-folder').addEventListener('click', pickFolder);
  document.getElementById('import-btn').addEventListener('click', importFiles);

  document.getElementById('select-all-files').addEventListener('change', (e) => {
    if (e.target.checked) {
      currentFiles.forEach(file => selectedFiles.add(file));
    } else {
      selectedFiles.clear();
    }
    renderFiles();
  });
  document.getElementById('import-project-btn').addEventListener('click', () => {
    console.log('Import project button clicked');
    importProject();
  });
  document.getElementById('run-btn').addEventListener('click', runAnalysis);

  document.getElementById('select-all-participants').addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('#run-participants-list input[type="checkbox"]');
    const items = document.querySelectorAll('#run-participants-list .selection-item');

    checkboxes.forEach((checkbox, index) => {
      checkbox.checked = e.target.checked;
      const item = items[index];
      const participantId = parseInt(item.dataset.id);

      if (e.target.checked) {
        if (!selectedParticipants.includes(participantId)) {
          selectedParticipants.push(participantId);
        }
        item.classList.add('selected');
      } else {
        selectedParticipants = selectedParticipants.filter(id => id !== participantId);
        item.classList.remove('selected');
      }
    });

    updateRunButton();
  });

  const fileTypeSelect = document.getElementById('file-type-select');
  const customExtension = document.getElementById('custom-extension');
  const customExtInput = document.getElementById('custom-ext-input');
  const customPattern = document.getElementById('custom-pattern');

  fileTypeSelect.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      customExtension.style.display = 'block';
    } else {
      customExtension.style.display = 'none';
      searchFiles();
    }
  });

  customExtInput.addEventListener('input', () => {
    searchFiles();
  });

  customPattern.addEventListener('input', (e) => {
    document.querySelectorAll('.pattern-btn').forEach(b => b.classList.remove('active'));
    currentPattern = e.target.value;
    renderFiles();
    updateImportButton();
  });
});
