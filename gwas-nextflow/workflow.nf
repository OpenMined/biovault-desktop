// GWAS Analysis Pipeline
// Two processes: gwas_analysis (plink) and make_plots (python)

nextflow.enable.dsl=2

workflow USER {
    take:
        context
        data_dir      // Directory containing PLINK files
        datasets_csv  // CSV file with dataset names

    main:
        def assetsDir = context.assets_dir
        if (!assetsDir) {
            throw new IllegalStateException("Missing assets directory in context")
        }
        def assetsDirPath = file(assetsDir)

        // Get parameters with defaults
        def n_pcs = context.params?.n_pcs ?: 10
        def annotation_pval = context.params?.annotation_pval ?: "1e-5"
        def gw_sig = context.params?.gw_sig ?: "5e-8"
        def output_prefix = context.params?.output_prefix ?: "combined_gwas"
        def threads = context.params?.threads ?: 4

        // Run GWAS analysis
        def gwas_results = gwas_analysis(
            assetsDirPath,
            data_dir,
            datasets_csv,
            output_prefix,
            n_pcs,
            threads
        )

        // Generate plots from GWAS results
        def plots = make_plots(
            assetsDirPath,
            gwas_results.assoc_file,
            annotation_pval,
            gw_sig
        )

    emit:
        gwas_output = gwas_results.results_dir
        manhattan_plot = plots.manhattan
        qq_plot = plots.qq
        significant_snps = plots.significant
}

process gwas_analysis {
    container 'quay.io/biocontainers/plink:1.90b6.21--h7b50bb2_7'
    publishDir params.results_dir, mode: 'copy', overwrite: true
    errorStrategy { params.nextflow?.error_strategy ?: 'ignore' }
    maxRetries { params.nextflow?.max_retries ?: 0 }

    input:
        path assets_dir
        path data_dir
        path datasets_csv
        val output_prefix
        val n_pcs
        val threads

    output:
        path "results", emit: results_dir
        path "results/${output_prefix}_gwas.assoc.logistic", emit: assoc_file
        path "logs", emit: logs_dir

    script:
    """
    set -e

    # Read dataset names from CSV (skip header, get first two rows)
    DATASET1=\$(tail -n +2 ${datasets_csv} | head -1 | cut -d',' -f1)
    DATASET2=\$(tail -n +2 ${datasets_csv} | tail -1 | cut -d',' -f1)

    echo "Dataset 1: \${DATASET1}"
    echo "Dataset 2: \${DATASET2}"

    # Link input files to working directory
    ln -sf ${data_dir}/\${DATASET1}.bed \${DATASET1}.bed
    ln -sf ${data_dir}/\${DATASET1}.bim \${DATASET1}.bim
    ln -sf ${data_dir}/\${DATASET1}.fam \${DATASET1}.fam
    ln -sf ${data_dir}/\${DATASET2}.bed \${DATASET2}.bed
    ln -sf ${data_dir}/\${DATASET2}.bim \${DATASET2}.bim
    ln -sf ${data_dir}/\${DATASET2}.fam \${DATASET2}.fam

    # Run GWAS analysis script
    bash ${assets_dir}/gwas_analysis.sh "\${DATASET1}" "\${DATASET2}" "${output_prefix}" "${n_pcs}" "${threads}"
    """
}

process make_plots {
    container 'quay.io/jupyter/scipy-notebook:latest'
    publishDir params.results_dir, mode: 'copy', overwrite: true
    errorStrategy { params.nextflow?.error_strategy ?: 'ignore' }
    maxRetries { params.nextflow?.max_retries ?: 0 }

    input:
        path assets_dir
        path assoc_file
        val annotation_pval
        val gw_sig

    output:
        path "*_manhattan.png", emit: manhattan
        path "*_qq.png", emit: qq
        path "*_genome_wide_significant.txt", emit: significant, optional: true
        path "*_top50_suggestive.txt", emit: top50, optional: true
        path "*_annotated_snps.txt", emit: annotated, optional: true

    script:
    """
    python3 ${assets_dir}/make_manhattan.py ${assoc_file} ${annotation_pval} ${gw_sig}
    """
}
