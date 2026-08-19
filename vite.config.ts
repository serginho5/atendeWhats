// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // Projeto saiu do Lovable Cloud (Cloudflare Workers) e agora roda em Docker no
  // próprio VPS — build precisa gerar um servidor Node comum, não um módulo Cloudflare.
  nitro: { preset: "node-server" },
  vite: {
    // Permite acesso via túnel público (localtunnel) durante dev local, necessário
    // pro webhook da Evolution API (rodando num VPS remoto) conseguir chamar de volta.
    server: { allowedHosts: [".loca.lt"] },
  },
});
