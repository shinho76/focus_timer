import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  webServer: {
    // 프로젝트 루트를 통째로 서빙한다 — demo/index.html 이 ../dist/focus-timer.js
    // 를 참조하므로 demo/ 만 루트로 잡으면(이전 설정) dist/ 가 404 난다.
    command: 'npx http-server . -p 4173 -c-1',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:4173',
  },
});
