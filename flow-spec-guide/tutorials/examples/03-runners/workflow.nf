nextflow.enable.dsl=2

process COUNT_LINES {
  input:
    path input_txt

  output:
    path "stats.tsv"

  script:
    """
    wc -l ${input_txt} | awk '{print $1}' > stats.tsv
    """
}

workflow USER {
  take:
    context
    input_txt

  main:
    COUNT_LINES(input_txt)

  emit:
    stats = COUNT_LINES.out
}
