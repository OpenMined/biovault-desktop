#!/bin/bash
# Use custom config location and override bv binary.
# Default to the current user's Desktop/BioVault unless BIOVAULT_CONFIG is already set.
BIOVAULT_CONFIG="${BIOVAULT_CONFIG:-"$HOME/Desktop/BioVault"}" ./dev-with-cli.sh
