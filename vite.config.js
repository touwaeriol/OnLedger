import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 只在打包产物里注入 CSP（开发模式下 Vite HMR 需要内联脚本和 websocket）
const cspPlugin = {
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace(
      '<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'" />`
    );
  },
};

export default defineConfig({
  plugins: [react(), cspPlugin],
  base: './', // 打包后通过 file:// 加载，需要相对路径
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787' }, // npm run dev:web：网页版开发时转发到本地后端
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 3000 },
});
