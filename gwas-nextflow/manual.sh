#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIOVAULT_DIR="$(cd "$SCRIPT_DIR/../biovault" && pwd)"
DATA_DIR="/Users/madhavajay/dev/biovaults/datasets/jordan_gwas"

nextflow run "$BIOVAULT_DIR/cli/src/templates/dynamic/template.nf" -with-docker \
    --work_flow_file "$SCRIPT_DIR/workflow.nf" \
    --project_spec "$SCRIPT_DIR/project.yaml" \
    --inputs_json "{\"data_dir\":{\"type\":\"Directory\",\"format\":\"unknown\",\"path\":\"$DATA_DIR\",\"mapping\":null},\"datasets_csv\":{\"type\":\"File\",\"format\":\"csv\",\"path\":\"$SCRIPT_DIR/test/datasets.csv\",\"mapping\":null}}" \
    --params_json "{\"assets_dir\":\"$SCRIPT_DIR/assets\",\"output_prefix\":\"combined_gwas\",\"n_pcs\":10,\"annotation_pval\":\"1e-5\",\"gw_sig\":\"5e-8\",\"threads\":4}" \
    --results_dir "$SCRIPT_DIR/test/results"
