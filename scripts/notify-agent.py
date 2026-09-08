#!/usr/bin/env python3
"""Compatible: notify-agent.py TEXT [SOURCE]. Structured identity is never truncated."""
import argparse, json, os, time, uuid
from task_protocol import ROOT, enqueue, event_id

def main():
    p=argparse.ArgumentParser();p.add_argument('text');p.add_argument('source',nargs='?',default='')
    p.add_argument('--root',default=str(ROOT));p.add_argument('--task-id');p.add_argument('--run-id')
    p.add_argument('--event-id');p.add_argument('--result-path');p.add_argument('--route');p.add_argument('--phase')
    p.add_argument('--json',action='store_true',help='request JSON receipt for a legacy notification')
    a=p.parse_args()
    if not a.text.strip(): p.error('text required')
    fields={k:getattr(a,k) for k in ('task_id','run_id','event_id','result_path') if getattr(a,k)}
    if a.task_id and a.run_id and not a.event_id:
        if not a.phase: p.error('--phase required with task/run when event-id is omitted')
        fields['event_id']=event_id(a.task_id,a.run_id,a.phase)
    if a.route: fields['route']=json.loads(a.route)
    legacy=not fields and not a.phase and not a.json
    if legacy:
        # QQ handoff validates this exact legacy receipt grammar. It is an
        # admission token backed by the inbox, not a newly created spool file.
        fields.update(event_id=uuid.uuid4().hex,legacy_receipt=f'{time.time_ns()}-{os.getpid()}.json')
    eid=enqueue(a.root,a.text,a.source,fields)
    print('queued '+fields['legacy_receipt'] if legacy else json.dumps({'state':'success','event_id':eid,'receipt':'durable_inbox'}))
if __name__=='__main__': main()
