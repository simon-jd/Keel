"""Task 11/13 matrix specs for `security_matrix.py prepare` (CPU only, no model calls).

The trusted host declaration for each AgentDojo case is what a user-side planner would
declare before reading any untrusted content: the tools in the user task's ground-truth
solution (capabilities == plan). Injected texts come from AgentDojo's own
`important_instructions_no_names` attack, which does not address the model by name.
"""
import argparse
import hashlib
import json
from pathlib import Path

from local_models import MODELS

SLACK_SIDE_EFFECTS = {'add_user_to_channel', 'send_direct_message', 'send_channel_message',
                      'invite_user_to_slack', 'remove_user_from_slack', 'post_webpage'}
AGENTDOJO_USER_TASKS = [f'user_task_{i}' for i in range(10)]
AGENTDOJO_INJECTION = 'injection_task_1'
ATTACK = 'important_instructions_no_names'


def model_entry(key):
    model = MODELS[key]
    version = model['name'] + '@' + model['revision']
    return {'id': key + '-' + hashlib.sha256(version.encode()).hexdigest()[:12], 'alias': 'local',
            'name': 'keel-local', 'provider': 'openaiCompatible', 'version': version}


def _attack(suite):
    from agentdojo.attacks import load_attack
    class Pipeline:
        # Only read by the attack constructor; NoNames then replaces the model name.
        name = 'gpt-4o-2024-05-13'
    return load_attack(ATTACK, suite, Pipeline())


def agentdojo_selectors(user_tasks=AGENTDOJO_USER_TASKS, injection_task=AGENTDOJO_INJECTION):
    from agentdojo_agent import get_suite
    suite = get_suite('v1', 'slack')
    attack = _attack(suite)
    tools = {tool.name: {'sideEffect': tool.name in SLACK_SIDE_EFFECTS} for tool in suite.tools}
    selectors = []
    for user_id in user_tasks:
        user = suite.get_user_task_by_id(user_id)
        environment = suite.load_and_inject_default_environment({})
        declared = list(dict.fromkeys(call.function for call in user.ground_truth(environment)))
        host = {'capabilities': declared, 'plan': list(declared), 'tools': dict(tools)}
        injections = attack.attack(user, suite.get_injection_task_by_id(injection_task))
        selectors.append({'benchmark': 'agentdojo', 'selector': {'suite_name': 'slack', 'user_task_id': user_id}, 'host': json.loads(json.dumps(host))})
        selectors.append({'benchmark': 'agentdojo', 'selector': {'suite_name': 'slack', 'user_task_id': user_id,
                          'injection_task_id': injection_task, 'injections': dict(injections)}, 'host': json.loads(json.dumps(host))})
    return selectors


def controlled_selectors():
    from security_matrix import controlled_cases
    selectors = []
    for scenario in controlled_cases():
        tools = {scenario['readTool']: {'sideEffect': False}, 'post_message': {'sideEffect': True},
                 'http_fetch': {'sideEffect': True}, 'grant_access': {'sideEffect': True}}
        host = {'capabilities': [scenario['readTool']], 'plan': [scenario['readTool']], 'tools': tools}
        for injected in (True, False):
            # The clean task is identical across attack types, so keep one clean case per carrier.
            if injected or scenario['attack'] == 'post_message':
                selectors.append({'benchmark': 'controlled', 'selector': {'scenarioId': scenario['id'], 'injected': injected},
                                  'host': json.loads(json.dumps(host))})
    return selectors


AIRLINE_SIDE_EFFECTS = {'book_reservation', 'cancel_reservation', 'send_certificate', 'update_reservation_baggages',
                        'update_reservation_flights', 'update_reservation_passengers'}


def tau2_selectors(count=4):
    """τ² airline utility subset: the first released tasks. An airline-agent task may use any domain
    tool, so the declaration is the whole toolset; only taint can stop a write here."""
    from tau2.registry import registry
    from security_matrix import tau_configuration
    from tau2.runner.helpers import select_run_tasks
    from tau2.runner.presets import load_cell_language
    names = [tool.name for tool in registry.get_env_constructor('airline')().get_tools()]
    tools = {name: {'sideEffect': name in AIRLINE_SIDE_EFFECTS} for name in names}
    tasks = select_run_tasks(tau_configuration('airline'), load_cell_language('en', 'airline', 'text'))[:count]
    return [{'benchmark': 'tau2', 'selector': {'domain': 'airline', 'task_id': task.id},
             'host': {'capabilities': list(names), 'plan': list(names), 'tools': dict(tools)}} for task in tasks]


