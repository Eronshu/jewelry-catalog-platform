# L03：持久支付核心与本地切片

当前基线：main `28c06d5`（L03a3b2b #57，head `446610e` CI85及完成的独立审查无发现，main CI86通过）。当前只读排查已合并；父 `424186e`/实现 `27a788e` 已在 `2026-10-28-payment-attention/source.bundle` 完整验证归档后清理。本轮只做执行开始登记，不派发请求，不放开重新扣款或库存释放。C架构与 [隔离契约](./COMMERCE_SANDBOX_BOUNDARY.md) 不变，不授权账户、真实收款、远程资源或部署。

## 1. 已合并 L03a1：只记录支付开始意图

在隔离的真实本地 D1 中，先记录一个不可变意图并将订单锁到 `processing`，防止原未付款释放流程继续运行。**这不是服务商已创建付款、顾客已同意最终金额或收款已成功。** 模块没有 routes、页面按钮、网络客户端、密钥或发送任务；普通 runner 也不配置该意图所需的 scope。

当前只接受旧 lab 的 `testOnly=true / CAD / local-test-v1` 快照，纯作约束夹具。它使用历史虚构零税率，不是交付页的 `fictional-delivery-v1` 最终报价，更不能用于顾客付款。L04必须另做资料/金额/规则/自己的订单绑定及重新确认；不得因两者都有 `totalCents` 就直接接入。

### 数据边界

| 数据                            | 本片的实际作用                                                                                                   | 不代表什么                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `commerce_payment_scope`        | 空表迁移；本地fixture明确写入唯一local-test实例UUID、两家非秘密的`fixture-*`账户引用；一经配置不可修改/删除/替换 | 不创建Stripe/PayPal账户，不是商家凭据，也不证明真实绑定；复制DB仍可复制实例标识 |
| `commerce_payment_attempts`     | 不可变的请求/命令、owner/order/quote、实例/渠道/账户、金额CAD/规则/快照摘要、所见版本和服务器时间                | 不是服务商交易、完整支付状态机、退款、inbox/outbox或派发结果                    |
| `commerce_orders.payment_state` | 与意图同一事务从not_started变processing、版本+1；只表示应阻止盲目释放                                            | 不表示银行/服务商正在处理或已经扣款，不能据此履约                               |
| 现有库存账本/余额               | 开始意图前后保持原有预留；不释放、不扣实物、不占Facebook留量                                                     | 不完成收款分配、迟到付款裁决或发货                                              |

迁移0009不回填既有订单，不配置通用共享实例。缺scope、错误实例/渠道账户、模式不符在读取订单之前关闭；不会根据请求自动初始化或改用另一环境。独立绑定的实际核对仍按L02b/L09执行。

### 内部调用契约

`beginTestPaymentAttempt(db, trusted, input, now)` 只供可信测试调用。`trusted`是服务端建立的 `mode=local-test / instanceId / provider / accountRef / ownerHash`；`input`恰好 `requestId / reference / expectedVersion`。客户端不能提交owner、账户、金额、币种、时钟或操作类型。当前没有可访问该函数的HTTP入口；未来入口仍须按自身权限/loopback或新模式验证，不能把 TypeScript 类型当成授权。

请求ID采用UUIDv4；首次落账另生成独立UUIDv4作为稳定的创建操作关联键，重放读取原键，不重新生成或覆盖它。请求哈希固定字段顺序，绑定原请求及可信owner/实例/渠道/账户，不加入新的时钟、当前版本或商品价。数据库收据重放读取最初金额、时间和版本，不重新解释成当前订单状态；返回不含快照、hash、账户配置、顾客资料或凭据。内部收据的存在只证明意图持久落账。

