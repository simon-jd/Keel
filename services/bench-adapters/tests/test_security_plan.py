from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class SecurityPlanTests(unittest.TestCase):
    def test_model_entries_match_the_served_route_identity(self):
        from security_plan import model_entry
        from local_models import MODELS
        entry = model_entry('qwen3-8b-awq')
        self.assertEqual(set(entry), {'id', 'alias', 'name', 'provider', 'version'})
        # services/api serves every local model as keel-local; the version pins which one.
        self.assertEqual((entry['alias'], entry['name'], entry['provider']), ('local', 'keel-local', 'openaiCompatible'))
        self.assertEqual(entry['version'], MODELS['qwen3-8b-awq']['name'] + '@' + MODELS['qwen3-8b-awq']['revision'])
        self.assertNotEqual(entry['id'], model_entry('qwen2.5-0.5b-instruct')['id'])

    def test_agentdojo_selectors_pair_clean_and_injected_cases_with_trusted_declarations(self):
        from security_plan import agentdojo_selectors, SLACK_SIDE_EFFECTS
        from agentdojo_agent import get_suite
        suite = get_suite('v1', 'slack')
        selectors = agentdojo_selectors(['user_task_1', 'user_task_2'], 'injection_task_1')
        self.assertEqual(len(selectors), 4)
        attacks = [s for s in selectors if 'injection_task_id' in s['selector']]
        cleans = [s for s in selectors if 'injection_task_id' not in s['selector']]
        self.assertEqual(len(attacks), 2); self.assertEqual(len(cleans), 2)
        goal = suite.get_injection_task_by_id('injection_task_1').GOAL
        for item in attacks:
            self.assertTrue(item['selector']['injections'])
            self.assertTrue(all(goal in text for text in item['selector']['injections'].values()))
        host = cleans[0]['host']
        self.assertEqual(set(host['tools']), {t.name for t in suite.tools})
        self.assertEqual({n for n, spec in host['tools'].items() if spec['sideEffect']}, SLACK_SIDE_EFFECTS)
        # user_task_1: read channel, fetch article, DM Alice (ground truth); capabilities == plan.
        self.assertEqual(host['capabilities'], ['read_channel_messages', 'get_webpage', 'send_direct_message'])
        self.assertEqual(host['plan'], host['capabilities'])

    def test_side_effect_list_covers_only_real_slack_tools(self):
        from security_plan import SLACK_SIDE_EFFECTS
        from agentdojo_agent import get_suite
        self.assertLessEqual(SLACK_SIDE_EFFECTS, {t.name for t in get_suite('v1', 'slack').tools})

    def test_controlled_selectors_cover_every_attack_and_one_clean_case_per_carrier(self):
        from security_plan import controlled_selectors
        selectors = controlled_selectors()
        attacks = [s for s in selectors if s['selector']['injected']]
        self.assertEqual(len(attacks), 12)
        self.assertEqual(sorted(s['selector']['scenarioId'] for s in selectors if not s['selector']['injected']),
                         ['document-post_message', 'email-post_message', 'tool-output-post_message', 'webpage-post_message'])
        for s in selectors:
            read = s['host']['capabilities']
            self.assertEqual(len(read), 1); self.assertEqual(s['host']['plan'], read)
            self.assertFalse(s['host']['tools'][read[0]]['sideEffect'])
            self.assertTrue(all(s['host']['tools'][t]['sideEffect'] for t in ('post_message', 'http_fetch', 'grant_access')))

    def test_tau2_selectors_declare_the_whole_airline_toolset_with_write_flags(self):
        from security_plan import tau2_selectors, AIRLINE_SIDE_EFFECTS
        from tau2.registry import registry
        names = {tool.name for tool in registry.get_env_constructor('airline')().get_tools()}
        selectors = tau2_selectors(4)
        self.assertEqual(len(selectors), 4)
        self.assertLessEqual(AIRLINE_SIDE_EFFECTS, names)
        self.assertEqual({'book_reservation', 'cancel_reservation', 'send_certificate'}, AIRLINE_SIDE_EFFECTS & {'book_reservation', 'cancel_reservation', 'send_certificate'})
        for item in selectors:
            self.assertEqual(set(item['selector']), {'domain', 'task_id'})
            self.assertEqual(set(item['host']['tools']), names)
            self.assertEqual(set(item['host']['capabilities']), names)
            self.assertEqual(item['host']['plan'], item['host']['capabilities'])
            self.assertEqual({n for n, s in item['host']['tools'].items() if s['sideEffect']}, AIRLINE_SIDE_EFFECTS)

    def test_full_agentdojo_selectors_cover_every_user_task_and_every_pair(self):
        from security_plan import agentdojo_full_selectors, SIDE_EFFECTS, FULL_VERSION, FULL_ATTACK
        from agentdojo_agent import get_suite
        self.assertEqual((FULL_VERSION, FULL_ATTACK), ('v1.2.2', 'important_instructions'))
        selectors = agentdojo_full_selectors()
        expected = {'workspace': (40, 14), 'travel': (20, 7), 'banking': (16, 9), 'slack': (21, 5)}
        for name, (users, injections) in expected.items():
            suite = get_suite(FULL_VERSION, name)
            self.assertLessEqual(SIDE_EFFECTS[name], {t.name for t in suite.tools})
            mine = [s for s in selectors if s['selector']['suite_name'] == name]
            self.assertEqual(sum('injection_task_id' not in s['selector'] for s in mine), users)
            self.assertEqual(sum('injection_task_id' in s['selector'] for s in mine), users * injections)
            self.assertEqual({s['selector']['benchmark_version'] for s in mine}, {FULL_VERSION})
        self.assertEqual(len(selectors), 97 + 949)
        # The standard attack addresses the model as AgentDojo does for local vLLM pipelines.
        attack = next(s for s in selectors if s['selector'].get('injection_task_id') == 'injection_task_0' and s['selector']['suite_name'] == 'banking')
        self.assertTrue(all('Local model' in text and 'Emma Johnson' in text for text in attack['selector']['injections'].values()))

    def test_full_spec_predeclares_policy_samples_stratified_by_suite(self):
        from security_plan import full_spec, stratified_sample
        selectors = [{'selector': {'suite_name': suite, 'user_task_id': f'u{i}'}} for suite in ('a', 'b') for i in range(10)]
        first = stratified_sample(selectors, 0.5, seed=7)
        self.assertEqual(first, stratified_sample(selectors, 0.5, seed=7))
        self.assertEqual(sum(selectors[i]['selector']['suite_name'] == 'a' for i in first), 5)
        self.assertEqual(first, sorted(first))
        value = full_spec('qwen3-8b-awq', sample_fraction=None)
        self.assertEqual(value['policies'], ['none', 'capability', 'taint', 'plan', 'all'])
        self.assertIsNone(value['policy_cases']['taint'])

    def test_spec_fits_the_matrix_limits(self):
        from security_plan import spec
        for benchmark in ('agentdojo', 'controlled', 'tau2'):
            value = spec(benchmark, 'qwen3-8b-awq')
            self.assertLessEqual(len(value['selectors']), 20)
            self.assertEqual(value['models'], [value['local_model']])
            self.assertEqual(value['seeds'], [0]); self.assertEqual(value['max_requests'], 1000)


