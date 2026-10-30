#!/usr/bin/env python3
"""Real OpenCode agent execution with a local scripted model; no paid/free quota."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import probe_opencode

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = probe_opencode.ARTIFACTS


class ScriptedModel(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append(body)
        if getattr(self.server, 'reject_titles', False) and any('Reply with only the title.' in str(m.get('content')) for m in body.get('messages', [])):
            self.send_response(429)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': {'type': 'FreeUsageLimitError', 'message': 'Synthetic title quota limit'}}).encode())
            return
        tools = [item['function']['name'] for item in body.get('tools', [])]
        messages = body.get('messages', [])
        has_result = bool(messages and messages[-1].get('role') == 'tool')
        tool = self.server.tool
        delta = {'role': 'assistant', 'content': 'TOOL_COMPLETE' if has_result else 'TOOL_UNAVAILABLE'}
        finish = 'stop'
        if not has_result and tool in tools:
            delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call_local_probe', 'type': 'function',
                'function': {'name': tool, 'arguments': json.dumps(getattr(self.server, 'arguments', None) or {'command': self.server.command})}}]}
            finish = 'tool_calls'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Connection', 'close')
        self.end_headers()
        for change, ending in [(delta, None), ({}, finish)]:
            chunk = {'id': 'chatcmpl-local-probe', 'object': 'chat.completion.chunk', 'created': int(time.time()),
                     'model': 'test', 'choices': [{'index': 0, 'delta': change, 'finish_reason': ending}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()


class AgentIntegration(unittest.TestCase):
    def setUp(self):
        self.host = probe_opencode.ShellCompatibility(methodName='runTest')
        self.host.temporary_parent = tempfile.gettempdir()
        self.host.setUp()
        self.root, self.project = self.host.root, self.host.project
        # Give the disposable project its own trusted root rather than inheriting
        # the enclosing integration repository as OpenCode's canonical project.
        subprocess.run(['git', 'init', '--quiet', str(self.project)], check=True)
        self.model = ThreadingHTTPServer(('127.0.0.1', 0), ScriptedModel)
        self.model.requests = []
        self.model.tool = 'sandbox_shell'
        self.model.command = 'printf sandbox-result; touch okay'
        self.thread = threading.Thread(target=self.model.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.host.tearDown()
        self.model.shutdown(); self.model.server_close(); self.thread.join(timeout=2)

    def config(self, *, plugin=True, escape='ask', agent='build', existing_plugins=None, profile=None, terminal=True, source_permissions=None):
        original = {'default_agent': agent, 'agents': {agent: {'mode': 'primary', 'system': 'Execute the requested test tool exactly once.'}},
                    'permissions': [{'action': '*', 'resource': '*', 'effect': 'allow'}], 'plugins': existing_plugins or [],
                    'model': 'probe/test', 'update': 'disable',
                    'providers': {'probe': {'name': 'Local test', 'env': ['PROBE_API_KEY'],
                      'package': '@opencode/ai/providers/openai-compatible',
                      'settings': {'baseURL': f'http://127.0.0.1:{self.model.server_port}/v1', 'apiKey': 'local-test-only'},
                      'models': {'test': {'name': 'Local test'}}}}}
        if source_permissions:
            original['agents'][agent]['permissions'] = source_permissions
        source = self.root / 'input.json'; target = self.host.config / 'opencode.json'
        source.write_text(json.dumps(original))
        subprocess.run(['node', str(ROOT / 'config.mjs'), '--input', str(source), '--output', str(target)], check=True)
        c = json.loads(target.read_text())
        # Same private policy location used by the real plugin; no project option
        # is trusted to grant filesystem access.
        policy_dir = self.root / 'xdg-config/opencode-kit'; policy_dir.mkdir(parents=True, exist_ok=True)
        access = profile or ('planner' if agent == 'plan' else 'read-only' if agent == 'foreign/reviewer' else 'workspace-write')
        policy = {'schemaVersion': 1, 'scratchRoot': str(self.root / 'scratch'), 'agents': {
            agent: {'profile': access, 'shell': terminal, 'escape': 'ask' if agent == 'build' and terminal else 'deny'}}}
        policy_file = policy_dir / 'policy.json'; policy_file.write_text(json.dumps(policy)); policy_file.chmod(0o600)
        if not plugin:
            c['plugins'] = []
        else:
            c['plugins'][-1]['options'] = {'scratchRoot': str(self.root / 'scratch')}
        c['permissions'].append({'action': 'shell_unsandboxed', 'resource': '*', 'effect': escape})
        target.write_text(json.dumps(c))

    def api(self, operation, body=None):
        response = self.host.api(operation, body)
        self.assertEqual(response.returncode, 0, self.host.last)
        return json.loads(response.stdout) if response.stdout else None

    def begin(self):
        self.api('config.get')
        plugins = self.api('plugin.list')
        (ARTIFACTS / 'loaded-plugins.json').write_text(json.dumps(plugins, indent=2))
        result = self.api('session.create', {'location': {'directory': str(self.project)}})
        sid = result['data']['id']
        self.api(f'/api/session/{sid}/prompt', {'text': 'Execute the configured test tool now.'})
        return sid

    def finish(self, sid, *, decision=None, after_count=0):
        observed = []
        for _ in range(150):
            if decision:
                pending = self.api(f'/api/session/{sid}/permission')
                for request in pending.get('data', []):
                    observed.append(request)
                    self.api(f'/api/session/{sid}/permission/{request["id"]}/reply', {'decision': decision})
            context = self.api(f'/api/session/{sid}/context')
            text = json.dumps(context)
            terminal = any(m.get('type') == 'assistant' and m.get('finish') in ('stop', 'error') for m in context.get('data', [])[after_count:])
            if terminal:
                tool_requests = [r for r in self.model.requests if r.get('tools')]
                if tool_requests:
                    (ARTIFACTS / 'tool-schemas.json').write_text(json.dumps(tool_requests[0]['tools'], indent=2))
                (ARTIFACTS / (self._testMethodName + '.json')).write_text(json.dumps(context, indent=2))
                (ARTIFACTS / 'loaded-plugins.json').write_text(json.dumps(self.api('plugin.list'), indent=2))
                return context, observed
            time.sleep(.05)
        (ARTIFACTS / 'failed-context.json').write_text(json.dumps(context, indent=2))
        self.fail('Agent did not finish. Context tail: ' + text[-3000:] + '; model requests: ' + str(len(self.model.requests)))

    def test_sandbox_tool_runs_through_real_opencode(self):
        self.config(); context, _ = self.finish(self.begin())
        self.assertTrue((self.project / 'okay').exists(), json.dumps(context)[-4000:])
        self.assertIn('sandbox-result', json.dumps(context))
        self.assertIn('exit_code', json.dumps(context))

    def test_title_quota_failure_gets_a_local_title_and_the_normal_reply_still_succeeds(self):
        self.model.reject_titles = True
        self.config()
        sid = self.begin(); context, _ = self.finish(sid)
        for _ in range(50):
            session = self.api('/api/session/' + sid)['data']
            if session.get('title'): break
            time.sleep(.02)
        self.assertEqual(session.get('title'), 'Execute the configured test tool now')
        self.assertTrue((self.project / 'okay').exists())
        self.assertIn('TOOL_COMPLETE', json.dumps(context))

    def test_chat_avoids_workflow_context_but_keeps_file_web_and_sandbox_tools(self):
        injector = self.root / 'workflow-fixture'; injector.mkdir()
        (injector / 'package.json').write_text('{"type":"module"}')
        bootstrap = '<EXTREMELY_IMPORTANT>\nYou have superpowers.\nThe using-superpowers skill content is included below.\n**Tool Mapping for OpenCode:**\n</EXTREMELY_IMPORTANT>'
        (injector / 'index.js').write_text('import {createSuperpowersAdapter} from ' + json.dumps(str(ROOT / 'integrations/superpowers/index.js')) + '; export default createSuperpowersAdapter({id:"workflow-fixture",async setup(ctx){await ctx.session.hook("context",e=>{'
            + 'e.system.push({type:"text",text:"OpenCode goal mode policy:\\n- Manage goals only through the goal tools."});'
            + 'const user=e.messages.find(m=>m.role==="user");if(user)user.content.unshift({type:"text",text:' + json.dumps(bootstrap) + '});'
            + '});}});')
        self.config(agent='chat', existing_plugins=[str(injector)])
        target = self.host.config / 'opencode.json'; config = json.loads(target.read_text())
        pack = subprocess.run(['node', '--input-type=module', '-e',
            'import {readAgentPack} from "./kit/packs.mjs"; console.log(JSON.stringify(readAgentPack("./packs/deniz-agents").agents["deniz/chat"]));'],
            cwd=ROOT, capture_output=True, text=True, check=True)
        config['agents']['chat'] = json.loads(pack.stdout)
        config.setdefault('experimental', {})['todo'] = True
        target.write_text(json.dumps(config))
        context, _ = self.finish(self.begin())
        self.assertTrue((self.project / 'okay').exists(), json.dumps(context)[-3000:])
        # Startup warming may use the provider independently of this Chat turn.
        requests = [r for r in self.model.requests if r.get('tools') and any(
            m.get('role') == 'user' and 'Execute the configured test tool now.' in str(m.get('content'))
            for m in r.get('messages', []))]
        request = max(requests, key=lambda r: len(json.dumps(r)))
        names = {item['function']['name'] for item in request.get('tools', [])}
        self.assertTrue({'read', 'edit', 'write', 'glob', 'grep', 'webfetch', 'websearch', 'sandbox_shell', 'shell_unsandboxed'} <= names, names)
        self.assertFalse({'subagent', 'skill', 'todowrite', 'execute'} & names, names)
        self.assertFalse(any(name.startswith('opencode_') for name in names), names)
        self.assertFalse(any('goal' in name for name in names), names)
        sent = json.dumps(request['messages'])
        self.assertNotIn('You have superpowers.', sent)
        self.assertNotIn('OpenCode goal mode policy:', sent)
        self.assertIn('Execute the configured test tool now.', sent)

    def test_external_write_is_blocked(self):
        marker = ARTIFACTS / ('outside-' + self.root.name)
        self.addCleanup(marker.unlink, missing_ok=True)
        self.model.command = 'touch ' + str(marker)
        self.config(); context, _ = self.finish(self.begin())
        self.assertFalse(marker.exists(), json.dumps(context)[-3000:])
        self.assertIn('Read-only file system', json.dumps(context))

    def test_native_shell_is_unavailable_without_plugin(self):
        marker = self.root / 'escaped'
        self.model.tool = 'shell'; self.model.command = 'touch ' + str(marker)
        self.config(plugin=False)
        context, _ = self.finish(self.begin())
        self.assertIn('TOOL_UNAVAILABLE', json.dumps(context))
        self.assertFalse(marker.exists())

    def test_failed_plugin_keeps_native_shell_denied(self):
        self.config(plugin=False)
        broken = self.root / 'broken-plugin'; broken.mkdir()
        (broken / 'index.js').write_text('throw new Error("deliberate plugin load failure"); export default {};')
        p = self.host.config / 'opencode.json'; c = json.loads(p.read_text())
        c['plugins'] = [str(broken)]
        c['policies'].append({'action': 'integration.use', 'resource': 'plugin:' + str(broken), 'effect': 'allow'})
        p.write_text(json.dumps(c))
        marker = self.root / 'escaped'
        self.model.tool = 'shell'; self.model.command = 'touch ' + str(marker)
        context, _ = self.finish(self.begin())
        self.assertIn('TOOL_UNAVAILABLE', json.dumps(context)); self.assertFalse(marker.exists())
        records = json.loads((ARTIFACTS / 'loaded-plugins.json').read_text())['data']
        self.assertTrue(any(r.get('state', {}).get('status') == 'failed' for r in records), records)

    def test_project_cannot_override_global_shell_policy(self):
        self.config(plugin=False)
        (self.project / 'opencode.json').write_text(json.dumps({
            'permissions': [{'action': 'shell', 'resource': '*', 'effect': 'allow'}],
            'policies': [{'action': 'tool.use', 'resource': 'shell:*', 'effect': 'allow'}],
        }))
        self.model.tool = 'shell'; self.model.command = 'touch should-not-run'
        context, _ = self.finish(self.begin())
        self.assertIn('Blocked by configuration policy', json.dumps(context))
        self.assertFalse((self.project / 'should-not-run').exists())

    def test_unapproved_project_plugin_is_blocked_before_import(self):
        self.config()
        marker = self.root / 'unapproved-plugin-executed'
        plugin_dir = self.project / '.opencode/plugins'; plugin_dir.mkdir(parents=True)
        (plugin_dir / 'evil.js').write_text(
            'import fs from "node:fs"; fs.writeFileSync(' + json.dumps(str(marker)) + ', "executed");\n'
            'export default {id:"unapproved",setup(){}};\n')
        context, _ = self.finish(self.begin())
        self.assertTrue((self.project / 'okay').exists(), json.dumps(context)[-3000:])
        self.assertFalse(marker.exists(), 'Unapproved plugin executed host-side code at import')

    def test_explicit_escape_deny_remains_denied(self):
        marker = self.root / 'denied'
        self.model.tool = 'shell_unsandboxed'; self.model.command = 'touch ' + str(marker)
        self.config(escape='deny')
        context, prompts = self.finish(self.begin(), decision='once')
        self.assertFalse(prompts, 'An explicit deny was changed into an approval request')
        self.assertFalse(marker.exists(), json.dumps(context)[-3000:])

    def test_existing_global_plugins_remain_active(self):
        user_config = Path.home() / '.config/opencode/opencode.json'
        if not user_config.exists():
            self.skipTest('No existing user plugins to check on this host')
        packages = json.loads(user_config.read_text()).get('plugins', [])
        # Avoid loading the previous sandbox plugin and the candidate with the
        # same plugin ID into one disposable server.
        packages = [p for p in packages if 'opencode-sandbox' not in (p if isinstance(p, str) else p['package']) and ('/opencode-kit/versions/' not in (p if isinstance(p, str) else p['package']) or (p if isinstance(p, str) else p['package']).endswith('/integrations/superpowers'))]
        self.host.env['XDG_CACHE_HOME'] = str(Path.home() / '.cache')
        self.config(existing_plugins=packages)
        context, _ = self.finish(self.begin())
        records = self.api('plugin.list')['data']
        external = [r for r in records if r.get('source', {}).get('type') != 'builtin']
        (ARTIFACTS / 'existing-plugin-states.json').write_text(json.dumps(external, indent=2))
        expected = {p if isinstance(p, str) else p['package'] for p in packages} | {str(ROOT)}
        self.assertGreaterEqual(len(external), len(expected), external)
        self.assertTrue(all(r.get('state', {}).get('status') == 'active' for r in external), external)
        self.assertTrue((self.project / 'okay').exists(), json.dumps(context)[-2000:])

    def test_session_move_changes_only_the_trusted_workspace(self):
        self.config(); sid = self.begin(); context, _ = self.finish(sid)
        second = self.root / 'second-project'; second.mkdir()
        subprocess.run(['git', 'init', '--quiet', str(second)], check=True)
        self.model.command = 'touch moved-marker; pwd'
        self.api(f'/api/session/{sid}/move', {'directory': str(second)})
        self.api(f'/api/session/{sid}/prompt', {'text': 'Execute the test tool in the moved session.'})
        context, _ = self.finish(sid, after_count=len(context['data']))
        self.assertTrue((second / 'moved-marker').exists(), json.dumps(context)[-3000:])
        self.assertFalse((self.project / 'moved-marker').exists())

    def test_allowed_escape_is_forced_to_prompt_and_rejection_prevents_execution(self):
        marker = self.root / 'rejected'
        self.model.tool = 'shell_unsandboxed'; self.model.command = 'touch ' + str(marker)
        self.config(escape='allow')
        context, prompts = self.finish(self.begin(), decision='reject')
        self.assertTrue(prompts, 'No permission prompt was observed')
        self.assertFalse(marker.exists(), json.dumps(context)[-3000:])

    def test_approved_escape_executes_the_exact_command(self):
        marker = self.root / 'approved'
        self.model.tool = 'shell_unsandboxed'; self.model.command = 'touch ' + str(marker)
        self.config()
        context, prompts = self.finish(self.begin(), decision='once')
        self.assertTrue(prompts)
        self.assertTrue(marker.exists(), json.dumps(context)[-3000:])

    def test_planner_shell_writes_plans_and_scratch_but_not_source(self):
        self.config(agent='plan')
        self.model.command = 'touch src-denied; mkdir -p docs/superpowers/plans; printf planned > docs/superpowers/plans/test.md; touch "$TMPDIR/scratch-plan"'
        context, _ = self.finish(self.begin())
        self.assertFalse((self.project / 'src-denied').exists())
        self.assertEqual((self.project / 'docs/superpowers/plans/test.md').read_text(), 'planned', json.dumps(context)[-4000:])

    def test_foreign_reviewer_stays_readonly_despite_project_plugin_options(self):
        self.config(agent='foreign/reviewer')
        (self.project / 'opencode.json').write_text(json.dumps({'plugins': [{'package': str(ROOT), 'options': {'readOnly': False, 'policyFile': '/tmp/untrusted'}}],
            'agents': {'foreign/reviewer': {'permissions': [{'action': '*', 'resource': '*', 'effect': 'allow'}]}}}))
        self.model.command = 'touch reviewer-write; printf reviewer-tested'
        context, _ = self.finish(self.begin())
        self.assertFalse((self.project / 'reviewer-write').exists())
        self.assertIn('reviewer-tested', json.dumps(context))

    def test_imported_terminal_denial_cannot_use_replacement_shell(self):
        self.config(agent='foreign/reviewer', terminal=False)
        self.model.command = 'touch terminal-denied'
        context, prompts = self.finish(self.begin(), decision='once')
        self.assertFalse((self.project / 'terminal-denied').exists()); self.assertFalse(prompts)

    def test_planner_native_edit_cannot_write_application_source(self):
        self.config(agent='plan')
        (self.project / 'source.txt').write_text('original')
        self.model.tool = 'edit'
        self.model.arguments = {'path': str(self.project / 'source.txt'), 'oldString': 'original', 'newString': 'must not write'}
        context, prompts = self.finish(self.begin(), decision='once')
        self.assertEqual((self.project / 'source.txt').read_text(), 'original'); self.assertFalse(prompts)
        self.assertNotIn('TOOL_UNAVAILABLE', json.dumps(context))

    def test_planner_native_write_creates_only_a_planning_document(self):
        self.config(agent='plan')
        self.model.tool = 'write'
        self.model.arguments = {'path': str(self.project / 'docs/superpowers/plans/native.md'), 'content': 'Native plan'}
        context, prompts = self.finish(self.begin(), decision='once')
        self.assertEqual((self.project / 'docs/superpowers/plans/native.md').read_text(), 'Native plan', json.dumps(context)[-4000:])
        self.assertFalse(prompts)

    def test_todo_dependency_exposes_the_actual_tool(self):
        self.config()
        target = self.host.config / 'opencode.json'; c = json.loads(target.read_text())
        c.setdefault('experimental', {})['todo'] = True; target.write_text(json.dumps(c))
        context, _ = self.finish(self.begin())
        names = {item['function']['name'] for request in self.model.requests for item in request.get('tools', [])}
        self.assertIn('todowrite', names, json.dumps(context)[-2000:])

    def test_scoped_imported_shell_deny_survives_a_renamed_agent(self):
        self.config(agent='team/renamed', profile='read-only', source_permissions=[{'action': 'shell', 'resource': 'printf forbidden*', 'effect': 'deny'}])
        scratch = self.root / 'scratch' / hashlib.sha256(str(self.project.resolve()).encode()).hexdigest()[:16] / 'tmp'
        self.model.command = 'printf forbidden; touch "$TMPDIR/denied"'
        context, prompts = self.finish(self.begin(), decision='once')
        self.assertFalse((scratch / 'denied').exists(), json.dumps(context)[-3000:]); self.assertFalse(prompts)
        self.model.command = 'printf allowed; touch "$TMPDIR/permitted"'
        context, _ = self.finish(self.begin())
        self.assertTrue((scratch / 'permitted').exists(), json.dumps(context)[-3000:])

    def test_scoped_source_shell_deny_also_blocks_escape(self):
        self.config(source_permissions=[{'action': 'shell', 'resource': 'touch *', 'effect': 'deny'}])
        marker = self.root / 'escape-denied-by-source'; self.model.tool = 'shell_unsandboxed'; self.model.command = 'touch ' + str(marker)
        context, prompts = self.finish(self.begin(), decision='once')
        self.assertFalse(marker.exists(), json.dumps(context)[-3000:]); self.assertFalse(prompts)


if __name__ == '__main__':
    unittest.main(verbosity=2)
