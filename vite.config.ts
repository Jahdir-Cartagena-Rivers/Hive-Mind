import { defineConfig } from "vite-plus";
export default defineConfig({ test: { include: ["src/legacy/*.test.ts"] } });
