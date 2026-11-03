"""Trusted original half-duplex dispatch seam; no upstream source changes.

Only the orchestrator's host-owned from_role authorizes USER routing. Neither a
model ToolCall.requestor nor its arguments can select the user toolkit. Original
environment schema handling, synchronization, handlers and evaluators stay intact.
"""
from contextlib import contextmanager
import copy
import inspect
from types import MethodType
from pydantic import ValidationError

from tau2.data_model.message import ToolMessage
from tau2.orchestrator.orchestrator import Role


@contextmanager
def security_model_boundary(agent, local, max_requests):
    """Route original agent versus local simulator/judge calls via Keel only."""
    from tau2_agent import model_boundary
    from tau2.utils import llm_utils
    from agentdojo_agent import validate_action
    from artifacts import ArtifactLimit
    class Router:
        selected = None
        def step(self, messages, tools):
            attempt_messages = copy.deepcopy(messages)
            for attempt in range(3):
                if agent.calls + local.calls >= max_requests:
                    raise ArtifactLimit('MATRIX_REQUEST_LIMIT')
                response = self.selected.step(attempt_messages, tools)
                try:
                    if response.get('invalidToolCalls'): raise RuntimeError('INVALID_MODEL_ACTION')
                    validate_action(response.get('action'))
                    return response
                except RuntimeError:
                    if attempt == 2: raise
                    attempt_messages.append({'role': 'user', 'content': 'INVALID_MODEL_ACTION: Return a valid text answer or schema-valid tool call. No tool was executed.'})
    router = Router()
    with model_boundary(router):
        installed = llm_utils._generate_once
        def generate(model, *args, **kwargs):
            if model not in ('keel-security-agent', 'local'):
                raise RuntimeError('UNDECLARED_TAU_MODEL_ROUTE')
            router.selected = agent if model == 'keel-security-agent' else local
            return installed(model, *args, **kwargs)
        llm_utils._generate_once = generate
        try:
            yield
        finally:
            llm_utils._generate_once = installed


@contextmanager
def tool_boundary(orchestrator, guard):
    original = orchestrator._execute_tool_calls
    events = []
    corrections = 0

    def execute(host, calls):
        nonlocal corrections
        role = host.from_role
        if role not in (Role.AGENT, Role.USER):
            raise RuntimeError('INVALID_HOST_TOOL_ROLE')
        results = []
        for call in calls:
            requestor = 'assistant' if role == Role.AGENT else 'user'
            normalized = call.model_copy(deep=True, update={'requestor': requestor})
            event = {'host_role': requestor, 'function': call.name, 'executed': False}
            events.append(event)
            if role == Role.USER:
                results.extend(original([normalized]))
                event['executed'] = True
                continue
            # Resolve defaults exactly as the original Python handler does;
            # validate malformed arguments before any original handler dispatch.
            tool = host.environment.tools.get_tools().get(call.name)
            request = None
            try:
                if tool is None:
                    raise TypeError()
                bound = inspect.signature(tool).bind(**normalized.arguments)
                bound.apply_defaults()
                tool.params.model_validate(normalized.arguments, strict=True)
                request = {'function': call.name, 'args': copy.deepcopy(dict(bound.arguments))}
            except (TypeError, ValidationError):
                corrections += 1
                if corrections > 2:
                    raise RuntimeError('TOOL_CORRECTIONS_EXHAUSTED') from None
                host.num_errors += 1
                results.append(ToolMessage(role='tool', id=call.id, name=call.name, requestor=requestor,
                                           content='Error: INVALID_TOOL_ARGS_OR_UNKNOWN_TOOL', error=True))
                event['schema_error'] = True
                continue
            corrections = 0
            try:
                guard.preflight(request)
                guard.dispatch(request)
            except PermissionError as error:
                if str(error) != 'HOST_DENIED':
                    raise
                event['decision'] = guard.last_decision['decision']
                host.num_errors += 1
                results.append(ToolMessage(role='tool', id=call.id, name=call.name, requestor=requestor,
                                           content='PermissionError: HOST_DENIED', error=True))
                continue
            try:
                response = original([normalized])
                event['executed'] = True
                results.extend(response)
            finally:
                # Observation (including error text) precedes returning to agent.
                guard.observe(request)
        return results

    orchestrator._execute_tool_calls = MethodType(execute, orchestrator)
    try:
        yield events
    finally:
        orchestrator._execute_tool_calls = original
