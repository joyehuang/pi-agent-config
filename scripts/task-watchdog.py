#!/usr/bin/env python3
"""Reconciliation and durable notification retry are independent on every tick."""
import argparse, json, os, subprocess, sys
from pathlib import Path
from task_protocol import ROOT, reconcile, drain

def sender(root,target,event):
    phase=event['phase'];label=('待验收' if phase in ('ready_for_review','done','review_overdue') else
      '已验收，交付待签收' if phase in ('verified','verified_overdue') else '任务状态（未经目标验收）')
    text=f"{label}：{event['task_id']} / {event['run_id']} · {phase}。事件 {event['event_id']}"
    if event.get('human_reason'): text=f"任务需要关注：{event['task_id']} / {event['run_id']} · {event['human_reason']}"
    if target=='agent':
        cmd=[sys.executable,str(Path(__file__).with_name('notify-agent.py')),text,'task-watchdog','--root',str(root),
          '--task-id',event['task_id'],'--run-id',event['run_id'],'--event-id',event['event_id'],'--route',json.dumps(event['route'])]
        if event.get('result_path'):cmd+=['--result-path',event['result_path']]
    else:
        cmd=[sys.executable,str(Path(__file__).with_name('notify-telegram.py')),text,'--root',str(root),'--event-id',event['event_id']]
        if event['route'].get('target'):cmd+=['--target',json.dumps(event['route']['target'])]
    try:
        p=subprocess.run(cmd,capture_output=True,text=True,timeout=25,env=dict(os.environ,NOTIFY_PROFILE=event['route'].get('profile','personal')))
        result=json.loads(p.stdout)
        if p.returncode and result.get('state')=='success': return {'state':'unknown'}
        return result
    except Exception:return {'state':'unknown' if target=='telegram' else 'failed'}

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=ROOT);p.add_argument('--offline',action='store_true');a=p.parse_args()
    failed=False
    try:
        reconcile(a.root)
    except Exception as error:
        failed=True
        print(json.dumps({'phase':'reconcile','error':type(error).__name__}),file=sys.stderr)
    finally:
        if not a.offline: drain(a.root,lambda target,event:sender(a.root,target,event))
    return int(failed)
if __name__=='__main__':sys.exit(main())
