# 2026-09-07 审计覆盖

本文逐项对应昨日审计。`fixed` 表示仓库实现已改；`covered offline` 表示真实模块副本/模拟 sender 或隔离 Python 状态已验证；`production pending` 表示等待主 agent 独立验收和上线；`residual` 是保留的实际边界。所有 fixed 项当前均为 production pending，不表示在线已生效。

- 跨回合 source/target 继承及双 final：fixed；covered offline。同一个真实安装模块在补丁前普通回合发送一次、自主未 settled 后接用户发送两次；补丁后各一次。新 queue 对象/目标形成新归属；同请求 follow-up 保留身份。没有全局正文去重。
- 旧 settled 清掉新 activity：fixed；covered offline。异步生命周期前捕获 activity id，完成时核对身份和宿主 idle。真实 runtime session shutdown/start 后的旧 id 也不能清新活动；真实 lifecycle model_select 事件后接用户回合只发送一次（无模型调用）。
- 合法自主输出、中间进展、同文两回合与跨线程：fixed；covered offline。用户→自主、自主→用户、intermediate+final、同文同线程两次、不同线程分别保留。
- empty-reply-guard：保留；covered offline。实际扩展最多一次空回复 follow-up，然后接用户只交付一次。residual：没有证据将用户全部重复消息归因于空重试，不能宣布其为已证实根因。
- 空 artifact/空 TTS 伪语音错误：fixed；covered offline。无 voiceReplies、空数组、空白文本均 no-op；实际非空语音失败行为保留。
- 缺投递审计：fixed；covered offline。私有 hash-only ledger 包含 request/activity/route/placement/source/profile/target/thread/reply_to/send-or-edit/message_id/status；不存正文/token。成功、失败、unknown 区分；写前 unknown 支持崩溃后对账。
- 未知 ACK 盲重发：fixed；covered offline。bridge 不新增盲重试；独立 Telegram notifier 先写 sending，超时、服务端不确定、缺 message_id 等持久 unknown，不因再次调用而重发。429 等明确拒绝可按既有/新 backoff 重试。
- 同 task 连续批次反复“完成”：fixed；covered offline。task/run 分离，稳定 task/run/phase event，不同 run 不误吞。batch_finished、ready_for_review、verified、reported 分开；预算/接口边界不是目标完成。
- all([])、旧/空/缺产物：fixed；covered offline。必须有当前 run 新的非空产物，记录 baseline/mtime/size/hash；旧内容不因单纯 touch 被认定新结果。通用内容 schema/业务质量由主 agent 的 acceptance 验收。
- PID 消失或复用：fixed；covered offline。runner 实际 wait 保存退出码和进程出生身份，ps 只作存活观察，不推断 exit=0。启动失败也落不可变结果；runner 崩溃无结果则 needs_reconciliation。
- result 混入旧 run/损坏：fixed；covered offline。task/run/started_at 必须匹配；重复相同 result 幂等，冲突拒绝；读取错误不产生 readiness。
- herdr done 无 marker、PATH 错误、身份字段混用：fixed；covered offline。绝对路径和受控 PATH；显式 agent_name/workspace_id/pane_id；查询失败保留状态证据，不将 prompt 回显当完成。residual：旧 herdr 任务没有 runner 结果时只能 needs_reconciliation，需主 agent 迁移 supervisor，不会编造退出码。
- HTTP/read_error、预算耗尽而正常 exit：fixed；covered offline。结构化 reason/error 是独立闸门，即使有 marker/exit=0 也不 ready。
- 保存 done 后通知失败永久漏推：fixed；covered offline。状态与 outbox 同一 registry 事务；drain 独立于状态扫描，在 done/verified 后仍重试失败目标，退避上限一小时；unknown 保留待对账。
- 双生产与并发 registry 覆盖：fixed；covered offline。6 个结果生产者、8 个通知生产者及 12 个 registry writer 并发；同事件只一份，各新任务不丢。探测后 CAS 避免覆盖同时增加的字段。residual：不守同一 flock 的旧 writer 仍能覆盖；提供 register/start-run/update/migrate 工具和 skill 建议补丁，上线前必须逐个迁移，锁不能阻挡任意外部覆盖。
- notify 子进程失败、缺配置、HTTP/API ok/message_id：fixed；covered offline。非零返回码/配置缺失明确失败；不打印带凭据的异常 URL；API false、HTTP 4xx/5xx、缺 id、坏 JSON、超时分别检查。
- 多 Pi 抢主会话通知：fixed；covered offline。bridge live owner port + 实际 run-pi.sh 父进程 + PID/session/profile/thread/队列检查；非主或错误目标不能 claim，无 owner 留 pending。residual：主角色若转为 follower 则保守暂停 relay，需明确交接；跨进程 follower 的 originating request/activity 通过严格字段白名单经过真实 bus 序列化，leader 发送账本保留；实际 socket 模拟 ACK 丢失时 API 仅一次。生产中的角色迁移仍待主 agent 验收。
- claim 后崩溃、忙时内存丢队列、过早 .done：fixed；covered offline。私有 inbox 持久 pending/claimed/enqueued/handled；lease 回收；注入失败不删；重启 busy 仍 pending；旧 spool 迁移幂等并保留原件，不重放 .done。
- 注入后崩溃与未知 ACK：fixed；covered offline。同 session 已持久化 user event marker 用于幂等对账；sendUserMessage 为 void，enqueued 只记录尝试。residual：跨 session/持久输入丢失时是 at-least-once，业务副作用必须按 event 对账，绝不承诺 exactly-once。
- 用户优先、host settled、shutdown：fixed；covered offline。宿主 idle/pending 与 bridge active/dispatch/compaction/queue 同时检查，claim 后重新检查，用户输入留 quiet window，shutdown 清 timer 并用版本阻止旧异步结果注入。没有 fs.watch 残留。
- 500 字截断丢证据：fixed；covered offline。正文仅展示，task/run/event/result_path/route 独立字段；旧 mail-watch/QQ 所用 TEXT SOURCE CLI 保留。协议文件 0600；测试不读取生产正文或凭据。
- 双通道角色与签收：fixed；covered offline。默认保留 agent+telegram 两路，各自签收。用户收到待验收状态，verified 明确已验收待交付。没有擅自启用延迟兜底或关闭原直达通道。
- done 无人验收、blocked 无后续：fixed；covered offline。执行、待验收、blocked、rework、needs_reconciliation、verified 待交付均巡检；每阶段超时只生成稳定提醒并保留 attention_required，失败目标继续退避。两次返工后阻塞；新 run 能恢复执行失败；不因“收到”结束巡检。
- reported 没有验收/交付凭据：fixed；covered offline。实际 review 文件、发送前 report intent、真实 sender ledger、正文 hash、target、验收/发送时间均匹配才报告；无签收/不相关签收不允许 reported。保留每 run 验收/交付历史。主 agent 仍负责认真验收并完成已授权后续工作，代码不能证明模型会做出正确判断。
- 全链路：covered offline。真实 runner→状态/outbox→真实 notify-agent CLI→真实 relay（模拟 Pi host）→独立读产物验收→prepare-report→模拟 API 真 notifier→report→handled。原待验收通知 Telegram ACK unknown 仍保留，不能由最终报告冒充它的签收。
- 部署、回滚、版本/本地补丁：fixed；covered offline。精确 Pi/bridge 版本和内容 hash，混合/漂移基线拒绝；完整隔离 home 安装、重复安装、回滚及冲突阻断。保留现有 footer/recovery 源码。只读 plan 不改生产；须主 agent 先验收，暂停旧 watchdog writer、安装、监督主 Pi 重启、迁移/对账后恢复调度。回滚保留新私有状态，不安全重放通知。

