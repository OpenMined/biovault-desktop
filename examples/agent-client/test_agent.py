#!/usr/bin/env python3
"""
Basic tests for the BioVault Agent Client.

These tests require a running BioVault Desktop instance with the
WebSocket bridge enabled.

Run with:
    pytest test_agent.py -v

Or without pytest:
    python test_agent.py
"""

import asyncio
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from biovault_agent import BioVaultAgent, BioVaultAgentError, AgentConfig


async def test_connection():
    """Test basic connection to the agent bridge."""
    async with BioVaultAgent() as agent:
        assert agent._ws is not None
        print("  Connection: OK")


async def test_discover():
    """Test API discovery endpoint."""
    async with BioVaultAgent() as agent:
        result = await agent.discover()
        assert "version" in result
        assert "name" in result
        assert result["name"] == "BioVault Desktop Agent API"
        print(f"  API Version: {result['version']}")


async def test_get_app_version():
    """Test getting app version."""
    async with BioVaultAgent() as agent:
        version = await agent.get_app_version()
        assert isinstance(version, str)
        assert len(version) > 0
        print(f"  App Version: {version}")


async def test_is_dev_mode():
    """Test dev mode check."""
    async with BioVaultAgent() as agent:
        is_dev = await agent.is_dev_mode()
        assert isinstance(is_dev, bool)
        print(f"  Dev Mode: {is_dev}")


async def test_check_is_onboarded():
    """Test onboarding status check."""
    async with BioVaultAgent() as agent:
        is_onboarded = await agent.check_is_onboarded()
        assert isinstance(is_onboarded, bool)
        print(f"  Onboarded: {is_onboarded}")


async def test_get_syftbox_state():
    """Test SyftBox state retrieval."""
    async with BioVaultAgent() as agent:
        state = await agent.get_syftbox_state()
        assert isinstance(state, dict)
        assert "running" in state
        print(f"  SyftBox Running: {state.get('running')}")


async def test_check_dependencies():
    """Test dependency checking."""
    async with BioVaultAgent() as agent:
        deps = await agent.check_dependencies()
        assert isinstance(deps, list)
        print(f"  Dependencies: {len(deps)} found")
        for dep in deps[:3]:  # Show first 3
            status = "installed" if dep.get("installed") else "missing"
            print(f"    - {dep.get('name')}: {status}")


async def test_get_projects():
    """Test project listing."""
    async with BioVaultAgent() as agent:
        projects = await agent.get_projects()
        assert isinstance(projects, list)
        print(f"  Projects: {len(projects)} found")


async def test_sql_list_tables():
    """Test SQL table listing."""
    async with BioVaultAgent() as agent:
        tables = await agent.sql_list_tables()
        assert isinstance(tables, list)
        print(f"  Database Tables: {len(tables)}")
        for table in tables[:5]:  # Show first 5
            print(f"    - {table}")


async def test_audit_log():
    """Test audit log functionality."""
    async with BioVaultAgent() as agent:
        # Get audit log
        log = await agent.get_audit_log(max_entries=5)
        assert isinstance(log, list)
        print(f"  Audit Log Entries: {len(log)}")

        # Verify recent entry has expected fields
        if log:
            entry = log[-1]
            assert "timestamp" in entry
            assert "cmd" in entry
            assert "success" in entry


async def test_invalid_command():
    """Test that invalid commands return errors."""
    async with BioVaultAgent() as agent:
        try:
            await agent.invoke("this_command_does_not_exist")
            assert False, "Should have raised an error"
        except BioVaultAgentError as e:
            assert "Unhandled command" in str(e)
            print("  Invalid command handling: OK")


async def test_auth_with_wrong_token():
    """Test authentication rejection with wrong token."""
    # Only run if token auth is configured
    if not os.environ.get("AGENT_BRIDGE_TOKEN"):
        print("  Skipping (no token configured)")
        return

    config = AgentConfig(token="wrong-token")
    async with BioVaultAgent(config) as agent:
        try:
            await agent.get_app_version()
            assert False, "Should have been rejected"
        except BioVaultAgentError as e:
            assert "Authentication failed" in str(e)
            print("  Auth rejection: OK")


async def run_all_tests():
    """Run all tests and report results."""
    tests = [
        ("Connection", test_connection),
        ("API Discovery", test_discover),
        ("Get App Version", test_get_app_version),
        ("Dev Mode Check", test_is_dev_mode),
        ("Onboarding Status", test_check_is_onboarded),
        ("SyftBox State", test_get_syftbox_state),
        ("Dependencies", test_check_dependencies),
        ("Projects", test_get_projects),
        ("SQL Tables", test_sql_list_tables),
        ("Audit Log", test_audit_log),
        ("Invalid Command", test_invalid_command),
        ("Auth Rejection", test_auth_with_wrong_token),
    ]

    passed = 0
    failed = 0
    skipped = 0

    print("\nBioVault Agent Client Tests")
    print("=" * 50)

    for name, test_fn in tests:
        print(f"\nTest: {name}")
        try:
            await test_fn()
            passed += 1
            print(f"  Result: PASSED")
        except AssertionError as e:
            failed += 1
            print(f"  Result: FAILED - {e}")
        except BioVaultAgentError as e:
            failed += 1
            print(f"  Result: FAILED - Agent error: {e}")
        except Exception as e:
            if "Skipping" in str(e) or "no token" in str(e):
                skipped += 1
                print(f"  Result: SKIPPED")
            else:
                failed += 1
                print(f"  Result: ERROR - {type(e).__name__}: {e}")

    print("\n" + "=" * 50)
    print(f"Results: {passed} passed, {failed} failed, {skipped} skipped")
    print("=" * 50)

    return failed == 0


# Pytest integration
import pytest

@pytest.fixture
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.mark.asyncio
async def test_connection_pytest():
    await test_connection()


@pytest.mark.asyncio
async def test_discover_pytest():
    await test_discover()


@pytest.mark.asyncio
async def test_get_app_version_pytest():
    await test_get_app_version()


@pytest.mark.asyncio
async def test_is_dev_mode_pytest():
    await test_is_dev_mode()


@pytest.mark.asyncio
async def test_check_is_onboarded_pytest():
    await test_check_is_onboarded()


@pytest.mark.asyncio
async def test_get_syftbox_state_pytest():
    await test_get_syftbox_state()


@pytest.mark.asyncio
async def test_check_dependencies_pytest():
    await test_check_dependencies()


@pytest.mark.asyncio
async def test_get_projects_pytest():
    await test_get_projects()


@pytest.mark.asyncio
async def test_sql_list_tables_pytest():
    await test_sql_list_tables()


@pytest.mark.asyncio
async def test_audit_log_pytest():
    await test_audit_log()


@pytest.mark.asyncio
async def test_invalid_command_pytest():
    await test_invalid_command()


if __name__ == "__main__":
    # Run tests directly
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
