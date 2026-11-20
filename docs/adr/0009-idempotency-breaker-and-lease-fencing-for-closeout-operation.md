# ADR-0009. Idempotency, breaker and lease fencing for closeout operations

- **Status:** accepted
- **Date:** 2026-11-19
- **Deciders:** A03
- **Task:** Tfb6b-arch

## Context and Problem Statement

Retries, outages and multi-session work must not duplicate effects; phases 71, 74 and 78 already carry durable keys and fencing that the closeout must preserve consistently

## Decision Drivers

AC-18 zero duplicate side effects; AC-19 BreakerOpenError with retryAfterMs above 0; AC-3 key plus fingerprint resume; AC-5 zero mutations on clean tick

## Considered Options

- At-least-once retries without keys
- global breaker
- TTL-free leases

## Decision Outcome

Chosen option: "Apply idempotency keys with stored results, per-plane CircuitBreaker threshold 5 with 30 s half-open probe, and lease epoch-CAS fencing with TTL 900 s to all closeout write paths".

### Positive Consequences

- Retries of `cross_repo_fanout`, event emit and steering commands return the stored result with zero duplicate effects, including across process restarts (AC-3, AC-18).
- A failing data plane opens its own breaker after 5 consecutive failures and degrades answers instead of blocking the prompt path (AC-19).
- Lease fencing keeps two sessions of the same agent from holding one node; a lapsed lease reads free with no reaper (phase 71).

### Negative Consequences

- Every write path must persist key-to-result rows before effects, which is extra storage and a strict ordering rule for implementers.
- Breaker-open callers must handle `BreakerOpenError` and back off; silently retrying defeats the breaker and is a violation.

## Consequences

Stores hold key-to-result rows before effects; plane callers surface BreakerOpenError and back off; lapsed leases read free
