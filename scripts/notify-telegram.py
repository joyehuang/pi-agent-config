#!/usr/bin/env python3
"""One-attempt Telegram notification with explicit confirmed/failed/unknown receipt.
Legacy TEXT invocation and NOTIFY_PROFILE remain supported. Never log exception URLs.
"""
import argparse, json, os, sys, time, urllib.request, urllib.parse, urllib.error, uuid
from pathlib import Path
from task_protocol import ROOT, transaction, digest, delivery_hash

def send(text, config, profile='personal', opener=urllib.request.urlopen, target=None):
    try: cfg=json.loads(Path(config).read_text())
    except (OSError,ValueError): return {'state':'failed','reason':'configuration_unavailable'}
    if not isinstance(cfg,dict) or not isinstance(cfg.get('profiles'),dict): return {'state':'failed','reason':'configuration_invalid'}
    prof=cfg['profiles'].get(profile,{})
    if not isinstance(prof,dict): return {'state':'failed','reason':'configuration_invalid'}
    token=prof.get('botToken');chat=prof.get('allowedUserId')
    if not token or not chat: return {'state':'failed','reason':'skipped_missing_configuration'}
    target=target or {'chatId':chat}
    if target.get('chatId')!=chat: return {'state':'failed','reason':'target_not_paired'}
    payload={'chat_id':chat,'text':text}
    if target.get('threadId') is not None: payload['message_thread_id']=target['threadId']
    req=urllib.request.Request('https://api.telegram.org/bot'+token+'/sendMessage',data=urllib.parse.urlencode(payload).encode())
    try:
        with opener(req,timeout=15) as r:
            data=json.loads(r.read())
            if not 200<=r.status<300: return {'state':'unknown','reason':'unexpected_http_status'}
            if data.get('ok') is not True: return {'state':'failed','reason':'api_rejected'}
            mid=data.get('result',{}).get('message_id')
            if not isinstance(mid,int) or isinstance(mid,bool): return {'state':'unknown','reason':'missing_message_id'}
            return {'state':'success','status':'success','message_id':mid,'target':target}
    except urllib.error.HTTPError as e:
        return {'state':'failed' if 400<=e.code<500 else 'unknown','reason':'http_error','http_status':e.code}
    except Exception: return {'state':'unknown','reason':'transport_or_response_unknown'}

def durable_send(root,eid,text,config,profile,opener=urllib.request.urlopen,target=None):
    key=digest([eid,profile,target]);h=delivery_hash(text)
    with transaction(root,'telegram-receipts.json') as receipts:
        previous=receipts.get(key)
        if previous:
            if previous['hash']!=h: raise ValueError('event payload collision')
            if previous['state'] in ('success','unknown','sending'): return previous if previous['state']!='sending' else {'state':'unknown','reason':'previous_attempt_unresolved'}
        receipts[key]={'state':'sending','hash':h,'event_id':eid}
    result=send(text,config,profile,opener,target)
    result["at"]=time.time()
    with transaction(root,'telegram-receipts.json') as receipts:
        receipts[key]=dict(result,hash=h,event_id=eid)
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument('text');p.add_argument('--event-id');p.add_argument('--root',default=str(ROOT))
    p.add_argument('--config',default=str(Path.home()/'.pi/agent/telegram.json'));p.add_argument('--target')
    a=p.parse_args()
    if not a.text.strip(): p.error('text required')
    r=durable_send(a.root,a.event_id or uuid.uuid4().hex,a.text,a.config,os.environ.get('NOTIFY_PROFILE','personal'),target=json.loads(a.target) if a.target else None)
    print(json.dumps(r));return 0 if r['state']=='success' else 2 if r['state']=='unknown' else 1
if __name__=='__main__':
    try: sys.exit(main())
    except Exception as error:
        print(json.dumps({'state':'failed','reason':type(error).__name__}));sys.exit(1)
