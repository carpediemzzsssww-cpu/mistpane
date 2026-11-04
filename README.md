# 哈气 · Mistpane

![白色飞机窗、火车窗、无框玻璃与照片选择](docs/preview.webp)

> 窗外的灯还亮着。在玻璃上，写一个字。

**[在线体验](https://mistpane.vercel.app)** · [白色火车窗](https://mistpane.vercel.app/?window=2) · [无框玻璃](https://mistpane.vercel.app/?window=0)

一扇可以哈气、擦雾、写字的窗。阳光云海、雪地暖灯、暮色广场……8 张旅行照片可以慢慢挑。默认是白色飞机舷窗，拖动遮光板，房间的光线跟着变暗或变亮；也可以换成白色火车窗或全屏无框玻璃。

## 怎么玩

- 长按玻璃，或按住空格，让玻璃起雾；拖动手指或鼠标擦开。
- 底部照片按钮打开缩略图面板，保留原编号 01、02、03、04、07、14、18、20，方便继续挑选。切换窗型会保留当前照片。
- 天气按钮依次切换「晴 → 雨 → 雪」。双击玻璃也可以；拖动写字不会触发换天气。
- 「慢 / 中 / 快」控制雾气消散，三档均较此前放慢约 20%。雨丝、雪花在窗外，凝结的水滴与融化留在玻璃上。
- 拖动飞机舷窗的把手或遮光板，可停在中间；轻点打开 / 关闭。键盘方向键调节，Home 打开、End 关闭。
- 可以打开麦克风哈气，也可以上传自己的照片。上传只在当前浏览器内使用，不发送到服务器；麦克风不可用时，长按与空格仍然可玩。

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

A winter window you can breathe on and draw through. Hold the screen or Space to fog the glass, then drag to reveal the view. Choose from eight travel photographs in a numbered contact sheet, with a white aircraft window, a white train window, or a full-screen frameless view. Drag the aircraft shade to change the cabin light. Rain and snow appear inside the opening immediately; writing gestures keep the weather unchanged. The layout supports portrait and landscape phones. Uploaded photographs stay in your browser. Built with WebGL1 and a simplified Canvas2D fallback, with no runtime dependencies.
