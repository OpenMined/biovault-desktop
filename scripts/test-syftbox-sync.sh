#!/bin/bash
# test-syftbox-sync.sh - Test SyftBox sync UI between two datasites
#
# This script creates test data for two simulated users to verify:
# 1. UI updates when files are added/modified
# 2. syft.pub.yaml sharing works correctly
# 3. Sync checkboxes toggle ignored state
# 4. Large file for pause/resume testing
#
# Usage: ./test-syftbox-sync.sh [data_dir]
# Default data_dir: ~/SyftBox/datasites

set -e

# Configuration
DATA_DIR="${1:-$HOME/SyftBox/datasites}"
USER1="alice@test.local"
USER2="bob@test.local"
CURRENT_USER="${SYFTBOX_EMAIL:-$USER1}"

echo "=== SyftBox Sync Test Scenario ==="
echo "Data directory: $DATA_DIR"
echo "User 1: $USER1"
echo "User 2: $USER2"
echo "Current user: $CURRENT_USER"
echo ""

# Create directory structure
create_user_dirs() {
    local user=$1
    echo "Creating directories for $user..."

    mkdir -p "$DATA_DIR/$user/public/crypto"
    mkdir -p "$DATA_DIR/$user/public/biovault/datasets"
    mkdir -p "$DATA_DIR/$user/public/shared"
    mkdir -p "$DATA_DIR/$user/app_data/biovault"
    mkdir -p "$DATA_DIR/$user/private"
}

# Create DID document (essential - always synced)
create_did() {
    local user=$1
    echo "Creating DID for $user..."

    cat > "$DATA_DIR/$user/public/crypto/did.json" << EOF
{
  "id": "did:syft:$user",
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "publicKey": {
    "type": "Ed25519VerificationKey2020",
    "publicKeyBase58": "$(openssl rand -base64 32 | tr -d '\n')"
  }
}
EOF
}

# Create dataset metadata (essential - always synced)
create_dataset_metadata() {
    local user=$1
    local name=$2
    local desc=$3

    echo "Creating dataset metadata: $user/$name..."

    cat > "$DATA_DIR/$user/public/biovault/datasets/${name}.yaml" << EOF
name: $name
description: $desc
owner: $user
created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
files:
  - path: public/shared/$name/data.csv
    size: 1024
    type: text/csv
  - path: public/shared/$name/analysis.json
    size: 512
    type: application/json
EOF
}

# Create syft.pub.yaml to share content
create_share() {
    local owner=$1
    local path=$2
    local share_with=$3

    echo "Creating share: $owner/$path -> $share_with..."

    mkdir -p "$DATA_DIR/$owner/$path"

    cat > "$DATA_DIR/$owner/$path/syft.pub.yaml" << EOF
# SyftBox ACL file
version: 1
created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
permissions:
  - user: $share_with
    access: read
  - user: "*"
    access: none
metadata:
  description: Shared data from $owner
  file_count: 3
  total_size: 2048
EOF
}

