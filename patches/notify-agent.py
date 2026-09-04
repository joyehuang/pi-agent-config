#!/usr/bin/env python3
"""notify-agent.py — 给 pi agent 注入后台任务通知（写 spool 文件，relay-notify 扩展消费）

用法：python3 ~/bin/notify-agent.py "任务X完成，PR链接 https://..."
后台 relay 脚本的标准收尾：先 notify-telegram.py 通知用户，再 notify-agent.py 通知 agent。
"""
import json, sys, time, os

SPOOL = os.path.expanduser("~/.pi/agent/notifications")
os.makedirs(SPOOL, exist_ok=True)

text = sys.argv[1] if len(sys.argv) > 1 else ""
source = sys.argv[2] if len(sys.argv) > 2 else ""
if not text.strip():
    sys.exit("usage: notify-agent.py <text> [source]")

name = f"{int(time.time()*1000)}-{os.getpid()}.json"
tmp = os.path.join(SPOOL, f".tmp-{name}")
with open(tmp, "w") as f:
    json.dump({"text": text[:500], "source": source, "ts": int(time.time()*1000)}, f, ensure_ascii=False)
os.rename(tmp, os.path.join(SPOOL, name))
print(f"queued {name}")
