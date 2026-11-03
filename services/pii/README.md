# PII sidecar

The sidecar uses actual Presidio AnalyzerEngine 2.2.364 and AnonymizerEngine
2.2.362, with the official NoOpNlpEngine, EmailRecognizer and US-region
PhoneRecognizer. It handles English email and phone recognition only. It has no
NER checkpoint, token/credential detector, universal PII coverage or model-based
semantic detection. False positives and negatives remain possible.

The existing Python 3.12 environment contains the 58 exact versions in
`requirements.lock`. The lock is the admitted metadata-compatible, hash-pinned
set, SHA-256 `ff4b2f85739052e98935a127198365edc267b5170171475bd7f012d5ab00a00e`.
Anonymizer 2.2.362 supports the existing cryptography 50.0.2; this selection
preserves the historical environment. No dependency or checkpoint download is
performed by the service. The lock includes the original resolved service set,
including FastAPI; this endpoint uses plain ASGI to avoid validation input echoes.

A trusted operator starts one worker on loopback port 18082, with a finite
process lifetime, memory and CPU limits appropriate to the host. In this
resource-constrained project, starting it requires the controller's resource
admission; it is not a resident service. The application target is
`services.pii.app:app`; use uvicorn with `--host 127.0.0.1 --port 18082 --workers 1
--loop asyncio --http h11 --no-access-log --log-level warning`. Set
`PYTHONDONTWRITEBYTECODE=1`. The app sets CPU/thread count 1 and the supported
`tldextract` suffix-list URLs/cache environment to empty **before** importing
Presidio, using its bundled PSL snapshot without fetching or writing a cache.

`GET /health` indicates that real analyzer/anonymizer initialization finished.
`POST /redact` takes JSON only:

```json
{"items":[{"id":"0","text":"Email audit@example.com or call +1 202-555-0143."}]}
```

The response preserves item order and sequential decimal IDs, replacing detected
entities with the fixed `[REDACTED]` operator. Callers cannot choose recognizers,
language, operators or replacement values. Limits are 128 items, 4096 characters
per nonempty string, 49,152 aggregate UTF-8 text bytes, 65,536 HTTP body bytes and
200 ms to receive the request body. Parse/validation failures return a fixed
error without input echoes; provider faults return `PII_UNAVAILABLE` without
exception details. Request bodies, findings and provider errors are not logged.
The Node client has a separate absolute 200 ms deadline for the entire HTTP
exchange and cancels its request on failure. A synchronous analyzer already
running in the sidecar can finish after that client deadline; per-process CPU,
wall and memory limits bound the admitted invocation.

`configureTracing({ endpoint: '<OTLP signal URL>' })` uses the built-in OTLP
exporter and always enables PII at `http://127.0.0.1:18082/redact`. A trusted
operator may set `piiEndpoint` or `KEEL_PII_ENDPOINT` to another fixed numeric
loopback HTTP `/redact` endpoint. DNS hostnames, external hosts, authentication,
queries, fragments and redirects are rejected. Without the sidecar, numeric
metrics still export but **all string attributes in the affected batch are
omitted**. An explicitly injected trusted exporter retains Task 4's existing
metadata-only semantics; set `piiEndpoint` to enable the stage for that sink.
Without any configured OTLP sink, the prior rejection/no-export behavior remains.

The pipeline projects the entire span envelope first, sends only whitelisted
string metadata to the sidecar, awaits the result, then projects again before
export. It never starts collecting raw prompts, tool arguments/results, events,
status messages, resource/scope content or tokens. Redacted model identifiers
that no longer satisfy the whitelist are omitted, rather than exported as a new
content field. Trace/span IDs and timestamps remain the originals. Failures,
timeouts, cancellation, oversized batches and malformed/uncorrelated responses
omit strings; they never fall back to original text. Flush and shutdown drain
in-flight preprocessing and downstream callbacks. The existing SDK batch cap is
512 spans; metadata-rich batches exceeding 128 string items conservatively lose
string metadata, and production high-concurrency throughput remains unmeasured.
SDK export failures remain
fixed `TRACE_EXPORT_FAILED` errors.

The owned OTLP serializer adapter retains the official 0.223 transport,
configuration, request protobuf, headers and callback semantics. Before the
upstream diagnostic path can run, it replaces malformed-response diagnostics
with `TRACE_OTLP_INVALID_RESPONSE` and projects partial-success responses to
finite rejected counts and a fixed message. It does not disable the global
logger. Upstream treats HTTP 2xx as successful even with malformed acknowledgement
protobuf; this behavior is preserved and does not establish backend persistence.
An arbitrary injected third-party exporter can still perform its own I/O.

Tests: `make test-pii` and `make test-ts` run under `scripts/with_pii_sidecar.py`,
which starts the real sidecar on a free loopback port, exports
`KEEL_TEST_PII_ENDPOINT`, and stops it afterwards. The HTTP tests skip without that
variable. `make measure-pii-overhead` re-measures the paired SDK overhead and rewrites
`docs/evidence/pii-overhead.json`; `make test` never does. (The earlier systemd-unit
controller `tests/run_bounded.py` was retired in 2026-10.) Fault
fixtures are separate from the real-service proof. Two upstream Click import
deprecations (spaCy `cli/_util.py:23`, weasel `util/config.py:8`) were observed and
disclosed; no blanket warning filter or package upgrade hides them.

See `docs/evidence/pii-overhead.md` for the actual latency protocol and limits.
No complete Langfuse backend, real model, model calibration or RAG quality
completion is established by these CPU/loopback checks.
