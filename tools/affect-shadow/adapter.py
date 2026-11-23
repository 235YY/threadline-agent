"""Experimental host-owned affect transitions. No persistence, model or tool calls."""
import copy
import hashlib
import json
import math
from datetime import datetime, timedelta, timezone

from limbic.engine import Engine, State, circadian as upstream_circadian
import limbic.engine as core
from limbic.appraisal import Appraisal
from limbic.temperament import Temperament
from limbic import needs

VERSION = 'jingyang-affect-shadow-v1'
COMMIT = '2132fa81b20134f469fd7adeb8e38fa20dd32071'
PARAMS = {'reactivity': (0, 3), 'social_need': (0, .2), 'novelty_need': (0, .2),
          'competence_need': (0, .2), 'recognition_need': (0, .2),
          'fatigue_recovery_h': (.25, 48), 'mood_tau_h': (.1, 48),
          'baseline_tau_d': (1, 90), 'resilience_tau_d': (1, 180),
          'circadian_strength': (0, 1)}
APP_FIELDS = {'event', 'summary', 'valence', 'intensity', 'relevance', 'agency',
              'target', 'prospective', 'loss', 'blocked', 'humor', 'novelty',
              'affinity', 'competence', 'fiction'}
RANGES = {'valence': (-1, 1), 'intensity': (0, 1), 'relevance': (0, 1),
          'humor': (0, 1), 'novelty': (0, 1), 'affinity': (-1, 1), 'competence': (-1, 1)}


