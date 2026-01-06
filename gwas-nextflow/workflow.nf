// GWAS Analysis Pipeline
// Two processes: gwas_analysis (plink) and make_plots (python)

nextflow.enable.dsl=2

workflow USER {
    take:
        context
        datasets      // Map[String, Record{bed,bim,fam}]

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

        // Debug: Print input information
        println "=========================================="
        println "[GWAS] Workflow starting..."
        println "[GWAS] Assets directory: ${assetsDir}"
        println "[GWAS] Parameters:"
        println "  - n_pcs: ${n_pcs}"
        println "  - annotation_pval: ${annotation_pval}"
        println "  - gw_sig: ${gw_sig}"
        println "  - output_prefix: ${output_prefix}"
        println "  - threads: ${threads}"
        println "[GWAS] Datasets received:"
        datasets?.each { name, files ->
            println "  - ${name}:"
            files?.each { key, path ->
                println "      ${key}: ${path}"
            }
        }
        println "=========================================="

        def datasetMap = datasets ?: [:]
        if (!(datasetMap instanceof Map) || datasetMap.isEmpty()) {
            throw new IllegalArgumentException("Expected datasets map with at least two entries")
        }
        def datasetNames = datasetMap.keySet().toList().sort()
        if (datasetNames.size() < 2) {
            throw new IllegalArgumentException("GWAS pipeline requires at least two datasets")
        }

        def dataset1Name = datasetNames[0]
        def dataset2Name = datasetNames[1]
        def dataset1 = datasetMap[dataset1Name]
        def dataset2 = datasetMap[dataset2Name]
        def requiredKeys = ['bed', 'bim', 'fam']
        requiredKeys.each { key ->
            if (!(dataset1 instanceof Map) || !dataset1.containsKey(key)) {
                throw new IllegalArgumentException("Dataset '${dataset1Name}' missing '${key}' file")
            }
            if (!(dataset2 instanceof Map) || !dataset2.containsKey(key)) {
                throw new IllegalArgumentException("Dataset '${dataset2Name}' missing '${key}' file")
            }
        }

        // Run GWAS analysis
        def gwas_results = gwas_analysis(
            assetsDirPath,
            dataset1Name,
            dataset1.bed,
            dataset1.bim,
            dataset1.fam,
            dataset2Name,
            dataset2.bed,
            dataset2.bim,
            dataset2.fam,
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
        val dataset1_name
        path dataset1_bed
        path dataset1_bim
        path dataset1_fam
        val dataset2_name
        path dataset2_bed
        path dataset2_bim
        path dataset2_fam
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

    echo "=========================================="
    echo "[GWAS] gwas_analysis starting..."
    echo "[GWAS] Dataset 1: ${dataset1_name}"
    echo "  - BED: ${dataset1_bed}"
    echo "  - BIM: ${dataset1_bim}"
    echo "  - FAM: ${dataset1_fam}"
    echo "[GWAS] Dataset 2: ${dataset2_name}"
    echo "  - BED: ${dataset2_bed}"
    echo "  - BIM: ${dataset2_bim}"
    echo "  - FAM: ${dataset2_fam}"
    echo "[GWAS] Output prefix: ${output_prefix}"
    echo "[GWAS] Parameters: n_pcs=${n_pcs}, threads=${threads}"
    echo "=========================================="

    DATASET1="${dataset1_name}"
    DATASET2="${dataset2_name}"

    # Link input files to working directory
    [ -e "\${DATASET1}.bed" ] || ln -sf ${dataset1_bed} \${DATASET1}.bed
    [ -e "\${DATASET1}.bim" ] || ln -sf ${dataset1_bim} \${DATASET1}.bim
    [ -e "\${DATASET1}.fam" ] || ln -sf ${dataset1_fam} \${DATASET1}.fam
    [ -e "\${DATASET2}.bed" ] || ln -sf ${dataset2_bed} \${DATASET2}.bed
    [ -e "\${DATASET2}.bim" ] || ln -sf ${dataset2_bim} \${DATASET2}.bim
    [ -e "\${DATASET2}.fam" ] || ln -sf ${dataset2_fam} \${DATASET2}.fam

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
    echo "=========================================="
    echo "[PLOTS] make_plots starting..."
    echo "[PLOTS] Assets directory: ${assets_dir}"
    echo "[PLOTS] Assoc file: ${assoc_file}"
    echo "[PLOTS] Annotation P-value: ${annotation_pval}"
    echo "[PLOTS] Genome-wide significance: ${gw_sig}"
    echo "=========================================="

    python3 ${assets_dir}/make_manhattan.py ${assoc_file} ${annotation_pval} ${gw_sig}
    """
}
