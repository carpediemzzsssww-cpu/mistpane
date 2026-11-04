# Mistpane 小工具独立构建

基于网页版 v0.8.0，按官方 minitool-zip-builder 1.8.0 与 2026-11-04 获取的在线契约适配。浏览器入口、雾气模拟和网页保存逻辑保留原样。

小工具差异：

- `platform.js`：通过公开 `window.xhs.miniTool` 读取版本与窗口安全区；兼容容器注入的安全区 CSS 变量。
- `save.js`：`writeTempFile` → `saveImageToPhotosAlbum`，客户端 9.42+；用户拒绝、方法缺失或超时会保留画面，供重试或返回。
- `overrides.css`：安全区、旧内核焦点与弹层基线。
- 构建脚本生成图形预算 / 后台暂停 / 慢帧降档 / 上下文丢失后的 2D 兜底，只作用于 `dist-minitool/`。
- 八张照片在小工具构建时缩到最长边 1600px、JPEG 82；保留原始网页版资源。

从本仓库运行：

```sh
npm run build:minitool
npm run check:minitool
```

从上一级工作区（已解压官方 skill）打包：

```sh
node mistpane/scripts/minitool/package-minitool.mjs mistpane/dist-minitool release/mistpane-minitool-v3.zip
```

同名 zip 默认不覆盖，后续改版本号出包。官方 skill 不进 git，发布资源仅 `dist-minitool/` 内的白名单文件；许可证文本放在 `licenses.json`。

本机严格 CSP / 原生 API 模拟检查仅用于发现明显问题，不能替代创服平台模拟器与 Android / iOS 真机扫码验收。未进行真实容器性能和 Chrome 61 实机验证，不作真机性能承诺。
