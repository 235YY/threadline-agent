// Failure scope for the inbound QQ connector.
// A normal message failure must not stop the receiver. Only shared receive
// ownership/identity/state failures are allowed to take the connector out.
const GLOBAL_STOP = new Set([
  'RECEIVE_STATE_UNAVAILABLE',
  'RECEIVE_RECOVERY_REQUIRED',
  'RECEIVE_STATE_INVALID',
  'RECEIVE_BACKLOG_LIMIT',
  'QQ_IDENTITY_NOT_READY',
  'CONNECTOR_OWNED',
]);

export function shouldStopConnector(error) {
  const code = String(error?.code ?? '');
  if (GLOBAL_STOP.has(code)) return true;
  return /^RECEIVE_(STATE|RECOVERY|BACKLOG)_/.test(code);
}

export function isMessageScopedFailure(error) {
  return !shouldStopConnector(error);
}
