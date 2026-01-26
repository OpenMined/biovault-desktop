# SyftBox Auth Bypass (Dev Mode)

This document describes the "Bypass" authentication flow designed for rapid development within `devstack` environments.

## Overview
To speed up testing, BioVault Desktop supports a bypass that skips network-based OTP verification and UI-driven key generation while still exercising the core "Identity Connection" flow.

## How to Enable
Set the following environment variable before launching the app or the devstack scripts:
```bash
export SYFTBOX_AUTH_ENABLED=0
```

## How it Works

### 1. OTP Bypass
- When you click **"Send Code"** in the SyftBox Sign-In dialog, the app detects the bypass flag.
- The backend acknowledges the request immediately without sending a network request.
- It writes dummy `bypass-tokens` to your BioVault configuration to satisfy the "Is Authenticated?" check.

### 2. UI-Side Key Generation Skip
- The Sign-In dialog **skips** the `key_generate` SDK call.
- **Why?** In a `devstack` environment, keys are usually already provisioned by the setup script (via `bv init`). Attempting to "re-generate" or check them while the `syftboxd` daemon is running would cause a **Lock Collision Error**.
- By skipping this, we avoid the lock error and rely on the keys already present in the sandbox.

### 3. Identity Pulse & Configuration
- Even in bypass mode, the app performs a "Configuration Pulse."
- It writes the chosen email to `syftbox/config.json` in your BioVault home.
- This ensures the running SyftBox daemon knows which identity it should be syncing for, which is critical for making your datasets appear in the **Explore** tab.
- It **skips daemon restarts** in this mode, preventing race conditions with the devstack scripts that manage the processes.

## Summary of Benefits
- **Realistic Testing**: Still exercises the UI transitions and state changes (Connect -> Joined).
- **Speed**: No waiting for emails or manual OTP entry.
- **Conflict Prevention**: Safely co-exists with running daemons without triggering workspace locks.
