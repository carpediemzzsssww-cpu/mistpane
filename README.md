# 哈气 · Mistpane

![手机哈气按钮与小雨、大雨效果](docs/preview.webp)

> 窗外的灯还亮着。在玻璃上，写一个字。

**[在线体验](https://mistpane.vercel.app)** · [白色火车窗](https://mistpane.vercel.app/?window=2) · [无框玻璃](https://mistpane.vercel.app/?window=0)

一扇可以哈气、擦雾、写字的窗。阳光云海、雪地暖灯、暮色广场……8 张旅行照片，点一下就换一张。默认是白色飞机舷窗，拖动遮光板，房间的光线跟着变暗或变亮；也可以换成白色火车窗或全屏无框玻璃。

## 怎么玩

- 手机按住「哈气」按钮，松开后在玻璃上写字；也可以长按玻璃或按住键盘空格。
- 点「照片」直接切换下一张。保留原编号 01、02、03、04、07、14、18、20 的八张风景，换窗型时保留当前照片。
- 天气按钮依次切换「晴 → 小雨 → 大雨 → 雪」。双击玻璃也可以；拖动写字不会触发换天气。
- 点「消散」在慢、中、快三档之间切换，三档均保留较慢的融化速度。小雨以细短雨丝和小水珠为主，大雨更密、更快，玻璃外侧逐渐积起较大的水滴。
- 拖动飞机舷窗的把手或遮光板，可停在中间；轻点打开 / 关闭。键盘方向键调节，Home 打开、End 关闭。
- 点「麦克风」授权后，靠近手机麦克风轻轻哈气；声音在本机实时分析，不录制或上传。再次点击关闭，切到后台也会停止；不可用时继续用「按住哈气」。
- 「上传」可以使用自己的照片，仅在当前浏览器内处理。

手机竖屏将哈气 / 麦克风放在上排，五个带短标签的环境按钮放在下排；横屏移到右侧，给玻璃留出书写空间。

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

A winter window you can breathe on and draw through. Hold the breath button, release it, then write on the glass. Tap the photo button to cycle through eight travel photographs. Optional microphone input responds to breath sounds, with local audio analysis and manual controls available if permission is denied. Choose clear weather, drizzle, heavy rain or snow. Rain intensity changes both distant streaks and water on the outer glass. White aircraft and train windows sit alongside a full-screen frameless view. Portrait and landscape layouts keep the controls reachable. Uploaded photographs stay in your browser. WebGL1 with a simplified Canvas2D fallback; no runtime dependencies.
