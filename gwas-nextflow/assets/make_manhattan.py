#!/usr/bin/env python3
"""
Manhattan and QQ Plot Generator for GWAS Results
Generates publication-quality plots from PLINK association output

Usage:
    python make_manhattan.py <gwas_results_file> [annotation_pval] [gw_sig]

Arguments:
    gwas_results_file: PLINK .assoc.logistic output file (test results)
    annotation_pval: P-value threshold for annotating SNPs (default: 1e-5)
    gw_sig: Genome-wide significance threshold (default: 5e-8)
"""

import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')  # Use non-interactive backend
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator
import sys
import os

def load_gwas_results(filename):
    """Load GWAS results from PLINK output"""
    print(f"Loading GWAS results from {filename}...")
    
    # Read the file - PLINK output has header
    try:
        df = pd.read_csv(filename, sep='\s+')
        print(f"Initial load: {len(df)} rows")
        print(f"Columns found: {list(df.columns)}")
    except Exception as e:
        print(f"ERROR reading file: {e}")
        sys.exit(1)
    
    # Check if P column exists
    if 'P' not in df.columns:
        print("ERROR: No 'P' column found in results file!")
        print(f"Available columns: {list(df.columns)}")
        sys.exit(1)
    
    # Filter for valid P-values
    df = df[df['P'].notna()].copy()
    df = df[df['P'] != 'NA'].copy()
    
    # Convert P to numeric
    df['P'] = pd.to_numeric(df['P'], errors='coerce')
    df = df.dropna(subset=['P'])
    df = df[(df['P'] > 0) & (df['P'] <= 1)].copy()
    
    print(f"After P-value filtering: {len(df)} SNPs")
    
    if len(df) == 0:
        print("ERROR: No valid SNPs after filtering!")
        sys.exit(1)
    
    # Calculate -log10(p)
    df['NEGLOG10P'] = -np.log10(df['P'])
    df = df[np.isfinite(df['NEGLOG10P'])].copy()
    
    # Convert CHR to numeric
    df['CHR'] = df['CHR'].replace({'X': 23, 'Y': 24, 'MT': 25, 'M': 25})
    df['CHR'] = pd.to_numeric(df['CHR'], errors='coerce')
    df = df.dropna(subset=['CHR'])
    df['CHR'] = df['CHR'].astype(int)
    
    # Convert BP to numeric
    df['BP'] = pd.to_numeric(df['BP'], errors='coerce')
    df = df.dropna(subset=['BP'])
    df['BP'] = df['BP'].astype(int)
    
    print(f"Final dataset: {len(df):,} SNPs across {df['CHR'].nunique()} chromosomes")
    print(f"P-value range: {df['P'].min():.2e} to {df['P'].max():.2e}")
    print(f"-log10(P) range: {df['NEGLOG10P'].min():.2f} to {df['NEGLOG10P'].max():.2f}")
    
    return df

