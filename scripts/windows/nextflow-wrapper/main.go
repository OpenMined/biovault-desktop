package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func existingFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func resolveJava(exeDir string) string {
	if env := os.Getenv("BIOVAULT_BUNDLED_JAVA"); env != "" && existingFile(env) {
		return env
	}

	rel := filepath.Clean(filepath.Join(exeDir, "..", "..", "java", "windows-x86_64", "bin", "java.exe"))
	if existingFile(rel) {
		return rel
	}

	return "java"
}

func main() {
	exePath, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to resolve executable path:", err)
		os.Exit(1)
	}
	exeDir := filepath.Dir(exePath)

	jar := filepath.Join(exeDir, "nextflow.jar")
	if !existingFile(jar) {
		fmt.Fprintln(os.Stderr, "nextflow.jar not found next to nextflow.exe:", jar)
		os.Exit(1)
	}

	java := resolveJava(exeDir)
	args := []string{"-jar", jar}
	args = append(args, os.Args[1:]...)

	cmd := exec.Command(java, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.Env = os.Environ()

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintln(os.Stderr, "failed to run nextflow:", err)
		os.Exit(1)
	}
}

