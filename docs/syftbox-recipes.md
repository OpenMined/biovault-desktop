# SyftBox Control Plane Recipes

This document provides common recipes for controlling SyftBox through the BioVault Desktop Agent API.

## Overview

SyftBox is the decentralized data synchronization layer used by BioVault. These recipes help agents:

- Check authentication and daemon status
- Start/stop the SyftBox client
- Trigger and monitor synchronization
- Diagnose common issues

## Prerequisites

Before using these recipes, ensure:

1. BioVault Desktop is running with the WebSocket bridge enabled
2. Onboarding is complete (`check_is_onboarded` returns `true`)
3. A cryptographic key has been generated (`key_get_status`)

## Recipes

### Recipe 1: Check Overall SyftBox Health

Use this recipe to get a complete picture of SyftBox status.

```python
async def check_syftbox_health(agent):
    """
    Check overall SyftBox health and return a status summary.
    """
    results = {}

    # 1. Check authentication
    auth = await agent.check_syftbox_auth()
    results["authenticated"] = auth.get("authenticated", False)
    results["email"] = auth.get("email")

    # 2. Check daemon state
    state = await agent.get_syftbox_state()
    results["running"] = state.get("running", False)
    results["mode"] = state.get("mode")
    results["backend"] = state.get("backend")
    results["error"] = state.get("error")

    # 3. Get config info
    config = await agent.get_syftbox_config_info()
    results["config_path"] = config.get("config_path")
    results["data_dir"] = config.get("data_dir")
    results["has_tokens"] = config.get("has_access_token") and config.get("has_refresh_token")

    # 4. Determine overall health
    results["healthy"] = (
        results["authenticated"] and
        results["running"] and
        results["has_tokens"] and
        not results["error"]
    )

    return results
```

**Example usage:**

```json
// Request sequence:
{"id": 1, "cmd": "check_syftbox_auth"}
{"id": 2, "cmd": "get_syftbox_state"}
{"id": 3, "cmd": "get_syftbox_config_info"}
```

### Recipe 2: Ensure SyftBox is Running

Use this to start SyftBox if it's not running, with retry logic.

```python
async def ensure_syftbox_running(agent, max_retries=3, retry_delay=2.0):
    """
    Ensure SyftBox daemon is running. Start it if not.

    Returns:
        dict: Final SyftBox state

    Raises:
        Exception: If unable to start after retries
    """
    for attempt in range(max_retries):
        # Check current state
        state = await agent.get_syftbox_state()

        if state.get("running"):
            return state

        # Not running - try to start
        if attempt > 0:
            await asyncio.sleep(retry_delay)

        try:
            state = await agent.start_syftbox_client()
            if state.get("running"):
                return state
        except Exception as e:
            if attempt == max_retries - 1:
                raise Exception(f"Failed to start SyftBox after {max_retries} attempts: {e}")

    raise Exception("SyftBox failed to start")
```

**Example command sequence:**

```json
// Check state
{"id": 1, "cmd": "get_syftbox_state"}

// If not running, start it
{"id": 2, "cmd": "start_syftbox_client"}

// Verify it started
{"id": 3, "cmd": "get_syftbox_state"}
```

### Recipe 3: Safe SyftBox Restart

Use this when you need to restart SyftBox cleanly.

```python
async def safe_restart_syftbox(agent, wait_time=3.0):
    """
    Safely restart SyftBox daemon.

    Returns:
        dict: New SyftBox state after restart
    """
    # 1. Stop if running
    state = await agent.get_syftbox_state()
    if state.get("running"):
        await agent.stop_syftbox_client()
        await asyncio.sleep(wait_time)

    # 2. Start fresh
    new_state = await agent.start_syftbox_client()

    # 3. Wait for healthy state
    for _ in range(10):
        await asyncio.sleep(1.0)
        state = await agent.get_syftbox_state()
        if state.get("running") and not state.get("error"):
            return state

    return await agent.get_syftbox_state()
```

### Recipe 4: Trigger Sync and Wait for Completion

Use this to force a sync and monitor progress.

