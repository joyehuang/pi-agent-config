# 独立 Codex Agent provider

`extensions/openai-codex-agent.ts` 注册 `openai-codex-agent`，与现有 `openai-codex` 共存。目标模型为 `openai-codex-agent/gpt-6-astra`。内置 Codex 模型目录来自当前 pi，Astra 的自定义模型元数据保留为源码快照；本机验证版本为 pi 0.84.1。

扩展每次请求只读 `/Users/joye/.config/codex-agent/auth.json` 的 access_token，校验文件权限、格式、到期时间与账号字段一致性。不复制、刷新或写入任何凭据，不回退到 pi 已有凭据、环境变量或调用方 apiKey。不提供 pi 内登录。这里的 API-key resolver 只是原生 bearer token 的适配入口。

thinking、service tier、重试、transport 和 onPayload 均按原生 provider 透传；扩展不强制 medium，也不启用 fast。调用方自行选择 thinking。本次验证分别使用 medium 和 low，均未指定 service_tier。

## 增量安装

在本仓库根目录运行下列脚本。改前为已有目标写同目录 `.bak-<timestamp>`，扩展设为 0600，settings 只追加一个 extensions 条目。不要复制整个 settings.example.json，不修改 auth.json、models.json 或默认模型。

```sh
python3 - <<'PY'
from pathlib import Path
import datetime, json, shutil, os
stamp = datetime.datetime.now().strftime('%Y%m%dT%H%M%S%f')
src = Path('extensions/openai-codex-agent.ts')
dst = Path.home() / '.pi/agent/extensions/openai-codex-agent.ts'
settings = Path.home() / '.pi/agent/settings.json'
entry = '~/.pi/agent/extensions/openai-codex-agent.ts'
obj = json.loads(settings.read_text())
dst.parent.mkdir(parents=True, exist_ok=True)
if dst.exists():
    shutil.copy2(dst, str(dst) + '.bak-' + stamp)
shutil.copy2(settings, str(settings) + '.bak-' + stamp)
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.fchmod(fd, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(src.read_text())
if entry not in obj.setdefault('extensions', []):
    obj['extensions'].append(entry)
settings.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n')
PY
```

本文件中的凭据路径是 Joye 本机专用路径；其它机器部署需自行确认只读来源。安装不重启进程、不执行 `/reload`，现有会话不因此重新加载。未来正常启动的 pi 会按扩展配置加载。

## 凭据续期要求

**本版不做 token 刷新。access_token 过期或剩余有效期不足五分钟时，provider fail-closed。** 必须由外部凭据管理者（codex-agent CLI 或面向同一 Codex 配置目录的 `codex login`）重新登录/刷新，再进行下一次请求。不要在默认 `~/.codex` 目录误登录或切换账号。安装和验证脚本不会执行登录或刷新。

底层错误为 `AGENT_AUTH_UNAVAILABLE`；pi CLI 在认证预检查中可能将其折叠为 `No API key found for openai-codex-agent`。两者都不会触发备用账号请求。

## 验证记录（2026-09-10 第二轮）

隔离 `PI_CODING_AGENT_DIR`，显式 `-e /Users/joye/.pi/agent/extensions/openai-codex-agent.ts`，禁用其它扩展、工具、技能及会话持久化。真实 `pi -p --provider openai-codex-agent --model gpt-6-astra --thinking medium ...` 返回 `PI_CODEX_AGENT_OK`（6.066 秒，退出码 0）；low 返回相同结果（5.652 秒，退出码 0）。只读 `before_provider_request` 观察器分别记录 effort=medium/low，service_tier 均未指定。

缺失凭据负例仅改临时副本的 AUTH_PATH：CLI 退出 1；直接调用该副本的 stream 和 streamSimple 都报 `AGENT_AUTH_UNAVAILABLE`，即便提供备用 apiKey 也不会回退，网络尝试数为 0。主配置下只读 `pi --list-models`（抑制其它扩展启动）同时列出两种 provider 及各自的 Astra。

可复现脚本和完整脱敏命令保存在本机 `/Users/joye/research/pi-codex-multi-account-2026-09-10.round2/`，主报告与 evidence.json 位于其父目录。远端请求成功不独立证明 Pro 订阅、额度或当前执行 agent 的模型/账号；凭据来源遵守指定路径，未切换账号或模型。多轮工具调用及未来 pi 升级未验证。

## 回滚

1. 先备份当前 settings.json；仅从 extensions 数组删除 `~/.pi/agent/extensions/openai-codex-agent.ts`，保留其它条目和默认值。不要用旧 settings 备份覆盖后续修改。
2. 本轮目标原先不存在，可仅删除新增的 `~/.pi/agent/extensions/openai-codex-agent.ts`；后续覆盖安装时则恢复该扩展的对应 `.bak-<timestamp>`，权限设为 0600。
3. 仓库回滚只 revert 本扩展与说明的提交并按需 push；仓库回滚不自动修改本机安装。
4. 不恢复/改写 auth.json、models.json 或 `~/.codex/**`。不主动重启、reload 或操纵现有进程。
