// Read-only, bounded, privacy-aware social projection for model views.
// Aggregates entity/person context, cross-session metadata ("elsewhere"),
// readable speaker names, relative timestamps, and private-source boundaries.
import { anchorKey } from './anchor.mjs';
import { findPerson } from './identity.mjs';

const clip = (s, max = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max) + '…';
};

export const isPrivateScene = scene =>
  typeof scene === 'string' && (scene.startsWith('qq/private/') || scene.startsWith('private:'));

export const isGroupScene = scene =>
  typeof scene === 'string' && (scene.startsWith('qq/group/') || scene.startsWith('group:'));

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return '不到1分钟';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}分钟`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}小时`;
  return `${Math.floor(ms / 86_400_000)}天`;
}

export function formatRelativeTime(at, now) {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(now)) return null;
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return '刚刚';
  return formatDuration(diff) + '前';
}

export function resolveSpeakerName(store, { sender = null, actor = null } = {}) {
  const rawName = sender?.name || sender?.nickname || null;
  if (rawName && typeof rawName === 'string' && rawName.trim() && rawName.trim() !== sender?.id) {
    return rawName.trim();
  }
  const entityId = sender?.entityId ?? (typeof actor === 'string' && actor.startsWith('person:') ? actor : null);
  if (store && entityId) {
    try {
      const entity = store.read(entityId);
      if (entity?.type === 'entity' && entity.name && entity.name !== entity.id) return entity.name;
    } catch {}
  }
  if (store && sender?.system && sender?.id) {
    try {
      const entity = findPerson(store, { system: sender.system, id: sender.id });
      if (entity?.name && entity.name !== entity.id) return entity.name;
    } catch {}
  }
  if (rawName) return rawName.trim();
  if (typeof actor === 'string' && actor && !['host', 'agent', 'system'].includes(actor)) {
    return actor.startsWith('person:') ? actor.split(':').at(-1) : actor;
  }
  return '对方';
}

function resolvePersonEntity(store, currentEvent) {
  if (!currentEvent || !['observed', 'reported'].includes(currentEvent.origin)) return null;
  const sender = currentEvent.sender ?? null;
  const actor = currentEvent.actor ?? null;
  let entity = null;
  if (sender?.entityId) {
    try {
      const e = store.read(sender.entityId);
      if (e?.type === 'entity' && e.kind === 'person') entity = e;
    } catch {}
  }
  if (!entity && sender?.system && sender?.id) {
    try { entity = findPerson(store, { system: sender.system, id: sender.id }); } catch {}
  }
  if (!entity && actor && !['host', 'agent', 'system'].includes(actor)) {
    entity = [...store.all('entity')].find(
      e => e.kind === 'person' && (e.id === actor || e.name === actor || (e.aliases ?? []).includes(actor))
    ) ?? null;
  }
  const entityId = entity?.id ?? sender?.entityId ?? null;
  const externalId = sender?.id ?? (entityId?.startsWith('person:') ? entityId.split(':').at(-1) : null);
  if (!entity && !sender && (!actor || ['host', 'agent', 'system'].includes(actor))) return null;
  return { entity, entityId, externalId, sender, actor };
}

function recordScenes(store, record) {
  const scenes = new Set();
  const refs = [
    ...(record.basis?.observations ?? []),
    ...(record.evidence ?? []),
    ...(Array.isArray(record.rootIds) ? record.rootIds.map(id => ({ id })) : []),
  ];
  for (const r of refs) {
    if (!r?.id) continue;
    try {
      const ev = r.revision ? store.read(r.id, r.revision) : store.read(r.id);
      if (ev?.scene) scenes.add(ev.scene);
    } catch {}
  }
  for (const s of record.scope?.scenes ?? []) if (s) scenes.add(s);
  return [...scenes];
}

