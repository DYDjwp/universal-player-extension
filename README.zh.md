<div align="center">

# 通用播放器

**Universal Player — 面向多个在线视频平台的自定义播放器扩展**

[![Version](https://img.shields.io/badge/version-1.0.0-2ea44f.svg)](#)
[![Browser](https://img.shields.io/badge/Firefox-Manifest%20V3-FF7139.svg)](#)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)

[English](README.md) | **中文**

通过统一的自定义播放界面替换受支持网站的原生播放器，集成弹幕、观看历史、倍速、画中画、全屏控制以及 HLS 分片检测与流式解包。

</div>

> [!IMPORTANT]
> 本项目是非官方第三方浏览器扩展，与腾讯视频、爱奇艺、芒果 TV、优酷、哔哩哔哩及相关接口服务提供方没有隶属、授权或合作关系。
>
> 本项目不提供、存储或托管任何视频内容，也不保证能够播放会员、付费、DRM、地区限制或其他受访问控制保护的内容。请仅在获得合法授权的前提下使用，并遵守所在地区法律、网站服务条款和内容版权要求。

## 功能概览

### 多平台播放器替换

当前版本支持识别并替换以下播放页面：


| 平台     | 支持范围           | URL 示例或规则                                                     |
| -------- | ------------------ | ------------------------------------------------------------------ |
| 腾讯视频 | 标准剧集播放页     | `https://v.qq.com/x/cover/<cover-id>/<video-id>.html`              |
| 爱奇艺   | 标准视频播放页     | `https://www.iqiyi.com/v_<video-id>.html`                          |
| 芒果 TV  | 节目播放页         | `https://www.mgtv.com/b/<program-id>/<video-id>.html`              |
| 优酷     | 标准视频播放页     | `https://v.youku.com/v_show/id_<video-id>.html`                    |
| 哔哩哔哩 | 番剧季度页和单集页 | `https://www.bilibili.com/bangumi/play/ss<number>` 或 `ep<number>` |

扩展会根据当前 URL 选择对应的网站适配器，再将统一的 `player/index.html` 播放器挂载到原播放器区域。对于会频繁重建播放器 DOM 的网站，扩展使用独立覆盖层并持续跟踪播放器尺寸和位置。

### 自定义播放控制

* 播放与暂停。
* 后退 10 秒、前进 10 秒。
* 当前时间、总时长和可拖动进度条。
* 静音和音量控制。
* 画中画。
* 全屏播放。
* 全屏状态下自动隐藏控制栏；鼠标移动、点击或暂停后重新显示。
* 小尺寸播放器下自动折叠部分次要控件，减少界面拥挤。
* 自动保存上次使用的播放倍速。

支持的倍速：

`0.5×`、`0.75×`、`1.0×`、`1.25×`、`1.5×`、`1.75×`、`2.0×`、`3.0×`

### 弹幕系统

播放器会同时尝试加载两类弹幕：

1. 根据当前视频页面 URL 获取的平台弹幕。
2. 根据弹幕 ID 获取的独立公益弹幕库内容。

主要能力：

* 支持滚动、顶部固定和底部固定弹幕。
* 视频暂停、缓冲、页面隐藏时暂停弹幕动画。
* 播放恢复后按当前视频时间重新同步。
* 拖动进度后清理旧弹幕并从新时间点重新排队。
* 调整播放倍速时同步调整弹幕动画速度。
* 单独开关平台弹幕和独立弹幕。
* 调整不透明度、字体大小、移动速度、显示区域和同屏上限。
* 自定义颜色与字号并发送独立弹幕。
* 弹幕请求失败时不会阻止视频继续播放。
* 弹幕设置保存在 `browser.storage.local`。

### 观看历史与断点续播

* 按规范化后的视频 URL 保存记录。
* 保存播放进度、视频时长、完成百分比、标题、集数、封面和平台信息。
* 播放超过 2 秒后开始产生有效历史记录。
* 再次打开相同视频时显示上次观看位置。
* 点击提示可跳转到上次播放时间。
* 视频播放结束后标记为已看完。
* 独立历史页面按作品分组展示各集进度。
* 点击历史记录可返回原视频页面。
* 支持删除单条记录或清空全部历史。
* 支持将全部观看历史导出为 JSON 备份文件。
* 支持导入兼容的 JSON 备份文件以恢复观看历史。
* 监测扩展本地存储使用率，并在接近容量限制时显示警告。

### HLS 检测与流式解包

播放器会分析解析接口返回的媒体地址，并根据内容类型选择播放模式：

* 普通媒体地址：交给浏览器原生媒体元素播放。
* 标准 HLS：在 Firefox 中通过本地 `hls.js` 播放，不再把 `.m3u8` 直接交给原生 `<video>`。
* PNG 外壳 HLS：检测 PNG 尾部附加的 MPEG-TS 媒体数据，并使用 Media Source Extensions 边下载、边解包、边播放。

流式解包模块包含：

* 播放列表解析和高带宽变体选择。
* 分片内容预检。
* PNG、MPEG-TS 和 fMP4 文件特征识别。
* 最多 4 次单轮请求尝试。
* 后台并发预取与缓冲区控制。
* 跳转后分片预取。
* 失败分片的多轮恢复。
* CDN 重定向地址学习和缓存。
* 失效直连地址刷新。
* 502、503、504、429 等可重试响应处理。
* 播放位置变化后的队列重建和恢复。

当前 PNG 解包模式的已知限制：

* 仅支持 MPEG-TS 分片追加播放。
* 暂不支持 PNG 包装的 fMP4 分片播放。
* 暂不支持加密 HLS。
* 暂不支持 `EXT-X-MAP`。
* 暂不支持 `EXT-X-BYTERANGE`。
* 依赖浏览器对 MediaSource MPEG-TS MIME 类型的支持。

### 设置与界面

设置页面目前提供：

* 自动替换播放器。
* 在同一标签页切换视频或集数时自动重新挂载。
* 开启或关闭观看历史。
* 中文与英文界面切换。
* 纯黑与纯白主题切换。
* 查看本地存储使用情况。
* 打开观看历史页面。
* 重置全部扩展数据。

## 安装

本项目不需要 npm 或构建步骤，但首次加载 Firefox 扩展前需要运行 `tools/download-hls.cmd`，或者手动把 `hls.min.js` 放到 `player/libs/hls.min.js`。

### 从源码安装

1. 下载本仓库源码。
2. 在 Firefox 中打开 `about:debugging#/runtime/this-firefox`。
3. 点击“临时载入附加组件”。
4. 选择项目根目录中的 `manifest.json`。
5. 刷新已经打开的视频页面。

> [!NOTE]
> 对于firefox用户请直接选择压缩包，不要解压

### 更新

1. 用新版本文件覆盖旧项目目录，或重新下载并解压。
2. 打开扩展管理页面。
3. 点击“通用播放器”卡片上的重新加载按钮。
4. 刷新已经打开的视频页面。

更新前建议保留原目录，避免误删尚未导出的观看历史。扩展更新通常不会删除 `browser.storage.local` 中的数据，但删除扩展本身可能导致本地数据丢失。

## 使用方法

### 手动替换

1. 打开受支持的视频播放页。
2. 点击浏览器工具栏中的“通用播放器”图标。
3. 等待扩展识别当前网站和页面结构。
4. 点击“开始替换”。
5. 再次点击操作按钮可恢复网站原播放器。

### 自动替换

1. 打开扩展弹窗。
2. 点击“打开设置”。
3. 开启“自动替换播放器”。
4. 如需在切换集数后自动重新加载播放器，同时开启“自动切换视频”。

### 查看观看历史

1. 打开设置页面。
2. 点击“查看观看历史”。
3. 点击任意记录返回对应视频页面。
4. 使用记录右侧的删除按钮删除单条记录，或点击顶部按钮清空全部历史。
5. 点击“导出历史”将全部记录下载为 JSON 备份文件。
6. 点击“导入历史”并选择兼容的 JSON 备份文件以恢复记录。

## 工作原理

```text
当前标签页 URL
       │
       ▼
shared/site-registry.js
根据 URL 匹配站点和适配器
       │
       ▼
initial.js + content/core.js
注入站点适配器并检测播放器 DOM
       │
       ▼
content/sites/<site>.js
返回挂载目标、尺寸基准和挂载策略
       │
       ▼
player/index.html iframe
加载统一播放器界面
       │
       ├── player/player.js
       │   解析媒体地址、控制播放、保存历史
       │
       ├── player/hls-decoder.js
       │   分析 HLS、预取分片、流式解包
       │
       └── player/danmaku.js
           加载、渲染和发送弹幕
```

后台 Service Worker 负责：

* 注册 Declarative Net Request 动态规则。
* 维护已替换标签页状态。
* 监听标签页更新、激活和关闭事件。
* 根据设置执行自动替换或自动重新挂载。
* 统一读写观看历史。
* 统计本地存储使用情况。

## 权限说明


| 权限                            | 用途                                                             |
| ------------------------------- | ---------------------------------------------------------------- |
| `activeTab`                     | 配合用户在扩展弹窗中的操作访问当前标签页。                       |
| `scripting`                     | 向匹配的播放页面注入核心逻辑和网站适配器。                       |
| `declarativeNetRequest`         | 修改特定解析接口和 HLS 请求所需的请求头。                        |
| `declarativeNetRequestFeedback` | 在开发环境中观察动态网络规则是否匹配。正式发布时可评估是否移除。 |
| `storage`                       | 保存设置、主题、语言、倍速、弹幕设置、替换状态和观看历史。       |
| `tabs`                          | 查询当前标签页、监听页面导航、打开设置页和历史页。               |
| `https://*/*`                   | 识别受支持的视频页面，并请求解析、弹幕、元数据和媒体资源。       |

`https://*/*` 是范围较大的主机权限。虽然当前站点路由只会在明确支持的 URL 上启动播放器替换，但安装前仍建议检查源码并确认你接受这些权限。

## 数据与隐私

### 本地保存的数据

以下数据可能保存在浏览器的 `browser.storage.local` 中：

* 自动替换设置。
* 自动切换设置。
* 是否保存观看历史。
* 中文或英文语言设置。
* 黑色或白色主题设置。
* 上次使用的播放倍速。
* 弹幕显示设置。
* 已替换标签页状态。
* 视频 URL、标题、集数、封面、播放进度、时长和完成比例。

### 外部请求

为了完成媒体解析、弹幕和历史元数据功能，扩展会向第三方服务发送请求，包括但不限于：


| 服务                   | 发送或请求的内容                                    | 用途                                                       |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `data.video.iqiyi.com` | 时间请求                                            | 获取生成解析请求所需的时间值。                             |
| `cache.0567890.xyz`    | 当前视频页面 URL 的编码值和签名参数                 | 获取媒体地址与视频信息。                                   |
| `dmku.hls.one`         | 规范化视频 URL、弹幕 ID、弹幕内容、时间、颜色和字号 | 获取平台弹幕、独立弹幕、标题或集数信息，以及发送独立弹幕。 |

扩展请求中设置了 `credentials: "omit"` 的部分接口不会主动携带第三方 Cookie，但网络服务提供方仍可能根据其自身策略记录 IP 地址、请求时间、User-Agent 或其他常规服务器日志。

当前源码中没有集成独立的统计分析 SDK，但这不代表外部接口不会记录请求。使用前请自行阅读相关服务的隐私政策和使用条款。

## 添加新的网站适配器

### 1. 创建适配器文件

复制 `content/sites/_template.js`，例如：

```text
content/sites/example.js
```

适配器至少需要：

* 唯一的 `id`。
* 网站显示名称。
* URL 匹配逻辑。
* 播放器 DOM 查找逻辑。
* `detect()` 方法。
* 挂载目标 `target`。
* 尺寸参考元素 `sizeHost`。
* 原始页面地址 `sourceUrl`。

简化示例：

```js
(() => {
  "use strict";

  const api = globalThis.VideoPlayerReplacer;
  const ADAPTER_ID = "example";

  if (!api || api.hasAdapter(ADAPTER_ID)) return;

  api.register({
    id: ADAPTER_ID,
    name: "Example Video",

    async detect() {
      const target = document.querySelector(".video-player");

      if (!(target instanceof HTMLElement)) {
        return {
          supported: false,
          code: "UNSUPPORTED_STRUCTURE",
          message: "未找到播放器容器"
        };
      }

      return {
        supported: true,
        message: "已找到播放器容器",
        context: {
          target,
          sizeHost: target,
          sourceUrl: location.href
        }
      };
    }
  });
})();
```

### 2. 注册站点路由

在 `shared/site-registry.js` 中添加：

```js
Object.freeze({
  id: "example",
  name: "Example Video",
  adapterScript: "content/sites/example.js",

  getPageKey(urlString) {
    const url = new URL(urlString);
    return `${url.origin}${url.pathname}`;
  },

  matches(urlString) {
    const url = new URL(urlString);
    return url.hostname === "video.example.com";
  }
})
```

### 3. 测试

重点测试：

* 初次打开页面时能否识别。
* 网站播放器延迟加载时能否等待到目标 DOM。
* 原播放器是否真正暂停并隐藏。
* 页面滚动和窗口缩放后覆盖层是否仍对齐。
* 切换集数或单页应用路由后是否重新挂载。
* 恢复原播放器后页面结构和样式是否正常。
* 全屏、画中画、历史保存和弹幕是否正常。

## 调试

### 扩展后台日志

1. 打开 `chrome://extensions/`。
2. 找到“通用播放器”。
3. 点击 Service Worker 对应的“检查视图”。
4. 查看网络规则注册、自动替换和历史存储日志。

### 页面适配器日志

1. 在目标视频页面按 `F12`。
2. 打开 Console。
3. 搜索 `Universal Player`、`VideoPlayerReplacer` 或站点适配器相关信息。

### 播放器 iframe 日志

播放器运行在扩展 iframe 中。可在开发者工具的 JavaScript 上下文下拉菜单中切换到 `player/index.html`，再查看：

* 媒体解析结果。
* HLS 检测模式。
* 分片请求和重试。
* MediaSource 状态。
* 弹幕加载和发送状态。
* 观看历史保存错误。

播放器初始化后还会暴露只读调试对象：

```js
UniversalPlayer
UniversalPlayer.getLogs()
UniversalPlayer.playbackState
UniversalPlayer.playbackState.prepared?.getStats?.()
```

## 常见问题

### 当前网页不支持

可能原因：

* 当前 URL 不符合支持规则。
* 网站修改了播放器 DOM 结构。
* 页面仍在加载，播放器容器尚未出现。
* 当前页面不是正式播放页。

请刷新页面后重试，并在 Issue 中附上完整 URL、浏览器版本和控制台错误。

### Media Chrome 未加载

确认以下文件存在：

```text
player/libs/media-chrome.js
```

当前源码包已经包含该文件，不需要另外运行安装脚本。若文件缺失，请重新下载完整仓库，而不是单独复制部分文件。

### hls.js 未加载

Firefox 桌面版不会可靠地把 `.m3u8` 直接作为 `<video src>` 播放。标准 HLS 分支需要：

```text
player/libs/hls.min.js
```

运行：

```text
tools/download-hls.cmd
```

下载完成后，在 `about:debugging` 中重新加载扩展并刷新视频页面。不要在扩展 HTML 中直接引用远程 CDN 脚本。

### 接口返回 403

这通常表示第三方解析服务拒绝了当前请求、网络或 IP。扩展本身无法保证外部服务可用。请稍后重试、切换网络，或联系对应接口服务提供方。

### 接口返回 502、503 或 504

播放器会自动进行有限次数的重试。持续失败通常说明解析服务、CDN 或目标分片暂时不可用。可尝试：

* 等待后刷新页面。
* 恢复原播放器后重新替换。
* 检查浏览器 Network 面板中的失败 URL。
* 确认不是单个 HLS 分片长期失效。

### 视频有声音但没有画面，或出现 MediaError 4

可能原因：

* 浏览器不支持对应编码。
* MediaSource 不支持当前 MPEG-TS MIME 类型。
* 分片实际是 fMP4、加密 HLS 或其他暂不支持的格式。
* PNG 外壳中没有找到有效媒体数据。

请在 Issue 中附上 `UniversalPlayer.playbackState` 和解包统计信息，但不要公开包含个人令牌、Cookie 或授权参数的完整私有地址。

### 无法自动播放

浏览器可能因为自动播放策略阻止带声音的视频自动开始。手动点击播放按钮即可。扩展不会尝试绕过浏览器的用户交互限制。

### 观看历史没有保存

检查：

* 设置中是否开启“保留观看历史”。
* 视频是否已实际播放超过 2 秒。
* 扩展本地存储是否接近上限。
* Service Worker 是否出现通信错误。
* 是否删除或重新安装过扩展。

## 已知限制

* 网站 DOM 结构变化可能导致适配器失效。
* 播放能力依赖第三方解析接口、弹幕接口和 CDN。
* 不支持所有视频页面、直播页面、短视频页面或用户上传页面。
* 标准 HLS 依赖本地 `player/libs/hls.min.js` 和 Firefox 的 Media Source Extensions。
* PNG 解包目前主要面向 MPEG-TS 分片。
* 不处理 DRM 解密，也不应被用于绕过付费或访问控制。
* 外部接口域名、参数或签名算法变化后可能需要更新代码。
* 当前使用范围较大的 HTTPS 主机权限。
* 当前没有自动化测试和持续集成流程。

## 贡献

欢迎提交 Issue 和 Pull Request。

### 提交 Issue 前

请尽量提供：

* 浏览器名称和完整版本。
* 扩展版本。
* 操作系统。
* 发生问题的平台和页面类型。
* 可公开的复现步骤。
* Console 错误。
* Service Worker 错误。
* 相关 Network 请求状态码。
* 是否可以稳定复现。

请删除或遮盖：

* Cookie。
* 登录令牌。
* 个人账号信息。
* 带签名的私有媒体 URL。
* 任何能够访问受保护内容的授权参数。

### 提交 Pull Request

1. Fork 本仓库。
2. 从最新主分支创建功能分支。
3. 保持代码风格与现有项目一致。
4. 仅修改与当前功能相关的文件。
5. 测试所有受影响的平台。
6. 在 Pull Request 中说明修改动机、实现方式和测试结果。

建议的分支名称：

```text
feature/add-example-adapter
fix/hls-segment-retry
refactor/history-storage
```

建议的提交信息：

```text
feat: add example video adapter
fix: recover from expired HLS redirect
docs: update installation guide
```

## 第三方组件

本项目包含或使用以下第三方开源组件：

* [Media Chrome](https://github.com/muxinc/media-chrome)，当前固定版本为 `4.19.2`，使用 MIT License。
* [CryptoJS](https://github.com/brix/crypto-js)，使用 MIT License。
* [hls.js](https://github.com/video-dev/hls.js)，当前固定版本为 `1.6.16`，使用 Apache License 2.0。

第三方组件仍受各自原始许可证约束。详细信息请参阅 `THIRD_PARTY_NOTICES.md` 以及第三方项目自身的许可证文件。

## 免责声明

本软件按“原样”提供，不附带任何明示或暗示的保证。项目维护者不对以下情况承担责任：

* 外部接口停止服务、限流、封禁或改变行为。
* 网站更新导致扩展失效。
* 播放失败、数据丢失或观看历史损坏。
* 使用本项目造成的账号限制、服务条款争议或法律风险。
* 用户通过本项目访问、传播或使用未经授权的内容。
* 第三方接口、媒体资源或弹幕内容的准确性、合法性和安全性。

用户应自行判断其使用方式是否合法并承担相应责任。

## 许可证

本项目建议采用 **GNU General Public License v3.0 or later**：

```text
GPL-3.0-or-later
```

你可以自由使用、研究、修改和分发本项目；但当你向他人分发本项目或其修改版本时，需要按照 GPL 的要求提供对应源代码，并在兼容条件下继续使用相同许可证。

完整条款见 [LICENSE](LICENSE)。
