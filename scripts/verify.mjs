// 冒烟 + 截图：用本机 Chrome（真 GPU），脚本化地哈气、擦、等待，截几张关键帧
// 用法：node scripts/verify.mjs [outDir] [url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const out = process.argv[2] || 'shots';
const url = process.argv[3] || 'http://127.0.0.1:5181/';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];

async function run(name, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: opts.dpr || 2, hasTouch: !!opts.touch, isMobile: !!opts.touch });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror ${e.message}`));
  await page.goto(url + (opts.query || '?q=high'), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__fog && window.__fog.renderer && window.__fog.renderer.images && window.__fog.renderer.images.cur, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2200);
  const W = viewport.width, H = viewport.height;
  await page.evaluate(() => window.__fog.pause(true));
  const shot = async (tag) => {
    await page.evaluate(() => window.__fog.render());
    await page.screenshot({ path: `${out}/${name}-${tag}.png` });
    // 呼气中心附近的 1:1 局部
    const cw = Math.min(W, 640), ch = Math.min(H, 400);
    await page.screenshot({ path: `${out}/${name}-${tag}-crop.png`, clip: { x: W * 0.5 - cw / 2, y: H * 0.48 - ch / 2, width: cw, height: ch } });
  };
  await shot('0-clear');
  // 哈气 2.5 秒
  await page.evaluate(([x, y]) => { window.__fog.breath(x, y, 1); window.__fog.step(2500); }, [W * 0.5, H * 0.48]);
  await shot('1-breath');
  // 停止，写字
  await page.evaluate(([W, H]) => {
    const f = window.__fog;
    f.breath(0, 0, 0);
    f.step(300);
    const cx = W * 0.5, cy = H * 0.48, s = Math.min(W, H) * 0.12;
    const pts = [];
    for (let i = 0; i <= 60; i++) { const a = (i / 60) * Math.PI * 2; pts.push([cx - s * 0.9 + Math.cos(a) * s * 0.55, cy + Math.sin(a) * s * 0.55]); }
    f.stroke(pts);
    const line = [];
    for (let i = 0; i <= 40; i++) line.push([cx + s * 0.1 + i * s * 0.03, cy - s * 0.6 + i * s * 0.03]);
    f.stroke(line);
    const line2 = [];
    for (let i = 0; i <= 40; i++) line2.push([cx + s * 1.3 - i * s * 0.03, cy - s * 0.6 + i * s * 0.03]);
    f.stroke(line2);
    f.step(200);
  }, [W, H]);
  await shot('2-written');
  await page.evaluate(() => window.__fog.step(2500));
  await shot('3-after2s');
  await page.evaluate(() => window.__fog.step(9000));
  await shot('4-after11s');
  // 再哈一口：字被重新盖住，油脂鬼影
  await page.evaluate(([x, y]) => { window.__fog.breath(x, y, 1); window.__fog.step(1800); window.__fog.breath(0,0,0); window.__fog.step(400); }, [W * 0.5, H * 0.48]);
  await shot('5-rebreath');
  await page.evaluate(() => window.__fog.step(30000));
  await shot('6-evaporated');
  const stats = await page.evaluate(() => ({ gl: window.__fog.usingGL, dpr: window.__fog.dpr, grid: [window.__fog.sim.gw, window.__fog.sim.gh], fog: window.__fog.sim.totalD, drops: window.__fog.drops.list.length }));
  console.log(name, JSON.stringify(stats));
  await ctx.close();
}

await run('desk', { width: 1440, height: 900 }, { dpr: 2 });
await run('phone', { width: 390, height: 844 }, { dpr: 3, touch: true });
await browser.close();
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exitCode = 1; } else console.log('no console errors');