剩余生产验收包括：真实 Pi 插件生命周期与 owner 交接、实际 Telegram send/edit/message_id/线程归属、使用中的历史 writer 迁移与验收超时响应、主 agent 授权后续动作。当前没有真实模型/Telegram/QQ 测试，没有历史重复消息逐对 message_id 归因。安装基线 standalone TypeScript 已有诊断，本补丁验的是无新增诊断，不声称全包 typecheck 全绿。完整命令、测试输出和限制见交接说明及本地实现报告。


## 独立验收返工 1（替代相关首轮覆盖结论）

首轮 commit 697b6a3 的原离线测试通过，不等于下列遗漏已经覆盖。主 agent 独立证据 review-herdr-working.json 证明工作中 herdr 被误标 needs_reconciliation。本节如实修正首轮结论；父目录原 result/commit/证据保留，新证据在 rework-1。

- R1 herdr 实际嵌套 schema：fixed / covered offline / production pending。官方 CLI 导出 AgentInfo/AgentStatus schema 和脱敏 agent get 输出为 fixture 来源；working/running、blocked→working、done/idle 无结果、unknown/not-found、错误 schema、错误 pane/workspace、CLI PATH/失败均分别处理。runner 的真实 PID 出生身份优先，退出仍必须以实际结果为准。未知观察持久保存，超时单一事件；不立即把活跃任务判完成/失败。
- R2 有 run_id 无有效 runs 的 legacy：fixed / covered offline / production pending。migrate/reconcile 保留旧字段/快照且不重放；start-run 给出 adopt 要求，不再 KeyError。真实 CLI adopt-legacy 新建执行身份，close-legacy 以 inspection 和引用摘要显式归档，无伪造结果/退出码/成功状态；CAS 拒绝过期 inspection。覆盖缺映射、null、空/不完整 metadata、旧字段保留、重复/非法迁移与缺引用。
- R3 全树输入误抑制：fixed / covered offline / production pending。真实 Pi SessionManager 创建临时会话、重开文件、branch 导航；只查当前 getBranch，不把不活跃兄弟分支当已注入。已持久化但未处理的原 deadline 不会滚动延期；超时产生稳定恢复提示，提示后崩溃的未知 ACK 不重复提示，仍缺 handled proof 则持久 needs_attention。新分支可重新评估；处理 proof 跨分支有效；保留用户 quiet window、忙时队列和 shutdown 清理。
- R4 实际 QQ stdout 调用者：fixed / covered offline / production pending。QQ handoff 严格接受 queued DIGITS-DIGITS.json，新增 durable legacy_receipt 映射恢复该契约；显式结构化/--json 调用维持新协议 JSON。直接可执行、python、python -u、TEXT/SOURCE、多行文本、NOTIFY_PROFILE 和非零配置失败均覆盖。测试不运行外部业务脚本，不产生真实发送。
- 调用者核对：covered read-only。检查 ~/bin、~/dev（排除依赖/构建）、在线 extensions、LaunchAgents、相关 skill 指令，并补充 HOME 代码文件搜索；没有发现其他直接 spool writer。私有 caller-inventory.json 仅存路径/调用位置/契约分类。residual：未遍历原始会话、历史 artifact、依赖/缓存或不可读 Trash；动态拼接/未落盘命令不可能用静态搜索穷尽。部分现有调用者忽略失败或独立设置更短 timeout，其可靠性不等于本轮 CLI 兼容，不能宣称全部迁移完成。
- 原 sender/bridge patch 未修改，原 19 项和所有新增回归一起运行；仍验证补丁前自主→用户双发送、修后一次、跨线程、bus ACK unknown 等原边界。部署必须接受返工后的新 commit，不接受旧 commit 代替。生产 before hash 再次核验，运行时重启/上线仍由主 agent 负责。

## 后续重复 completion 修复

原先“empty guard 保留”的覆盖结论不涵盖 native retry 与 synthetic follow-up 重叠。后续离线重现已证明：空 error 的 agent_end 提前排入自动 follow-up，native retry 成功后仍消费它，导致同活动再次回复。新独立补丁改为 settlement 后基于当前分支判断，并在 owner sender 保留同 intent 的 in-flight/success/unknown 状态；详见 [重复回复修复](duplicate-reply-fix.md)。生产激活仍由主 maintainer 独立完成。
