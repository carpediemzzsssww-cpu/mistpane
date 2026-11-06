// 麦克风呼气检测回归：用 Chrome 假麦克风播放测试音频，打印每 0.1 秒的呼气强度
// 用法：node scripts/verify-mic.mjs shots/breath.wav   （期望 2–4.5 秒为 1，其余为 0）
//       node scripts/verify-mic.mjs shots/speech.wav   （期望全程为 0）
import { chromium } from 'playwright-core';
const wav = process.argv[2];
const b = await chromium.launch({ channel: 'chrome', args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${wav}`,'--autoplay-policy=no-user-gesture-required'] });
const ctx = await b.newContext({ viewport: { width: 900, height: 600 }, permissions: ['microphone'] });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto('http://127.0.0.1:5181/?q=low');
await p.waitForFunction(() => window.__fog.renderer.images.cur);
await p.click('#btnMic');
await p.waitForFunction(() => window.__fog.mic.state === 'on', null, { timeout: 5000 });
const log = [];
for (let i = 0; i < 90; i++) { await p.waitForTimeout(100); log.push(await p.evaluate(() => { const m = window.__fog.mic; return [m.strength, m.raw, m.level - m.floor, m.flat, m.lowLevel - m.lowFloor, m.voice]; })); }
console.log(wav.split('/').pop(), 'label=', await p.textContent('#btnMic'));
console.log('strength:', log.map(r => r[0].toFixed(1)).join(' '));
console.log('above dB:', log.filter((_, i) => i % 3 === 0).map(r => r[2].toFixed(0)).join(' '));
console.log('flat    :', log.filter((_, i) => i % 3 === 0).map(r => r[3].toFixed(2)).join(' '));
console.log('voice   :', log.filter((_, i) => i % 3 === 0).map(r => r[5].toFixed(2)).join(' '));
console.log('fog after:', await p.evaluate(() => window.__fog.sim.totalD.toFixed(3)));
await b.close();
