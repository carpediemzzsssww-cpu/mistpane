# 素材与第三方说明

## 背景照片（Wikimedia Commons，缩到 2400px 宽、重新压缩，未做其他修改）

| 文件 | 作者 | 许可证 | 来源 |
| --- | --- | --- | --- |
| `assets/photos/snow-street.jpg` | Robot8A | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Tram_disruption_in_the_snow.jpeg |
| `assets/photos/lisbon-rain.jpg` | Terry Kearney | CC0 | https://commons.wikimedia.org/wiki/File:LISBON_IN_THE_NIGHT_RAIN_(10604014063).jpg |
| `assets/photos/fog-house.jpg` | Lukas Neasi | CC0 | https://commons.wikimedia.org/wiki/File:A_house_in_winter_fog_(Unsplash).jpg |
| `assets/photos/autumn-forest.jpg` | Artem Sapegin | CC0 | https://commons.wikimedia.org/wiki/File:Early_morning_in_autumn_forest_(Unsplash).jpg |
| `assets/photos/tuntorp-night.jpg` | W.carter | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Snowy_night_in_Tuntorp.jpg |

CC BY-SA 4.0 的两张：缩放后的版本同样按 CC BY-SA 4.0 提供；页面切到这两张时右下角显示作者和许可证。

## 参考过的开源实现（都是 MIT；只借鉴思路，没有复制代码）

- [KingDuane/Raindrop](https://github.com/KingDuane/Raindrop)：水珠画成法线贴图、用 smoothstep 阈值合成后折射背景
- [maherkhan-builds/fog-mirror](https://github.com/maherkhan-builds/fog-mirror)：麦克风吹气检测 + 遮罩擦除的基本思路
- [Sourav142005/DEWGLASS](https://github.com/Sourav142005/DEWGLASS)：边缘凝结、水珠挂壁的观察

## 代码里的小片段

- `hash12`：Dave Hoskins「Hash without Sine」（MIT）
- 4 次采样的三次 B 样条纹理采样：Sigg & Hadwiger, GPU Gems 2 第 20 章的公开技巧
