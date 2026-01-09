## General

- You have full network and run/write permission in a VM so don't worry about permissions.
- You are on windows and some of our tools are made for linux, where possible use the original tools otherwise create tool.ps1 equivalents if you have to.
- Read `TASK.md` for technical reference, completed features, and what's next. - Read PROGRESS.md from the last loop (if it exists)
- Do the next most important thing in your task and if you are done then say so
- keep working on it until you think you are done
- As you progress put your updated thinking in PROGRESS.md and keep it up to date
- When you think you are done write at the end of PROGRESS.md: FINAL LOOP I think I am done, check everything one last time and exit
- When you resume one last time if this is the last time and you are really done output: <promise>RALPH IS DONE</promise>
- Use the local `./repo` helper for workspace setup/status across sub-repos. - Setup: `./repo --init` (use `--https` in CI).
  - Status: `./repo` or `./repo --status` - Sync: `./repo sync`
  - Pin manifest to current SHAs: `./repo pin` - Tooling check: `./repo tools`

## Testing

- On windows the repo tools are ./repo.ps1
- Multi-repo lint: `./repo lint` (runs lint.sh for dirty repos) --force to double check as well
- Toolchain check: `./repo tools`
- Rust tests read the repo script and run some there
- Read the github actions there are lots of end to end tests
- Periodically run them all I want you to go through them and mark them off as passing with observability enabled
- You can run them with .\win.ps1 ./test-scenario-obs.sh xyz
- If UI windows do not appear or interactive mode pauses are skipped, run test scenarios in the desktop session:
  - `.\win.ps1 --desktop --desktop-wait .\test-scenario-obs.sh --pipelines-collab --interactive`
  - This uses PsExec to attach to the active desktop session so Tauri windows and Playwright headed mode show up.
  - `--desktop-wait` keeps the attached process in the foreground so the run is visible and interactive.
  - Use `--session <id>` if the active desktop session is not detected.

## Git Etiquette

- Don't commit temp/debug files
- Run linting before committing
- Commit after each working feature with descriptive message
- Do not co-author commits or commit .claude / other agent cruft
- Create a feature branch for your work using `./repo branch <name>` so all repos stay in sync.
- You may open PRs to run CI, but do not merge anything without approval.

## Refactoring Rules

- Have tests passing BEFORE refactoring
- Copy code to new location first, then delete from old
- Keep functionality identical - no "improvements" during refactor
- Run tests after each move

## DO NOT

- Skip tests to move faster
- Add new features before stabilizing existing ones
- Make changes without reading the relevant code first
- Leave unwrap() calls that could panic in production paths
