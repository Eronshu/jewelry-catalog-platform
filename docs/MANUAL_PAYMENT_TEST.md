# 首轮人工测试：下单与测试付款

**本轮只试顾客端。** 开发者准备好隔离测试程序后会给你 `http://127.0.0.1:8803/products/fictional-0`。在运行程序的这台Mac上打开；你不需要开终端。手机上的127.0.0.1指向手机自己，因此这个地址不能用于另一台手机。原5193页面只是展示，不用于本轮付款。

## 按顺序操作

1. **选商品和数量。** 选虚构项链的Gold-tone或Silver-tone，加1件到购物车。Black为缺货测试，不应可买。可先在无痕窗口打开，以免混入旧测试购物车；一笔订单要始终用原浏览器窗口，付款前不要关闭无痕窗口。
2. **确认金额。** 进入交付预览后点 **Continue to fictional order confirmation**。选固定Ontario虚构资料及shipping，读取并同意最终报价，再建未付款测试订单。单件CAD25、虚构运费15、虚构税4，总额应为CAD44。填写的真实姓名/地址不应保存；请直接使用固定虚构资料，不用Google资料。
3. **先测取消。** 第一单不要点付款，点 **Cancel unpaid test order**，刷新后应仍是已取消，付款入口消失。这一步不应访问Stripe/PayPal。
4. **再测Stripe。** 另建一单，点 **Pay with Stripe (test)**，准备好后再点 **Continue to Stripe test payment**。只在明确Sandbox/测试模式的托管页面使用[Stripe官方测试卡](https://docs.stripe.com/testing?testing-method=card-numbers)。官方示例Visa为4242 4242 4242 4242，填未来日期和任意3位测试CVC；邮箱用`buyer@example.invalid`，姓名用虚构姓名。完成后返回网站，再点 **Check payment result** 核查付款状态。回跳本身不会直接标已付款；核查后应显示已确认付款。刷新不应多收一次。
5. **测PayPal。** 再建另一单，不能拿上一笔Stripe单切换渠道。点 **Pay with PayPal (test)**，准备好后点 **Continue to PayPal test approval**，用已有Personal Sandbox测试买家批准。返回后先点 **Check PayPal result**，应为已批准但尚未收款，再明确点一次 **Complete PayPal test payment** 完成收款，随后核查应为已确认付款。不要使用真实PayPal买家账号。

若想少走一页，购物车已有商品时可直接打开 `/checkout/confirm` 使用固定虚构资料；交付预览本身不创建订单或启动付款。

## 出问题时只做这些

- 保存订单页面，告诉开发者：在哪一步、页面提示、显示金额、是否已经从服务商返回；可以发不含敏感资料的截图。
- 若提示结果未知/正在核查，留在原订单，使用同页核查或刷新；不要另付一笔、切换渠道、清Cookie或反复按收款。
- 不用把任何密钥、密码、真实卡资料发到聊天。固定资料/运费/税只用于测试，不是经营规则。

## 这次能测与还不能测的内容

本轮可以人工操作真实本机Worker/D1上的商品、购物车、固定虚构订单、未付款取消、两家实际Sandbox托管付款和自己的私有状态。页面表现不代表iPhone Safari/VoiceOver已验收，也不是正式收款。

本机Admin仍要求真实Access且没有登录入口；收货/库存/退款/交付等后台操作**没有交付人工登录**。不会用假Admin、测试JWT/JWKS或任意header绕过保护，5193表现fixture不算后台操作验收。后台手动操作须另做独立HTTPS测试环境/身份与运行模式评审，并取得测试部署/资源授权，本轮不创建远程资源。

## 程序与状态保留（开发者）

使用已构建代码和现有runner，显式设置`COMMERCE_LOCAL_PORT=8803`、`COMMERCE_STRIPE_MODE=sandbox`/外部0600配置路径、`COMMERCE_PAYPAL_MODE=sandbox`/外部0600配置路径。不要继承Google/live配置或公开日志。原样使用严格文件reader；程序不会仅因启动访问服务商，只有显式付款/核查/收款操作才调用对应Sandbox。

每次`commerce:local`都会新建虚构DB。测试期间保持当前实例；停止或重启时先保存状态目录、实例、原订单关联及未知请求，不把新库当恢复，不删除原库/换键重发。保留旧Sandbox及未知状态。机器休眠/关闭程序会使本机地址不可访问；通知开发者恢复，用户无需自己重跑程序。顾客cookie绑定实例；购物车仍按原同origin浏览器存储约定，不以端口作隔离承诺。
