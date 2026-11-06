# 哈气 · Mistpane

![上面调节、下面动作的两条工具栏，以及「拍一张 / 从相册选」](docs/preview.webp)

> 窗外的灯还亮着。在玻璃上，写一个字。

**[在线体验](https://mistpane.vercel.app)** · [白色火车窗](https://mistpane.vercel.app/?window=2) · [无框玻璃](https://mistpane.vercel.app/?window=0)

一扇可以哈气、擦雾、写字的窗。玻璃本身是干净的，打开时水汽一片片凝上来；雾厚的地方过一会儿聚成水珠，长到够大就一顿一顿地滑下来，留下一道水痕；雾散了，没滑走的小水珠还会挂一阵。阳光云海、雪地暖灯、暮色广场……8 张旅行照片，点一下就换一张。默认是白色飞机舷窗，拖动遮光板，房间的光线跟着变暗或变亮；也可以换成白色火车窗或全屏无框玻璃。

## 怎么玩

- 长按玻璃，手指下的圆环合拢后开始起雾，保持按住并拖动可以涂开雾气；松手后，再划就是擦雾写字。
- 写字时被推到笔画下沿的水会聚成小水珠，横着写更容易挂珠；手指擦过水珠会把它抹掉。

上面一条是调节，点一下就换，按钮上写着当前状态：

- **天气**：晴 → 雨 → 雪。双击玻璃也可以；拖动写字不会触发换天气。
- **窗户**：飞机舷窗 → 火车窗 → 无框玻璃。拖动舷窗的把手或遮光板可停在中间，轻点打开 / 关闭；键盘方向键调节，Home 打开、End 关闭。
- **消散**：慢（约两分半）→ 中（约半分钟）→ 快（约十秒）→ 不融化。「不融化」保留雾与字迹，仍可继续涂雾或擦写。

下面一条是动作：

- **换窗景**：换下一张照片。保留原编号 01、02、03、04、07、14、18、20 的八张风景，换窗户时保留当前照片。
- **我的照片**：手机上可以拍一张或从相册选，电脑上选一个文件；只在当前浏览器内处理。
- **起雾**：整面窗由下往上重新凝满雾，写过的字会留下很淡的痕迹，不影响继续写。
- **保存**：先确认，再导出不带操作按钮的 PNG（窗景、雾字和水滴）。手机可以用系统分享存到相册，或长按图片保存。

手机横屏和电脑宽屏时，两条都移到右侧（调节在上、动作在下），窗户用满高度。

**电脑上**：按住空格或鼠标右键哈气（可以边按边移动）、左键拖动写字、滚轮调笔触粗细，鼠标在玻璃上显示笔刷大小。快捷键：C 或 ← → 换窗景、F 起雾、S 保存、W 天气、V 窗户、M 消散。鼠标停 3 秒，工具条退到背景里，移过去就回来。2K / 4K 大屏把渲染像素控制在 500 万以内。

触摸笔迹随玻璃面积适配，细一些，能留下更多书写空间。全部操作使用触摸或鼠标，不请求麦克风。

## 本地运行

```sh
npm run dev
npm run build
```

无运行依赖和外部 CDN，`dist/` 可部署到静态托管。采用 WebGL1，失败时使用简化 Canvas2D 效果。浏览器脚本以 Chrome 61 的语法和 API 为目标；旧内核和手机真机仍需实测。

`?window=4` 为飞机窗，`?window=2` 为火车窗，`?window=0` 为无框玻璃；`?scene=` 使用照片原编号减一，例如 14 号对应 `?scene=13`。已撤下照片的旧链接回到默认阳光云海。`?look=previous` 对照此前雾层，`?look=original` 对照原 HTML 质感。验收说明见 [docs/QA.md](docs/QA.md)。

## 素材与版权

代码使用 MIT 许可证。照片由项目创建者提供，仅授权在本项目中展示；照片授权与代码许可分开，详见 [LICENSES.md](LICENSES.md)。

## English

A winter window you can mist and draw through. Settings sit in a top bar (weather, window, how fast the fog fades); actions sit below (next view, your own photo, fog the whole pane, save). The glass starts clear and fogs up; where condensation lingers, droplets nucleate, grow, and slide down in stick-slip steps, leaving clear trails and tiny beads behind. Hold the glass, then drag to spread condensation; release and start a new stroke to wipe it away. Tap to cycle through eight travel photographs. Rain gradually changes intensity, with refracting droplets and wet trails on the outer glass; snow and clear weather are also available. White aircraft and train windows sit alongside a full-screen frameless view. Six tactile controls adapt to portrait and landscape screens. Save the current window, writing and droplets as a PNG without the controls. Mobile offers an image preview for long-press saving or system sharing. Uploaded photographs stay in your browser. No microphone permission; WebGL1 with a simplified Canvas2D fallback and no runtime dependencies.
