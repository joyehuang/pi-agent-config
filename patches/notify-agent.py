#!/usr/bin/env python3
"""Repository compatibility entry. Deploy the guarded bundle, not this shim."""
from pathlib import Path
import runpy, sys
script=Path(__file__).resolve().parents[1]/'scripts/notify-agent.py'
if not script.is_file():
    sys.exit('Install notify-agent.py and task_protocol.py using scripts/deploy_fix.py')
sys.path.insert(0,str(script.parent))
runpy.run_path(str(script),run_name='__main__')