创建键不复用为PayPal capture、退款或其他操作的幂等键。服务商幂等窗口/状态含义到各适配器时按选定API核对；本地永久收据不能证明服务商无限期记得同一键。[Stripe idempotency](https://docs.stripe.com/api/idempotent_requests)、[PayPal idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)（2026-10-27核对）。超出可安全重试窗口必须先查事实/接管，不换键猜测未扣款。

### 同一写事务内的必要条件

1. scope与可信实例/渠道/账户匹配，命令与原请求及时间相符。
2. 目标属于该owner，所见版本精确匹配；订单为pending_payment/not_started/none。已取消/已确认、held、任何已开始/未明/失败付款都拒绝新意图。
3. 原报价期限与预留期限均严格大于服务器时间；等于期限即拒绝。lab10分钟报价和15分钟预留不是经营规则，不趁仍有预留延长过期报价。
4. 金额为合法安全整数、正数、CAD、lab测试规则；完整快照的各行/数量/单价/版本/总额与存储订单行及原reserve账本精确对应。只比较总行数不够；空/多余/替换/缺少行或原预留记录都拒绝。
5. 从读取到写入期间原snapshot若改变，不落账；写入时不能仅信任之前计算的摘要。意图存在后冻结订单商业身份/快照/期限，禁止重置not_started，旧cancel/expire不能绕过持久意图。
6. 命令+意图+订单锁为原子事务，失败全回滚；没有零行更新也返回成功的路径。没有外部调用参与这段事务。[D1 batch事务说明](https://developers.cloudflare.com/d1/worker-api/d1-database/)（2026-10-27核对）。

本片采用可单独替换的具名唯一索引，**一个订单只允许一条意图**。这是尚无结果/重试命令时的保守限制，涵盖所有未明甚至已成功场景；不是未来“失败后换一个渠道”的完整实现。后续必须先增加经核验的结果/活跃尝试规则，再用新迁移调整索引，保留原历史，不能删除意图或改原命令来开放重试。

既有未开始付款的lab测试仍可按原命令取消/到期；旧测试在意图前设置异常夹具不改变。意图之后再修改商业字段或重置not_started必须被数据库拒绝。原手工恢复资格不放宽，不新增强制释放/退款/重新分配会话。

## 2. 并发、回放和未明结果

| 情况                                  | 必须得到的结果                                                              |
| ------------------------------------- | --------------------------------------------------------------------------- |
| 同一请求重复/同时提交                 | 一份不可变意图、一次版本变化、原始收据；库存不变                            |
| 不同请求键/渠道同时开始同一订单       | 仅一个获准，失败方没有残留命令/意图/库存动作                                |
| 原键改owner/实例/渠道/账户/版本或引用 | 不冒充原请求成功；配置不匹配关闭，载荷冲突拒绝                              |
| cancel/expire/recovery先提交          | 新意图拒绝，不复活已释放预留                                                |
| 意图先提交                            | 三种旧释放路径均不能释放其预留，之后not_started重置也不能使它们复活         |
| 意图在首次收据查询与订单读取间提交    | 拒绝当前状态前再次查原收据；失败batch核对窗口也相同，不重复#48的误报409问题 |
| 写响应丢失                            | 查持久原收据；原请求重放可恢复，即使时间/订单状态已变                       |
| 后续存储/收据读取也失败               | `unavailable`仅表示无法确认，保留原键，不宣称失败/成功、不另起一次支付      |
| 命令存在但缺匹配意图                  | 不能当成功收据；保留调查，不能补造一个新意图掩盖异常                        |

内部错误只提供 `invalid_request / not_found / conflict / unavailable`，不回显SQL、提交字段或资料。未来路由需再评审自身HTTP映射、授权与限流；本片没有公共错误面或客户支付入口。

## 3. 后续L03小PR的依赖顺序

下表区分已合并、当前切片和后续目标；逐项从更新main建分支。派发执行器需要持久结果承接，因此先完成a2a待办/领取，再完成a3事实，之后实现a2b执行器；这个依赖细化不改变C架构，不提前调用provider。

| 小任务                                      | 前置                | 交付和验收                                                                                                      | 停止/回滚                                                          |
| ------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| L03a1 已合并：scope/开始意图/订单锁         | L02a、既有订单/预留 | #52：迁移/内部服务/真实D1升级与竞态证据；不连接provider                                                         | 停新开始调用，保留意图/schema及processing锁；不删表复活not_started |
| L03a2a 已合并：持久待办与领取日志           | a1已合并            | #53：自动建待办、固定短lease/版本、不可变领取收据；领取后恢复仅query；没有派发许可或执行器                      | 停领取，保留待办/claim/锁；不复位create或删历史                    |
| L03a3a 已合并：不可变capture事实            | a2a、核验契约       | #54：按经济交易键去重、保留首次来源及实际/期望金额币种；错金额和额外交易不丢，不变订单或任务状态                | 停新记录，保留事实/锁；金额匹配不是履约许可                        |
| L03a3b1 已合并：规范化观察日志              | a3a                 | #55：六类状态来源、严格字段、旧claim与原ID重放；不改金融/订单/work状态                                          | 停记录，保留日志与原锁                                             |
| L03a3b2a 已合并：原子处理与异常结果         | b1                  | #56：同事务capture条件落账/结果，保留冲突、金额异常及当时额外收款标记，不变订单/work/库存                       | 停处理，保留全部来源/事实/结果                                     |
| L03a3b2b 已合并：实时只读排查队列           | b2a                 | 按订单聚合当前事实/未处理观察/冲突与超时待核查；分页、最小投影、环境先检，不改变历史或业务状态                  | 停调用即可，保留所有来源/事实/锁                                   |
| L03a3b2c1 当前：执行开始登记                | b2b                 | 0014空不可变日志，scope/来源/当前claim与版本/重采样时钟/租约/CREATE条件在SQL重检；唯一登记与明确新写确认        | 停登记，保留日志/原锁；收据不能用来派发                            |
| L03a2b 派发/核查执行器与模拟适配器          | a2a、a3持久结果、c1 | 执行前再核对时钟/当前资格，登记后崩溃仅query恢复；仅模拟无网络，不根据重放收据派发，不开放新尝试或库存释放      | 停新执行，保留登记/原键与查询待办，不因超时重新创建                |
| L03a3b2c2 后续：异常处置/活跃尝试终局裁决   | 持久事实及核验契约  | 在真实适配核验依据清楚后另设计受审计接管、终局/重试/渠道切换；保留历史，需对应迁移与竞态验收                    | 证据不足继续锁定；未通过前保留one-intent/order限制                 |
| L03a4 验真事件持久收件箱                    | a3                  | 验真边界只接适配器可信输入；event去重与transaction去重分开；重复/乱序/崩溃可重放；provider验签在L07/L08实际实现 | 停问题处理器，保留接收/核查及未处理事件，不假装成功丢消息          |
| L03a5 业务事件/通知outbox与可靠任务扫描基础 | a3–a4               | 业务变更与发送意图同事务；限量重试/重启/失败可见；测试环境不向真实收件人发送                                    | 暂停发送但保留任务，人工接管；不回滚已发生的支付事实               |

这里把原b2c的依赖收窄为c1登记与c2后续终局处置：保持one-intent/order、不增加第二次扣款/释放的保守路径，足以先做c1和无网络执行器；完整异常关闭、退款和安全换渠道不再被误当作模拟执行器的前置。此细化已在实现前解释并作独立只读设计审查，不改变C架构。真正放开重试仍须c2核验与新迁移，不因本片合并而获得批准。

L04才接顾客交付资料/不可变最终金额/订单/预留，L05才做付款后的库存分配与迟到付款裁决，L06才接游客复核/私有查询；L07/L08分别实现两家托管适配与验真，L02b/L09是新模式、授权环境和实际provider证据。未明任务不得因为顾客返回页、站点重启或新点击而被当成失败。两渠道、三交付、退款/通知/对账/恢复仍需完整后续验收。

## 4. 已合并 L03a2a：持久待办与领取日志

本片只做内部journal，不执行付款。`commerce_payment_work`每个不可变attempt一条；0010从旧意图回填、新意图同事务自动建立。回填为初始create待办的依据仅是已合并a1没有任何派发路径；未来已有网络的数据库不能照此推断。初始化只依赖attempt，不依赖两个AFTER触发器的执行顺序。scope不自动配置，原订单/意图/库存不变。

内部 `claimTestPaymentWork(db, trusted, input, now)` 的可信上下文恰好 `mode / instanceId / provider / accountRef / workerId`；输入恰好 `claimId / requestId / expectedVersion`。workerId是合成关联UUID，不是认证或访问能力；未来任务入口仍须认证、环境绑定和限流。金额/CAD/订单/稳定创建键从原attempt取，不接受请求覆盖。

领取之前先核对scope，再查原claim。新claim通过数据库CAS、版本和时间核对，追加不可变收据并原子更新work；固定30秒租约只是本地测试调度假设。有效旧租约内不能重领，等于期限可领；倒退时钟、溢出版本/时间拒绝。第一次只有订单仍pending_payment/processing/none且报价与预留均未到期，才记 `operation=create`，否则记query。任何领取后work永远转为query，不能直接复位create。query不会因顾客报价过期而停止核查旧付款。

**收据不是发送许可。** operation只是当时记录的工作类型；同claim重放保留原类型/时间/版本，不续租，即使仍写create也不能据此发请求。接口不返回mayDispatch、实时授权或provider结果。响应/读回丢失保留原claim；两段收据→当前态读取窗口重查原收据。不存在新键猜测未发送、清空租约复活create或“超时即付款失败”。本片没有任务扫描、执行器、结果完成/安全终止或解锁路径。

lease只能约束本地写入，不能阻止暂停后恢复的旧worker访问provider。后续a2b必须用新鲜时钟复核当前claim/版本/租约，原键和原参数不可变；即使调用前复核也仍有跨系统TOCTOU，需服务商幂等窗口、结果核验及持久事实共同处理，不能宣称exactly-once。旧收据不是新worker的当前资格，旧worker不能覆盖新claim状态。

验收覆盖0009→0010多意图回填和新意图自动建立/回滚；同异claim并发、活跃/到期租约、首次过期降query、过期重放不续租、scope/worker/载荷冲突、时间/版本边界、两段确定性交错、写响应/读回丢失、无写适配器和不可改删替换。每例核对原订单/意图/库存不变。停止领取保留0010及全部历史，不删除待办或重置create；真实网络、任务调度及经营验收仍需后续证据。

## 5. 已合并 L03a3a：不可变capture事实

本片只在内部fixture中记录“调用方声称已经核验的capture”，不实现任何provider核验、HTTP入口或任务完成。0011新增空 `commerce_payment_capture_facts`，不回填付款事实。原订单、payment/work状态、预留、库存及既有审计不变；既没有自动paid，也没有释放、发货或退款。pending、approved、失败、未明等观察已有0012内部日志，处理裁决仍后续，不能把此表当完整支付状态机。

`recordTestCaptureFact(db, trusted, input, now)`复用a2a上下文的五字段；输入恰好 `requestId / claimId / providerObjectRef / transactionRef / amountCents / currency`。对象/交易引用仅接受`fixture-*`合成值，三大写字母币种仅为测试类型，不证明受支持币种或真实provider字段规则。实际值与原attempt的CAD/金额分别保存；`amountMatch=match/mismatch`**只比较金额和币种，不代表验真、唯一收款、订单付款裁决或可履约**。实际错金额/错币种也必须持久保留，不能因为不适格就把已观察付款丢掉或改成失败。

每次先核对scope、本次claim的worker/原attempt/渠道账户，再读取事实。claim可不是当前claim、lease可已过期、订单可已演进；这些变化不能抹掉迟到经济事实。但来源必须属于本次可信worker/attempt，服务器记录时间不得早于来源claim/attempt。workerId仍不是认证；未来入口不能靠提交workerId授权。

经济自然键是 `local-test / instance / provider / account / transactionRef`；服务端生成稳定摘要ID，数据库另对完整自然键唯一约束。核心载荷绑定原attempt/order、provider对象及实际/期望金额币种，排除领取ID/worker/新记录时间。合法新query claim或worker重复观察同交易同载荷时返回最早来源/时间，不续写或覆盖；最早记录时间可以早于后来query claim。原claim不可变，没有基于当前lease/订单态的资格重验；并发INSERT和响应丢失按同经济键读回，不照搬a1/a2的两段可变状态分支。

同交易改attempt、对象或金额/币种冲突，不覆盖。另一交易即使属于同attempt也另外保留，不能用唯一订单约束吞掉多收款；是否额外收款、退款还是人工处理需后续裁决和经营流程。冲突返回不意味着付款不存在。a3b/a4必须持久保留冲突来源/原始事件最小必要信息及异常队列后，才允许真实适配入口；本片无此入口，不能把错误返回当正式事件确认。经济事实去重与event ID去重不同，后者仍需inbox。

只用合成fixture不能证明provider真的收款。未来适配器必须按固定API对象区分批准、待处理和实际收款，并核验账户/环境/关联/金额币种；Stripe官方说明要求服务端监控结果而非依赖顾客返回页，[状态核对](https://docs.stripe.com/payments/payment-intents/verifying-status)；PayPal也区分capture的COMPLETED/PENDING等状态，[capture定义](https://developer.paypal.com/sdk/orders/v2/definitions/capture/)、[事件分类](https://developer.paypal.com/api/rest/webhooks/event-names/)（2026-10-27核对）。这些资料不是本项目实际适配/Sandbox证据，退款/争议也不能覆盖原capture历史。

验收覆盖0010→0011升级不变且事实空、两渠道匹配/错金额/错币种、同交易并发/不同合法来源重放、跨attempt/改载荷冲突、不同交易完整保留、过期旧worker不改新work、scope/来源拒绝、直接SQL绑定/分类和不可改删替换、事务回滚/响应丢失/读回失效/零写适配器。停止新记录保留0011与全部金融历史，不删事实“撤销收款”；既有processing锁仍不能盲放。

## 6. 已合并 L03a3b1：规范化观察日志

0012只新增空的 `commerce_payment_observations`，不回填或更新任何订单/payment/work/库存/capture事实。它保留内部可信fixture调用的 `unknown / not_found / pending / approved / reported_failed / captured` 来源；不做provider验真、HTTP、派发、处理完成或状态裁决。approved不是收款，not_found不是未发送/未扣款证明，reported_failed不是订单终局失败或放库存依据。

`recordTestPaymentObservation(db, trusted, input, now)`复用五字段合成上下文；输入恰好 `observationId / requestId / claimId / kind / providerObjectRef / capture`。captured必须有fixture对象引用及严格三字段capture（transactionRef/amountCents/currency）；pending/approved/reported_failed只许对象引用、capture=null；unknown/not_found可无对象引用，金融字段仍须null。无自由错误字符串、原始payload或顾客资料。三字母币种及fixture引用只是测试类型，不冒充真实API映射。

每次先scope、再不可变claim/worker/原attempt证据，最后查原观察收据，包括重放。旧claim、过期lease或订单态改变不阻止迟到观察，但当前调用必须匹配来源worker和环境账户，记录时间不早于claim/attempt。稳定hash绑定规范化请求及来源，排除fresh clock；同ID原字段重放保留首次时间，同ID改来源/状态/载荷冲突。不同ID是不同观察，可描述同一经济交易；日志不调用capture服务，不能因两条captured观察就多记一次经济事实。

SQL独立校验kind对应字段/类型/范围、scope/来源绑定和时间；追加原子且不可改删替换。写响应丢失按原ID读回，无法确认则unavailable，不另造ID猜测失败；成功也要求持久读回。没有基于当前可变状态的资格，因此不复制两段receipt→当前态竞争分支。日志并发、响应丢失和旧worker都不能改当前work或金融历史。

这提供后续处理器持久输入，不代表a3b全部完成。recordedAt只是本地落账时间，不是provider状态发生时间，不能用最后到达一条覆盖付款事实。a3b2仍须逐条处理/重放、将captured观察映射到经济事实、持久保留冲突/额外收款/金额异常与处理结果，且不因乱序失败覆盖收款；再做活跃尝试/安全重试裁决和a2b模拟执行器。实际Webhooks的原始请求验真、event去重和inbox属于a4/L07–L09，不能把内部观察收据当正式Webhook确认。

验收覆盖0011→0012保留业务数据且空日志、两渠道六种kind与严格投影、同ID并发/载荷冲突、不同ID同金融交易、过期旧worker、scope/proof及重放拒绝、同步拷贝/嵌套输入/时钟边界、SQL绑定/shape/不可变、回滚/响应丢失/读回失效/无写适配器。停止新记录保留0012和原事实/锁；没有删日志作为付款取消或退款的路径。

## 7. 已合并 L03a3b2a：观察处理事务与异常结果

0013新增空的不可变 `commerce_payment_observation_results`，每条观察最多一个处理结果。内部 `processTestPaymentObservation(db, trusted, {observationId}, now)` 的可信上下文仅 `mode / instanceId / provider / accountRef`；处理者从已核验的观察/原claim/attempt重建来源，不要求调用者提交或冒充原worker。上下文不是认证，未来任务入口仍须独立授权/绑定。无HTTP、provider调用、扫描器、当前lease完成或订单/payment/work/库存变化。

先核对scope与不可变来源，再查原结果；本次now不得早于原观察记录，重放也适用，但可早于原processedAt。历史claim过期或被替换、订单态演进不丢证据。稳定请求摘要只绑定上下文/原观察ID，不加入新时钟；原结果重放保留processedAt及标记，不能随当前事实集合重算历史。processedAt取本调用开始时的服务器时间，不是provider事实发生时间，也不能构造跨worker的全序。等待期间其他worker可能以稍晚时间提交事实；本片不增加now必须晚于所有既有fact时间的条件，AtProcessing始终指该事务可见的事实。

非captured仅记 `observation_only`，不创建经济事实。captured在同一D1 batch中先条件插入capture事实，再按事务内真实记录写结果：完整对应为 `capture_fact`，已有相关经济键/ID但核心字段冲突为 `capture_conflict`。条件插入、处理结果和SQL守卫是一笔事务；第二步失败要连同新事实回滚。captured无相关事实时不得伪造冲突结果。两个观察同交易可有两条结果，但只有一份经济事实；另一笔交易则保留，不因同订单而丢弃。

原API与处理器共用纯descriptor帮助函数，保留0011的操作版本和JSON属性顺序，并用固定向量/双向互操作验收。candidate ID/hash只是应用提供的见证，SQL不会重算SHA；成功必须同时核对完整自然键、attempt/order、对象、实际/期望金额币种和分类。相关ID与自然键双命中冲突时不靠first/LIMIT任取；冲突保留原观察，不暴露另一订单或冲突事实的ID。scope/source/time、shape和结果/flag关系分别用短守卫及显式NULL/整数检查，避免已遇到的D1表达式深度限制。

`amountMismatch`按本观察实际与原期望比较，金额异常即使冲突也保留；不代表paid或可履约。`additionalCaptureAtProcessing`仅在成功对应经济事实且同mode/instance/order的不同事实已超过一笔时为true，计数覆盖该订单的全部attempt/provider/account。它是**处理当时的历史切片**：最初false、后来出现额外交易，重放原收据仍false。实时异常队列必须查当前事实，不能拿旧false当作无异常证明。不同交易并发时至少后一次结果能标额外，同一交易重复观察不能误报多收款。

同ID并发、丢失写响应按原观察读持久结果，无法读回仅unavailable，不另造ID或据此推断没写入；成功也要求持久回读。回退停止新处理并保留0013/观察/事实/原锁，不删除经济记录作为退款。真正的异常队列、人工处置、活跃尝试/安全重试裁决和执行器仍后续，不因有处理结果就解锁付款、释放库存或履约。

验收包括0012→0013保留旧数据且结果空、六kind、两渠道及双向API去重/固定摘要向量、同/不同观察并发、改载荷/跨订单经济冲突、金额异常和不同交易保留、历史额外标记不重算、过期来源/新任务隔离、scope/来源拒绝、SQL NULL/witness/flags/双命中碰撞/不可变、第二步失败全回滚、响应丢失/读回失效/零写与缺事实适配器。当前one-intent/order约束仍保留；诊断fixture里的跨尝试计数不等于已批准实际多尝试流程。

## 8. 已合并 L03a3b2b：实时只读排查队列

内部 `listTestPaymentAttention(db, trusted, {cursor}, now)` 只读同一local-test实例，可信上下文恰好 `mode / instanceId`；不是顾客凭证，也不是Admin认证。先严格验证输入并在await前拷贝，再核对数据库不可变scope及两家fixture账户配置，缺失/不符即关闭；无自动配置、HTTP入口或普通runner接线。跨owner汇总只供未来另行授权的内部经营排查，不能直接暴露给顾客。

一次聚合查询按订单给出当前capture事实数、金额不符事实数、未处理观察数、capture冲突结果数、金额不符观察数及有序原因：`unprocessed_observations / capture_conflict / amount_mismatch / additional_captures / expired_without_capture`。金额不符观察包括尚未处理或冲突的captured来源；直接capture API写入而无观察的金额异常同样可见。额外交易按当前同环境/订单全部attempt/provider/account的经济事实计数，重复观察不会变成多次收款；绝不使用旧结果的历史false标记证明现在安全。原收据仍保持原样。

`expired_without_capture`仅表示已有开始意图、预留期限已到且当前无capture事实，需要继续查证；不是没有扣款、终局失败、可重新付款或可释放库存的证据。单笔匹配capture也不代表已确认/已分配库存，本队列不是完整付款对账、工作调度或履约清单。异常暂不支持确认已处理/关闭，持久冲突会继续出现；后续用单独受审计处置命令解决，不能删除事实让它消失。

每页最多25单，多读1单判断下一页，稳定升序键为`created_at / id`；游标是有长度限制的规范base64url JSON时间/订单引用，不是访问令牌或一致性快照。翻页间数据可变，新出现且在游标之前的异常要从第一页刷新发现；`checkedAt`是本次服务器调用时间，不是服务商发生时间或事务全局时钟。限制返回量不等于限制数据库扫描量；当前小型fixture范围聚合，扩大数据量前须测查询计划和成本，不能声称已有大规模性能证据。

输出只含测试标记、检查时间、分页、必要订单状态/版本/期限/引用及计数/原因，不返回owner、worker、账户、provider对象/交易引用、快照、hash、姓名/邮件/地址、原始payload或混合币种金额总计。返回形状异常/存储失败仅通用错误，不泄露SQL或把半页当健康结果；无写入、无provider调用，不修改任何订单、工作、库存或历史结果。回退停用查询即可，schema和全部历史保持不变。当前内部fixture异常由开发者调查；未来实际收款争议由小姨决定顾客安排、开发者核查技术事实，均需后续界面与操作手册验收。

本片验收重点：历史false之后新交易仍被当前队列找到、同经济交易重复不误报、未处理变处理的刷新、错金额/冲突不丢、直接API事实、两渠道、期限边界、稳定多页及同时间排序、严格scope/游标/同步快照、最小输出、读失败及只读不变量。真实身份/真机/服务商验真仍未验证；无页面变化不能算完成经营者异常操作。

## 9. 当前 L03a3b2c1：执行开始登记

`registerTestPaymentExecution(db, trusted, input, clock)` 仅供内部fixture。可信上下文仍为 `mode / instanceId / provider / accountRef / workerId`，不是认证；输入恰好 `claimId / requestId / expectedVersion`。requestId关联原开始意图，expectedVersion是**当前work版本**，等于原claim.expected_version+1，可取2至MAX_SAFE_INTEGER；不能拿领取前版本冒充。时间来自服务端函数，不能从顾客表单传入。输入在await前严格检查并拷贝，scope先于业务读取；原claim/worker/attempt/实例/渠道账户证据先于收据读取。

0014只新增空 `commerce_payment_execution_starts`，以claim_id为唯一身份，保存绑定来源、操作、所见当前版本、请求摘要及started_at；不回填历史，不改变work、订单、付款、事实、库存或原保护。每条claim最多一份不可变登记；更新、删除和REPLACE均拒绝。原金额/CAD/create键继续由不可变attempt提供，不接受请求覆盖、不另造操作键。

开始调用先采样合法时钟，异步scope/来源/hash/原收据准备完成后、写入前再次采样；倒退或早于原claim拒绝。SQL独立核对scope/来源、当前claim、work.version=输入版本=claim.expected_version+1、next_operation=query、claimed_at≤started_at<lease_until及操作等于原claim.kind。它比较本次采样时间，**不是数据库墙钟栅栏**，也不保证网络调用时租约仍有效。

CREATE仅限原第一个create claim（expected_version=1）、pending_payment/processing/none、报价与预留均严格未到期，且同环境订单的所有attempt/provider/account都没有capture事实或任何观察；已处理not_found、reported_failed和approved同样阻止CREATE。QUERY在当前claim/版本/租约有效时可核查过期、held或已有capture的订单，不增加扣款权限。原始合法旧worker仍可记录迟到观察/事实，登记不能抹掉或拒绝它们。

普通INSERT须获得单条成功且meta.changes=1的明确确认，并读回匹配持久记录，才返回replayed=false。并发原键仅一个调用能得到该确认；任何写异常/响应丢失、结果元数据不完整或变更数不明，查回的记录都只能replayed=true，查不回则unavailable。零写成功不能伪造新登记。原键重放验证不可变来源并保留首次时间，即使claim已过期或被替换；重放不重检当前资格为新许可。SQL拒绝后无法确定是否原条件冲突的情况保持通用unavailable，不泄露数据库异常，也不把它解释成付款不存在。

**全部返回值都是登记收据，不是发送许可，包括replayed=false。** 当前没有执行器、provider或HTTP入口。后续执行器须在本次明确新登记的调用内部消费资格，调用前重新核对当前状态/租约和新鲜时钟；不能接受调用者拿历史收据请求派发。登记后崩溃或响应未知会消耗原CREATE机会，同claim重放不能再次创建；等原lease结束，下一claim只能QUERY并沿用原意图/创建键。登记至调用之间仍有暂停/事实到达竞态，唯一日志不等于一次外部调用，真实适配仍需原参数、服务商幂等窗口和核验事实。

当前fixture由开发者排查，未增加小姨的强制退款/解锁按钮，也不要求她改SQL。异常关闭/终局失败、再次付款、跨渠道切换、已付款分配、取消/退款和经营者界面仍另做。回退停止新登记并保留0014、所有来源/日志/事实及原锁；不能删除登记来恢复CREATE。

验收包括0013→0014保留业务历史且登记空、两渠道、同claim竞争仅一份新写确认、严格来源/版本/输入/时钟、准备期间推进时钟/租约边界、当前claim替换、登记崩溃后原键重放和新claim仅query、已有各种观察/直接capture及写前到达证据阻止create、登记后迟到事实保留、写响应/元数据/回读丢失/零写、SQL绑定/NULL/类型/期限/不可变和batch失败回滚。不把fixture测试当真实服务商或经营验收。

## 10. a1验收、经营者接管与边界

本片应在真实临时D1从0008升级，先保留既有订单/预留/审计，再验证新增空scope；每条意图核对原行、余额和命令。覆盖严格输入、scope拒绝、金额/快照/预留不一致、相同/不同请求与释放竞争、lost response/readback、两次收据查询竞态、不可改/删/替换及后续商业字段保护。内部模块不被任何运行路由导入，无网络调用；仍跑全部format/lint/typecheck/tests/生产构建/Admin资源保护。

没有支付UI变化，不需要为本片新增表现截图或要求小姨开账户。真实provider Sandbox、Access浏览器、iPhone Safari/VoiceOver、经营者UAT、真实规则和正式环境仍是未通过门槛。收款/退款未明、跨渠道额外交易、库存盘亏等未来由小姨决定顾客处置，开发者负责核查和修复；当前内部fixture异常只由开发者调查，不能让小姨改SQL或强制释放。

## 11. 发布与回滚

0009–0014为增量迁移；默认运行没有scope配置/入口，不开收款。它们尚未在远程运行，不能把本地迁移测试记为生产升级。确认兼容性后才能在单独授权的环境应用。

回退代码时保留scope、尝试、命令、待办/claim、capture事实/观察日志/处理结果/执行登记、订单锁和保护trigger；旧代码看到processing仍应保留预留。仅删除调用/禁用新开始、领取或记录，不删除事实、改余额、复位create或将订单复位not_started。即使当前没有网络派发，也不能把删除持久意图设计成通用回滚：一旦后续接入派发就无法由本地记录缺失证明没有扣款。后续安全终止/释放须有独立核验命令、审计和竞争测试。
