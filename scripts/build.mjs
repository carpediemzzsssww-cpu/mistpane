// Publish only the browser application, never the local workspace or raw photos.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const script of ['windows.js', 'app.js']) {
  new vm.Script(fs.readFileSync(path.join(root, 'js', script), 'utf8'));
}
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const name of ['index.html', 'css', 'js', 'assets', 'LICENSE', 'LICENSES.md']) {
  fs.cpSync(path.join(root, name), path.join(dist, name), { recursive: true });
}
console.log('Built static site: dist/');
