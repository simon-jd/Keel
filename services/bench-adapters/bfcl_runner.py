"""BFCL native function-call handler: original orchestration, conversion and AST scoring."""
import json
from bfcl_eval.model_handler.api_inference.openai_completion import OpenAICompletionsHandler
from bfcl_eval.model_handler.base_handler import BaseHandler
from bfcl_eval.constants.enums import ModelStyle, Language
from openai.types.chat import ChatCompletion

class KeelBFCLHandler(OpenAICompletionsHandler):
    def __init__(self, client):
        # Intentionally initialize BaseHandler directly: no SDK client/provider transport.
        BaseHandler.__init__(self,'local',0.0,'Keel-local-FC',True)
        self.model_style=ModelStyle.OPENAI_COMPLETIONS
        self.keel=client

    def _query_FC(self,inference_data):
        messages=[]
        for original in inference_data['message']:
            m=original if isinstance(original,dict) else original.model_dump(exclude_none=True)
            item={'role':m['role'],'content':m.get('content') or ''}
            if m.get('tool_call_id'): item['toolCallId']=m['tool_call_id']
            if m.get('tool_calls'): item['toolCalls']=[{'id':c['id'],'name':c['function']['name'],'args':json.loads(c['function']['arguments'])} for c in m['tool_calls']]
            messages.append(item)
        result=self.keel.step(messages,[t['function'] for t in inference_data['tools']])
        action=result['action']; usage=result.get('usage')
        if usage is None: raise RuntimeError('BFCL_USAGE_UNKNOWN')
        # Data model only: no SDK request. Original BaseHandler consumes this structure.
        response=ChatCompletion(id='keel',created=0,model='local',object='chat.completion',choices=[{'index':0,'finish_reason':'tool_calls' if action.get('toolCalls') else 'stop','message':{'role':'assistant','content':action['content'],'tool_calls':[{'id':c['id'],'type':'function','function':{'name':c['name'],'arguments':json.dumps(c['args'])}} for c in action.get('toolCalls',[])] or None}}],usage={'prompt_tokens':usage['input'],'completion_tokens':usage['output'],'total_tokens':usage['input']+usage['output']})
        return response,result['latency_ms']/1000

    def generate_with_backoff(self,**kwargs):
        raise RuntimeError('DIRECT_PROVIDER_DENIED')

def evaluate_ast(handler,entry,result,answers):
    from bfcl_eval.eval_checker.ast_eval.ast_checker import ast_checker
    from bfcl_eval.constants.model_config import MODEL_CONFIG_MAPPING, ModelConfig
    # Original scorer uses is_fc_model; preserve function-calling type semantics. The OpenAI
    # tool compilation sends "math.factorial" as "math_factorial", so the checker must map
    # dotted names the same way, as upstream does for every OpenAI-style FC model.
    MODEL_CONFIG_MAPPING[handler.registry_name]=ModelConfig(model_name='local',display_name='Keel local',url='',org='Keel',license='model-dependent',model_handler=KeelBFCLHandler,is_fc_model=True,underscore_to_dot=True)
    decoded=handler.decode_ast(result,Language.PYTHON,False)
    return ast_checker(entry['function'],decoded,answers,Language.PYTHON,entry['id'].rsplit('_',1)[0],handler.registry_name)
