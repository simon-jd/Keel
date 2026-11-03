"""Pinned upstream integration tests, with scripted model transport (not scores)."""
import importlib.util
import sys
import unittest
from pathlib import Path
from loguru import logger
logger.remove()
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

class UpstreamTests(unittest.TestCase):
    def test_original_tau_agent_environment_and_action_evaluator(self):
        self.assertIsNotNone(importlib.util.find_spec('tau2_agent'), 'upstream tau adapter is missing')
        from tau2_agent import KeelTauAgent, model_boundary
        from tau2.agent.base_agent import HalfDuplexAgent
        from tau2.data_model.message import UserMessage, MultiToolMessage, ToolMessage
        from tau2.registry import registry
        class Transport:
            def step(self, messages, tools):
                self.messages, self.tools = messages, tools
                return {'action': {'content': '', 'toolCalls': [{'id':'real-id','name':'get_user_details','args':{'user_id':'invalid-fixture-user'}}]}, 'accounting':{'costUsd':0,'costStatus':'known'},'usage':{'input':1,'output':2},'latency_ms':1}
        transport=Transport()
        env=registry.get_env_constructor('retail')()
        agent=KeelTauAgent(env.get_tools(),env.get_policy())
        self.assertIsInstance(agent,HalfDuplexAgent)
        state=agent.get_init_state()
        with model_boundary(transport):
            action,state=agent.generate_next_message(UserMessage(role='user',content='lookup'),state)
            self.assertEqual(action.tool_calls[0].id,'real-id')
            self.assertIn(env.get_policy(),transport.messages[0]['content'])
            self.assertIn('get_user_details',[t['name'] for t in transport.tools])
            agent.generate_next_message(MultiToolMessage(role='tool',tool_messages=[ToolMessage(role='tool',id='real-id',name='get_user_details',content='{"error":"User not found"}',requestor='assistant')]),state)
            self.assertEqual(transport.messages[-1]['toolCallId'],'real-id')
        from tau2.evaluator.evaluator_action import ActionEvaluator
        from tau2.data_model.tasks import Task, EvaluationCriteria, Action, RewardType
        task=Task(id='fixture',user_scenario={'instructions':'fixture'},evaluation_criteria=EvaluationCriteria(actions=[Action(action_id='a',name='get_user_details',arguments={'user_id':'invalid-fixture-user'})],reward_basis=[RewardType.ACTION]))
        reward=ActionEvaluator.calculate_reward(task=task,full_trajectory=[action])
        self.assertEqual(reward.reward,1.0)

    def test_native_orchestrators_reach_controlled_model_transport(self):
        from run_matrix import run_tau, released_plan, released_tasks, digest
        class StopAtTransport:
            calls=0
            def step(self,*args):
                self.calls+=1
                raise RuntimeError('SCRIPTED_TRANSPORT_STOP')
        plan=released_plan()
        self.assertEqual(plan.frame.benchmark_version,'text-v1')
        self.assertEqual(len(plan.configs),3)
        for config in plan.configs:
            domain=config.domain
            with self.subTest(domain=domain):
                tasks=released_tasks(config)
                self.assertEqual(len(tasks),50)
                self.assertEqual(config.num_trials,3)
                self.assertEqual(config.language,'en')
                task=tasks[0]
                transport=StopAtTransport()
                try:run_tau({'domain':domain,'task_id':task.id,'seed':0,'task_hash':digest(task.model_dump(mode='json'))},transport)
                except Exception:pass
                self.assertGreater(transport.calls,0,'original orchestrator failed before the controlled model boundary')

    def test_bfcl_original_handler_and_ast_evaluator(self):
        self.assertIsNotNone(importlib.util.find_spec('bfcl_runner'), 'BFCL adapter is missing')
        from bfcl_runner import KeelBFCLHandler, evaluate_ast
        from bfcl_eval.model_handler.base_handler import BaseHandler
        class Transport:
            def step(self,messages,tools):
                return {'action':{'content':'','toolCalls':[{'id':'bfcl-1','name':'add','args':{'a':2,'b':3}}]},'usage':{'input':4,'output':5},'latency_ms':2}
        handler=KeelBFCLHandler(Transport())
        self.assertIsInstance(handler,BaseHandler)
        entry={'id':'simple_python_fixture','question':[[{'role':'user','content':'add 2 and 3'}]],'function':[{'name':'add','description':'sum','parameters':{'type':'dict','properties':{'a':{'type':'integer'},'b':{'type':'integer'}},'required':['a','b']}}]}
        result,meta=handler.inference(entry,include_input_log=False,exclude_state_log=True)
        self.assertEqual(handler.decode_ast(result,'Python',False),[{'add':{'a':2,'b':3}}])
        self.assertTrue(evaluate_ast(handler,entry,result,[{'add':{'a':[2],'b':[3]}}])['valid'])
        self.assertFalse(evaluate_ast(handler,entry,result,[{'add':{'a':[9],'b':[3]}}])['valid'])

class OriginalUnknownToolTests(unittest.TestCase):
    def test_original_environment_unknown_tool_error_reaches_original_evaluator(self):
        from tau2_agent import KeelTauAgent,model_boundary
        from tau2.registry import registry
        from tau2.runner.build import build_user
        from tau2.runner.simulation import run_simulation
        from tau2.orchestrator.orchestrator import Orchestrator
        from tau2.data_model.tasks import Task,EvaluationCriteria,Action,RewardType
        from tau2.user.user_simulator_base import STOP
        class Scripted:
            agent_calls=0;user_calls=0;saw_error=False
            def step(self,messages,tools):
                if tools:
                    self.agent_calls+=1
                    if self.agent_calls==1:action={'toolCalls':[{'id':'unknown-1','name':'nonexistent_fixture_tool','args':{}}]}
                    else:
                        self.saw_error=any(m['role']=='tool' and m.get('toolCallId')=='unknown-1' for m in messages)
                        action={'content':'Unable to complete the request.'}
                else:
                    self.user_calls+=1;action={'content':'Please help.' if self.user_calls==1 else STOP}
                return {'action':action,'accounting':{'costUsd':0,'costStatus':'known'}}
        task=Task(id='fixture',user_scenario={'instructions':'synthetic request'},evaluation_criteria=EvaluationCriteria(actions=[Action(action_id='a',name='get_user_details',arguments={'user_id':'fixture'})],reward_basis=[RewardType.ACTION]))
        env=registry.get_env_constructor('retail')();transport=Scripted()
        orch=Orchestrator(domain='retail',agent=KeelTauAgent(env.get_tools(),env.get_policy()),user=build_user('user_simulator',env,task=task,llm='local'),environment=env,task=task,max_steps=10,max_errors=10,seed=0)
        with model_boundary(transport):result=run_simulation(orch)
        self.assertTrue(transport.saw_error)
        self.assertEqual(result.reward_info.reward,0.0)
