# @magpie-community/opencode-loomy-auth

[OpenCode](https://opencode.ai) / [magpie](https://usemagpie.ai) provider 插件：**Loomy（讯飞，`loomyad.xunfei.cn`）**——登录、密码账号自动续登、模型清单、聊天转发、双积分钱包与每日赠送积分刷新（签到）。

请求形态移植自 [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api)（MIT）的 `providers/loomy`，按 magpie 插件 API 重写。

## 安装

```
magpie plugin add @magpie-community/opencode-loomy-auth
magpie plugin login loomy     # 选「账号密码登录」「短信验证码登录」或「手动粘贴 session」
```

## 能力

- **登录**：`账号密码登录`（无人值守，可自动续登）、`短信验证码登录`（发码 → 输入 6 位码完成）或 `手动粘贴 session`。session 有效期 **14 天**。
- **续登**：Loomy 没有 refresh token，session 只有 14 天，唯一能续期的凭据是密码。因此**密码登录的账号会自动续登**：magpie 在到期前 3 天调 `auth.refresh` 重新登录（每账号一次）；OpenCode 不调这个钩子，所以请求路径上也会兜底——网关返回 401/403 时自动重登一次并重发该请求（响应带 `X-Magpie-Sign-In: renewed`）。**短信登录与粘贴 session 的账号没有密码，无法续登**，仍和以前一样需要重新登录。
- **凭据存储**：密码登录时手机号与密码以 JSON 形式存进 magpie 的 `plugin-auth.json`（`settings.Dir()/plugin-auth.json`，权限 600），**明文，不是加密保险库**——和浏览器保存密码是同一级别的信任模型。不接受这一点就别用密码登录。续登逻辑独立在同目录的 `renew.mjs`，便于与上游 `index.mjs` 分别合并。
- **聊天**：`POST {modelBase}/chat/completions`，OpenAI 形态基本透传，两处适配（参照实现 `reasoning_patch` / `images.rs`）：思考档折进 low/medium/high（超档删除）、DeepSeek 系模型的 data-URI 图片转 `<image_base64>` 标记；SSE；请求头必须带 `charset=utf-8`（上游对无 charset 的 body 按 GBK 解码）。
- **画图**：`POST {modelBase}/images/generations`（doubao-seedream-5-lite / qwen-image-3.0-pro / Hy-Image-3.5-preview），body 按 magpie 写的原样透传，`Accept: application/json`（不是 SSE），回答是普通 JSON（`data[].url`、`points_consumed`）。401/403 报登录失效。`/images/edits`（改图）暂不转发：magpie 发给插件的改图是 multipart，Loomy 网关收不收这种改图没有实测过（#609）。
- **模型**：登录前给静态表（2026-10-16 实抓 `/api/v1/models` 的 chat 模型：DeepSeek-V4.1-Flash / deepseek-v4-flash-0731 / MiniMax-M3 / Kimi-k2.6 / qwen-3.8-max / GLM-5.3-Flash / qwen3.8-flash / spark-x / mimo-v2.5 / auto），登录后以 `GET /api/v1/models` 的实时目录为准（能力位读 `capabilities`；展示名尾部倍率 `(x3.0)` 拆为 rate 字段）。
- **余额（usage）**：`GET /api/v2/points/records?...` → 永久积分 + 每日赠送积分两个窗口；每日窗口用厂商自己的 `dailyLimitPoints`/`dailyRemainingPoints` 报「已用/剩余/上限」，厂商未带这一对时按无上限的余额展示（不编造上限）。响应缺余额字段时报 error（"未知"不冒充 0）。
- **签到判定**：`first-login` 接口对"当天首登"与"重复调用"都返回成功，插件用调用前后的每日余额差判定——涨了 = `claimed`（今日首登奖励），没涨 = `done`（已领过/无每日钱包）。
- **每日签到（checkin）**：`POST /api/v1/points/first-login`（body `{}`）——服务端按"当天是否第一次"把每日赠送刷回；按天幂等，重复调=成功。这是厂商客户端自己就会发的那个单请求（判定见上）。

## 账号域签名说明

账号域的每个请求都带 HMAC-SHA1 签名头（9 段待签串，AK/SK 为客户端内置常量），插件按参照实现同款实现（见 `index.mjs` 的 `signHeaders`）。走的接口有四个：短信登录两步（`/login/phone/sendMsgCode`、`/login/phone/checkCode`）与密码登录两步（`/login/account/getPuKey`、`/login/account/byPwd`，见下一节）。

## 密码登录与续登（`renew.mjs`）

Loomy 的密码登录分两步，全程无人值守（`rcode` 是服务端下发的 nonce，不是验证码）：

```
POST /login/account/getPuKey → { pukey: base64 DER 公钥, rcode }
POST /login/account/byPwd    → { session, userid, phone }
     body: { loginid, password: RSA_PKCS1v15(pukey, 明文密码), rcode, type: 1, expire: 1209600 }
```

密码封在 `getPuKey` 当场下发的 RSA 公钥里（PKCS#1 v1.5，`node:crypto` 的 `publicEncrypt`，无新依赖）。公钥可能是 SPKI 也可能是裸 PKCS#1，base64 可能缺 padding，两种都兼容。

续登有两条路，缺一不可：

| 路径 | 触发 | 说明 |
|---|---|---|
| `auth.refresh` | magpie，到期前 `refreshLead`=3 天 | 每账号一次，返回值由 magpie 自己存 |
| 请求路径兜底 | 网关 401/403 | OpenCode 不调 `auth.refresh`，只能在这里救；重登一次后重发，响应带 `X-Magpie-Sign-In: renewed` |

同一账号的并发重登由单飞（`Map` 按手机号去重）挡住，不会两次登录把前一个 session 作废。

「密码错」用业务码判定（HTTP 200 + 非 `000000` = 服务端明确拒绝 → 标记登出）；网络错误、5xx 一律只 throw 不标记，避免抖动把好账号标死。

## 环境变量（测试 / 镜像用，与 agent2api 同名）

| 变量 | 默认 |
|---|---|
| `LOOMY_XFYUN_BASE_URL` | `https://account.xfinfr.com`（登录域，HMAC 签名；来自客户端安装包 `app.asar` 内解密的 `.env.prod` 的 `VITE_XFYUN_BASE_URL`，是讯飞账号域 CAccount 自己的 host） |
| `LOOMY_POINTS_BASE_URL` | `https://loomyad.xunfei.cn`（积分/签到/模型网关） |

## 测试

```
bun test packages/loomy
```

测试打到本地假上游（`fake.mjs`），不触网、不使用真实 token。

## 许可

MIT。请求逻辑移植自 aimod-cc/agent2api（MIT）。
