# 本机试接 Stripe 与 PayPal

**状态：仅供体验支付服务商的测试流程；不是商店结账功能** · **2026-10-16**

这项原型在本机 `127.0.0.1:8789` 运行，使用一件**虚构的 CAD $1.00 商品**。Stripe 使用测试模式的托管 Checkout；PayPal 使用 Sandbox 的订单批准与捕获。原型不读写商品 D1/R2，不建立网站订单，不计算税费或运费，不部署到 Preview 或正式网站，不能用于真实销售。后续商业阶段已选择 C；本原型仅供学习，不是 C 路线的开工前提或完成证据，实施顺序见 [实施方案](./ONLINE_SALES_IMPLEMENTATION_PLAN.md)。

## 启动

1. 如果尚无账户，先分别注册 [Stripe](https://dashboard.stripe.com/register) 和 [PayPal Developer](https://developer.paypal.com/dashboard/)；只使用测试 / Sandbox 环境，无需现在开通正式收款。在 Stripe Dashboard 测试模式取得 `sk_test_` 密钥；在 PayPal Developer Dashboard 的 Sandbox 应用取得 Client ID 和 Client Secret。PayPal 还需要一个 **Sandbox Personal 买家账户**；不要用真实 PayPal 账户付款。[Stripe 测试说明](https://docs.stripe.com/testing)、[PayPal Sandbox 账户说明](https://developer.paypal.com/sandbox-testing/accounts)。
2. 在仓库根目录创建 `.env.payment-spike`，填入需要测试的服务商：

   ```dotenv
   STRIPE_SECRET_KEY=sk_test_替换为你自己的测试密钥
   PAYPAL_CLIENT_ID=替换为Sandbox应用的ClientID
   PAYPAL_CLIENT_SECRET=替换为Sandbox应用的ClientSecret
   ```

   只测一家时删去另一家的字段。这个文件被 `.gitignore` 的 `.env.*` 规则忽略。**不要把密钥发到聊天、截图、GitHub 或网页；只在本机文件中填写。** 不要放任何 `sk_live_` 或 PayPal 正式环境密钥。可选端口字段为 `PAYMENT_SPIKE_PORT=8789`。

3. 在仓库根目录运行 `npm run payment:spike`，打开 [http://127.0.0.1:8789](http://127.0.0.1:8789)。即使还没有账户，也能先打开本机页面；相应按钮会保持不可用，直到填好该服务商的测试凭据。
4. Stripe 仅使用[官方测试卡号](https://docs.stripe.com/testing)，例如 `4242 4242 4242 4242`；到期日用未来日期，CVC 用任意三位数。PayPal 使用 Sandbox Personal 买家账号登录。不要输入真实卡资料。
5. 完成后回到本机页查看服务商返回的测试结果。Stripe 页面会重新查询 Session 的付款状态；PayPal 页面会让你明确点击一次 **Capture Sandbox payment**，然后核对捕获状态。这些状态只用于体验，**不会在网站生成订单或触发备货、发货**。
6. 终止本机程序用 `Ctrl+C`。试用结束后可删除 `.env.payment-spike`，也可在两个服务商后台清理测试记录。

## 比较时记录

| 观察项                                     | Stripe | PayPal |
| ------------------------------------------ | ------ | ------ |
| iPhone / 桌面跳转和付款是否清晰            |        |        |
| 顾客取消或付款失败后发生什么               |        |        |
| 小姨在商家后台找到交易、退款和对账是否容易 |        |        |
| 加拿大商家账户、手续费与付款方式是否适合   |        |        |

## 真实商店仍缺少的部分

此原型刻意没有购物车、地址、库存预留、税费、运费、订单持久化、通知、退款界面、Webhooks 和对账。对真实商店来说，浏览器返回成功页不足以确认收款；还需验证服务商通知或服务端查询结果、去重并维护订单状态。Stripe [建议通过服务器端事件处理履约](https://docs.stripe.com/payments/checkout/fulfillment)，PayPal [提供 Webhook 签名验证流程](https://developer.paypal.com/api/rest/webhooks/rest/)。这也是为什么本次试用不应直接接到公开的 V1 目录站。
