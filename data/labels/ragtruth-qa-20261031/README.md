# RAGTruth QA grounding cohort (phase 7, frozen before any judge run)

Public human labels used to validate the Task 14 grounding judge (`kubernetes-grounding-binary-v1`).

**Source**: RAGTruth (Niu et al., ACL 2024, arXiv:2401.00396), ParticleMedia/RAGTruth on GitHub,
commit `c103204b9ce28d6bbad859304bf30de72b8ed8fe` (2024-12-02), **MIT License** (copy in [LICENSE](LICENSE)).
Files, fetched with `api.github.com/repos/ParticleMedia/RAGTruth/git/blobs/<id>` and checked against the git blob ids:

| File | Bytes | git blob id | sha256 |
|---|---:|---|---|
| dataset/response.jsonl | 21,458,735 | `f9ae5913fb9976684f3e13be3cd3465062db54cc` | `e4c2e4ac24fff676d8984cc61c35d791612fadc58015335d97dd632375e18073` |
| dataset/source_info.jsonl | 15,117,971 | `119277774009f110aa58596b93f9512f62594a89` | `0dffc26ea9f3c1c3d7c7e8336b56ef1646e3cec876edffcca3c9c624d12d578b` |

The Hugging Face listing found first was `flowaicom/RAGTruth_test` @ `325973ebb4778f85557635e865811c1f2d6ba837`
(MIT; the same RAGTruth test split, QA 900 rows; `data/qa-00000-of-00001.parquet` sha256
`701eafe8…07fd80` matched its LFS id). It is parquet only and no parquet reader is installed in the
project environments (installing one would need pypi, which is not an allowed host for Keel), so the
rows were taken from the publisher's original files above instead. The HF mirror's response-level
label rule (any span → hallucinated) is the same one used here.

**Labels**: written by RAGTruth's human annotators as hallucination spans in each response. Response
level: `fail` if there is any span (including spans flagged `implicit_true`: true in the world but not
supported by the passages), else `pass`.

**Protocol `keel-ragtruth-qa-20261031`** (`scripts/ragtruth_cohort.py`): QA task (MS MARCO questions,
three passages, answers from six LLMs), test split, quality `good` (refusals and truncated answers
excluded): population 875 = 160 fail / 715 pass. Cohort: all 160 fails and the first 160 passes in
sha256(`keel-ragtruth-qa-20261031:` + id) order = **320 items**, cohortHash
`19d030db268068880cf64ca26e565700c6034009b1c014374a8fc15ee163eed3` (`freeze.json`).

Samples are blind (`samples.jsonl`: question, passages as one context, answer); `reference.jsonl` holds the
labels, `audit.jsonl` the answering model and span types (not shown to the judge).

**Known mismatch**: our rubric also fails answers that do not answer the question; RAGTruth labels only
unsupported content. Refusals are excluded, but an off-topic yet supported answer is `pass` here.
The rubric text mentions Kubernetes; it is used unchanged because this run validates that exact rubric.
