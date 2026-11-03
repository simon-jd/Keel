"""Original AgentDojo pipeline/runtime/scorers with Keel as the only model transport.

Tools in the pinned default suites mutate virtual environments only. The trusted
host dispatch callback receives the environment and exact arguments before every
original runtime dispatch, including nested calls. No model authorization flags.
"""
import copy
from pathlib import Path
import sys
from security_sources import private_output, source_identity, source_root

_UPSTREAM = source_root('agentdojo') / 'src'
if 'agentdojo' in sys.modules:
    module_path = getattr(sys.modules['agentdojo'], '__file__', None)
    if module_path is None or not Path(module_path).resolve().is_relative_to(_UPSTREAM):
        raise RuntimeError('SECURITY_UPSTREAM_IMPORT_COLLISION')
else:
    sys.path.insert(0, str(_UPSTREAM))

from agentdojo.agent_pipeline import AgentPipeline, BasePipelineElement, PipelineConfig
from agentdojo.functions_runtime import FunctionCall, FunctionsRuntime
from agentdojo.logging import LOGGER_STACK, NullLogger
from agentdojo.task_suite import get_suite
from agentdojo.types import text_content_block_from_string


def to_keel_messages(messages):
    result = []
    for message in messages:
        blocks = message.get('content') or []
        if any(block['type'] != 'text' for block in blocks):
            raise ValueError('TEXT_ONLY_PROTOCOL')
        item = {'role': message['role'], 'content': '\n'.join(block['content'] for block in blocks)}
        if message['role'] == 'tool':
            item['content'] = message['error'] or item['content']
            item['toolCallId'] = message['tool_call_id']
        if message['role'] == 'assistant' and message.get('tool_calls'):
            item['toolCalls'] = [{'id': call.id, 'name': call.function, 'args': copy.deepcopy(call.args)}
                                 for call in message['tool_calls']]
        result.append(item)
    return result


def _jsonable(value):
    from pydantic_core import to_jsonable_python
    return to_jsonable_python(value, fallback=str)


def validate_action(action):
    """Require an explicit text answer (including '') or well-formed tool calls.

    Missing text is supported only for a nonempty tool-call batch. Validation is
    structural: original tool lookup, argument schemas and scoring stay upstream.
    """
    if not isinstance(action, dict) or action.get('role', 'assistant') != 'assistant':
        raise RuntimeError('INVALID_MODEL_ACTION')
    calls = action.get('toolCalls', [])
    if ('content' in action and not isinstance(action['content'], str)) or not isinstance(calls, list) or len(calls) > 64:
        raise RuntimeError('INVALID_MODEL_ACTION')
    if 'content' not in action and not calls:
        raise RuntimeError('INVALID_MODEL_ACTION')
    ids = set()
    for call in calls:
        if (not isinstance(call, dict) or not isinstance(call.get('id'), str) or not 1 <= len(call['id']) <= 256
                or call['id'] in ids or not isinstance(call.get('name'), str) or not 1 <= len(call['name']) <= 128
                or not isinstance(call.get('args'), dict) or not all(isinstance(key, str) for key in call['args'])):
            raise RuntimeError('INVALID_MODEL_ACTION')
        ids.add(call['id'])
    return action.get('content', ''), calls


class KeelAgentDojo(BasePipelineElement):
    name = 'keel'

    def __init__(self, client):
        self.client = client
        self.messages = []

    def query(self, query, runtime, env, messages=(), extra_args=None):
        tools = [{'name': function.name, 'description': function.description,
                  'parameters': function.parameters.model_json_schema()} for function in runtime.functions.values()]
        response = self.client.step(to_keel_messages(messages), tools)
        if response.get('invalidToolCalls'):
            raise RuntimeError('INVALID_MODEL_TOOL_CALLS')
        content, raw_calls = validate_action(response.get('action'))
        calls = [FunctionCall(function=call['name'], args=call['args'], id=call['id']) for call in raw_calls]
        assistant = {'role': 'assistant', 'content': [text_content_block_from_string(content)],
                     'tool_calls': calls or None}
        self.messages = copy.deepcopy([*messages, assistant])
        return query, runtime, env, self.messages, extra_args or {}


