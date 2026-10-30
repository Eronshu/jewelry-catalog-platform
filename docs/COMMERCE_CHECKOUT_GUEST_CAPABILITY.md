# 本机游客结账凭据与请求边界（L04d）

日期：2026-10-29。Issue #69；基线 #68 / main `62d8aa3`，准确head CI103、独立审查及main CI104通过。本片仅交付内部local-test服务与0020迁移，不接路由、runner、最终确认页面、付款或真实顾客资料；完成代码不表示HTTP消费者或正式身份方案已验收。前置见[报价接受](./COMMERCE_CHECKOUT_ACCEPTANCE.md)、[共享订单来源](./COMMERCE_CHECKOUT_ORDER_RESERVATION.md)及[未付款释放](./COMMERCE_CHECKOUT_OWNED_RELEASE.md)。

## 凭据、归属和有限信任

新高熵opaque capability由服务器生成，浏览器只通过专用host-only、HttpOnly Cookie携带；数据库只存独立域的token hash、完整mode/instance/canonical origin、独立随机owner hash和生命周期，不存原令牌、CSRF proof、姓名或地址。owner由服务端记录决定，不采用请求中的email、订单编号、购物车ID、owner或instance作为身份。旧lab Cookie与任务bearer、Access身份和服务商签名都不能代替它。

选择持久hash会话而非签名Cookie，便于明确撤销且不用在本片引入签名密钥配置；代价是读取依赖D1可用，无法读库时关闭，不降级为客户端身份。它仍是bearer：持有有效原Cookie者拥有该会话能力，不是实名验证。复制数据库/错误资源绑定不能靠scope字符串检测；不能宣称数据库绑定已验真。

**本片只支持受信任本机上的虚构测试。** Cookie不区分端口；实例化名称、host-only、HttpOnly和精确Origin不能阻止同一hostname上另一个本地服务接收Cookie并在非浏览器请求伪造Origin。不同localhost端口不是隔离环境。配置只接受服务器传入的local-test、实例UUID和精确HTTP loopback canonical origin，HTTPS/远程/Sandbox/live一律拒绝；不通过URL、Host或转发头生成配置。

HTTP本地Cookie无Secure，使用SameSite=Lax、Path=/和测试用固定24小时；不是经营者确认的会话/保留政策。未来HTTPS另行实施Secure、host-only命名、资源和origin配置、真实浏览器返回验收；不把本片Cookie复制到正式站。SameSite建议不是Safari/托管支付兼容保证。

## 生命周期和请求策略

- GET初始化只在本片Cookie完全不存在时生成新身份，先持久化并确认记录再给Cookie；有效既有身份复用，不续期。畸形、重复、未知、过期或已撤销Cookie均拒绝，不悄悄换owner。旧lab Cookie不参与本片身份。
- 变更要求已有有效会话、POST、精确Origin和该会话的CSRF proof；缺失/`null`/异端口Origin、错误proof和不安全方法拒绝，绝不在写请求自动创建身份。Origin不是非浏览器认证；CSRF本身也不是会话凭据。
- token hash与CSRF proof分别用原高熵capability及完整scope进行域分离；不能从数据库token hash计算可提交proof，不能把owner hash当proof。原Cookie只进入Set-Cookie，不进入URL、日志、localStorage或JSON；proof只供未来no-store页面提交，不能记录或用作查单编号。
- GET有Origin时必须匹配。Fetch-Site缺失、same-origin或none可初始化/读取；same-site/cross-site仅在navigate/document顶层导航且已有本片Cookie时可读取，不能初始化；其他值拒绝。POST的Fetch-Site仅缺失/same-origin可用，且仍须Origin/proof。返回页面不写paid。请求体限长、类型、重复字段检查仍须由未来HTTP消费者使用受审的bounded parser实施，不能因为凭据通过就信任表单。
- 异步读取后再取新时钟，要求创建时间不晚于当前时间，且当前时间严格早于到期；恰好到期或回拨拒绝。撤销单调不可恢复；新撤销须仍在有效期，匹配原Cookie/scope/Origin/proof的已撤销请求可在到期后返回原revokedAt，但回拨早于创建或撤销时间仍拒绝；这不允许普通变更重用撤销身份，不重绑定旧订单。
- 写响应丢失时只按本次原token hash恢复准确记录，不能盲发另一身份；读/存储不确定时返回通用unavailable，不附SQL、原异常cause、Cookie或顾客信息。不可用不是授权拒绝后的新身份回退。

## 后续消费者必须处理的边界

本片没有完成最终确认、查询或取消路由。未来调用者必须在读取商业数据前验权限、仅把最少收据放进private/no-store响应，绝不把内部context/owner/hash序列化。过期检查与后续订单写入不是同一SQL事务；必须明确授权时点、在长等待后重验，不能声称撤销可中断已授权的在途动作。

两个初始GET可以各建会话；没有业务对象时只是闲置记录。未来页面必须先完成/串行初始化，再允许确认，处理双tab或旧响应覆盖Cookie，不能在身份未稳定时预留或付款。丢失Cookie不能凭订单ID/email恢复；另立受控恢复/验证与过期记录清理方案，不能删除订单、释放未知付款或自动转移owner。没有会员、密码或地址簿需求。

## 验收与停止

真实临时D1测试覆盖含旧0019订单/预留的增量升级、随机签发/复用、scope/origin/mode拒绝、重复/畸形Cookie、缺CSRF/错误方法、到期等号/回拨/延迟读、撤销/重放/竞争、不可变和REPLACE/UPSERT绕过、写丢响应/读取失败及无敏感错误。HTTP未激活必须由未改路由/runner/config的范围核对支持。

格式/lint/生成typecheck/全套应用测试、6项HTTP模拟、生产构建及独立安全审查完成，准确head CI无未解决项才代合并。实际结果另记[日志](./COMMERCE_EXECUTION_LOG.md)；单元/D1模拟不代表真实Safari、Google留存、商家Sandbox或UAT通过。回退停止新消费者并保留hash/撤销及业务历史，不降级迁移、不复活会话、不重绑定订单；真实隐私保留/清理规则仍需单独确认。
