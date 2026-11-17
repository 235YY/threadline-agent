# ADR: stable source identity and request-local failure isolation

Status: accepted by JY-RECOVERY-004; implementation in an isolated candidate.

## Identity and authority

RequestJournal is the request-state authority. Source is persisted before async
preflight: fixed subject identity plus fixed Event reference, or Task identity and
stepCount, or the existing durable reflection activity reference. Maintenance uses
its existing durable job ID. Subject revision, now, contact, scene, leaseToken and
packet regeneration cannot establish a new source. Contacts are not frozen: a new
message has a different Event reference.

The stored packet remains immutable. Existing Affect/turn-activity records are
projections of execution, not new budget authorities. Old journal rows can acquire
missing source metadata only from an exact matching persisted packet, with the
record's fixed reference and packet hash retained. Rows without such evidence stay
unresolved; their source must not be guessed.

## Transitions

- reserved -> released: verified before-transport failure, no external inference.
  Time or changing packet IDs does not readmit it.
- reserved -> dispatched -> uncertain: no automatic resend of the same source,
  including after restart. Fees, prior holds and all original records remain.
- dispatched -> settled: provider usage is recorded even if output is unusable.
  Captured raw output and the provider termination fact are retained.
- settled output -> accepted or rejected: full existing Proposal validation decides
  adoption. Rejected output executes no embedded tools and stops only its source.
  A successful lookup/deferred stage can continue its existing cognition cycle.

Host-only reconcile requires a verifier and evidence bound to the original
request ID and fingerprint; it changes that row only. Explicit readmit is permitted
only for a primary request proven not sent. It keeps the original ID and source,
archives the complete prior attempt, and binds the newly admitted packet on the
same row. Replaying that bound packet returns its saved output without a new call.
No automatic reconciliation or retry agent is added.

Exactly the existing repair:packetId:1 corrective child is permitted, bound to its
settled primary, source, packet and frozen recovery record. UNKNOWN or semantic
rejection is not a reason to start correction. Full Proposal validation still
follows a mechanical format correction.

## Persistence and serial execution

The existing synchronous journal reservation and dispatch transitions reject
duplicate sources and overlapping actual calls. Affect.invoke rechecks the
persisted subject slot at actual invocation, covering two prior prepared inputs.
On an exclusively owned journal reopen, a crash-left dispatched row becomes
uncertain with its previous status and recovery reason retained. It is not a
currently in-flight call in the new process and must not globally block B.
An already bound reserved row instead becomes released/not-sent: no dispatch
was registered. Its prior status is retained and explicit readmission of the
original ID is still required. An explicitly readmitted, not-yet-bound reserved
row (null fingerprint) retains that authorization; it is not a repeated attempt.
Stale process/journal locks still require the existing controlled ownership
review; no automatic lock takeover or process termination is introduced.
An orphan Affect dispatched turn is not a current in-flight authority: when its
exact Journal row is absent or no longer dispatched, the turn is conservatively
isolated as uncertain. Reserved/released/settled Journal facts and captured text
stay exactly as recorded; no successful result or unsent fact is invented. This
also covers exit between Affect dispatch and Journal registration, or between
provider settlement and Affect capture. A genuinely dispatched Journal row still
preserves subject serialization.
Failed/uncertain sources remain stopped across now changes and restart; unrelated
sources can prepare. No concurrency expansion or separate isFrozen flag is used.

Decision and activity remain in the existing SQLite transaction. Journal adoption
is recorded afterwards; if that write fails, the already committed fixed Decision
is used on continuation to finish the journal fact without another model call.
This is recovery of a real commit, not invented adoption or a cross-file atomicity
claim. Unresolved original results are never interpreted as success.

An isolated failed reflection does not revive solely because an idle clock moved.
A new Event or explicitly distinct followup remains an independent opportunity.
Host-only explicit Event readmission uses the existing Driver path; arbitrary
Task/reflection readmission is not added.

The approved Affect A2 test changes from global blocking to preserved malformed
capture + same-source blocking + unrelated-source successful commit. The old
failure log remains archived. A1 and three strict legacy Budget assertions remain.
Schema11, subjective memory selection, Intent/Process/Task semantics, tool
authorization and external UNKNOWN protections are unchanged.
