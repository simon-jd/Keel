"""Scripted original virtual handlers and actual TS guard; never model metrics."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from loguru import logger
logger.remove()

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

class TauSecurityTests(unittest.TestCase):
    def test_original_agent_handler_allow_deny_and_user_role_cannot_be_forged(self):
        from tau2_security import tool_boundary
        from tau2.orchestrator.orchestrator import BaseOrchestrator, Role
        from tau2.domains.mock.environment import get_environment
        from tau2.data_model.message import ToolCall
        from keel_guard import KeelGuard
        for policy in ('none', 'capability', 'taint', 'plan', 'all'):
            with self.subTest(policy=policy), tempfile.TemporaryDirectory(prefix='keel-task13-') as directory:
                env = get_environment()
                user_id = next(iter(env.tools.db.users))
                task_id = next(iter(env.tools.db.tasks))
                before = len(env.tools.db.tasks)
                config = {'tenantId': 'fixture', 'runId': '10000000-0000-4000-8000-000000000013',
                    'capabilities': ['get_users'], 'tools': {'get_users': {'sideEffect': False}, 'create_task': {'sideEffect': True}},
                    'benchmark': {'policy': policy, 'taskHash': 'trusted-initial-task'}, 'options': {'plan': ['get_users']}}
                path = Path(directory) / 'config.json'; path.write_text(json.dumps(config))
                guard = KeelGuard(path, Path(directory) / 'state.json')
                orch = SimpleNamespace(environment=env, from_role=Role.AGENT, num_errors=0)
                orch._execute_tool_calls = lambda calls: BaseOrchestrator._execute_tool_calls(orch, calls)
                with tool_boundary(orch, guard) as events:
                    read = orch._execute_tool_calls([ToolCall(id='r', name='get_users', arguments={}, requestor='assistant')])
                    self.assertFalse(read[0].error)
                    # A model-produced requestor=user must not switch the trusted host role.
                    write = orch._execute_tool_calls([ToolCall(id='w', name='create_task', arguments={'user_id': user_id, 'title': 'synthetic'}, requestor='user')])
                    self.assertEqual(len(env.tools.db.tasks), before + (policy == 'none'))
                    self.assertEqual(write[0].requestor, 'assistant')
                    self.assertEqual(write[0].error, policy != 'none')
                    orch.from_role = Role.USER
                    notification = env.user_tools.add_notification('fixture-notification', 'synthetic', task_id)
                    response = orch._execute_tool_calls([ToolCall(id='u', name='dismiss_notification', arguments={'notification_id': notification.notification_id}, requestor='assistant')])
                    self.assertFalse(response[0].error)
                    self.assertEqual(env.user_tools.db.notifications['fixture-notification'].status, 'read')
                    self.assertEqual(response[0].requestor, 'user')
                    self.assertEqual(events[-1]['host_role'], 'user')
                self.assertEqual(orch.environment, env)

    def test_clean_original_orchestrator_scoring_and_taint_observation(self):
        from tau2_security import tool_boundary
        from tau2_agent import KeelTauAgent, model_boundary
        from tau2.registry import registry
        from tau2.runner.build import build_user
        from tau2.runner.simulation import run_simulation
        from tau2.orchestrator.orchestrator import Orchestrator
        from tau2.data_model.tasks import Task, EvaluationCriteria, Action, RewardType
        from tau2.user.user_simulator_base import STOP
        from keel_guard import KeelGuard
        class Transport:
            agent_calls = 0; user_calls = 0
            def step(self, messages, tools):
                if tools:
                    self.agent_calls += 1
                    action = {'toolCalls': [{'id': 'lookup', 'name': 'get_user_details', 'args': {'user_id': 'synthetic-unknown'}}]} if self.agent_calls == 1 else {'content': 'No matching user.'}
                else:
                    self.user_calls += 1
                    action = {'content': 'Please look up the user.' if self.user_calls == 1 else STOP}
                return {'action': action, 'accounting': {'costUsd': 0, 'costStatus': 'known'}}
        task = Task(id='fixture', user_scenario={'instructions': 'synthetic'}, evaluation_criteria=EvaluationCriteria(actions=[Action(action_id='a', name='get_user_details', arguments={'user_id': 'synthetic-unknown'})], reward_basis=[RewardType.ACTION]))
        env = registry.get_env_constructor('retail')()
        orch = Orchestrator(domain='retail', agent=KeelTauAgent(env.get_tools(), env.get_policy()), user=build_user('user_simulator', env, task=task, llm='local'), environment=env, task=task, max_steps=10, max_errors=10, seed=0)
        with tempfile.TemporaryDirectory(prefix='keel-task13-') as directory:
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps({'tenantId': 'fixture', 'runId': '10000000-0000-4000-8000-000000000013', 'capabilities': ['get_user_details'], 'tools': {'get_user_details': {'sideEffect': False}}, 'benchmark': {'policy': 'all', 'taskHash': 'trusted-initial-task'}, 'options': {'plan': ['get_user_details']}}))
            guard = KeelGuard(path, Path(directory) / 'state.json')
            with model_boundary(Transport()), tool_boundary(orch, guard) as events:
                result = run_simulation(orch)
            self.assertEqual(result.reward_info.reward, 1.0)
            self.assertTrue(events[0]['executed'])
            self.assertTrue(json.loads((Path(directory) / 'state.json').read_text())['security']['observed'])

    def test_malformed_arguments_never_execute_and_two_corrections_only(self):
        from tau2_security import tool_boundary
        from tau2.orchestrator.orchestrator import BaseOrchestrator, Role
        from tau2.domains.mock.environment import get_environment
        from tau2.data_model.message import ToolCall
        env = get_environment()
        original_count = len(env.tools.db.tasks)
        orch = SimpleNamespace(environment=env, from_role=Role.AGENT, num_errors=0)
        orch._execute_tool_calls = lambda calls: BaseOrchestrator._execute_tool_calls(orch, calls)
        # No guard can be reached for malformed input; a mock allow would hide this.
        with tool_boundary(orch, None):
            for index in range(2):
                result = orch._execute_tool_calls([ToolCall(id=str(index), name='create_task', arguments={'user_id': 'user_1', 'title': 42})])
                self.assertTrue(result[0].error)
                self.assertIn('INVALID_TOOL_ARGS', result[0].content)
            with self.assertRaisesRegex(RuntimeError, 'TOOL_CORRECTIONS_EXHAUSTED'):
                orch._execute_tool_calls([ToolCall(id='third', name='create_task', arguments={'user_id': 'user_1', 'title': 42})])
        self.assertEqual(len(env.tools.db.tasks), original_count)

    def test_local_simulator_route_and_all_malformed_generation_costs_retained(self):
        from tau2_security import security_model_boundary
        from tau2.utils import llm_utils
        from tau2.data_model.message import UserMessage
        class Client:
            calls = 0
            def step(self, messages, tools):
                self.calls += 1
                self.last = messages
                return {'action': {}}
        agent, local = Client(), Client()
        with security_model_boundary(agent, local, 10):
            with self.assertRaisesRegex(RuntimeError, 'INVALID_MODEL_ACTION'):
                llm_utils._generate_once('keel-security-agent', [UserMessage(role='user', content='synthetic')])
            self.assertEqual(agent.calls, 3)
            self.assertIn('INVALID_MODEL_ACTION', agent.last[-1]['content'])
            with self.assertRaisesRegex(RuntimeError, 'INVALID_MODEL_ACTION'):
                llm_utils._generate_once('local', [UserMessage(role='user', content='synthetic')])
            self.assertEqual(local.calls, 3)
            self.assertEqual(agent.calls, 3)
