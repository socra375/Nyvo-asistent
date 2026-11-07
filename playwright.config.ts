import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFakeMic } from './tests/e2e/fakeMic.js';

// Micrófono falso con dos «frases» (la segunda cae sobre la voz de Nyvo para probar la interrupción).
const FAKE_MIC = resolve('test-results/fake-mic.wav');
writeFakeMic(FAKE_MIC);

/**
 * Pruebas en Chromium real contra la web compilada (npm run build) y la API local.
 * Micrófono falso de Chromium para probar «pulsar para hablar».
 */
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const launchOptions = {
  executablePath,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
};

const voiceLaunch = { ...launchOptions, args: [...launchOptions.args, `--use-file-for-fake-audio-capture=${FAKE_MIC}%noloop`] };

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    locale: 'es-ES',
    permissions: ['microphone'],
    trace: 'off',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'escritorio', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions }, grepInvert: /@movil|@voz/ },
    { name: 'voz', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 }, launchOptions: voiceLaunch }, grep: /@voz/ },
    { name: 'movil', use: { ...devices['Pixel 7'], launchOptions }, grep: /@movil/ }
  ],
  webServer: [
    { command: 'node --import tsx tests/e2e/server.ts', url: 'http://localhost:3100/api/health', reuseExistingServer: false, timeout: 60_000, stdout: 'pipe' },
    { command: 'node --import tsx tests/e2e/server.ts --bare', url: 'http://localhost:3101/api/health', reuseExistingServer: false, timeout: 60_000, stdout: 'pipe' }
  ]
});
