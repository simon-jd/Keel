"""Local vLLM models the batch runner may serve, and the BFCL prompt variants it may send."""
import copy
import json

_COMMON = {'license': 'apache-2.0', 'temperature': 0.0, 'thinking': False, 'tool_parser': 'hermes', 'max_tokens': 2048}
MODELS = {
    'qwen3-8b-awq': {'name': 'Qwen/Qwen3-8B-AWQ', 'revision': '4da05a8edb55c6046cce958586c33b61da07bb79',
                     'quantization': 'AWQ int4', **_COMMON},
    'qwen2.5-0.5b-instruct': {'name': 'Qwen/Qwen2.5-0.5B-Instruct', 'revision': '7ae557604adf67be50417f59c2c2f167def9a775',
                              'quantization': 'none (bf16)', **_COMMON},
    # Task 9 judge.
    'qwen2.5-14b-instruct-awq': {'name': 'Qwen/Qwen2.5-14B-Instruct-AWQ', 'revision': '539535859b135b0244c91f3e59816150c8056698',
                                 'quantization': 'AWQ int4', **_COMMON},
    # Phase 7 judge candidates: one checkpoint, served without and with Qwen3 thinking.
    'qwen3-14b-awq': {'name': 'Qwen/Qwen3-14B-AWQ', 'revision': '31c69efc29464b6bb0aee1398b5a7b50a99340c3',
                      'quantization': 'AWQ int4', **_COMMON},
    'qwen3-14b-awq-thinking': {'name': 'Qwen/Qwen3-14B-AWQ', 'revision': '31c69efc29464b6bb0aee1398b5a7b50a99340c3',
                               'quantization': 'AWQ int4', **_COMMON, 'thinking': True},
}


def judge_max_tokens(model):
    # Earlier judges answered in 1024 tokens; thinking needs room for the reasoning (the API caps requests at 4096).
    return 4096 if model['thinking'] else 1024
# Phase 6 retrieval models: local copies under .cache/phase6/models whose files were checked
# against the publisher's sha256 / git blob ids (data/rag/beir/sources.lock.json).
POOLING_MODELS = {
    'bge-base-en-v1.5': {'name': 'BAAI/bge-base-en-v1.5', 'revision': 'a5beb1e3e68b9ab74eb54cfd186867f64f240e1a',
                         'path': '.cache/phase6/models/bge-base-en-v1.5', 'served': 'keel-embed', 'license': 'mit'},
    'bge-reranker-base': {'name': 'BAAI/bge-reranker-base', 'revision': '2cfc18c9415c912f9d8155881c133215df768a70',
                          'path': '.cache/phase6/models/bge-reranker-base', 'served': 'keel-rerank', 'license': 'mit'},
}


def pooling_command(python, root, key, token):
    model = POOLING_MODELS[key]
    return [python, '-m', 'vllm.entrypoints.openai.api_server', '--model', str(root / model['path']), '--served-model-name', model['served'],
            '--runner', 'pooling', '--host', '127.0.0.1', '--port', '18000', '--gpu-memory-utilization', '0.80', '--max-model-len', '512',
            '--max-num-seqs', '64', '--enforce-eager', '--no-enable-log-requests', '--api-key', token]


# 'no-tool-descriptions' is the deliberate regression used for the Task 10 gate drill.
PROMPT_VARIANTS = ('original', 'no-tool-descriptions')


def model_key(model):
    for key, registered in MODELS.items():
        if model == registered:
            return key
    raise ValueError('MODEL_NOT_REGISTERED')


def strip_tool_descriptions(functions):
    """Blank every function and parameter description. The keys stay because upstream BFCL
    appends its own type notes to them (e.g. " This is a float type value.")."""
    def strip(value, names=False):
        # Keys of a `properties` map are parameter names (one may be called "description").
        if isinstance(value, dict) and names:
            return {k: strip(v) for k, v in value.items()}
        if isinstance(value, dict):
            return {k: '' if k == 'description' else strip(v, k == 'properties') for k, v in value.items()}
        if isinstance(value, list):
            return [strip(v) for v in value]
        return copy.deepcopy(value)
    return strip(functions)


def vllm_command(python, model, token, max_num_seqs=1):
    # Default 1 (serial, as every earlier run); concurrent security episodes raise it so vLLM batches.
    if type(max_num_seqs) is not int or not 1 <= max_num_seqs <= 32: raise ValueError('INVALID_MAX_NUM_SEQS')
    return [python, '-m', 'vllm.entrypoints.openai.api_server', '--model', model['name'], '--revision', model['revision'],
            '--tokenizer-revision', model['revision'], '--served-model-name', 'keel-local', '--host', '127.0.0.1',
            '--port', '18000', '--gpu-memory-utilization', '0.80', '--max-model-len', '32768', '--max-num-seqs', str(max_num_seqs),
            '--enforce-eager', '--enable-auto-tool-choice', '--tool-call-parser', model['tool_parser'],
            '--default-chat-template-kwargs', json.dumps({'enable_thinking': model['thinking']}, separators=(',', ':')),
            *(['--reasoning-parser', 'qwen3'] if model['thinking'] else []), '--no-enable-log-requests', '--api-key', token]
