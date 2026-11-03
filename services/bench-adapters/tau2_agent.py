"""τ² half-duplex adapter. Policies, state transitions, simulator and scoring stay upstream."""
from contextlib import contextmanager
from tau2.agent.llm_agent import LLMAgent
from tau2.data_model.message import AssistantMessage, ToolCall
from tau2.utils import llm_utils

class KeelTauAgent(LLMAgent):
    def __init__(self, tools, domain_policy, **kwargs):
        super().__init__(tools, domain_policy, llm='local', llm_args={'temperature': 0.0}, **kwargs)

def to_keel_messages(messages):
    # Preserve upstream user-simulator role swapping and tool-call IDs exactly.
    result=[]
    for message in llm_utils.to_litellm_messages(messages):
        item={'role':message['role'],'content':message.get('content') or ''}
        if not isinstance(item['content'],str): raise ValueError('TEXT_ONLY_PROTOCOL')
        if message.get('tool_call_id'): item['toolCallId']=message['tool_call_id']
        if message.get('tool_calls'):
            import json
            item['toolCalls']=[{'id':c['id'],'name':c['function']['name'],'args':json.loads(c['function']['arguments'])} for c in message['tool_calls']]
        result.append(item)
    return result

@contextmanager
def model_boundary(client):
    """Replace only upstream transport; keep original structured response retry/validation.

    Applies to every generate() consumer, including simulator and semantic/NL judges.
    Callers must serialize simulations (the original transport is process-global).
    """
    original=llm_utils._generate_once
    def generate_once(model,messages,tools=None,tool_choice=None,call_name=None,**kwargs):
        if tool_choice not in (None,'auto'): raise ValueError('UNSUPPORTED_TOOL_CHOICE')
        llm_utils.validate_message_history(messages)
        response=client.step(to_keel_messages(messages),[t.openai_schema['function'] for t in tools or []])
        action=response['action']; usage=response.get('usage'); accounting=response.get('accounting') or {}
        return AssistantMessage(role='assistant',content=action.get('content') or None,
            tool_calls=[ToolCall(id=c['id'],name=c['name'],arguments=c['args']) for c in action.get('toolCalls',[])] or None,
            cost=accounting.get('costUsd') if accounting.get('costStatus')=='known' else None,
            usage={'prompt_tokens':usage['input'],'completion_tokens':usage['output']} if usage else None,
            generation_time_seconds=response.get('latency_ms',0)/1000)
    llm_utils._generate_once=generate_once
    try: yield
    finally: llm_utils._generate_once=original