class Rejected(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def check(ok, code):
    if not ok:
        raise Rejected(code)


def canonical(x):
    return json.dumps(x, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def digest(x):
    return hashlib.sha256(canonical(x).encode()).hexdigest()


def finite(x):
    if isinstance(x, float):
        check(math.isfinite(x), 'NONFINITE')
    elif isinstance(x, dict):
        for v in x.values():
            finite(v)
    elif isinstance(x, list):
        for v in x:
            finite(v)


def number(v, lo, hi):
    return type(v) in (int, float) and math.isfinite(v) and lo <= v <= hi


def configuration(value):
    value = value or {}
    check(isinstance(value, dict) and set(value) <= {'timezoneMinutes', 'parameters'}, 'CONFIG')
    offset = value.get('timezoneMinutes', 480)
    check(type(offset) is int and -720 <= offset <= 840, 'TIMEZONE')
    parameters = value.get('parameters', {})
    check(isinstance(parameters, dict) and set(parameters) <= set(PARAMS), 'PARAMETER')
    for key, v in parameters.items():
        check(number(v, *PARAMS[key]), 'PARAMETER')
    return {'timezoneMinutes': offset, 'parameters': parameters, 'offlinePolicy': 'freeze-lived-time',
            'aggregation': 'weighted-counterfactual-v1', 'fatigue': 'explicit-activity-hours-v1'}


def temperament(config):
    return Temperament(**config['parameters'], dormant_after_h=0, romance_enabled=False,
                       adult_enabled=False, autonomy_enabled=False, leisure_enabled=False)


def projected(s):
    names = ('social', 'novelty', 'competence', 'recognition', 'fatigue', 'sleepiness')
    return {'drives': {k: s.drives[k] for k in names}, 'mood': dict(s.mood),
            'baseline': dict(s.baseline), 'emotions': copy.deepcopy(s.emotions),
            'meaning': 'computed-state-not-endorsed-concern-or-action-command'}


def new_snapshot(now_ms, config=None):
    check(type(now_ms) is int and 1_000_000_000_000 <= now_ms <= 9_000_000_000_000, 'TIME')
    c = configuration(config)
    s = Engine(temperament(c)).new_state(now_ms / 1000)
    return {'format': VERSION, 'upstream': COMMIT, 'revision': 0, 'wallAt': now_ms,
            'mode': 'online', 'config': c, 'engineState': s.to_dict(), 'requests': {}, 'sources': {}}


def clock_function(config, wall_now, engine_now):
    # Explicit fixed offset (v1 has no DST); never inherits the worker's OS timezone.
    shift = wall_now / 1000 - engine_now
    zone = timezone(timedelta(minutes=config['timezoneMinutes']))
    def clock(T, now):
        if not T.circadian_strength:
            return 0.0
        local = datetime.fromtimestamp(now + shift, zone)
        h = local.hour + local.minute / 60.0
        bed, wake = T.sleep_hours
        m, night = (h - bed) % 24, (wake - bed) % 24 or 8
        peak = .4 * night
        if m >= 22:
            v = .5 * (m - 22) / 2
        elif m < peak:
            v = .5 + .35 * m / peak
        elif m < night:
            v = .85 - .75 * (m - peak) / (night - peak)
        elif m < night + 1:
            v = .1 * (1 - (m - night))
        else:
            v = 0
        return max(0, min(1, v * T.circadian_strength))
    return clock


def validate_appraisal(item, known):
    check(isinstance(item, dict) and set(item) == {'weight', 'value'}, 'APPRAISAL_SHAPE')
    check(number(item['weight'], 0, 1) and item['weight'] > 0, 'WEIGHT')
    a = item['value']
    check(isinstance(a, dict) and set(a) <= APP_FIELDS, 'APPRAISAL_FIELD')
    check({'event', 'summary', 'valence', 'intensity', 'relevance', 'agency'} <= set(a), 'APPRAISAL_REQUIRED')
    check(isinstance(a['event'], str) and 0 < len(a['event']) <= 80 and isinstance(a['summary'], str) and len(a['summary']) <= 400, 'APPRAISAL_TEXT')
    check(a['agency'] in ('self', 'other', 'circumstance'), 'AGENCY')
    for k, bounds in RANGES.items():
        if k in a:
            check(number(a[k], *bounds), 'APPRAISAL_RANGE')
    for k in ('prospective', 'loss', 'blocked', 'fiction'):
        check(k not in a or type(a[k]) is bool, 'APPRAISAL_BOOLEAN')
    check(a.get('target') is None or a['target'] in known, 'UNKNOWN_ENTITY')
    return Appraisal(**a, interaction=False, effort=0)


def episode(engine, s, op, now):
    facts = op.get('facts', {})
    check(isinstance(facts, dict) and set(facts) <= {'contacts', 'activity'}, 'FACTS')
    contacts = facts.get('contacts', [])
    check(isinstance(contacts, list) and len(contacts) <= 8 and len(set(contacts)) == len(contacts), 'CONTACTS')
    for entity in contacts:
        check(isinstance(entity, str) and 0 < len(entity) <= 120, 'ENTITY')
        s.relationships.setdefault(entity, needs.new_relationship(now))['is_person'] = True
    before = copy.deepcopy(s)
    aps = op.get('appraisals', [])
    check(isinstance(aps, list) and len(aps) <= 8, 'APPRAISALS')
    check(not aps or abs(sum(a.get('weight', -99) for a in aps) - 1) < 1e-9, 'WEIGHT_SUM')
    candidates, effects = [], []
    for item in aps:
        ap = validate_appraisal(item, set(s.relationships))
        candidate = copy.deepcopy(before)
        saved_fatigue = engine.t.fatigue_per_effort
        engine.t.fatigue_per_effort = 0
        try:
            eff = engine.apply(candidate, ap, now)
        finally:
            engine.t.fatigue_per_effort = saved_fatigue
        candidates.append((item['weight'], candidate))
        effects.append({'weight': item['weight'], 'appraisal': ap.to_dict(), 'effects': eff})
    # Counterfactual components all start from the same state; order does not compound rewards.
    if candidates:
        for attr in ('mood', 'drives'):
            base = getattr(before, attr)
            setattr(s, attr, {k: base[k] + math.fsum(w * (getattr(c, attr)[k] - base[k]) for w, c in candidates) for k in base})
        s.emotions = copy.deepcopy(before.emotions)
        for key in set().union(*(set(c.emotions) for _, c in candidates)):
            old = before.emotions.get(key, {}).get('i', 0)
            options = [(w, c.emotions[key]) for w, c in candidates if key in c.emotions]
            e = copy.deepcopy(max(options, key=lambda x: (x[0], canonical(x[1])))[1])
            e['i'] = old + math.fsum(w * (c.emotions.get(key, {}).get('i', 0) - old) for w, c in candidates)
            s.emotions[key] = e
        for entity, rel in s.relationships.items():
            for k, value in before.relationships[entity].items():
                if type(value) in (int, float) and k not in ('interactions', 'last_seen', 'first_seen'):
                    rel[k] = value + math.fsum(w * (c.relationships[entity].get(k, value) - value) for w, c in candidates)
        for key in set().union(*(set(c.habituation) for _, c in candidates)):
            s.habituation[key] = max([before.habituation.get(key, 0)] + [c.habituation.get(key, 0) for _, c in candidates])
    # Contact bookkeeping uses host facts, not the emotion target or number of appraisals.
    if contacts:
        valence = math.fsum(a['weight'] * a['value']['valence'] for a in aps)
        s.drives['social'] = before.drives['social'] * (.6 if valence >= -.3 else .85)
        s.last_interaction = now
        for entity in contacts:
            contact_effects = {'emotions': {}}
            contact = Appraisal(event='contact', summary='host-confirmed contact', valence=0,
                                intensity=0, relevance=0, agency='other', target=entity,
                                interaction=True, novelty=0)
            # Reuse upstream reunion/longing transitions once per actual contact.
            needs.on_event(engine, s, contact, 0, s.relationships[entity], now, contact_effects)
            s.relationships[entity]['last_seen'] = now
            s.relationships[entity]['interactions'] = before.relationships[entity].get('interactions', 0) + 1
        for emotion, drive in (('loneliness', 'social'), ('boredom', 'novelty')):
            if s.emotions.get(emotion, {}).get('sustained'):
                engine._sustain(s, emotion, s.drives[drive], now)
    # Fatigue is one explicit activity's elapsed work, not a per-appraisal or per-request fee.
    activity = facts.get('activity')
    cost = 0
    if activity is not None:
        check(isinstance(activity, dict) and set(activity) == {'kind', 'seconds', 'effort'}, 'ACTIVITY')
        check(activity['kind'] in ('work', 'social', 'leisure', 'rest'), 'ACTIVITY_KIND')
        check(number(activity['seconds'], 0, 86400) and number(activity['effort'], 0, 1), 'ACTIVITY_RANGE')
        share = {'work': 1, 'social': engine.t.social_fatigue, 'leisure': engine.t.passive_fatigue, 'rest': 0}[activity['kind']]
        cost = engine.t.fatigue_per_effort * activity['effort'] * activity['seconds'] / 3600 * share
        if cost:
            s.fatigue_src[activity['kind']] = s.fatigue_src.get(activity['kind'], 0) + cost
    s.drives['fatigue'] = min(1, before.drives['fatigue'] + cost)
    s.events = before.events + 1
    engine._update_label(s)
    return {'components': effects, 'contactsCounted': len(contacts), 'fatigueCost': cost,
            'aggregation': 'weighted-counterfactual-v1', 'counterfactualFatigueNotCommitted': True}


def cognitive_episode(engine, s, op, now, times_recalled):
    # Use the upstream memory path, not apply(): no earned drives, contacts or event count.
    before = copy.deepcopy(s)
    aps = op.get('appraisals', [])
    check(isinstance(aps, list) and 1 <= len(aps) <= 8, 'APPRAISALS')
    check(abs(sum(a.get('weight', -99) for a in aps) - 1) < 1e-9, 'WEIGHT_SUM')
    candidates, effects = [], []
    for item in aps:
        ap = validate_appraisal(item, set(s.relationships))
        candidate = copy.deepcopy(before)
        effect = engine.recall(candidate, {'appraisal': ap.to_dict()}, now, times_recalled)
        candidates.append((item['weight'], candidate))
        effects.append({'weight': item['weight'], 'appraisal': ap.to_dict(), **effect})
    for key in set().union(*(set(c.emotions) for _, c in candidates)):
        old = before.emotions.get(key, {}).get('i', 0)
        options = [(w, c.emotions[key]) for w, c in candidates if key in c.emotions]
        emotion = copy.deepcopy(max(options, key=lambda x: (x[0], canonical(x[1])))[1])
        emotion['i'] = old + math.fsum(w * (c.emotions.get(key, {}).get('i', 0) - old) for w, c in candidates)
        s.emotions[key] = emotion
    engine._update_label(s)
    return {'policy': 'upstream-recall-weighted-v1', 'timesRecalledBefore': times_recalled,
            'contactsCounted': 0, 'fatigueCost': 0, 'externalEventsCounted': 0,
            'committedFields': ['emotions', 'mood_index'], 'components': effects}


def transition(snapshot, op):
    finite(snapshot)
    finite(op)
    s0 = copy.deepcopy(snapshot)
    check(s0.get('format') == VERSION and s0.get('upstream') == COMMIT, 'STATE_VERSION')
    check(set(op) <= {'id', 'kind', 'nowMs', 'expectedRevision', 'source', 'facts', 'appraisals', 'mode', 'memoryKey'}, 'OP_FIELD')
    check(isinstance(op.get('id'), str) and 0 < len(op['id']) <= 160, 'OP_ID')
    fingerprint = digest({k: v for k, v in op.items() if k != 'expectedRevision'})
    if op['id'] in s0['requests']:
        check(s0['requests'][op['id']] == fingerprint, 'OP_CONFLICT')
        return {'state': s0, 'receipt': {'operationId': op['id'], 'duplicate': True, 'revision': s0['revision']}, 'projection': projected(State.from_dict(s0['engineState']))}
    check(op.get('expectedRevision') == s0['revision'], 'STALE_STATE')
    check(len(s0['requests']) < 8192, 'SHADOW_HISTORY_LIMIT')
    now_ms = op.get('nowMs')
    check(type(now_ms) is int and s0['wallAt'] <= now_ms <= s0['wallAt'] + 100 * 86400000, 'TIME_ORDER_OR_HORIZON')
    check(op.get('kind') in ('advance', 'experience', 'cognitive', 'mode'), 'OP_KIND')
    if op['kind'] not in ('experience', 'cognitive'):
        check(not (set(op) & {'facts', 'appraisals', 'source'}), 'NONEXPERIENCE_PAYLOAD')
    source_key = None
    if op['kind'] in ('experience', 'cognitive'):
        source = op.get('source')
        check(isinstance(source, dict) and set(source) == {'id', 'revision'} and isinstance(source['id'], str) and source['id'] and type(source['revision']) is int and source['revision'] > 0, 'SOURCE')
        source_key = canonical(source)
        check(source_key not in s0['sources'], 'SOURCE_ALREADY_APPLIED')
    if op['kind'] != 'cognitive':
        check('memoryKey' not in op, 'NONCOGNITIVE_PAYLOAD')
    config = s0['config']
    check(config == configuration({'timezoneMinutes': config['timezoneMinutes'], 'parameters': config['parameters']}), 'CONFIG_CHANGED')
    e, s = Engine(temperament(config)), State.from_dict(s0['engineState'])
    check(not s.intents and not s.sexuality and s.drives.get('libido', 0) == 0 and s.drives.get('intimacy', 0) == 0, 'DISABLED_STATE')
    elapsed = (now_ms - s0['wallAt']) / 1000 if s0['mode'] == 'online' else 0
    target = s.t + elapsed
    old_clock = core.circadian
    core.circadian = clock_function(config, now_ms, target)
    try:
        # Anchor to a global 5-minute grid; never let long gaps enlarge the integration step.
        while s.t < target:
            e.advance(s, min(target, (math.floor(s.t / 300) + 1) * 300))
        effects = {}
        if op['kind'] == 'cognitive':
            check(s0['mode'] == 'online', 'EXPERIENCE_WHILE_OFFLINE')
            check('facts' not in op, 'COGNITIVE_FACTS_FORBIDDEN')
            memory_key = op.get('memoryKey')
            check(isinstance(memory_key, str) and len(memory_key) == 64 and all(c in '0123456789abcdef' for c in memory_key), 'COGNITIVE_MEMORY_KEY')
            counts = s0.setdefault('cognitiveCounts', {})
            times = counts.get(memory_key, 0)
            check(type(times) is int and 0 <= times <= 8192, 'COGNITIVE_COUNT')
            effects = cognitive_episode(e, s, op, target, times)
            counts[memory_key] = times + 1
        if op['kind'] == 'experience':
            check(s0['mode'] == 'online', 'EXPERIENCE_WHILE_OFFLINE')
            effects = episode(e, s, op, target)
        if op['kind'] == 'mode':
            check(op.get('mode') in ('online', 'offline'), 'MODE')
            s0['mode'] = op['mode']
    finally:
        core.circadian = old_clock
    s0.update(engineState=s.to_dict(), wallAt=now_ms, revision=s0['revision'] + 1)
    s0['requests'][op['id']] = fingerprint
    if source_key:
        s0['sources'][source_key] = op['id']
    finite(s0)
    check(all(number(v, 0, 1) for v in s.drives.values()) and all(number(v, -1, 1) for v in s.mood.values()), 'STATE_BOUNDS')
    return {'state': s0, 'receipt': {'operationId': op['id'], 'duplicate': False, 'fromRevision': snapshot['revision'], 'revision': s0['revision'],
            'source': op.get('source'), 'livedSeconds': elapsed, 'effects': effects, 'configHash': digest(config), 'stateHash': digest(s0)}, 'projection': projected(s)}
