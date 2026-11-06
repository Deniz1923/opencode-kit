#!/usr/bin/env python3
"""Quota-free compatibility checks against the installed OpenCode binary.

Every subprocess uses disposable config, data, cache and state directories.
The probe shell never executes the submitted command.
"""

import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time
import unittest
import urllib.request
import urllib.error
import socket
import re
import base64


ARTIFACTS = Path(os.environ.get('OPENCODE_KIT_TEST_ARTIFACTS', str(Path(__file__).resolve().parents[1] / '.artifacts')))


class ShellCompatibility(unittest.TestCase):
    def setUp(self):
        ARTIFACTS.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='compat-', dir=getattr(self, 'temporary_parent', ARTIFACTS))
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()
        self.config = self.root / 'config'
        self.config.mkdir()
        self.env = dict(os.environ,
                        OPENCODE_CONFIG_DIR=str(self.config),
                        XDG_CONFIG_HOME=str(self.root / 'xdg-config'),
                        XDG_DATA_HOME=str(self.root / 'data'),
                        XDG_STATE_HOME=str(self.root / 'state'),
                        XDG_CACHE_HOME=str(self.root / 'cache'))
        self.submitted = self.root / 'submitted-command-ran'
        self.record = self.root / 'wrapper-invocation'

    def tearDown(self):
        if hasattr(self, 'server'):
            self.server.terminate()
            try:
                self.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.server.wait()
            self.server_log.close()
        self.temp.cleanup()

    def configure(self, shell):
        (self.config / 'opencode.json').write_text(json.dumps({
            'plugins': [], 'shell': str(shell),
            'update': 'disable',
            'permissions': [{'action': '*', 'resource': '*', 'effect': 'deny'}],
        }))

    def api(self, operation, body=None):
        if not hasattr(self, 'server'):
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            self.base = f'http://127.0.0.1:{port}'
            self.server_log = (self.root / 'server.log').open('w+')
            self.server = subprocess.Popen(
                ['opencode', 'serve', '--hostname', '127.0.0.1', '--port', str(port)],
                cwd=self.project, env=self.env, stdout=self.server_log,
                stderr=subprocess.STDOUT)
            for _ in range(100):
                try:
                    log = (self.root / 'server.log').read_text()
                    match = re.search(r'^server password (\S+)', log, re.M)
                    if not match:
                        time.sleep(.05)
                        continue
                    self.auth = 'Basic ' + base64.b64encode(('opencode:' + match[1]).encode()).decode()
                    request = urllib.request.Request(self.base + '/api/config', headers={'Authorization': self.auth})
                    urllib.request.urlopen(request, timeout=.2).close()
                    break
                except urllib.error.HTTPError as error:
                    error.close()
                    self.fail(f'Authenticated readiness request failed: HTTP {error.code}')
                except (OSError, urllib.error.URLError):
                    if self.server.poll() is not None:
                        self.server_log.seek(0)
                        self.fail(self.server_log.read())
                    time.sleep(.05)
            else:
                self.fail('Server did not start')
        paths = {'config.get': '/api/config', 'shell.create': '/api/shell',
                 'plugin.list': '/api/plugin', 'session.create': '/api/session'}
        url = self.base + paths.get(operation, operation)
        request = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                         headers={'Content-Type': 'application/json', 'Authorization': self.auth})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                result = subprocess.CompletedProcess([], 0, response.read().decode(), '')
        except urllib.error.HTTPError as error:
            result = subprocess.CompletedProcess([], error.code, error.read().decode(), '')
            error.close()
        self.last = {'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
        return result

    def execute(self):
        config = self.api('config.get')
        self.assertEqual(config.returncode, 0, self.last)
        self.api('session.create', {'location': {'directory': str(self.project)}})
        plugins = self.api('plugin.list')
        self.assertEqual(plugins.returncode, 0, self.last)
        result = self.api('shell.create', {
            'command': 'touch ' + shlex.quote(str(self.submitted)),
            'cwd': str(self.project), 'timeout': 2000,
        })
        if result.returncode == 0:
            info = json.loads(result.stdout)['data']
            for _ in range(100):
                result = self.api('/api/shell/' + info['id'])
                if json.loads(result.stdout)['data']['status'] != 'running':
                    break
                time.sleep(.02)
        return result

    def test_configured_shell_is_invoked(self):
        shell = self.root / 'probe-shell'
        shell.write_text('#!/bin/bash\nprintf "%s\\n" "$@" > '
                         + shlex.quote(str(self.record)) + '\nexit 77\n')
        shell.chmod(0o700)
        self.configure(shell)
        self.execute()
        self.assertTrue(self.record.exists(), self.last)
        self.assertIn('-c', self.record.read_text(), self.last)
        self.assertFalse(self.submitted.exists(), self.last)
        self.save_result('custom-shell')

    def test_missing_shell_does_not_fall_back(self):
        self.configure(self.root / 'nonexistent-shell')
        self.execute()
        self.save_result('missing-shell')
        self.assertFalse(self.submitted.exists(), self.last)
        self.assertTrue(self.last['exit'] or 'error' in self.last['stdout'].lower()
                        or '127' in self.last['stdout'], self.last)

    def save_result(self, name):
        (ARTIFACTS / (name + '.json')).write_text(json.dumps({
            **self.last, 'submitted_command_executed': self.submitted.exists(),
            'wrapper_invoked': self.record.exists(),
        }, indent=2) + '\n')

    def test_config_sources_are_disposable(self):
        self.configure(self.root / 'nonexistent-shell')
        result = self.api('config.get')
        self.assertEqual(result.returncode, 0, self.last)
        self.assertIn(str(self.config), result.stdout)
        self.assertNotIn(str(Path.home() / '.config/opencode/opencode.json'), result.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