def create_manhattan_plot(df, output_prefix, annotation_pval=1e-5, gw_sig=5e-8):
    """Create Manhattan plot with annotations"""
    
    print("Creating Manhattan plot...")
    
    df = df.sort_values(['CHR', 'BP']).reset_index(drop=True)
    
    # Calculate cumulative position
    df['cumulative_pos'] = 0
    chr_centers = []
    last_pos = 0
    
    for chrom in sorted(df['CHR'].unique()):
        chr_df = df[df['CHR'] == chrom]
        chr_len = chr_df['BP'].max()
        df.loc[df['CHR'] == chrom, 'cumulative_pos'] = chr_df['BP'] + last_pos
        chr_centers.append(last_pos + chr_len / 2)
        last_pos += chr_len
    
    # Create figure
    fig, ax = plt.subplots(figsize=(16, 6))
    
    # Plot by chromosome
    colors = ['#3182bd', '#9ecae1']
    chr_list = sorted(df['CHR'].unique())
    
    for idx, chrom in enumerate(chr_list):
        chr_df = df[df['CHR'] == chrom]
        ax.scatter(chr_df['cumulative_pos'], chr_df['NEGLOG10P'], 
                  c=colors[idx % 2], s=5, alpha=0.7, linewidths=0)
    
    # Significance lines
    gw_line = -np.log10(gw_sig)
    sugg_line = -np.log10(annotation_pval)
    
    ax.axhline(y=gw_line, color='red', linestyle='--', linewidth=1.5, 
               label=f'Genome-wide sig. (P={gw_sig:.0e})', alpha=0.7)
    ax.axhline(y=sugg_line, color='blue', linestyle='--', linewidth=1, 
               label=f'Suggestive (P={annotation_pval:.0e})', alpha=0.7)
    
    # Annotate top SNPs
    top_snps = df[df['P'] < annotation_pval].copy()
    
    if len(top_snps) > 0:
        print(f"Annotating {len(top_snps)} top SNPs...")
        
        if len(top_snps) > 20:
            top_snps = top_snps.nsmallest(20, 'P')
        
        for _, snp in top_snps.iterrows():
            ax.annotate(snp['SNP'], 
                       xy=(snp['cumulative_pos'], snp['NEGLOG10P']),
                       xytext=(5, 5), textcoords='offset points',
                       fontsize=7, alpha=0.8,
                       bbox=dict(boxstyle='round,pad=0.3', facecolor='yellow', 
                                alpha=0.3, edgecolor='none'),
                       arrowprops=dict(arrowstyle='->', lw=0.5, alpha=0.5))
            
            ax.scatter([snp['cumulative_pos']], [snp['NEGLOG10P']], 
                      c='red', s=30, marker='D', zorder=5, edgecolors='darkred', linewidths=0.5)
    else:
        print("No SNPs reached annotation threshold")
    
    # Format axes
    ax.set_xticks(chr_centers)
    ax.set_xticklabels([str(c) for c in chr_list])
    ax.set_xlabel('Chromosome', fontsize=12, fontweight='bold')
    ax.set_ylabel('-log₁₀(P)', fontsize=12, fontweight='bold')
    ax.yaxis.set_major_locator(MaxNLocator(integer=True))
    
    y_max = max(df['NEGLOG10P'].max() * 1.1, gw_line * 1.2)
    ax.set_ylim([0, y_max])
    
    ax.grid(True, alpha=0.2, linestyle=':', linewidth=0.5)
    ax.set_title('Genome-Wide Association Study Results', 
                fontsize=14, fontweight='bold', pad=15)
    ax.legend(loc='upper right', framealpha=0.9, fontsize=9)
    
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    
    plt.tight_layout()
    
    # Save PNG
    output_file = f'{output_prefix}_manhattan.png'
    print(f"Saving Manhattan plot to {output_file}...")
    plt.savefig(output_file, dpi=300, bbox_inches='tight')
    print(f"Manhattan plot (PNG) saved successfully")
    
    plt.close()
    
    return top_snps

def create_qq_plot(df, output_prefix):
    """Create QQ plot"""
    
    print("Creating QQ plot...")
    
    pvals = df['P'].dropna()
    pvals = pvals[pvals > 0]
    
    if len(pvals) == 0:
        print("No valid p-values for QQ plot")
        return None
    
    observed = -np.log10(sorted(pvals))
    n = len(observed)
    expected = -np.log10(np.arange(1, n + 1) / (n + 1))
    
    # Calculate lambda (genomic inflation factor)
    chisq_values = -2 * np.log(pvals)
    lambda_gc = np.median(chisq_values) / 0.456
    
    fig, ax = plt.subplots(figsize=(7, 7))
    
    ax.scatter(expected, observed, s=10, alpha=0.6, c='#3182bd', linewidths=0)
    
    max_val = max(max(expected), max(observed))
    ax.plot([0, max_val], [0, max_val], 'r--', linewidth=2, alpha=0.7, label='Expected')
    
    ax.text(0.05, 0.95, f'λ = {lambda_gc:.3f}', 
           transform=ax.transAxes, fontsize=11, verticalalignment='top',
           bbox=dict(boxstyle='round', facecolor='white', alpha=0.8))
    
    ax.set_xlabel('Expected -log₁₀(P)', fontsize=12, fontweight='bold')
    ax.set_ylabel('Observed -log₁₀(P)', fontsize=12, fontweight='bold')
    ax.set_title('QQ Plot', fontsize=14, fontweight='bold', pad=15)
    
    ax.grid(True, alpha=0.2, linestyle=':', linewidth=0.5)
    ax.legend(loc='lower right', framealpha=0.9)
    
    plt.tight_layout()
    
    # Save QQ plot
    output_file = f'{output_prefix}_qq.png'
    print(f"Saving QQ plot to {output_file}...")
    plt.savefig(output_file, dpi=300, bbox_inches='tight')
    print(f"QQ plot saved successfully")
    
    plt.close()
    
    print(f"Genomic inflation factor (λ): {lambda_gc:.4f}")
    
    return lambda_gc

