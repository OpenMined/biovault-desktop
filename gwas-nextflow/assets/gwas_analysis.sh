#!/bin/bash
################################################################################
# GWAS Analysis Pipeline - Parameterized Version
# Combines datasets, performs PCA, runs association analysis
# Usage: gwas_analysis.sh <dataset1_prefix> <dataset2_prefix> <output_prefix> [n_pcs] [threads]
################################################################################

set -e

# Parse arguments
if [ $# -lt 3 ]; then
    echo "Usage: $0 <dataset1_prefix> <dataset2_prefix> <output_prefix> [n_pcs] [threads]"
    echo "  dataset1_prefix: First PLINK dataset (without .bed/.bim/.fam)"
    echo "  dataset2_prefix: Second PLINK dataset (without .bed/.bim/.fam)"
    echo "  output_prefix: Output prefix for combined/results"
    echo "  n_pcs: Number of principal components (default: 10)"
    echo "  threads: Number of threads (default: 4)"
    exit 1
fi

DATASET1="$1"
DATASET2="$2"
COMBINED="$3"
N_PCS="${4:-10}"
THREADS="${5:-4}"

echo "========================================="
echo "GWAS Analysis Pipeline Started"
echo "Date: $(date)"
echo "Dataset1: ${DATASET1}"
echo "Dataset2: ${DATASET2}"
echo "Output: ${COMBINED}"
echo "PCs: ${N_PCS}, Threads: ${THREADS}"
echo "========================================="

mkdir -p results logs

# ============================================================================
# STEP 1: COMBINE DATASETS
# ============================================================================

echo ""
echo "========================================="
echo "STEP 1: Combining datasets"
echo "========================================="

if [ ! -f "${DATASET1}.bed" ] || [ ! -f "${DATASET2}.bed" ]; then
    echo "ERROR: Input plink files not found!"
    echo "Looking for: ${DATASET1}.bed and ${DATASET2}.bed"
    ls -la *.bed 2>/dev/null || echo "No .bed files found"
    exit 1
fi

echo "Merging ${DATASET1} and ${DATASET2}..."

plink --bfile ${DATASET1} \
      --bmerge ${DATASET2} \
      --out ${COMBINED} \
      2>&1 | tee logs/merge.log

if [ -f "${COMBINED}-merge.missnp" ]; then
    echo "Found SNPs with strand issues. Flipping and re-merging..."

    plink --bfile ${DATASET2} \
          --flip ${COMBINED}-merge.missnp \
          --make-bed \
          --out ${DATASET2}_flipped \
          2>&1 | tee logs/flip.log

    plink --bfile ${DATASET1} \
          --bmerge ${DATASET2}_flipped \
          --out ${COMBINED} \
          2>&1 | tee logs/merge_retry.log
fi

echo "Datasets successfully merged!"
echo ""
echo "Sample Summary:"
awk 'END {print "Total samples: " NR}' ${COMBINED}.fam
awk '$6==2 {cases++} $6==1 {controls++} END {print "Cases: " cases "\nControls: " controls}' ${COMBINED}.fam

# ============================================================================
# STEP 2: PRINCIPAL COMPONENT ANALYSIS
# ============================================================================

echo ""
echo "========================================="
echo "STEP 2: Population Stratification (PCA)"
echo "========================================="

echo "Performing LD pruning for PCA..."
plink --bfile ${COMBINED} \
      --indep-pairwise 50 5 0.2 \
      --out results/${COMBINED}_pruned \
      2>&1 | tee logs/ld_prune.log

echo "Extracting pruned SNPs..."
plink --bfile ${COMBINED} \
      --extract results/${COMBINED}_pruned.prune.in \
      --make-bed \
      --out results/${COMBINED}_pruned_data \
      2>&1 | tee logs/extract_pruned.log

echo "Removing AT/GC SNPs..."
awk '($5=="A" && $6=="T") || ($5=="T" && $6=="A") || \
     ($5=="C" && $6=="G") || ($5=="G" && $6=="C") {print $2}' \
     results/${COMBINED}_pruned_data.bim > results/${COMBINED}_atgc_snps.txt

plink --bfile results/${COMBINED}_pruned_data \
      --exclude results/${COMBINED}_atgc_snps.txt \
      --make-bed \
      --out results/${COMBINED}_pruned_noambig \
      2>&1 | tee logs/remove_ambig.log

echo "Computing principal components (PC1-${N_PCS})..."
plink --bfile results/${COMBINED}_pruned_noambig \
      --pca ${N_PCS} \
      --threads ${THREADS} \
      --out results/${COMBINED}_pca \
      2>&1 | tee logs/pca.log

echo "Adding header to .eigenvec file..."
HEADER="FID IID"
for i in $(seq 1 ${N_PCS}); do
    HEADER="${HEADER} PC${i}"
done

echo "$HEADER" | cat - results/${COMBINED}_pca.eigenvec > results/${COMBINED}_pca.eigenvec.tmp
mv results/${COMBINED}_pca.eigenvec.tmp results/${COMBINED}_pca.eigenvec

echo "PCA complete!"

# ============================================================================
# STEP 3: GWAS ASSOCIATION ANALYSIS
# ============================================================================

echo ""
echo "========================================="
echo "STEP 3: GWAS Association Analysis"
echo "========================================="

echo "Running logistic regression with PC1-PC${N_PCS} as covariates..."

COVAR_NAMES=$(seq 1 ${N_PCS} | sed 's/^/PC/' | paste -sd, -)

plink --bfile ${COMBINED} \
      --logistic hide-covar \
      --covar results/${COMBINED}_pca.eigenvec \
      --covar-name ${COVAR_NAMES} \
      --ci 0.95 \
      --threads ${THREADS} \
      --out results/${COMBINED}_gwas \
      2>&1 | tee logs/gwas.log

echo "Association analysis complete!"

# ============================================================================
# STEP 4: GENERATE SUMMARY
# ============================================================================

echo ""
echo "========================================="
echo "STEP 4: Generating Summary"
echo "========================================="

cat > results/GWAS_ANALYSIS_INFO.txt << ENDREPORT
================================================================================
GWAS ANALYSIS SUMMARY
================================================================================
Date: $(date)
Dataset 1: ${DATASET1}
Dataset 2: ${DATASET2}
Combined dataset: ${COMBINED}

Sample Summary:
$(awk 'END {print "  Total samples: " NR}' ${COMBINED}.fam)
$(awk '$6==2 {cases++} $6==1 {controls++} END {print "  Cases: " cases "\n  Controls: " controls}' ${COMBINED}.fam)

SNP Summary:
$(awk 'END {print "  Total SNPs tested: " NR}' ${COMBINED}.bim)

PCA: ${N_PCS} components computed
Results file: results/${COMBINED}_gwas.assoc.logistic
================================================================================
ENDREPORT

cat results/GWAS_ANALYSIS_INFO.txt

echo ""
echo "========================================="
echo "GWAS Analysis Complete!"
echo "========================================="
echo "Key Output: results/${COMBINED}_gwas.assoc.logistic"
echo "========================================="
