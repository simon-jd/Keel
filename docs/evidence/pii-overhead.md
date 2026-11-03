# Actual PII preprocessing overhead

## Clean-source re-measurement (2026-10-28)

`make measure-pii-overhead` on clean commit `a6c01e5` (`source_dirty: false`), same workload
(10 warm-up + 100 measured alternating pairs, 16 spans per batch, 200 ms PII deadline):

| Run | Baseline p95 | Protected p95 | Paired added p50 | Paired added p95 |
| --- | ---: | ---: | ---: | ---: |
| 2026-10-28 clean source | 1.232764 ms | 3.580527 ms | 1.550207 ms | **2.257411 ms** |
| 2026-10-25 dirty source (below) | 1.517809 ms | 8.337589 ms | 3.241862 ms | 6.950330 ms |

800/800 clean attributes and 1,600/1,600 spans exported; peak Node RSS 84.8 MB. Machine load during the run:
32 CPUs, load average 5.53 / 2.90 / 2.20 (1/5/15 min), other projects running on the same machine.
The shared CPU makes the two runs only loosely comparable; [`pii-overhead.json`](pii-overhead.json) now holds
the clean run (the 2026-10-25 JSON is in git history).

## 2026-10-25 record

The final paired p95 added overhead was **6.950330 ms** for a
16-span batch through actual Presidio HTTP and the actual SDK pre-export path.
This is a local CPU result for the limited metadata workload below, not a
Langfuse/backend throughput or real-model evaluation result.

The final run completed at 2026-10-25T16:41:46.439Z. It used source base
`170007a99a505b745b49cdbd5b93c67e362d1889` with **dirty=true**. It ran before
commit; [the complete JSON](pii-overhead.json) records per-file SHA-256 bindings
for the final service, requirements, exporter, PII stage, span projection,
measurement/controller code, package metadata and lockfile. Those bindings allow comparison with the local implementation commit. It does not pretend
to have run at a future commit SHA.

| Run | Baseline p95 | Protected p95 | Paired added p95 |
| --- | ---: | ---: | ---: |
| Initial admitted run | 1.420740 ms | 7.310058 ms | 6.032076 ms |
| Final source-bound run | 1.517809 ms | 8.337589 ms | 6.950330 ms |

The second run was required after live-only test entrypoints were made explicit
skips without the controller service environment and the regression controller
was extended to verify those skips. It binds the final bytes; the final, larger
value is reported. No pairs, warmup outcomes or slower samples were removed to
choose a better result. Both raw runs are retained; the initial private JSON has
SHA-256 `7d69babc09521b057f6c0001ffa0ee5383c2f00131331cb90cbd9649db26592f`.
Final public JSON SHA-256:
`9d7456d3d7d67aae561e1ba67aac05ddbe88413b24ede96b5ba99f510ce7b8a3`.

Protocol: 10 warmup pairs, then 100 measured pairs; batch size 16; concurrency 1;
`node:perf_hooks performance.now()` monotonic elapsed time. Baseline and protected
order alternate each pair. Each arm uses a real TracerProvider and
BatchSpanProcessor, the same whole-envelope projection and an in-memory sink.
The protected arm additionally awaits the real loopback Presidio HTTP service.
Each batch has eight clean `qwen3` model identifiers and eight synthetic reserved
US phone identifiers, plus numeric cost metadata. Each batch is flushed; times
include span creation, SDK flush, preprocessing and sink delivery. Paired added
latency is protected minus its paired baseline, not the difference between
independent percentiles. The raw JSON contains every measured pair.

Final results: paired added p50 3.241862 ms;
800/800 expected clean attributes retained;
1600/1600 spans delivered; clean-attribute drop fraction 0;
span drop fraction 0. Detected phone identifiers were omitted by the final
whitelist after `[REDACTED]` replacement. Their omission is intended privacy
behavior and is not counted as a failed clean-attribute delivery. Raw prompts,
email attributes, events and status content are already removed by the first
projection; they were not added to the workload to inflate positive PII results.
The Python HTTP test independently proves real email and phone replacement.

Host: 13th Gen Intel(R) Core(TM) i9-13900K, 32 logical CPUs;
Linux 7.0.0-38-generic; 132,310,061,056 bytes total RAM.
Node v20.19.5; SDK 2.12.0; OTLP base/transformer
0.223.0; Python 3.12.13; Presidio analyzer
2.2.364, anonymizer
2.2.362; spaCy
3.7.5; numpy 1.26.4;
cryptography 50.0.2; uvicorn
0.54.0. Package versions were read from actual
installed metadata. Official NoOpNlpEngine, EmailRecognizer and US-region
PhoneRecognizer were used; no NER checkpoint, model/GPU, external PSL fetch or
fixture sleep supplied the latency.

The HTTP preprocessing deadline is 200 ms; failures drop all string attributes
in that batch while retaining allowed numeric metrics. The real service never
timed out on this workload, as confirmed by 800/800 clean attributes. Fault
fixtures separately cover timeout, reorder, missing/duplicate/wrong fields,
malformed JSON, non-2xx, socket failure, truncation and oversized responses.
A finite systemd user unit imposed 4 GiB hard total memory, zero swap and 210 s
runtime, verified at entry. The controller imposed a 180 s wall deadline and
owned process-group cleanup; the single sidecar had 1.5 GB address-space and
90 s CPU limits. It used one worker and numerical-library thread counts 1.
Final unit memory peak was `260.1M` exactly as reported by systemd (swap 0); measured
Node worker peak RSS was 84,996,096 bytes. Both service and test
process groups were verified gone after 3.051 s of controller elapsed time.

The workload is small, synthetic, sequential and metadata-only. It establishes
neither universal PII recall nor throughput under production concurrency. No
complete Langfuse backend, real model, RAG QA or calibration completion is claimed.
The first measured p95 and final measured p95 both fall below 200 ms for this
workload; the safety deadline remains necessary for every failure path.
