import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config/
export default defineConfig({
    root: 'src',
    plugins: [tailwindcss()],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
        port: 5173,
        strictPort: true,
        host: true,
        watch: {
            // 3. tell vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"],
        },
    },
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        // Tauri supports es2021
        target: process.env.TAURI_ENV_PLATFORM == 'windows' ? 'chrome105' : 'safari13',
        // don't minify for debug builds
        minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
        // produce sourcemaps for debug builds
        sourcemap: !!process.env.TAURI_ENV_DEBUG,
    },
});
