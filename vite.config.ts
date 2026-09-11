import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({
      viteEnvironment: { name: "server" },
      remoteBindings: false,
      inspectorPort: false,
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: {
      deny: [
        "**/.kamal/**",
        "**/.bundle/**",
        "**/config/**",
        "**/storage/**",
        "**/log/**",
        "**/tmp/**",
      ],
    },
  },
});