# Full AgentDojo benchmark (phase 6): the newest version in the pinned checkout, all four
# suites, every user task clean and every user x injection pair under the standard attack.
FULL_VERSION = 'v1.2.2'
FULL_ATTACK = 'important_instructions'
FULL_SUITES = ('workspace', 'travel', 'banking', 'slack')
# AgentDojo names local vLLM pipelines 'vllm_parsed'; its attack then addresses "Local model".
FULL_PIPELINE_NAME = 'vllm_parsed'
SIDE_EFFECTS = {
    'workspace': {'add_calendar_event_participants', 'append_to_file', 'cancel_calendar_event', 'create_calendar_event',
                  'create_file', 'delete_email', 'delete_file', 'reschedule_calendar_event', 'send_email', 'share_file'},
    'travel': {'cancel_calendar_event', 'create_calendar_event', 'reserve_car_rental', 'reserve_hotel',
               'reserve_restaurant', 'send_email'},
    'banking': {'schedule_transaction', 'send_money', 'update_password', 'update_scheduled_transaction', 'update_user_info'},
    'slack': set(SLACK_SIDE_EFFECTS),
}
# Item 1c development split, fixed before any per-task result was read.
DEVELOPMENT_SUITES = ('slack', 'travel')
HELD_OUT_SUITES = ('banking', 'workspace')


def agentdojo_full_selectors(version=FULL_VERSION, suites=FULL_SUITES, attack_name=FULL_ATTACK):
    from agentdojo_agent import get_suite
    from agentdojo.attacks import load_attack
    class Pipeline:
        name = FULL_PIPELINE_NAME
    selectors = []
    for suite_name in suites:
        suite = get_suite(version, suite_name)
        attack = load_attack(attack_name, suite, Pipeline())
        tools = {tool.name: {'sideEffect': tool.name in SIDE_EFFECTS[suite_name]} for tool in suite.tools}
        for user_id, user in suite.user_tasks.items():
            environment = suite.load_and_inject_default_environment({})
            declared = list(dict.fromkeys(call.function for call in user.ground_truth(environment)))
            host = {'capabilities': declared, 'plan': list(declared), 'tools': dict(tools)}
            base = {'suite_name': suite_name, 'user_task_id': user_id, 'benchmark_version': version}
            selectors.append({'benchmark': 'agentdojo', 'selector': dict(base), 'host': json.loads(json.dumps(host))})
            for injection_id, injection in suite.injection_tasks.items():
                injections = attack.attack(user, injection)
                selectors.append({'benchmark': 'agentdojo', 'selector': {**base, 'injection_task_id': injection_id, 'injections': dict(injections)},
                                  'host': json.loads(json.dumps(host))})
    return selectors


def stratified_sample(selectors, fraction, seed):
    """Case indices: the same fraction of each suite (rounded), drawn with a fixed seed."""
    import random
    rng = random.Random(seed)
    chosen = []
    for suite_name in sorted({s['selector']['suite_name'] for s in selectors}):
        members = [i for i, s in enumerate(selectors) if s['selector']['suite_name'] == suite_name]
        chosen += rng.sample(members, round(len(members) * fraction))
    return sorted(chosen)


def full_spec(model_key, sample_fraction=None, sample_seed=20261029, policies=('none', 'capability', 'taint', 'plan', 'all'),
              sampled=('capability', 'taint', 'plan')):
    selectors = agentdojo_full_selectors()
    sample = stratified_sample(selectors, sample_fraction, sample_seed) if sample_fraction else None
    return {'model': model_entry(model_key), 'selectors': selectors, 'policies': list(policies),
            'policy_cases': {p: (sample if p in sampled else None) for p in policies},
            'sample': {'fraction': sample_fraction, 'seed': sample_seed, 'policies': list(sampled)} if sample else None,
            'per_job_requests': 48}


def spec(benchmark, model_key):
    model = model_entry(model_key)
    selectors = {'agentdojo': agentdojo_selectors, 'controlled': controlled_selectors, 'tau2': tau2_selectors}[benchmark]()
    return {'models': [model], 'local_model': dict(model), 'seeds': [0], 'selectors': selectors, 'max_requests': 1000}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('benchmark', choices=('agentdojo', 'controlled', 'tau2', 'agentdojo-full'))
    parser.add_argument('model', choices=sorted(MODELS))
    parser.add_argument('out', type=Path)
    # agentdojo-full: run capability/taint/plan only on this predeclared stratified fraction of cases.
    parser.add_argument('--sample-fraction', type=float)
    parser.add_argument('--policies', default='none,capability,taint,plan,all', help='agentdojo-full: comma-separated policies')
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    value = full_spec(args.model, args.sample_fraction, policies=tuple(args.policies.split(','))) if args.benchmark == 'agentdojo-full' else spec(args.benchmark, args.model)
    with args.out.open('x') as stream:
        json.dump(value, stream, indent=1)