export function socialProjection({ store, subjectId, currentEvent = null, attentionFrame = null, now = null } = {}) {
  if (!store || !subjectId) return null;
  // Indexed stores answer each question from a bounded index read instead of a full scan.
  const indexed = typeof store.newestInScene === 'function';
  const clock = Number.isSafeInteger(now) ? now : (store.clockNow?.() ?? Date.now());
  const currentScene = currentEvent?.scene ?? null;
  const currentAt = currentEvent ? (currentEvent.occurredAt ?? currentEvent.recordedAt ?? null) : null;
  const senderName = currentEvent
    ? (currentEvent.origin === 'tool_receipt' ? 'host' : resolveSpeakerName(store, { sender: currentEvent.sender, actor: currentEvent.actor }))
    : null;

  // Pending inbox scan across all scenes (bounded metadata only).
  const inboxGroups = new Map();
  let pendingInScene = 0;
  try {
    let afterSeq = 0;
    for (let page = 0; page < 4; page++) {
      const batch = store.subjectInbox({ subjectId, pendingOnly: true, afterSeq, limit: 100 });
      if (!batch.items.length) break;
      afterSeq = batch.items.at(-1).seq;
      for (const row of batch.items) {
        const ev = store.read(row.eventId);
        if (!ev || ev.type !== 'event') continue;
        if (currentScene && ev.scene === currentScene) {
          if (!currentEvent || ev.id !== currentEvent.id) pendingInScene++;
          continue;
        }
        if (!ev.scene) continue;
        const at = ev.occurredAt ?? ev.recordedAt ?? clock;
        let g = inboxGroups.get(ev.scene);
        if (!g) {
          g = { where: ev.scene, pendingCount: 0, earliestAt: at, latestAt: at, from: new Set() };
          inboxGroups.set(ev.scene, g);
        }
        g.pendingCount++;
        if (at < g.earliestAt) g.earliestAt = at;
        if (at > g.latestAt) g.latestAt = at;
        if (['observed', 'reported'].includes(ev.origin)) {
          g.from.add(resolveSpeakerName(store, { sender: ev.sender, actor: ev.actor }));
        }
      }
      if (!batch.hasMore) break;
    }
  } catch {}

  const elsewhere = [...inboxGroups.values()]
    .sort((a, b) => a.earliestAt - b.earliestAt || a.where.localeCompare(b.where))
    .slice(0, 8)
    .map(g => {
      const wait = formatDuration(Math.max(0, clock - g.earliestAt));
      const latestAgo = formatRelativeTime(g.latestAt, clock);
      const priv = isPrivateScene(g.where);
      return {
        where: g.where,
        pendingCount: g.pendingCount,
        ...(wait ? { waiting: wait } : {}),
        ...(latestAgo ? { latestAgo } : {}),
        ...(g.from.size ? { from: [...g.from].slice(0, 4) } : {}),
        ...(priv ? { private: true } : {}),
        summary: priv
          ? `私聊有${g.pendingCount}条未读，已等${wait ?? '不久'}`
          : `${g.pendingCount}条未处理消息，最新${latestAgo ?? '刚刚'}`,
      };
    });

  // Person aggregation for the current speaker.
  let person = null;
  const target = resolvePersonEntity(store, currentEvent);
  if (target) {
    const { entity, entityId, externalId, sender, actor } = target;
    const personKey = entityId ? `entity:${entityId}` : null;
    const matchesEvent = ev => {
      if (!ev || !['observed', 'reported'].includes(ev.origin)) return false;
      if (entityId && ev.sender?.entityId === entityId) return true;
      if (externalId && ev.sender?.id === externalId) return true;
      if (actor && !['host', 'agent', 'system'].includes(actor) && ev.actor === actor) return true;
      return false;
    };

    const knowledge = [];
    if (personKey) {
      for (const type of ['personal_state', 'note']) {
        for (const rec of store.all(type)) {
          if (type === 'personal_state') {
            if (rec.subject !== subjectId || rec.status === 'closed' || rec.kind === 'impression') continue;
          } else if (rec.status !== 'current') continue;
          const aKey = anchorKey(rec.anchor);
          const aboutHit = Array.isArray(rec.about) && rec.about.some(r => `${r.kind}:${r.id}` === personKey);
          if (aKey !== personKey && !aboutHit) continue;
          const scenes = recordScenes(store, rec);
          const fromScene = scenes[0] ?? null;
          const privateOnly = scenes.some(sc => isPrivateScene(sc) && sc !== currentScene);
          const at = rec.recordedAt ?? null;
          knowledge.push({
            kind: rec.kind ?? type,
            ...(rec.mind?.role ? { role: rec.mind.role } : {}),
            text: clip(rec.body, 200),
            ...(formatRelativeTime(at, clock) ? { ago: formatRelativeTime(at, clock) } : {}),
            ...(fromScene ? { fromScene } : {}),
            ...(privateOnly ? { privateOnly: true, privacy: '私聊内容，不可在群聊或对他人外传' } : {}),
            _at: at ?? 0,
          });
        }
      }
      knowledge.sort((a, b) => b._at - a._at);
    }
    const knowledgeList = knowledge.slice(0, 8).map(({ _at, ...rest }) => rest);

    // Related active/paused processes involving this person.
    const relatedWork = [];
    if (attentionFrame?.processes?.length) {
      const linkedProcIds = new Set();
      for (const link of indexed ? store.extensionRecords({ stateType: 'event-process-link', owner: subjectId }) : store.all('extension_record')) {
        if (link.owner === subjectId && link.stateType === 'event-process-link' && link.value?.status === 'active') {
          const ev = link.value.event?.id ? store.read(link.value.event.id, link.value.event.revision) : null;
          if (matchesEvent(ev)) linkedProcIds.add(link.value.processId);
        }
      }
      for (const proc of attentionFrame.processes) {
        if (['completed', 'abandoned'].includes(proc.status)) continue;
        const basisHit = (proc.basis ?? []).some(r => matchesEvent(store.read(r.id, r.revision)));
        if (!basisHit && !linkedProcIds.has(proc.id)) continue;
        const ago = formatRelativeTime(proc.updatedAt ?? proc.recordedAt ?? null, clock);
        relatedWork.push({
          title: proc.label,
          status: proc.status,
          ...(ago ? { updatedAgo: ago } : {}),
        });
        if (relatedWork.length >= 4) break;
      }
    }

    // Cross-session interaction snippets with this person outside currentScene.
    const cross = [];
    for (const ev of indexed && externalId ? store.newestFromSender({ senderId: externalId, limit: 200 }) : store.all('event')) {
      if (!ev.scene || ev.scene === currentScene) continue;
      if (!matchesEvent(ev)) continue;
      const at = ev.occurredAt ?? ev.recordedAt ?? 0;
      const priv = isPrivateScene(ev.scene);
      cross.push({
        where: ev.scene,
        who: resolveSpeakerName(store, { sender: ev.sender, actor: ev.actor }),
        ...(formatRelativeTime(at, clock) ? { ago: formatRelativeTime(at, clock) } : {}),
        text: clip(ev.body, 120),
        ...(priv ? { privateOnly: true, privacy: '来自私聊，不可在群聊或对他人外传' } : {}),
        _at: at,
      });
    }
    // Include own sent replies in private chats with this person when currently outside that private chat.
    const privateSceneForPerson = externalId ? `qq/private/${externalId}` : null;
    if (privateSceneForPerson && privateSceneForPerson !== currentScene) {
      for (const resp of indexed ? store.newestInScene({ type: 'response', scene: privateSceneForPerson, limit: 12 }) : store.all('response')) {
        if (resp.subject !== subjectId || resp.status !== 'sent' || !resp.body) continue;
        let sc = resp.scene ?? null;
        if (!sc && resp.decision?.id) {
          try {
            const d = store.read(resp.decision.id);
            const e = d?.currentEvent ? store.read(d.currentEvent.id) : null;
            if (e?.scene) sc = e.scene;
          } catch {}
        }
        if (sc !== privateSceneForPerson) continue;
        const at = resp.recordedAt ?? 0;
        cross.push({
          where: sc,
          who: '你',
          ...(formatRelativeTime(at, clock) ? { ago: formatRelativeTime(at, clock) } : {}),
          text: clip(resp.body, 120),
          privateOnly: true,
          privacy: '来自私聊，不可在群聊或对他人外传',
          _at: at,
        });
      }
    }
    cross.sort((a, b) => b._at - a._at);
    const crossSession = cross.slice(0, 6).map(({ _at, ...rest }) => rest);
    const hasPrivate = knowledgeList.some(k => k.privateOnly) || crossSession.some(c => c.privateOnly);

    person = {
      who: {
        name: resolveSpeakerName(store, { sender, actor }),
        ...(entityId ? { id: entityId } : {}),
        ...(externalId ? { externalId } : {}),
        ...(sender?.isOwner ? { isOwner: true } : {}),
        ...(entity?.aliases?.length ? { aliases: entity.aliases.slice(0, 6) } : {}),
        ...(entity?.description ? { description: clip(entity.description, 160) } : {}),
      },
      ...(knowledgeList.length ? { knowledge: knowledgeList } : {}),
      ...(relatedWork.length ? { relatedWork } : {}),
      ...(crossSession.length ? { crossSession } : {}),
      ...(hasPrivate ? { privacyNotice: '标有 privateOnly 的信息来自私聊，严禁在群聊或对他人转述或暗示' } : {}),
    };
  }

  // Recent tool receipts in the current scene (last 20 minutes, excluding currentEvent)
  // so multi-step tool chains retain earlier tool outputs across turns.
  const recentTools = [];
  if (currentScene) {
    const actionByReceipt = new Map();
    if (!indexed) try {
      for (const a of store.all('action')) {
        if (a.receipt?.id) actionByReceipt.set(a.receipt.id, a);
      }
    } catch {}
    const candidates = [];
    for (const ev of indexed ? store.newestInScene({ type: 'event', scene: currentScene, since: clock - 20 * 60_000, limit: 200 }) : store.all('event')) {
      if (ev.origin !== 'tool_receipt' || ev.scene !== currentScene) continue;
      if (currentEvent && ev.id === currentEvent.id) continue;
      const at = ev.occurredAt ?? ev.recordedAt ?? 0;
      if (clock - at > 20 * 60_000) continue;
      const act = indexed ? store.actionForReceipt(ev.id) : actionByReceipt.get(ev.id);
      if (!act) continue;
      let summary=clip(ev.body,320);
      if(act.tool?.startsWith('qq_send_')){
        try{
          const parsed=JSON.parse(ev.body);
          if(parsed?.message_id!==undefined)summary='已发送并投递（请用自然语言转述，不要向用户报内部回执号）';
        }catch{}
      }
      candidates.push({
        tool: act.tool,
        status: act.status,
        ago: formatRelativeTime(at, clock),
        summary,
        _at: at,
      });
    }
    candidates.sort((a, b) => b._at - a._at);
    for (const item of candidates.slice(0, 4)) {
      const { _at, ...rest } = item;
      recentTools.push(rest);
    }
  }

  return {
    currentMeta: {
      ...(senderName ? { senderName } : {}),
      ...(formatRelativeTime(currentAt, clock) ? { ago: formatRelativeTime(currentAt, clock) } : {}),
      pendingInScene,
    },
    ...(person ? { person } : {}),
    ...(elsewhere.length ? { elsewhere } : {}),
    ...(recentTools.length ? { recentTools } : {}),
  };
}
