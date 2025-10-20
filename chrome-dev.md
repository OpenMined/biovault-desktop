# Chrome DevTools Development Loop

## Quick Start

```bash
# 1. Kill existing session & start dev environment
tmux kill-session -t biovault-dev 2>/dev/null
tmux new-session -d -s biovault-dev 'bash ./dev-with-chrome.sh'

# 2. Launch Chrome with remote debugging
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug-profile \
  http://localhost:8080 &

# 3. Verify services
lsof -Pi :8080 -sTCP:LISTEN -t  # HTTP server
lsof -Pi :3333 -sTCP:LISTEN -t  # WebSocket backend
lsof -Pi :9222 -sTCP:LISTEN -t  # Chrome debug port
```

## Architecture

```
Browser → HTTP (8080) → WebSocket (3333) → Rust Backend
          ↑                                    ↑
    Python server                      Tauri + biovault CLI
```

## Chrome DevTools MCP Usage

### List & Navigate

```typescript
mcp__chrome-devtools__list_pages()
mcp__chrome-devtools__navigate_page(url: "http://localhost:8080")
```

### Snapshot & Interact

```typescript
// Get page structure (token-efficient)
mcp__chrome-devtools__take_snapshot()

// Click elements by uid
mcp__chrome-devtools__click(uid: "1_3")

// Fill forms
mcp__chrome-devtools__fill(uid: "2_5", value: "text")

// Evaluate JavaScript
mcp__chrome-devtools__evaluate_script(
  function: "() => document.title"
)
```

### Monitoring

```typescript
mcp__chrome - devtools__list_console_messages()
mcp__chrome - devtools__list_network_requests()
```

## Dev Workflow

1. **Start** → tmux session + Chrome debug mode
2. **Snapshot** → Get page structure (use text, not screenshots)
3. **Interact** → Click/fill/evaluate via MCP tools
4. **Monitor** → Console/network as needed
5. **Iterate** → Code changes auto-reload via Tauri dev

## Cleanup

```bash
tmux kill-session -t biovault-dev
pkill -f "chrome-debug-profile"
```

## Notes

- Snapshot uses minimal tokens vs screenshots
- Chrome must launch with `--remote-debugging-port=9222`
- MCP connects to existing Chrome instance automatically
- Backend logs: `tail -f /tmp/tauri-dev.log`