```python
async def sync_and_wait(agent, timeout=60.0):
    """
    Trigger SyftBox sync and wait for completion.

    Returns:
        dict: Queue status after sync
    """
    # 1. Trigger sync
    await agent.trigger_syftbox_sync()

    # 2. Poll queue status until empty or timeout
    start = time.time()
    while time.time() - start < timeout:
        status = await agent.invoke("syftbox_queue_status")

        # Check if queue is empty
        pending = status.get("pending", 0)
        if pending == 0:
            return {"success": True, "status": status}

        await asyncio.sleep(2.0)

    return {"success": False, "timeout": True, "status": status}
```

**Example command sequence:**

```json
// Trigger sync
{"id": 1, "cmd": "trigger_syftbox_sync"}

// Check queue status (poll until empty)
{"id": 2, "cmd": "syftbox_queue_status"}
{"id": 3, "cmd": "syftbox_queue_status"}
// ... repeat until pending == 0
```

### Recipe 5: Diagnose SyftBox Issues

Use this when SyftBox is not working correctly.

```python
async def diagnose_syftbox(agent):
    """
    Comprehensive SyftBox diagnostics.

    Returns:
        dict: Diagnostic report with issues found
    """
    issues = []
    report = {}

    # 1. Check auth
    auth = await agent.check_syftbox_auth()
    report["auth"] = auth
    if not auth.get("authenticated"):
        issues.append("Not authenticated - run onboarding or check credentials")

    # 2. Check state
    state = await agent.get_syftbox_state()
    report["state"] = state
    if not state.get("running"):
        issues.append("Daemon not running - try start_syftbox_client")
    if state.get("error"):
        issues.append(f"Daemon error: {state['error']}")

    # 3. Check config
    config = await agent.get_syftbox_config_info()
    report["config"] = config
    if not config.get("has_access_token"):
        issues.append("Missing access token")
    if not config.get("has_refresh_token"):
        issues.append("Missing refresh token")
    if config.get("data_dir_error"):
        issues.append(f"Data dir error: {config['data_dir_error']}")

    # 4. Get full diagnostics
    diag = await agent.get_syftbox_diagnostics()
    report["diagnostics"] = diag

    # 5. Check dependencies
    deps = await agent.check_dependencies()
    report["dependencies"] = deps
    for dep in deps:
        if dep.get("name") == "syftbox" and not dep.get("installed"):
            issues.append("SyftBox binary not found")

    report["issues"] = issues
    report["healthy"] = len(issues) == 0

    return report
```

### Recipe 6: Bootstrap New Profile with SyftBox

Use this when setting up a new profile from scratch.

```python
async def bootstrap_profile(agent, email: str):
    """
    Bootstrap a new profile with SyftBox configured.

    Args:
        email: User email for the profile

    Returns:
        dict: Bootstrap result
    """
    result = {"steps": []}

    # 1. Check if already onboarded
    is_onboarded = await agent.check_is_onboarded()
    if is_onboarded:
        result["steps"].append({"step": "onboarding", "status": "already_complete"})
    else:
        # Complete onboarding
        await agent.complete_onboarding(email)
        result["steps"].append({"step": "onboarding", "status": "completed"})

    # 2. Check/generate keys
    key_status = await agent.key_get_status(email)
    if key_status.get("hasKey"):
        result["steps"].append({"step": "key_generation", "status": "already_exists"})
    else:
        key_result = await agent.key_generate(email)
        result["steps"].append({
            "step": "key_generation",
            "status": "generated",
            "mnemonic": key_result.get("mnemonic")  # Save this!
        })

    # 3. Start SyftBox
    state = await agent.get_syftbox_state()
    if not state.get("running"):
        await agent.start_syftbox_client()
        result["steps"].append({"step": "syftbox_start", "status": "started"})
    else:
        result["steps"].append({"step": "syftbox_start", "status": "already_running"})

    # 4. Trigger initial sync
    await agent.trigger_syftbox_sync()
    result["steps"].append({"step": "initial_sync", "status": "triggered"})

    # 5. Final health check
    health = await check_syftbox_health(agent)
    result["health"] = health
    result["success"] = health["healthy"]

    return result
```

### Recipe 7: Monitor Sync Status

Use this for continuous monitoring of sync operations.

