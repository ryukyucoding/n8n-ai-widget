#!/usr/bin/env node
/**
 * One-time login for n8n Cloud Playwright sessions.
 * Saves cookies to playwright/.auth/storageState.json
 */

import 'dotenv/config';
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = resolve(__dirname, '..');
const CLOUD_URL = (process.env.N8N_CLOUD_URL || 'https://widmn8n.app.n8n.cloud').replace(/\/$/, '');
const EMAIL = process.env.N8N_CLOUD_EMAIL || '';
const PASSWORD = process.env.N8N_CLOUD_PASSWORD || '';
const OUT = resolve(BENCHMARK_ROOT, process.env.PLAYWRIGHT_STORAGE_STATE || 'playwright/.auth/storageState.json');

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${CLOUD_URL}/signin`, { waitUntil: 'domcontentloaded' });

  if (EMAIL && PASSWORD) {
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await page.waitForURL(/workflow|home|projects/, { timeout: 120000 });
  } else {
    console.log('Set N8N_CLOUD_EMAIL / N8N_CLOUD_PASSWORD in .env, or log in manually in the opened browser.');
    console.log('Waiting up to 3 minutes for you to finish login...');
    await page.waitForURL(/workflow|home|projects/, { timeout: 180000 });
  }

  await context.storageState({ path: OUT });
  console.log(`Saved session to ${OUT}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
