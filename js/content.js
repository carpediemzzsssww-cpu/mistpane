/* 界面文字和场景配置集中在这里（不用 fetch，file:// 和小工具容器里都能直接读） */
window.FG_CONTENT = {
  scenes: [
    {
      id: 'snow-street',
      file: 'assets/photos/snow-street.jpg',
      name: '雪夜，电车停在路口',
      focus: [0.5, 0.55],
      fogTint: [0.93, 0.9, 0.87],
      fogLight: 0.12,
      room: [1.0, 0.74, 0.48],
      ambient: 0.9,
      credit: { author: 'Robot8A', license: 'CC BY-SA 4.0', url: 'https://commons.wikimedia.org/wiki/File:Tram_disruption_in_the_snow.jpeg' }
    },
    {
      id: 'lisbon-rain',
      file: 'assets/photos/lisbon-rain.jpg',
      name: '里斯本，夜雨',
      focus: [0.42, 0.5],
      fogTint: [0.95, 0.9, 0.84],
      fogLight: 0.1,
      room: [1.0, 0.7, 0.45],
      ambient: 0.75,
      credit: { author: 'Terry Kearney', license: 'CC0', url: 'https://commons.wikimedia.org/wiki/File:LISBON_IN_THE_NIGHT_RAIN_(10604014063).jpg' }
    },
    {
      id: 'fog-house',
      file: 'assets/photos/fog-house.jpg',
      name: '冬雾里的小屋',
      focus: [0.38, 0.6],
      fogTint: [0.88, 0.92, 0.97],
      fogLight: 0.1,
      room: [0.9, 0.8, 0.7],
      ambient: 1.0,
      credit: { author: 'Lukas Neasi', license: 'CC0', url: 'https://commons.wikimedia.org/wiki/File:A_house_in_winter_fog_(Unsplash).jpg' }
    },
    {
      id: 'autumn-forest',
      file: 'assets/photos/autumn-forest.jpg',
      name: '秋林，清晨',
      focus: [0.55, 0.5],
      fogTint: [0.95, 0.93, 0.89],
      fogLight: 0.15,
      room: [1.0, 0.78, 0.55],
      ambient: 0.7,
      credit: { author: 'Artem Sapegin', license: 'CC0', url: 'https://commons.wikimedia.org/wiki/File:Early_morning_in_autumn_forest_(Unsplash).jpg' }
    },
    {
      id: 'tuntorp-night',
      file: 'assets/photos/tuntorp-night.jpg',
      name: '图恩托普，落雪的夜',
      focus: [0.5, 0.5],
      fogTint: [0.9, 0.9, 0.93],
      fogLight: 0.11,
      room: [1.0, 0.76, 0.5],
      ambient: 0.95,
      credit: { author: 'W.carter', license: 'CC BY-SA 4.0', url: 'https://commons.wikimedia.org/wiki/File:Snowy_night_in_Tuntorp.jpg' }
    }
  ],
  copy: {
    hintTitle: '对着玻璃，哈一口气',
    hintTouch: '长按玻璃也可以',
    hintDesk: '按住空格，或长按玻璃',
    hintMic: '打开麦克风',
    micOff: '麦克风',
    micOn: '麦克风 · 开',
    micAsking: '麦克风 · …',
    micDenied: '没拿到麦克风，长按玻璃也能哈气',
    micUnsupported: '这里用不了麦克风，长按玻璃也能哈气',
    scene: '换一扇窗',
    upload: '用自己的照片',
    uploadName: '你的照片',
    uploadFail: '这张照片读不出来，换一张试试',
    photoBy: '摄影',
    noGl: '当前环境不支持 WebGL，已切换为简化效果'
  }
};
