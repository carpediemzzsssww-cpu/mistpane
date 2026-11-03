# 素材与第三方说明

## 照片

`assets/photos/` 中 `winter-valley.jpg`、`snow-cabin.jpg`、`coast.jpg`、`cloud-sea.jpg`、`cloud-dusk.jpg` 五张旅行照片由项目创建者提供，仅授权在本项目中展示，不适用代码的 MIT 许可证。另作他用请先取得权利人的许可。

`fog-house.jpg`：Lukas Neasi，[A house in winter fog](https://commons.wikimedia.org/wiki/File:A_house_in_winter_fog_(Unsplash).jpg)，CC0。照片色彩在浏览器渲染时作了低饱和度处理。

个人照片发布文件已转正方向、缩放至最长边 2048px、重新编码；不携带 EXIF、GPS 或原文件名。两张云层照片从原始舷窗照片内裁取，去掉原照片的实物窗框。

`rain-street.jpg`：Nenad Stojković（Wikimedia 用户 Shixart1985），[Warm street lights glow along a narrow city street filled with parked cars on a rainy night](https://commons.wikimedia.org/wiki/File:Warm_street_lights_glow_along_a_narrow_city_street_filled_with_parked_cars_on_a_rainy_night.jpg)，[CC BY 2.0](https://creativecommons.org/licenses/by/2.0/)。缩放、重新压缩并移除元数据，页面渲染时降低饱和度；界面保留作者、来源和许可链接。

`lisbon-rain.jpg`：Terry Kearney，[LISBON IN THE NIGHT RAIN](https://commons.wikimedia.org/wiki/File:LISBON_IN_THE_NIGHT_RAIN_(10604014063).jpg)，[CC0](https://creativecommons.org/publicdomain/zero/1.0/)。缩放、重新压缩并移除元数据，页面渲染时降低饱和度。

## 代码与参考

代码基于项目创建者提供的 Breath on Glass HTML，代码按仓库内 [MIT License](LICENSE) 发布。以下项目仅用于实现思路参考；随原 HTML 附带的许可注释保留在 `js/app.js`：

- [Fog Mirror](https://github.com/maherkhan-builds/fog-mirror)，MIT，© 2026 Maher Khan：麦克风气流检测。
- [DEWGLASS](https://github.com/Sourav142005/DEWGLASS)，MIT，© 2026 Sourav Kamble：独立雾气遮罩、按住累积。
- [Raindrop](https://github.com/KingDuane/Raindrop)，MIT，© 2021 SardineFish：水珠透镜与背景分级模糊。

Animorio 仅为视觉研究参考，未复制其代码或素材。

飞机舷窗的视觉层次与遮光板联动参考 [Mike Barton](https://www.mikes.cv/)；分层云、遮光板与低动态偏好的实现方式参考 [movin.design Window seat](https://movin.design/components/cards/window-seat/)。窗框、遮光板、运动模型和云层视差由本项目独立实现，未复制参考站的图片、模型或代码。movin.design 的示例标为 MIT-0。
