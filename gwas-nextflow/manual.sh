#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIOVAULT_DIR="$(cd "$SCRIPT_DIR/../biovault" && pwd)"
DATA_DIR="/Users/madhavajay/dev/biovaults/datasets/jordan_gwas"
DATASETS_JSON="$SCRIPT_DIR/test/datasets.json"

cat > "$DATASETS_JSON" <<EOF
{
  "Chechen_qc": {
    "bed": "$DATA_DIR/Chechen_qc.bed",
    "bim": "$DATA_DIR/Chechen_qc.bim",
    "fam": "$DATA_DIR/Chechen_qc.fam"
  },
  "Circassian_qc": {
    "bed": "$DATA_DIR/Circassian_qc.bed",
    "bim": "$DATA_DIR/Circassian_qc.bim",
    "fam": "$DATA_DIR/Circassian_qc.fam"
  }
}
EOF

nextflow run "$BIOVAULT_DIR/cli/src/templates/dynamic/template.nf" -with-docker \
    --work_flow_file "$SCRIPT_DIR/workflow.nf" \
    --project_spec "$SCRIPT_DIR/project.yaml" \
    --inputs_json "{\"datasets\":{\"type\":\"Map[String, Record{bed: File, bim: File, fam: File}]\",\"format\":\"json\",\"path\":\"$DATASETS_JSON\",\"mapping\":null}}" \
    --params_json "{\"assets_dir\":\"$SCRIPT_DIR/assets\",\"output_prefix\":\"combined_gwas\",\"n_pcs\":10,\"annotation_pval\":\"1e-5\",\"gw_sig\":\"5e-8\",\"threads\":4}" \
    --results_dir "$SCRIPT_DIR/test/results"