def run_agentdojo_case(client, *, suite_name, user_task_id, injection_task_id=None,
                       injections=None, benchmark_version='v1', dispatch_policy=None, trusted_guard=None, tool_error_limit=None,
                       score_exhausted=False):
    """Run an original default-suite case; raises on transport/exhaustion failures.

    The returned security value is the original attack predicate (True means an
    injection succeeded), not a defensive pass. Clean runs have no attack score.
    Raw results are private evidence; publish aggregates only. With score_exhausted, an episode
    that hits the pipeline's step limit keeps its original scores (as upstream's own benchmark
    loop does) and is flagged `exhausted` instead of raising.
    """
    source_root('agentdojo')
    if tool_error_limit is not None and (type(tool_error_limit) is not int or not 0 <= tool_error_limit <= 2 or trusted_guard is None):
        raise ValueError('INVALID_TOOL_ERROR_LIMIT')
    suite = get_suite(benchmark_version, suite_name)
    events = []

    class HostRuntime(FunctionsRuntime):
        def _call_guard(self, phase, request):
            try:
                getattr(trusted_guard, phase)(request)
            except Exception as error:
                if phase == 'observe' or not (isinstance(error, PermissionError) and str(error) == 'HOST_DENIED'):
                    # The original runtime catches handler exceptions. Latch host
                    # infrastructure faults so they still abort at its boundary.
                    self._guard_fault = error
                raise

        def _guard_handler(self, original):
            def execute(**kwargs):
                self._active_events[-1]['handler_entered'] = True
                # Upstream has already resolved nested calls, validated schema,
                # applied defaults/stripped extras, and injected trusted deps.
                args = {key: value for key, value in kwargs.items() if key not in original.dependencies}
                request = {'function': original.name, 'args': copy.deepcopy(args)}
                self._call_guard('dispatch', request)
                observed = dict(request)
                try:
                    value = original(**kwargs)
                    observed['result'] = _jsonable(value)
                    return value
                finally:
                    self._call_guard('observe', observed)
            execute._keel_guard = trusted_guard
            return original.model_copy(update={'run': execute})

        def run_function(self, env, function, kwargs, raise_on_error=False):
            if len(events) >= 64:
                raise RuntimeError('SECURITY_TOOL_LIMIT')
            event = {'function': function, 'args': copy.deepcopy(dict(kwargs)), 'executed': False}
            events.append(event)
            if dispatch_policy is not None or trusted_guard is not None:
                try:
                    # Copies prevent policy edits from silently changing original tool arguments.
                    request = {'function': function, 'args': copy.deepcopy(dict(kwargs)), 'environment': env}
                    if dispatch_policy is not None:
                        dispatch_policy(request)
                    if trusted_guard is not None:
                        self._call_guard('preflight', {'function': function})
                except PermissionError:
                    if getattr(self, '_guard_fault', None) is not None:
                        raise
                    event['error'] = 'HOST_DENIED'
                    if raise_on_error:
                        raise PermissionError('HOST_DENIED') from None
                    return '', 'PermissionError: HOST_DENIED'
            if trusted_guard is not None and function in self.functions:
                original = self.functions[function]
                if getattr(original.run, '_keel_guard', None) is not trusted_guard:
                    # Copy the host's function descriptor, never mutate shared
                    # upstream suite tools. Wrapping here also covers replacements.
                    self.functions[function] = self._guard_handler(original)
            if not hasattr(self, '_active_events'):
                self._active_events = []
                self._tool_corrections = 0
            self._active_events.append(event)
            try:
                result, error = super().run_function(env, function, kwargs, raise_on_error)
            finally:
                self._active_events.pop()
            if getattr(self, '_guard_fault', None) is not None:
                raise self._guard_fault
            event['executed'] = error is None
            event['error'] = error
            if tool_error_limit is not None and error and not event.get('handler_entered') and not self._active_events:
                self._tool_corrections += 1
                if self._tool_corrections > tool_error_limit:
                    raise RuntimeError('TOOL_CORRECTIONS_EXHAUSTED')
            elif event.get('handler_entered'):
                self._tool_corrections = 0
            return result, error

    llm = KeelAgentDojo(client)
    config = PipelineConfig(llm=llm, model_id=None, defense=None, system_message_name=None, system_message=None)
    pipeline = AgentPipeline.from_config(config)
    with private_output() as diagnostics:
        logger_token = LOGGER_STACK.set([NullLogger()])
        try:
            utility, attack_success = suite.run_task_with_pipeline(
                pipeline, suite.get_user_task_by_id(user_task_id),
                suite.get_injection_task_by_id(injection_task_id) if injection_task_id else None,
                injections or {}, runtime_class=HostRuntime)
            exhausted = bool(llm.messages and llm.messages[-1].get('tool_calls'))
            if exhausted and not score_exhausted:
                raise RuntimeError('SECURITY_PIPELINE_EXHAUSTED')
        except BaseException as error:
            error.security_evidence = {'tool_events': events, 'messages': llm.messages,
                                       'upstream_diagnostics': diagnostics.evidence()}
            raise
        finally:
            LOGGER_STACK.reset(logger_token)
    return {'protocol': 'original-agentdojo-pipeline', 'source': source_identity('agentdojo'),
            'benchmark_version': benchmark_version, 'suite': suite_name, 'user_task_id': user_task_id,
            'injection_task_id': injection_task_id, 'injections': injections or {}, 'defense': 'keel-guard-v1' if trusted_guard is not None else None,
            'utility': utility, 'injection_success': attack_success if injection_task_id else None, 'exhausted': exhausted,
            'tool_events': events, 'messages': llm.messages, 'upstream_diagnostics': diagnostics.evidence()}
