"""Trusted, synchronous original-tool gate backed by the actual TypeScript guard.

Config and state paths belong to the host. Model arguments cannot set policy,
capabilities, taint or approvals. Each event uses a fresh Node process and the same
atomically persisted security state. Serial use by one host only; never an HTTP API.
"""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


class KeelGuard:
    def __init__(self, config_path, state_path):
        self.config_path = Path(config_path).resolve()
        self.state_path = Path(state_path).resolve()
        self.last_decision = None
        self.decisions = []
        self._invoke({'op': 'init'})

    def _invoke(self, event):
        result = subprocess.run(
            ['node', '--import', 'tsx', str(ROOT / 'packages/guard/src/hostBridge.ts'),
             str(self.config_path), str(self.state_path)],
            input=json.dumps(event, allow_nan=False), text=True, capture_output=True,
            cwd=ROOT / 'packages/runtime', timeout=15, check=False)
        try:
            value = json.loads(result.stdout)
            if result.returncode or value.get('decision') not in ('allow', 'deny', 'needs_approval'):
                raise ValueError()
        except (ValueError, TypeError):
            raise PermissionError('HOST_GUARD_FAILED') from None
        self.last_decision = value
        self.decisions.append(value)
        if value['decision'] != 'allow':
            raise PermissionError('HOST_DENIED')

    def preflight(self, event):
        # Only the tool identity crosses this boundary. Upstream resolves nested
        # FunctionCall objects; their representation never authorizes outer args.
        self._invoke({'op': 'preflight', 'tool': event['function']})

    def dispatch(self, event):
        self._invoke({'op': 'dispatch', 'tool': event['function'], 'args': event['args']})

    def observe(self, event):
        # Observation is deliberately independent of raw tool text. Any original
        # result (including an injected/rephrased/error result) taints later args.
        # Provenance policies also read the structured result (other policies ignore it).
        self._invoke({'op': 'observe', 'tool': event['function'], 'args': event['args'],
                      **({'result': event['result']} if 'result' in event else {})})