```python
async def monitor_sync(agent, callback=None, poll_interval=5.0, max_duration=300.0):
    """
    Monitor SyftBox sync status continuously.

    Args:
        callback: Optional callback(status) called on each poll
        poll_interval: Seconds between polls
        max_duration: Maximum monitoring duration

    Yields:
        dict: Sync status at each interval
    """
    start = time.time()

    while time.time() - start < max_duration:
        # Get current status
        state = await agent.get_syftbox_state()
        queue = await agent.invoke("syftbox_queue_status")

        status = {
            "timestamp": time.time(),
            "running": state.get("running"),
            "queue_pending": queue.get("pending", 0),
            "queue_failed": queue.get("failed", 0),
            "error": state.get("error"),
        }

        if callback:
            callback(status)

        yield status

        await asyncio.sleep(poll_interval)
```

### Recipe 8: Sync Messages with Retry

Use this for reliable message synchronization.

```python
async def sync_messages_reliable(agent, max_retries=3):
    """
    Sync messages with automatic retry on failure.

    Returns:
        dict: Sync result with retry information
    """
    for attempt in range(max_retries):
        try:
            # Use sync_messages_with_failures for detailed error tracking
            result = await agent.invoke("sync_messages_with_failures")

            # Check for failures
            if result.get("new_failed", 0) == 0:
                return {
                    "success": True,
                    "attempt": attempt + 1,
                    "new_messages": result.get("new_messages", 0),
                    "synced": result.get("synced", 0),
                }

            # Some failures - log and retry
            if attempt < max_retries - 1:
                await asyncio.sleep(2.0 ** attempt)  # Exponential backoff

        except Exception as e:
            if attempt == max_retries - 1:
                return {
                    "success": False,
                    "attempt": attempt + 1,
                    "error": str(e),
                }
            await asyncio.sleep(2.0 ** attempt)

    return {
        "success": False,
        "attempt": max_retries,
        "error": "Max retries exceeded with failures",
    }
```

## Common Issues and Solutions

### Issue: "Not authenticated"

**Symptoms:** `check_syftbox_auth` returns `authenticated: false`

**Solutions:**

1. Ensure onboarding is complete: `complete_onboarding`
2. Check if tokens exist: `get_syftbox_config_info`
3. Re-authenticate by restarting onboarding flow

### Issue: "Daemon not running"

**Symptoms:** `get_syftbox_state` returns `running: false`

**Solutions:**

1. Try starting: `start_syftbox_client`
2. Check for errors in state
3. Verify SyftBox binary is installed: `check_single_dependency` with name "syftbox"

### Issue: "Sync stuck"

**Symptoms:** Queue status shows pending items not decreasing

**Solutions:**

1. Check for errors: `get_syftbox_diagnostics`
2. Try restart: Stop, wait, start
3. Check network connectivity
4. Review failed messages: `list_failed_messages`

### Issue: "Missing tokens"

**Symptoms:** `get_syftbox_config_info` shows `has_access_token: false`

**Solutions:**

1. Complete onboarding flow
2. Check if auth server is reachable
3. Review logs for auth errors: `get_desktop_log_text`

## Best Practices

1. **Always check auth first** before attempting sync operations
2. **Use exponential backoff** for retries (2s, 4s, 8s, ...)
3. **Monitor queue status** after triggering sync to ensure completion
4. **Log diagnostics** when issues occur for debugging
5. **Don't restart unnecessarily** - check state before starting/stopping
6. **Handle timeouts gracefully** - sync operations can take time
7. **Preserve mnemonics** - when generating keys, save the mnemonic securely

## Command Reference

| Command                       | Purpose                  | Typical Use           |
| ----------------------------- | ------------------------ | --------------------- |
| `check_syftbox_auth`          | Verify authentication    | Initial health check  |
| `get_syftbox_state`           | Get daemon status        | Monitor running state |
| `start_syftbox_client`        | Start daemon             | After profile switch  |
| `stop_syftbox_client`         | Stop daemon              | Before restart        |
| `get_syftbox_config_info`     | Get config details       | Diagnose issues       |
| `trigger_syftbox_sync`        | Force sync               | After data changes    |
| `syftbox_queue_status`        | Check queue              | Monitor sync progress |
| `get_syftbox_diagnostics`     | Full diagnostics         | Debug problems        |
| `sync_messages`               | Sync messages            | Refresh inbox         |
| `sync_messages_with_failures` | Sync with error tracking | Reliable sync         |