# Create sample data files
create_data_files() {
    local user=$1
    local dataset=$2

    echo "Creating data files for $user/$dataset..."

    local dir="$DATA_DIR/$user/public/shared/$dataset"
    mkdir -p "$dir"

    # CSV data
    cat > "$dir/data.csv" << EOF
id,timestamp,value,category
1,2024-01-15T10:00:00Z,42.5,A
2,2024-01-15T10:01:00Z,38.2,B
3,2024-01-15T10:02:00Z,45.1,A
4,2024-01-15T10:03:00Z,39.8,C
5,2024-01-15T10:04:00Z,41.3,B
EOF

    # JSON analysis
    cat > "$dir/analysis.json" << EOF
{
  "summary": {
    "count": 5,
    "mean": 41.38,
    "std": 2.67
  },
  "generated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

    # Create the share ACL
    create_share "$user" "public/shared/$dataset" "$CURRENT_USER"
}

# Create a large file for pause/resume testing
create_large_file() {
    local user=$1
    local size_mb=${2:-10}

    echo "Creating ${size_mb}MB file for pause/resume testing..."

    local dir="$DATA_DIR/$user/public/shared/large-dataset"
    mkdir -p "$dir"

    # Create a large file with random data
    dd if=/dev/urandom of="$dir/large-data.bin" bs=1M count=$size_mb 2>/dev/null

    # Create metadata
    cat > "$dir/metadata.yaml" << EOF
name: large-dataset
description: Large file for sync testing
size_bytes: $((size_mb * 1024 * 1024))
created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

    # Share it
    create_share "$user" "public/shared/large-dataset" "$CURRENT_USER"

    echo "Created: $dir/large-data.bin (${size_mb}MB)"
}

# Create app_data files (essential - always synced)
create_app_data() {
    local user=$1

    echo "Creating app_data for $user..."

    cat > "$DATA_DIR/$user/app_data/biovault/permissions.yaml" << EOF
version: 1
endpoints:
  - name: query
    path: /v1/query
    allowed:
      - "*"
  - name: compute
    path: /v1/compute
    allowed:
      - alice@test.local
      - bob@test.local
EOF
}

# Create .syftignore with default policy
create_syftignore() {
    echo "Creating default .syftignore..."

    cat > "$DATA_DIR/.syftignore" << 'EOF'
# SyftBox Default Sync Policy
# Ignore everything by default, whitelist essential paths

# Ignore all files by default
*

# Essential BioVault paths (whitelisted)
!*/public/crypto/did.json
!*/public/biovault/datasets.yaml
!*/public/biovault/datasets/*/dataset.yaml
!*/app_data/biovault/*.yaml
!**/syft.pub.yaml

# Request/Response files for sync coordination
!**/*.request
!**/*.response

# User subscriptions (add paths here to sync them)
# !alice@test.local/public/shared/heart-study/**
# !bob@test.local/public/shared/genomics-data/**
EOF
}

# Simulate file changes for UI testing
simulate_changes() {
    echo ""
    echo "=== Simulating File Changes ==="
    echo "Run this in a separate terminal to watch UI updates"
    echo ""

    local user=$1
    local dir="$DATA_DIR/$user/public/shared/live-updates"
    mkdir -p "$dir"

    echo "Will create files in: $dir"
    echo "Press Ctrl+C to stop"
    echo ""

    local counter=0
    while true; do
        counter=$((counter + 1))

        # Create a new file
        cat > "$dir/update-$counter.json" << EOF
{
  "sequence": $counter,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "data": "Random data: $(openssl rand -hex 16)"
}
EOF
        echo "[$(date +%H:%M:%S)] Created update-$counter.json"

        # Update the share ACL
        create_share "$user" "public/shared/live-updates" "$CURRENT_USER" 2>/dev/null

        sleep 3
    done
}

# Print test instructions
print_instructions() {
    echo ""
    echo "=== Test Instructions ==="
    echo ""
    echo "1. Open BioVault Desktop and go to the SyftBox tab"
    echo "2. You should see the tree with datasites: $USER1, $USER2"
    echo ""
    echo "3. Essential paths (always synced, checkbox locked):"
    echo "   - */public/crypto/did.json"
    echo "   - */public/biovault/datasets.yaml"
    echo "   - */public/biovault/datasets/*/dataset.yaml"
    echo "   - */app_data/biovault/*.yaml"
    echo "   - **/syft.pub.yaml"
    echo ""
    echo "4. Shared content (visible via syft.pub.yaml):"
    echo "   - $USER2/public/shared/heart-study/"
    echo "   - $USER2/public/shared/genomics-data/"
    echo "   - $USER2/public/shared/large-dataset/ (10MB for pause/resume)"
    echo ""
    echo "5. To test checkbox toggle:"
    echo "   - Uncheck a folder to add it to .syftignore"
    echo "   - Check it again to remove from .syftignore"
    echo "   - Verify the file: cat $DATA_DIR/.syftignore"
    echo ""
    echo "6. To test live updates, run:"
    echo "   $0 --simulate $USER2"
    echo ""
    echo "7. To test pause/resume:"
    echo "   - Start syncing large-dataset"
    echo "   - Uncheck the checkbox mid-sync"
    echo "   - Re-check to resume"
    echo ""
}

# Main execution
main() {
    if [[ "$1" == "--simulate" ]]; then
        simulate_changes "${2:-$USER2}"
        exit 0
    fi

    if [[ "$1" == "--clean" ]]; then
        echo "Cleaning test data..."
        rm -rf "$DATA_DIR/$USER1"
        rm -rf "$DATA_DIR/$USER2"
        echo "Done."
        exit 0
    fi

    # Create both user directories
    create_user_dirs "$USER1"
    create_user_dirs "$USER2"

    # Create essential files for both users
    create_did "$USER1"
    create_did "$USER2"

    create_app_data "$USER1"
    create_app_data "$USER2"

    # Create datasets for user 2 (to be shared with user 1)
    create_dataset_metadata "$USER2" "heart-study" "Cardiovascular health analysis data"
    create_dataset_metadata "$USER2" "genomics-data" "Genomic sequencing results"

    # Create actual data files with shares
    create_data_files "$USER2" "heart-study"
    create_data_files "$USER2" "genomics-data"

    # Create large file for pause/resume testing
    create_large_file "$USER2" 10

    # Create some data for user 1 too
    create_dataset_metadata "$USER1" "my-dataset" "Personal research data"
    create_data_files "$USER1" "my-dataset"

    # Create default syftignore
    create_syftignore

    echo ""
    echo "=== Test Data Created Successfully ==="
    print_instructions
}

main "$@"
