# 新来源订单的自有未付款释放（L04c）

日期：2026-10-29。Issue #67；基线 #66 / main `95ff4ed`，准确head CI101和独立审查通过，main CI102成功。前片CI全部72文件1348项应用测试、6项付款HTTP模拟及生产构建通过。代码/证据见[执行日志](./COMMERCE_EXECUTION_LOG.md)，原始来源与预留见[桥接契约](./COMMERCE_CHECKOUT_ORDER_RESERVATION.md)。

## 范围与身份

本片提供内部 `releaseTestCheckoutOrder`，输入为可信mode/instance/owner分区及 `{releaseKey, orderId, kind, expectedVersion}`。kind只允许cancel或expire；客户端不能选择库存动作、数量、金额、deadline或command ID。普通/空原型own-data输入在第一次await前严格检查复制，未知字段、访问器、符号和不安全整数拒绝。

完整来源映射决定命令可操作哪一个订单，不能仅按owner哈希或订单编号查单。context仍不是数据库归属证明、浏览器认证或Admin授权；本片不接HTTP、UI、runner或定时任务，不存实际顾客/Google资料。操作收据是历史证明，不表示现在可付款、派发或履约。

## 资格与重放

第一次释放必须同时满足：原订单pending、payment not_started、fulfillment none、版本与所见一致、且该order在所有环境/渠道上下文下都没有任何既有payment attempt。共用账本的work/观察/事实依赖attempt；不能只过滤调用者的provider来推断没有收款。processing、unknown、held、confirmed和已有付款意图的订单继续锁定，交后续金融事实核对流程，不能借取消按钮释放。

准备完成后取新时钟，要求不早于订单创建；expire仅在 `reserveUntil <= releasedAt`，恰好到期允许，cancel在期限前后均可。时钟/版本为安全整数，版本加一不能溢出。释放使用原订单行数量，不重新验商品名称/价格/当前发布或variant版本；这些变化不能把未付款预留永久锁住。原quote/acceptance/origin、实物on_hand、FB留量和allocated均保留。

同一原key和原内容返回原收据，时间、目录或当前订单后来改变不会重复释放。换kind/订单/版本复用key，或用另一个key处理已消费订单，均冲突；不能把另一请求的成功冒充本请求。资格检查前后和写/读响应故障都先恢复完整原键记录；未知结果为unavailable，保持原键，不返回内部SQL、地址或异常cause。

## 一次SQL完成释放与审计

新增不可变释放记录保存完整分区、请求键/hash、order、kind、时间、原/结果版本及服务端独立command身份。该记录的单次INSERT同时执行：核对资格→创建command→按全部保存行生成release流水→原订单cancelled且version+1→检查完整流水和状态对应。流水expected_variant_version明确为NULL，不复用reserve command。

0018的INSERT和UPDATE库存下限都演进为：映射订单占用总量减去已持久释放的对应占用。释放父记录在该原子语句内可见，允许自己的流水降低余额；**后续任一行、状态或覆盖检查失败，父记录与全部效果必须一起回滚**，下限随之恢复。不能先提交审计再慢慢释放。

订单UPDATE只允许有本次完整释放证据的pending/not_started/none→cancelled和版本加一，其他身份、owner、快照、金额/时间、payment及fulfillment列不变。原删除/替换/来源守卫、旧lab transition/recovery排除仍生效。释放记录不可UPDATE/DELETE/REPLACE；每个释放command的流水必须对应实际行位置/变体/原数量和release类型，拒绝追加或重复。其他未释放映射订单仍有INSERT/REPLACE/UPSERT及UPDATE下限保护，普通lab只能释放自己的余额。

## 验收与后续门槛

真实临时D1覆盖含旧订单和0018预留的升级、取消/到期边界及竞争、错owner/实例/版本、原键丢响应/读失败/并发胜者恢复、目录变化、多行晚失败或静默漏流水整组回滚、直接SQL变更和追加绕过、多个映射订单共用SKU及旧lab释放。未来付款状态的负面用例是明确注入的私有fixture，不冒充实际服务商支付或可运行付款状态机。

格式/lint/生成类型、应用测试/6项HTTP模拟/生产构建、准确head CI和独立审查通过后才代合并；合并树、源归档清理和main CI另记录。本片不放宽0009付款约束或0016，不操作账户、凭据、真实数据、远程资源/计费/收付款或部署。

完成命令仍不代表自动过期任务已经运行。后续单独接入有归属的扫描/重启恢复、游客凭据与同源/CSRF/限流，再实现最终确认和状态页面；真实Google留存/PII生命周期、经营规则、服务商适配/Sandbox、真机Safari/无障碍和UAT仍未验收。回退停止新释放，保留审计、订单、流水及余额，不删除释放记录或复原旧余额，不让已释放订单再次占库。

历史收口：#68 head `017f6b4` CI103与独立审查通过后合并main `62d8aa3`，main CI104成功；合并树等于已测/发布树。全历史source.bundle验证后清理两个本地分支/工作树；无HTTP消费者或自动调度启用。后续Issue #69见[游客凭据边界](./COMMERCE_CHECKOUT_GUEST_CAPABILITY.md)。
