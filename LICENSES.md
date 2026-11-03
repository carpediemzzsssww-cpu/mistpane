# 素材与第三方说明

## 照片

`assets/photos/` 及其中的 `thumbs/` 是项目创建者提供的 20 张旅行照片与缩略图，仅授权在本项目中展示，不适用代码的 MIT 许可证。另作他用请先取得权利人的许可。

照片导出已转正方向、缩放至最长边 2048px、重新编码，不携带 EXIF、GPS 或原文件名。两张云海照片从原始舷窗照片内裁取，去掉原照片的实物窗框。页面显示时适当降低饱和度，突出玻璃上的雾气与笔迹。

当前版本全部使用项目创建者的照片。之前版本中的雾林与外部雨夜街景已从当前资源和背景列表移除，历史提交保留对应的素材许可记录。

## 代码与参考

代码基于项目创建者提供的 Breath on Glass HTML，代码按仓库内 [MIT License](LICENSE) 发布。以下项目仅用于实现思路参考；随原 HTML 附带的许可注释保留在 `js/app.js`：

- [Fog Mirror](https://github.com/maherkhan-builds/fog-mirror)，MIT，© 2026 Maher Khan：麦克风气流检测。
- [DEWGLASS](https://github.com/Sourav142005/DEWGLASS)，MIT，© 2026 Sourav Kamble：独立雾气遮罩、按住累积。
- [Raindrop](https://github.com/KingDuane/Raindrop)，MIT，© 2021 SardineFish：水珠透镜与背景分级模糊。

Animorio 仅为视觉研究参考，未复制其代码或素材。

飞机舷窗的视觉层次与遮光板联动参考 [Mike Barton](https://www.mikes.cv/)；分层云、遮光板与低动态偏好的实现方式参考 [movin.design Window seat](https://movin.design/components/cards/window-seat/)。窗框、遮光板、运动模型和云层视差由本项目独立实现，未复制参考站的图片、模型或代码。movin.design 的示例标为 MIT-0。
