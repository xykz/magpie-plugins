# magpie-image-webp

Magpie 网关 hook：把请求里的内联图片转成 WebP 并按宽度降采样，减少上行字节和首 token 等待。

## 为什么

无状态 HTTP + base64 内联，网关必须收完整个 body 才能转发；同一张 2560×1600 截图每轮重发约 4.1 MB。上行只有 6 Mbps 时，首 token 被拖到 8–12 秒，而压缩发生在网关内部，不改变任何客户端行为。

实测（`agents: ["dsh"]`，1600px / q85）：

| 位置 | 请求体 | 首 token |
|---|---|---|
| 腾讯云网关（sharp） | 3.93 MB → 293 KB | 9.25 s → 2.6–3.1 s |
| 本机 Mac（cwebp） | 3.93 MB → 280 KB | 3.7–4.0 s |

本机到上游首 token 由 provider 主导，压图收益小；收益主要在多历史图、慢上行和按字节计费的 provider。

## 行为

- 只改 `data:image/...;base64,...` 形式的图片，覆盖 chat 和 responses 两种协议的请求体。
- 已压缩更大时保留原图；单张小于 `min` 字节的图不处理。
- 只处理 `agents` 列出的 agent；`agents: []` 表示全部。
- 任何异常、编码器缺失、超时都 fail-open：请求原样转发。
- 改完的图片统一在全部压缩结束后写回请求体，不会留下半改状态。

当前不支持 Anthropic 的 `source.data` 与 Gemini 的 `inlineData.data`（它们的 base64 不是 data URL，替换时还要改 `media_type` / `mimeType`）。这两条路径尚未对上游做 WebP 兼容性验证，见路线图。

## 安装

仓库尚未发布到 npm。在 Magpie 的 Plugins 页面把本仓库的 `image-webp.hooks.mjs` 加为本地 hook，或手写条目：

```json
{
  "spec": "/absolute/path/to/image-webp.hooks.mjs",
  "options": {
    "agents": ["dsh"],
    "width": 1600,
    "quality": 85,
    "max": 4,
    "min": 131072,
    "gatewayTimeoutMs": 5000
  }
}
```

安装后重启网关或用 `--force-recreate` 让 hook 生效。插件名就是 hooks 文件的路径，`magpie plugin options image-webp` 会报 no plugin。

## 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `agents` | `["dsh"]` | 生效的 agent；空数组表示全部 |
| `width` | `1600` | 最大宽度（px），只会缩小，不会放大 |
| `quality` | `85` | WebP 质量，1–100 |
| `max` | `4` | 每请求最多处理几张图 |
| `min` | `131072` | 原图小于该字节数时跳过 |
| `gatewayTimeoutMs` | `5000` | 本 hook 的执行预算，magpie 侧限制在 100–30000 ms |

## 编码后端

按顺序探测，第一个可用的胜出：

1. **sharp**：同目录装有 `sharp` 时使用，跨平台，自带 EXIF 旋转与宽度探测。
2. **cwebp**：PATH 里的 `cwebp`，或环境变量 `IMAGE_WEBP_CWEBP` 指定的路径。宽度由内置的 PNG/JPEG 头解析得出；未知格式不带 `-resize`，仍尝试转码。
3. 都没有：打印一条警告并跳过，请求原样转发。

默认零依赖。要用 sharp 时在 hooks 文件同目录执行 `bun add sharp`。

## WASM 后端实测

2026-11-20 在 Bun 1.4.4 上验证 `@jsquash/png` + `@jsquash/resize` + `@jsquash/webp`（1.5.0 / 3.1.1 / 2.1.1），尚未接入 `lib/backends.mjs`。单张图片，q85，Apple Silicon：

| 样本 | WASM 冷 / 热 | sharp | cwebp | 输出 | WASM 峰值 RSS |
|---|---|---|---|---|---|
| 1600×1000 截图样张（58 KB PNG） | 85 / 63 ms | 42 ms | 50 ms | 12.5 KB | 143 MB |
| 2560×1600 噪声 → 1600（16.4 MB PNG） | 516 / 461 ms | 278 ms | 280 ms | 2.5 MB | 384 MB |

- 冷启动的 wasm 实例化包含在首张耗时内，没有额外初始化开销。
- 4 张 2560 图一轮耗时 1.84 s，在 5 s 预算内，但只剩约 3 s 余量。
- 编码体积比 native 大约 5%（噪声样本）；截图样张两者一致。
- 宽度已达标时调用 resize 仍需 117–125 ms，后端必须跳过同宽 resize。
- 不加干预时 RSS 每张上涨约 40 MB（2560）或 10 MB（1600）；每轮调用 `Bun.gc(true)` 后稳定在 296 MB / 118 MB，单次 GC 约 18 ms，相对 450 ms 的压缩成本可忽略。

结论：WASM 可以作为默认后端，但需要配合 GC 与 resize 跳过；sharp 仍是快 1.7 倍、省 2.8 倍内存的可选加速。

## 开发

```sh
bun test
```

测试用确定性噪声生成 PNG，并像网关一样直接调用 `onRequest`。压缩相关用例在缺少 `cwebp` 与 `sharp` 的机器上跳过。

## 路线图

- [ ] `lib/protocols.mjs` 增加 Anthropic / Gemini 图片字段，先补 `cases.json` 再实现
- [ ] 上游 WebP 兼容矩阵：yescode、Gemini、Anthropic 原生路径各测一次，必要时按 provider 回退 JPEG
- [ ] 按 sha256 前缀的 LRU 缓存，避免历史图每轮重压
- [ ] 图形化 options 表单（page 插件）
- [ ] 发布 npm，并提 PR 到 `magpie-community/plugins`（命名为 `@magpie-community/gateway-image-webp`）

## 许可

MIT
