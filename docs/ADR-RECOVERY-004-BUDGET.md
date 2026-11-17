# ADR: one spending authority for the standard live runtime

Status: accepted by JY-RECOVERY-004; candidate implementation, not deployment authorization.

## Decision

The standard launchBrain live path injects the existing officialDashboard into
createModelDecision and the service. It injects the existing RequestJournal at
BRAIN_LEDGER for request facts. It does not run the legacy budget-directory audit
or construct DailyBudgetLedger. Live rhythm has no legacy daily request-count cap.
Per-task bounds and the existing one-shot format correction remain unchanged.

The official page must report today, Asia/Shanghai, CNY, and the dedicated system
key label. A report older than 90 seconds, unavailable report, or displayed spend
of at least 5,000,000 micros denies new model dispatch. The accepted platform delay
is unchanged: this is a displayed-spend cutoff, not an exact instantaneous hard cap.
UNKNOWN has no aggregate spending halt and is never erased.

Primary, corrective and maintenance clients check the same gate before preflight
and again synchronously immediately before RequestJournal.dispatch. Its synchronous
state transition refuses another genuinely dispatched request. No async gap exists
between the final gate, dispatch registration and entering the transport.
An already uncertain request does not occupy a genuinely in-flight slot.

Settlement, original-request reconciliation, receipt accounting and audit do not
call the spending gate. A report changing after dispatch cannot discard a result.
The server may pause opportunities that would create new cognitive requests; this
does not authorize retries or invalidate already persisted external facts.

## Compatibility and startup

An injected officialSpend monitor is reused. Otherwise the existing dashboard uses
state/official-usage.json and JY_OFFICIAL_USAGE_TOKEN (at least 32 characters).
The service can start with no report and remain paused. A missing report token
fails closed. This token authenticates the local report receiver; it is not an API
key and must not be published. BRAIN_MAX_MICROS and BRAIN_MAX_CALLS remain parsable
legacy configuration, but do not govern admission in the standard live path.

DailyBudgetLedger remains for explicit old callers and archive compatibility.
Its legacy uncertain and overrun halt remains strict; accounting an already
dispatched row is allowed while other rows are halted. It is not injected in live.
A legacy ledger passed as BRAIN_LEDGER is rejected as a format mismatch, never
converted, overwritten, reset or silently replaced. Deployment requires an
explicitly reviewed existing RequestJournal path and official report wiring.

No Schema change, financial table, new service or budget increase is introduced.
Offline injected transports establish engineering behavior only; no paid model,
QQ or production validation is claimed.