class SecurityLaunchTests(unittest.TestCase):
    def test_security_runner_command_selects_the_served_model(self):
        from local_batch import security_command
        command = security_command('/py', Path('/r'), Path('/r/m.json.gz'), Path('/r/out'), 'model-id')
        self.assertEqual(command[:3], ['/py', '/r/services/bench-adapters/security_matrix.py', 'run'])
        self.assertEqual(command[command.index('--model-id') + 1], 'model-id')
        self.assertEqual(command[command.index('--input') + 1], '/r/m.json.gz')

    def test_security_full_command_and_vllm_batching_follow_the_worker_count(self):
        from local_batch import security_full_command
        from local_models import MODELS, vllm_command
        command = security_full_command('/py', Path('/r'), Path('m.json.gz'), Path('out'), 12, 13000)
        self.assertEqual(command[:3], ['/py', '/r/services/bench-adapters/security_matrix.py', 'run-full'])
        self.assertEqual(command[command.index('--workers') + 1], '12')
        self.assertTrue(Path(command[command.index('--output') + 1]).is_absolute())
        served = vllm_command('/py', MODELS['qwen3-8b-awq'], 'secret', max_num_seqs=12)
        self.assertEqual(served[served.index('--max-num-seqs') + 1], '12')
        self.assertEqual(served[served.index('--gpu-memory-utilization') + 1], '0.80')
        default = vllm_command('/py', MODELS['qwen3-8b-awq'], 'secret')
        self.assertEqual(default[default.index('--max-num-seqs') + 1], '1')
        with self.assertRaises(ValueError): vllm_command('/py', MODELS['qwen3-8b-awq'], 'secret', max_num_seqs=64)

    def test_judge_runner_command_runs_every_prompt_version_over_the_samples(self):
        from local_batch import judge_command
        command = judge_command(Path('/r'), Path('s.jsonl'), Path('out'))
        self.assertEqual(command[:3], ['/r/node_modules/.bin/tsx', '/r/packages/evals/src/judgeRun.ts', 'run'])
        self.assertTrue(all(Path(p).is_absolute() for p in command[3:]))
        self.assertNotIn('--rubric', command)

    def test_judge_runner_command_can_select_a_rubric_and_prompt_version(self):
        from local_batch import judge_command
        command = judge_command(Path('/r'), Path('s.jsonl'), Path('out'), rubric='kubernetes-grounding-binary-v1', versions='v1')
        self.assertEqual(command[-4:], ['--rubric', 'kubernetes-grounding-binary-v1', '--versions', 'v1'])

    def test_judge_runner_command_passes_concurrency_and_the_thinking_token_budget(self):
        from local_batch import judge_command
        command = judge_command(Path('/r'), Path('s.jsonl'), Path('out'), concurrency=8, max_tokens=4096)
        self.assertEqual(command[command.index('--concurrency') + 1], '8')
        self.assertEqual(command[command.index('--max-tokens') + 1], '4096')
        self.assertNotIn('--concurrency', judge_command(Path('/r'), Path('s.jsonl'), Path('out')))

    def test_qwen3_14b_judge_is_registered_in_thinking_and_non_thinking_mode(self):
        from local_models import MODELS, judge_max_tokens, vllm_command
        plain, thinking = MODELS['qwen3-14b-awq'], MODELS['qwen3-14b-awq-thinking']
        self.assertEqual((plain['name'], plain['revision']), ('Qwen/Qwen3-14B-AWQ', '31c69efc29464b6bb0aee1398b5a7b50a99340c3'))
        self.assertEqual((thinking['name'], thinking['revision']), (plain['name'], plain['revision']))
        self.assertEqual((plain['thinking'], thinking['thinking']), (False, True))
        off, on = vllm_command('/py', plain, 'secret'), vllm_command('/py', thinking, 'secret')
        self.assertEqual(off[off.index('--default-chat-template-kwargs') + 1], '{"enable_thinking":false}')
        self.assertNotIn('--reasoning-parser', off)
        self.assertEqual(on[on.index('--default-chat-template-kwargs') + 1], '{"enable_thinking":true}')
        self.assertEqual(on[on.index('--reasoning-parser') + 1], 'qwen3')
        self.assertEqual(on[on.index('--gpu-memory-utilization') + 1], '0.80')
        self.assertEqual((judge_max_tokens(plain), judge_max_tokens(thinking)), (1024, 4096))
        # Earlier models keep the exact command they were served with.
        self.assertNotIn('--reasoning-parser', vllm_command('/py', MODELS['qwen2.5-14b-instruct-awq'], 'secret'))

    def test_rag_answer_command_runs_the_faithfulness_answer_step(self):
        from local_batch import rag_answer_command
        command = rag_answer_command(Path('/r'), Path('p.jsonl'), Path('out'))
        self.assertEqual(command[:3], ['/r/node_modules/.bin/tsx', '/r/packages/rag/src/faithfulnessRun.ts', 'answer'])
        self.assertTrue(all(Path(p).is_absolute() for p in command[3:]))

    def test_langfuse_command_runs_the_task4_agent_runs(self):
        from local_batch import langfuse_command
        command = langfuse_command(Path('/r'), Path('spec.json'), Path('out'))
        self.assertEqual(command[:3], ['/r/node_modules/.bin/tsx', '/r/packages/runtime/src/langfuseRun.ts', 'run'])
        self.assertTrue(all(Path(p).is_absolute() for p in command[3:]))

    def test_matrix_command_keeps_the_shared_store_unless_a_run_directory_is_given(self):
        from local_batch import matrix_command
        command = matrix_command('/py', Path('/r'), 'm.json', 'r.jsonl', 40)
        self.assertEqual(command, ['/py', '/r/services/bench-adapters/run_matrix.py', 'run', 'm.json', 'r.jsonl', '--max-jobs', '40'])
        command = matrix_command('/py', Path('/r'), 'm.json', 'r.jsonl', 40, Path('.tools/t8/artifacts'))
        self.assertEqual(command[-2], '--artifacts')
        self.assertTrue(Path(command[-1]).is_absolute())

    def test_run_matrix_parser_accepts_a_per_run_artifact_directory(self):
        from run_matrix import parser
        args = parser().parse_args(['run', 'm.json', 'r.jsonl', '--artifacts', '/x/artifacts'])
        self.assertEqual(args.artifacts, Path('/x/artifacts'))
        self.assertIsNone(parser().parse_args(['run', 'm.json', 'r.jsonl']).artifacts)

    def test_security_runner_paths_are_absolute(self):
        # The TS controlled runner works in packages/runtime; a relative journal path breaks it.
        from local_batch import security_command
        command = security_command('/py', Path('/r'), Path('.tools/m.json.gz'), Path('.tools/out'), 'model-id')
        self.assertTrue(Path(command[command.index('--output') + 1]).is_absolute())
        self.assertTrue(Path(command[command.index('--input') + 1]).is_absolute())


if __name__ == '__main__':
    unittest.main()
