# Stripe 托管 Sandbox 适配：Issue #73

状态：本地实现、离线验证与独立审查完成，待准确 head CI/PR 收口；前置 #72 已合并，main `3333576` / CI108 通过。当前仍不能付款。本片不读账户凭据、不接路由、不调用服务商、不改订单或库存。

## 交付边界

交付同一个 Stripe 适配模块的创建、读取、关闭 Checkout Session 和原始 Webhook 验签能力，只在显式注入配置与 HTTP transport 后可使用。没有隐式 global fetch、环境变量、SDK 初始化或普通 runner 开关；未导入消费者，现有顾客页面保持无付款提示。测试 transport 只返回合成数据。

调用者必须来自后续受审查的服务端订单流程：已授权会话、已持久化的原付款操作键、不可变订单金额与归属、仍受保护的库存。适配模块不查询这些商业数据，不能自行授予付款或库存操作权限。不能把它接受一个参数理解为该参数已获业务授权。

仅接受固定 CAD、信用卡、一次性付款；显式测试配置拒绝 live key，服务商返回还须匹配测试模式和预期账户。API 地址固定为 Stripe 官方域名，回跳由可信 loopback origin 与订单路径产生；不接受顾客传入的金额、API URL、回跳 URL 或任意附加参数。不发送真实姓名、地址、邮箱、卡号或 CVV。

创建请求明确关闭 `adaptive_pricing`，避免继承 Sandbox 后台的自动换汇设置；仅校验返回的 integration CAD 金额不足以证明顾客呈现币种。[官方说明](https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing?payment-ui=stripe-hosted)确认 Sandbox 与 inline price_data 也可使用该能力。实际顾客呈现与配置仍需 Sandbox 验收。

创建、查询、到期结果分开；即使验签成功，返回页、Session completed、单个事件或事件 ID 都不能直接将订单改为 paid。后续必须核对账户/环境、订单与尝试、金额/币种、实际收款状态，持久去重并裁决库存。当前签名验证不保存收件箱、不提供重放去重或事件处理。

实现位于 `app/lib/commerce/stripe-sandbox.server.ts`：三个 Session 操作与独立 Webhook 验证；结果仅投影受限字段及 `paymentIntentId`，paid 投影必须带合法未展开的 `pi_` 引用。每个 HTTP 操作先核对同凭据的账户，没有后台缓存或切换账户 header。调用者保存 `sessionExpiresAt` 为 Unix 秒，clock 返回毫秒；剩余不足 30 分钟时新建调用保守返回 reconcile_required，不偷偷延长原期限/换键。Webhook 同一事件再次验签可成功，必须由后续持久消费者去重。

## 超时、原键与预留期限

HTTP 请求有时限和响应体大小上限，禁止重定向及自动重试；错误仅输出受限分类，不输出凭据、原始服务商响应或私有付款 URL。创建结果不明时保留原操作键与参数，不能为了重试生成新键。适配器不替调用者实现持久幂等或跨系统恰好一次。

Stripe 的 [Session expires_at](https://docs.stripe.com/api/checkout/sessions/create) 当前要求创建后 30 分钟至 24 小时；本地订单现有 10 分钟期限不是可直接传入的值。后续接线必须在派发前持久保护可能收款的订单，停止盲目取消/释放，提供查询和关闭后的核对恢复。只收到返回取消或本地时间到期均不足以释放付款中的库存；本片不会修改该期限或启用派发。

[Stripe 幂等](https://docs.stripe.com/api/idempotent_requests) 是有限服务商保证，不能代替本地永久日志。固定参数包含原键、原金额/关联与原 Session 到期参数；不在重放时用新的时钟生成不同请求参数。实际过期键、网络丢响应和服务商报错的恢复仍需 Sandbox 验证。

## 验证与完成定义

- 离线检查覆盖请求方法/固定目标/版本/参数、测试账户、错误币种金额或关联、live 模式、无配置/未知结果、超时、大小限制与敏感资料不外泄。
- 原始字节签名覆盖有效、错误、过旧/未来时间、body 改动和多签名；同一已验签事件再次验证仍是签名验证成功，不冒充持久去重。使用 Web Crypto HMAC 校验，不声称手写字符串比较具备恒定时间保证。
- 适当的格式、lint、类型、测试、生产构建、支付边界独立审查及准确 head CI 完成后才合并。测试结果和实现契约以实际完成的执行记录为准。
- 关闭/回滚是保持无消费者、不配置/不导入；保留已有订单/付款/库存记录。不降级迁移、不删金融历史，不影响已有查询或取消。

## 紧接的订单接线与经营者操作

下一项直接将此适配接到共享订单及私有状态页面，必要的旧零税/fixture 限制兼容与 forward migration 随接线功能审查，不另造支付账本。覆盖托管付款发起、固定返回、可靠核查/验签事件、收款与库存分配，并始终区分待处理、失败、未知和已核实收款。PayPal 在此契约稳定后接入。

经营者回来后准备专用 [Stripe Sandbox](https://dashboard.stripe.com/) 与 [PayPal Developer/Sandbox](https://developer.paypal.com/dashboard/) 账户资格；届时再按已完成的安全本机配置流程输入测试凭据。不要在聊天、Issue、PR 或仓库里粘贴密钥、密码或银行卡资料。测试账户连接不授权正式支付、计费购买、生产资源或部署。没有凭据和授权前，真实服务商、认证/拒绝/退款及完整收款→本站订单/库存验收都保持未完成。

官方核对日期 2026-10-30：[托管 Checkout](https://docs.stripe.com/checkout/quickstart)、[创建 Session](https://docs.stripe.com/api/checkout/sessions/create)、[关闭 Session](https://docs.stripe.com/api/checkout/sessions/expire)、[Webhook 原始签名与投递](https://docs.stripe.com/events/manage-webhook-endpoints)、[API 版本](https://docs.stripe.com/api/versioning)。建议固定该日文档版本 `2026-10-28.endive`，实际配置和事件版本还须 Sandbox 核对；本文不固化费用、法律或税务结论。
