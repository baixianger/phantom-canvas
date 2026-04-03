<p align="center">
  <img src="https://raw.githubusercontent.com/baixianger/phantom-canvas/main/logo.png" width="128" alt="Phantom Canvas logo" />
</p>

<h1 align="center">Phantom Canvas</h1>

<p align="center"><strong>Gemini 图片生成的 CLI + HTTP API — 专为 AI Agent 打造</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/phantom-canvas"><img src="https://img.shields.io/npm/v/phantom-canvas?color=cb3837&logo=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/phantom-canvas"><img src="https://img.shields.io/npm/dm/phantom-canvas?color=cb3837" alt="npm downloads" /></a>
  <a href="https://github.com/baixianger/phantom-canvas/blob/main/LICENSE"><img src="https://img.shields.io/github/license/baixianger/phantom-canvas" alt="license" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/runtime-Node.js-339933?logo=nodedotjs" alt="Node.js" /></a>
</p>

<p align="center">
  <a href="https://github.com/baixianger/phantom-canvas/blob/main/README.md">English</a> |
  <a href="https://github.com/baixianger/phantom-canvas/blob/main/README.zh-CN.md">中文</a>
</p>

把免费的 [Gemini](https://gemini.google.com) 网页界面变成可编程的 **CLI 工具和 HTTP API**，用于图片和视频生成。无需 API 密钥、无需付费 — 只需你的 Google 账号。

<p align="center">
  <img src="https://raw.githubusercontent.com/baixianger/phantom-canvas/main/diagram.png" width="700" alt="你的应用 / AI Agent → CLI 或 HTTP → Phantom Canvas → Chrome → Gemini 网页" />
</p>

**两种使用方式：**
- **CLI** — `phantom-canvas generate "prompt" -o output.png` 适合脚本和 AI Agent 调用
- **HTTP API** — `phantom-canvas serve` 适合应用和流水线集成

后台运行一个持久化的 Chrome 浏览器（通过 CDP），自动操作 Gemini 网页界面。Phantom Canvas 处理剩下的 — 输入文字、上传参考图、等待生成、下载全尺寸原图（1024px）。

已经在用 Gemini Advanced？把你的订阅变成私有图片生成 API。

基于 **Node.js + Playwright + Hono + Chrome CDP** 构建。

## 快速开始

```bash
# 安装
bun add -g phantom-canvas    # 或：npm install -g phantom-canvas

# 生成图片（Chrome 自动启动，无需配置）
phantom-canvas generate "像素风骑士，等距视角，绿色 #00FF00 背景"

# 启动 HTTP API 服务
phantom-canvas serve

# 第一次使用：在弹出的 Chrome 窗口中登录 Google
# 之后一切自动 — 登录状态持久化
```

## 命令

| 命令 | 说明 |
|---|---|
| `phantom-canvas chrome` | 手动启动 Chrome（通常不需要） |
| `phantom-canvas generate "prompt"` | 单次生成 |
| `phantom-canvas serve` | 启动 HTTP API 服务 |

### 生成选项

| 参数 | 说明 |
|---|---|
| `--ref <file>` | 参考图（图生图） |
| `--video` | 生成视频而非图片 |
| `-o, --output <file>` | 输出文件路径 |
| `--conversation <id>` | 继续之前的对话 |
| `--timeout <secs>` | 超时时间（默认：图片 180 秒 / 视频 300 秒） |
| `--headed` | 显示浏览器窗口（默认无头模式） |
| `--cdp <url>` | Chrome DevTools 地址（默认 http://127.0.0.1:9222） |

## API

### `POST /generate`

提交图片或视频生成任务，立即返回任务 ID。

```bash
# 图片
curl -X POST localhost:8420/generate \
  -d '{"prompt": "像素风骑士，等距视角，绿色 #00FF00 背景"}'

# 带参考图（图生图）
curl -X POST localhost:8420/generate \
  -d '{
    "prompt": "同一个角色的 4 个方向，2x2 网格",
    "reference_images": ["/path/to/sprite.png"]
  }'

# 视频
curl -X POST localhost:8420/generate \
  -d '{"prompt": "骑士原地走路循环", "type": "video", "timeout_secs": 300}'
```

**参数：**

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `prompt` | string | 必填 | 生成提示词 |
| `type` | `"image"` \| `"video"` | `"image"` | 输出类型 |
| `reference_images` | string[] | — | 本地文件路径，作为参考上传 |
| `num_images` | number | 1 | 生成图片数量 |
| `timeout_secs` | number | 180 / 300 | 超时（图片 / 视频） |
| `callback_url` | string | — | 完成后回调的 Webhook URL |

### `GET /task/:id`

查询任务状态。

```json
{
  "task_id": "abc123",
  "status": "completed",
  "images": [{"index": 0, "url": "/task/abc123/image/0", "type": "image"}],
  "elapsed_secs": 45.3
}
```

### `GET /task/:id/image/:index`

下载原始文件（图片或视频）。

### `GET /health`

服务状态。

### `POST /session/refresh`

重新加载 Gemini 页面。

### `POST /debug/eval`

在浏览器中执行 JS（调试用）。

### `GET /debug/screenshot`

截取浏览器页面为 PNG。

## 工作原理

1. **启动 Chrome** — 通过 CDP 连接，使用持久化用户目录（`~/.phantom-canvas/chrome-profile`）
2. **导航到 Gemini** — 复用已登录的会话
3. **输入 prompt** — 自动填入 Gemini 的输入框
4. **等待生成** — 监控页面上新的 `<img>` 元素
5. **提取全尺寸原图** — 通过 `canvas.drawImage()` → `toDataURL()` 绕过 blob URL 限制
6. **返回结果** — 保存为本地 PNG 文件

## 游戏资产生成

专为 AI 游戏资产生成设计 — 无需付费 API 即可创建像素风精灵图。

```bash
# 锚点精灵
curl -X POST localhost:8420/generate \
  -d '{"prompt": "东南朝向等距像素风骑士，FFT 风格，#00FF00 背景"}'

# 四方向（带参考图）
curl -X POST localhost:8420/generate \
  -d '{"prompt": "2x2 网格：北、东、南、东南方向的同一角色", "reference_images": ["anchor.png"]}'

# 行走动画
curl -X POST localhost:8420/generate \
  -d '{"prompt": "循环行走动画", "reference_images": ["anchor.png"], "type": "video"}'
```

**提示：** 使用 `#00FF00` 纯绿背景而不是"透明背景" — Gemini 会把透明理解为棋盘格图案。绿幕在后期处理中很容易抠除。

## 限制

- Gemini 有每日生成配额（视频尤其有限）
- 同一时间只能处理一个请求（串行队列）
- 会话 Cookie 会定期过期 — 用 `phantom-canvas chrome` 重新登录
- 图片分辨率由 Gemini 决定（通常 1024px）
- 无头模式可用，但生成速度可能较慢

## 许可证

MIT
