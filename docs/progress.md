# BioVault Desktop – Current Progress & Notes

## High-Level Status

- **Wizard UX:** Reworked into five clear steps (Details → Inputs → Parameters → Outputs → Review). Navigation buttons stay fixed at the bottom with “Next: …” labels, and each contract stage has a dedicated “Add …” button.
- **Spec Editor:** Refactored into a reusable component with mount/configure APIs. In the wizard it shows a single section at a time; in the editor it keeps the full tabbed view.
- **Previews:** Added collapsible, syntax-highlighted previews for both `project.yaml` and `template.nf` in the wizard and editor. These call a new `preview_project_spec` Tauri command which uses the CLI’s generator, so they stay consistent with command-line behaviour.
- **Defaults:** Version falls back to `1.0.0` across CLI, wizard, and editor paths. Parameter copy clarifies they are optional UI knobs passed as `params.<name>` in Nextflow.
- **Template Dropdown:** Temporarily restricted to “Blank Project” only; the list is ready to accept curated templates later.

## Key Files Touched

- `src/templates/projects.html` & `src/templates/project-edit.html`: layout, preview panels, copy updates.
- `src/project-spec-form.js` & `src/projects.js`: new shared APIs (`configureSections`, `addEntry`, wizard step wiring, preview scheduling).
- `src/css/projects.css`: wizard/footer styling, preview aesthetics.
- `src-tauri/src/commands/projects.rs`: added `preview_project_spec` command; refactored metadata parsing.
- `biovault/cli/src/project_spec.rs`: exposed `generate_template_nf` for desktop use.

## Known Considerations

- Preview generation currently fires once per step change/edit; with large specs we might debounce further.
- No lint errors remain after latest edits, but an optional future improvement is to surface preview errors inline in the wizard rather than in the console.
- Template dropdown is intentionally blank for now; UI already handles the empty list gracefully.

## Next Steps (Optional Ideas)

1. Hook up syntax highlighting via client-side library (highlight.js / Prism) if richer formatting is desired.
2. Allow users to download the generated `project.yaml` preview directly from the wizard.
3. Consider autosave for wizard state so intermediate edits persist if the modal closes accidentally.

## Quick Test Commands

```bash
cargo test --lib data::project_editor
cargo check      # from src-tauri
```
