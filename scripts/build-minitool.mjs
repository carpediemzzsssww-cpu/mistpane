// Build a container-only variant; the browser entry and scripts stay unchanged.
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dist=path.join(root,'dist-minitool');
fs.rmSync(dist,{recursive:true,force:true});for(const p of ['js','css','assets/photos/thumbs'])fs.mkdirSync(path.join(dist,p),{recursive:true});
function patch(s,a,b){if(!s.includes(a))throw new Error('Source changed; review minitool patch: '+a.slice(0,70));return s.replace(a,b);}
let html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/(src|href)="(js|css|assets)\//g,'$1="./$2/');
html=patch(html,'<script src="./js/windows.js">','<script src="./js/platform.js"></script>\n<script src="./js/windows.js">');
html=patch(html,'<link rel="stylesheet" href="./css/style.css">','<link rel="stylesheet" href="./css/style.css">\n<link rel="stylesheet" href="./css/minitool.css">');fs.writeFileSync(path.join(dist,'index.html'),html);
let css=fs.readFileSync(path.join(root,'css/style.css'),'utf8');
// Use injected pixel values, avoiding env() at computed-value time on old WebViews.
css=css.replace(/inset:0; /g,'').replace(/env\(safe-area-inset-(top|bottom|left|right)\)/g,'var(--mist-safe-$1,0px)');
fs.writeFileSync(path.join(dist,'css/style.css'),css);fs.copyFileSync(path.join(root,'minitool/overrides.css'),path.join(dist,'css/minitool.css'));
for(const name of ['save.js','platform.js'])fs.copyFileSync(path.join(root,'minitool',name),path.join(dist,'js',name));
let win=fs.readFileSync(path.join(root,'js/windows.js'),'utf8');
win=patch(win,'var top = landscape ? 20 : 80;','var top = landscape ? 20 : Math.max(80, MIST_PLATFORM.insets.top + 70);');
win=patch(win,'var viewW = landscape ? Math.max(180, W - 152) : W;','var safeLeft=MIST_PLATFORM.insets.left, safeRight=MIST_PLATFORM.insets.right;\n    var viewW = Math.max(180, W-safeLeft-safeRight-(landscape?152:0));');
win=patch(win,'x:type?(viewW-w)/2:0','x:type?safeLeft+(viewW-w)/2:0');fs.writeFileSync(path.join(dist,'js/windows.js'),win);
let app=fs.readFileSync(path.join(root,'js/app.js'),'utf8');
app=patch(app,'rainScale = Math.min(0.5, 720 / Math.max(1, S.cssW));','rainScale = Math.min(0.5, (miniLevel?512:720) / Math.max(1, S.cssW), (miniLevel?1024:2048) / Math.max(1, S.cssH));');
app=patch(app,'var s = Math.min(base, Math.sqrt(cap / Math.max(1, S.cssW * S.cssH)));','var s = Math.min(base, Math.sqrt(cap / Math.max(1, S.cssW * S.cssH)), (miniLevel?1024:2048)/Math.max(S.cssW,S.cssH));');
app=patch(app,'var qualityTier = 0;','var qualityTier = 1, miniLevel = 0, miniRaf = 0;');
app=patch(app,'var dpr = Math.min(window.devicePixelRatio || 1, 1.6);',`var pixelBudget=miniLevel?1000000:2000000, edgeBudget=miniLevel?1024:2048;
  var dpr = Math.min(window.devicePixelRatio || 1, miniLevel?1:1.5, Math.sqrt(pixelBudget/(w*h)), edgeBudget/Math.max(w,h));`);
app=patch(app,'if (w === S.cssW && h === S.cssH && dpr === S.dpr && fogCanvas) return;',`if (w === S.cssW && h === S.cssH && dpr === S.dpr && fogCanvas) {
    syncFrame();setupRain();primeWeather(S.weather);buildBackground();return;
  }`);
app=patch(app,"function frame(t) {\n  window.requestAnimationFrame(frame);",`function frame(t) {
  miniRaf=0;if(document.hidden)return;
  miniRaf=window.requestAnimationFrame(frame);`);
const a=app.indexOf('      if (!adapted && avg > 0.030'),b=app.indexOf('\n    }\n  } catch',a);
if(a<0||b<0)throw new Error('Adaptation block missing');
app=app.slice(0,a)+`      if(avg>0.034){
        if(!miniLevel){miniLevel=1;qualityTier=2;applyResize();showToast('已调低画质，保持书写流畅',2400);}
        else if(useGL)switchToFlat('已使用简化渲染，仍可哈气写字');
      }`+app.slice(b);
app=patch(app,'/* ================================================================ 初始化 */',`function startMiniLoop(){if(!document.hidden&&!miniRaf){lastT=0;perfAcc=0;perfCnt=0;qaFrames=[];qaCpu=[];miniRaf=requestAnimationFrame(frame);}}
function pauseMiniLoop(){if(miniRaf)cancelAnimationFrame(miniRaf);miniRaf=0;lastT=0;}
document.addEventListener('visibilitychange',function(){if(document.hidden)pauseMiniLoop();else startMiniLoop();});
window.addEventListener('pagehide',pauseMiniLoop);window.addEventListener('pageshow',startMiniLoop);
MIST_PLATFORM.onLayout=onResize;
/* ================================================================ 初始化 */`);
app=patch(app,'    window.requestAnimationFrame(frame);','    startMiniLoop();');
app=patch(app,"glass.addEventListener('webglcontextlost', onContextLost, false);",`glass.addEventListener('webglcontextlost', onContextLost, false);
  glass.addEventListener('webglcontextrestored',function(){switchToFlat();},false);`);
// Diagnostic dimensions support the release checks; no diagnostic UI is shipped.
app=patch(app,'dpr: S.dpr, drops: drops.length,','dpr: S.dpr, buffer: [S.bufW,S.bufH], quality: miniLevel, drops: drops.length,');
fs.writeFileSync(path.join(dist,'js/app.js'),app);
for(const name of fs.readdirSync(path.join(dist,'js')))new vm.Script(fs.readFileSync(path.join(dist,'js',name),'utf8'));
const python='/opt/homebrew/bin/python3.11';
execFileSync(python,['-c',`from pathlib import Path
from PIL import Image
import shutil
src=Path(${JSON.stringify(path.join(root,'assets/photos'))});dest=Path(${JSON.stringify(path.join(dist,'assets/photos'))})
for p in src.glob('*.jpg'):
 im=Image.open(p);im.thumbnail((1600,1600));im.save(dest/p.name,format='JPEG',quality=82,optimize=True,progressive=True)
for p in (src/'thumbs').glob('*.jpg'):shutil.copyfile(p,dest/'thumbs'/p.name)
`]);
fs.writeFileSync(path.join(dist,'licenses.json'),JSON.stringify({code:fs.readFileSync(path.join(root,'LICENSE'),'utf8'),photos:fs.readFileSync(path.join(root,'LICENSES.md'),'utf8')},null,2));
console.log('Built independent minitool variant: '+dist);