def main():
    if len(sys.argv) < 2:
        print("Usage: python make_manhattan.py <gwas_results_file> [annotation_pval] [gw_sig]")
        sys.exit(1)
    
    input_file = sys.argv[1]
    annotation_pval = float(sys.argv[2]) if len(sys.argv) > 2 else 1e-5
    gw_sig = float(sys.argv[3]) if len(sys.argv) > 3 else 5e-8
    
    print("="*60)
    print("GWAS Manhattan and QQ Plot Generator")
    print("="*60)
    print(f"Input file: {input_file}")
    print(f"Annotation threshold: P < {annotation_pval}")
    print(f"Genome-wide significance: P < {gw_sig}")
    print("="*60)
    
    output_prefix = os.path.splitext(input_file)[0]
    
    # Load data
    df = load_gwas_results(input_file)
    
    # Calculate significance counts
    gw_significant = df[df['P'] < gw_sig]
    suggestive = df[df['P'] < annotation_pval]
    
    print("\n" + "="*60)
    print("SIGNIFICANCE SUMMARY")
    print("="*60)
    print(f"Genome-wide significant SNPs (P < {gw_sig}): {len(gw_significant)}")
    print(f"Suggestive SNPs (P < {annotation_pval}): {len(suggestive)}")
    
    # Save significant hits
    if len(gw_significant) > 0:
        gw_file = f'{output_prefix}_genome_wide_significant.txt'
        gw_significant_sorted = gw_significant.sort_values('P')[['CHR', 'SNP', 'BP', 'A1', 'OR', 'P']]
        gw_significant_sorted.to_csv(gw_file, sep='\t', index=False)
        print(f"Genome-wide significant SNPs saved to: {gw_file}")
    else:
        print("No genome-wide significant SNPs found")
    
    # Save top 50 suggestive hits
    if len(suggestive) > 0:
        top50_file = f'{output_prefix}_top50_suggestive.txt'
        top50 = suggestive.nsmallest(50, 'P')[['CHR', 'SNP', 'BP', 'A1', 'OR', 'P']]
        top50.to_csv(top50_file, sep='\t', index=False)
        print(f"Top 50 suggestive SNPs saved to: {top50_file}")
    
    # Create plots
    print("\n" + "="*60)
    print("GENERATING PLOTS")
    print("="*60)
    top_snps = create_manhattan_plot(df, output_prefix, annotation_pval, gw_sig)
    
    print("\n" + "="*60)
    lambda_gc = create_qq_plot(df, output_prefix)
    
    # Save annotated SNPs for plot
    if len(top_snps) > 0:
        top_file = f'{output_prefix}_annotated_snps.txt'
        top_snps_sorted = top_snps.sort_values('P')[['CHR', 'SNP', 'BP', 'A1', 'OR', 'P']]
        top_snps_sorted.to_csv(top_file, sep='\t', index=False)
        print(f"\nPlot-annotated SNPs saved to: {top_file}")
    
    print("\n" + "="*60)
    print("VISUALIZATION COMPLETE!")
    print("="*60)
    print(f"Manhattan plot: {output_prefix}_manhattan.png")
    print(f"QQ plot: {output_prefix}_qq.png")
    print(f"Genomic inflation factor (λ): {lambda_gc:.4f}")
    print("="*60)

if __name__ == '__main__':
    main()