import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto('http://localhost:8899/', { waitUntil: 'networkidle' });
await p.click('text=Gacha Desk');
await p.waitForTimeout(1200);
await p.screenshot({ path: '/tmp/gacha-v2.png' });
await b.close();
