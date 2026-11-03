#!/usr/bin/env python3
"""Quota-free real terminal smoke test. All sessions/config/data are disposable."""
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time
from opencode_integration import AgentIntegration, ROOT, ARTIFACTS

h=AgentIntegration(methodName='runTest');h.setUp();process=None;master=None;raw=bytearray()
try:
    h.model.report_usage=True
    h.config(existing_plugins=[str(ROOT/'integrations/usage')])
    master,slave=pty.openpty()
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',50,140,0,0))
    process=subprocess.Popen(['opencode','--standalone',str(h.project)],cwd=h.project,
        env=dict(h.host.env,TERM='xterm-256color'),stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
    os.close(slave)
    def screen():
        return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',raw.decode(errors='replace'))
    def wait_for(text,seconds):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            if select.select([master],[],[],.1)[0]:
                try:raw.extend(os.read(master,65536))
                except OSError:break
            if text in screen():return
            if process.poll() is not None:break
        raise AssertionError('Terminal did not show '+repr(text)+'; see usage-tui-screen.txt')
    wait_for('Ask anything',15)
    time.sleep(.5)
    os.write(master,b'hello\r')
    wait_for('TOOL_COMPLETE',15)
    os.write(master,b'/usage-live\r')
    time.sleep(.3)
    os.write(master,b'\r')
    wait_for('Observed session family',15)
    assert 'Provider billing: unknown' in screen(), 'Billing provenance missing'
    assert 'By agent / model' in screen(), 'Agent breakdown missing'
    assert 'Usage unavailable' not in screen(), 'Usage RPC failed'
    os.write(master,b'\x1b')
    print('PASS actual OpenCode TUI: plugin loaded, /usage-live rendered live counters, unknown billing and agent breakdown')
finally:
    ARTIFACTS.mkdir(parents=True,exist_ok=True)
    (ARTIFACTS/'usage-tui-screen.txt').write_text(raw.decode(errors='replace'))
    if process:
        try:os.killpg(process.pid,signal.SIGTERM);process.wait(timeout=3)
        except (ProcessLookupError,subprocess.TimeoutExpired):
            try:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=3)
            except ProcessLookupError:pass
    if master is not None:os.close(master)
    h.tearDown()
