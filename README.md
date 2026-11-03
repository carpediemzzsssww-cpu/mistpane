# 哈气 · Mistpane

![在雪地红屋前的玻璃上擦出一颗心](docs/preview.webp)

> 窗外的灯还亮着。在玻璃上，写一个字。

**[在线体验](https://mistpane.vercel.app)** · [原质感对照](https://mistpane.vercel.app/?look=original)

一扇可以哈气、擦雾、写字的窗。四张旅行照片里，有雪地的暖灯、雨夜咖啡馆、海边红屋和天黑以前的街巷。

## 怎么玩

- 长按画面，或按住空格，让玻璃起雾；拖动手指或鼠标擦开。
- 底部可以打开麦克风、切换照片、随机天气、切换窗型、上传自己的照片。
- 双击画面也能切换天气；「慢 / 中 / 快」控制雾气消散。
- 四种窗型：普通窗、车窗、火车窗、飞机舷窗。

上传的照片只在当前浏览器内使用，不发送到服务器。麦克风不可用时，可以长按或用空格完成相同的手动体验。

## 本地运行

```sh
npm run dev
npm run build
```

无运行依赖和外部 CDN，`dist/` 可以直接部署到静态托管。渲染采用 WebGL1，失败时使用简化 Canvas2D 效果。浏览器脚本以 Chrome 61 的语法和 API 为目标；旧内核和手机真机仍需实测。

默认是优化质感；在地址后加 `?look=original` 可对照替换照片后的原质感。加 `?scene=1`、`2`、`3` 直接查看其余照片。验收记录见 [docs/QA.md](docs/QA.md)。

## 素材与版权

代码使用 MIT 许可证。四张照片的展示授权与代码许可分开，详见 [LICENSES.md](LICENSES.md)。

## English

A winter window you can breathe on and draw through. Hold the screen or Space to fog the glass, then drag to reveal the view. Switch between four travel photographs, rain and snow, and four window shapes. Uploaded photographs stay in your browser. Built with WebGL1 and a simplified Canvas2D fallback, with no runtime dependencies.
