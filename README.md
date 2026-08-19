# pi-agent-config

Joye 的 pi coding agent 个性化配置与扩展（当前机器：Mac mini）。

> ⚠️ 本仓库只存**配置模板与扩展源码**，不含任何真实密钥。真实配置（含 bot token）在本地 `~/.pi/agent/`，已被 .gitignore 排除。

## 结构

```
extensions/           pi 扩展源码（agent 启动时加载）
  memory-inject/      记忆注入扩展（~/.memory.md 注入 system prompt）
  session-recap.ts    每轮 recap 落盘 ~/.pi/agent/recaps/ 索引
  pi-session-search.ts 跨会话检索工具（调 ~/bin/pi-search）
  telegram-restart.ts Telegram 远程重启/状态/日志命令
  command-code-provider.ts cmd-code provider
  pi-plugin-probe.ts  插件探针
telegram.example.json Telegram bridge 配置模板（token 已打码）
settings.example.json pi 全局设置模板（packages / extensions / models）
```

## 使用

```bash
# 复制模板到实际位置并填入真实值
cp telegram.example.json ~/.pi/agent/telegram.json   # 填入 bot token
cp settings.example.json ~/.pi/agent/settings.json
cp -r extensions/ ~/.pi/agent/extensions/
```

## Telegram 信息密度

pi-telegram bridge 的 Activity 投影控制 Telegram 侧展示的 agent trajectory：

| mode | thinking | tool evidence | final reply |
|---|---|---|---|
| verbose | yes | yes | yes |
| thinking | yes | no | yes |
| tools | no | yes | yes |
| quiet | no | no | yes |

当前使用 `quiet`（`assistant.activity`），Telegram 只显示最终回复。`/settings` 菜单可切换。

## 部署约定

- 改动后立即 `git add -A && git commit && git push`
- 真实密钥只存 `~/.config/`（0600），不写入本仓库
