// Lightweight reference bridge connecting Threadline's `/v1/events` SSE stream
// to external desktop pets & ecosystems (Cortico / Coopanion, DeepSeek Harness / DSH,
// Live2D / VRM / VTuber overlays). Zero external dependencies.
const baseUrl = (process.env.THREADLINE_GATEWAY_URL || 'http://127.0.0.1:18792').replace(/\/+$/, '');
const apiKey = process.env.THREADLINE_GATEWAY_KEY || '';

export async function subscribeThreadlineEvents({
  url = `${baseUrl}/v1/events`,
  token = apiKey,
  onEvent = ev => console.log(JSON.stringify(ev)),
  signal,
} = {}) {
  const res = await fetch(url, {
    headers: {accept: 'text/event-stream', ...(token ? {authorization: `Bearer ${token}`} : {})},
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Failed to connect Threadline event stream (${res.status})`);
  const decoder = new TextDecoder();
  let buf = '';
  let eventName = 'message';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, {stream: true});
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) { eventName = 'message'; continue; }
      if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
      if (line.startsWith('data:')) {
        const raw = line.slice(5).trim();
        try { onEvent({event: eventName, ...JSON.parse(raw)}); }
        catch { onEvent({event: eventName, raw}); }
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error(`[threadline-bridge] Subscribing to ${baseUrl}/v1/events ...`);
  await subscribeThreadlineEvents();
}
