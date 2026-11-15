"""Synthetic numerical checks plus selected original offline tests; no live data."""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE / 'vendor'), str(HERE / 'vendor' / 'upstream-tests'), str(HERE)]
import copy
import json
import math
import unittest
import adapter as a
from limbic import Engine, State, Temperament, Appraisal

T0 = 1794400000000
H = 3600000


def app(**updates):
    value = dict(event='success', summary='合成任务完成', valence=.7, intensity=.6,
                 relevance=.8, agency='self', novelty=.7, competence=.8)
    value.update(updates)
    return value


def step(s, id, hours=0, **payload):
    op = dict(id=id, expectedRevision=s['revision'], nowMs=s['wallAt'] + int(hours * H), kind='advance')
    op.update(payload)
    return a.transition(s, op)


def exp(s, id='e1', hours=0, aps=None, facts=None):
    return step(s, id, hours, kind='experience', source={'id': id, 'revision': 1},
                appraisals=aps if aps is not None else [{'weight': 1, 'value': app()}], facts=facts or {})


class Contracts(unittest.TestCase):
    def test_missing_appraisal_has_no_default_social_novelty_or_fatigue_reward(self):
        s = step(a.new_snapshot(T0), 'grow', 24)['state']
        r = exp(s, aps=[])
        self.assertEqual(s['engineState']['drives'], r['state']['engineState']['drives'])

    def test_one_contact_not_four(self):
        s = step(a.new_snapshot(T0), 'grow', 24)['state']
        one = exp(s, facts={'contacts': ['person:ann']})
        many = exp(s, aps=[{'weight': .25, 'value': app()} for _ in range(4)], facts={'contacts': ['person:ann']})
        self.assertAlmostEqual(one['state']['engineState']['drives']['social'], s['engineState']['drives']['social'] * .6)
        self.assertEqual(one['state']['engineState'], many['state']['engineState'])
        self.assertEqual(many['state']['engineState']['relationships']['person:ann']['interactions'], 1)

    def test_contact_not_emotion_target_and_target_not_contact(self):
        s = exp(a.new_snapshot(T0), aps=[], facts={'contacts': ['person:ann', 'person:bob']})['state']
        r = exp(s, id='e2', hours=24, aps=[{'weight': 1, 'value': app(target='person:bob', agency='other')}], facts={'contacts': ['person:ann']})['state']['engineState']
        self.assertEqual(r['relationships']['person:ann']['last_seen'], r['t'])
        self.assertEqual(r['relationships']['person:bob']['last_seen'], s['engineState']['t'])

    def test_activity_cost_independent_of_appraisal_count(self):
        s = a.new_snapshot(T0)
        facts = {'activity': {'kind': 'work', 'seconds': 3600, 'effort': 1}}
        one = exp(s, facts=facts)
        many = exp(s, aps=[{'weight': .5, 'value': app()}, {'weight': .5, 'value': app(event='achievement')}], facts=facts)
        self.assertEqual(one['state']['engineState']['drives']['fatigue'], .05)
        self.assertEqual(one['state']['engineState']['drives']['fatigue'], many['state']['engineState']['drives']['fatigue'])

    def test_appraisal_order_not_cumulative(self):
        s = a.new_snapshot(T0)
        aps = [{'weight': .7, 'value': app()}, {'weight': .3, 'value': app(event='setback', valence=-.6, competence=-.5)}]
        x, y = exp(s, aps=aps), exp(s, aps=list(reversed(aps)))
        self.assertEqual(x['state']['engineState'], y['state']['engineState'])
        names = {e['name'] for e in x['state']['engineState']['emotions'].values()}
        self.assertIn('joy', names)
        self.assertIn('sadness', names)

    def test_duplicate_request_current_head_never_rolls_back(self):
        s = a.new_snapshot(T0)
        op = dict(id='same', kind='experience', source={'id': 'source', 'revision': 1}, nowMs=T0,
                  expectedRevision=0, appraisals=[{'weight': 1, 'value': app()}])
        first = a.transition(s, op)['state']
        newer = step(first, 'later', 2)['state']
        again = a.transition(newer, op)
        self.assertTrue(again['receipt']['duplicate'])
        self.assertEqual(again['state'], newer)
        with self.assertRaisesRegex(a.Rejected, 'OP_CONFLICT'):
            a.transition(newer, {**op, 'appraisals': []})

    def test_same_source_new_request_rejected(self):
        s = exp(a.new_snapshot(T0))['state']
        with self.assertRaisesRegex(a.Rejected, 'SOURCE_ALREADY_APPLIED'):
            step(s, 'different', kind='experience', source={'id': 'e1', 'revision': 1}, appraisals=[])

    def test_stale_clock_and_bad_payload_rejected_without_mutation(self):
        s = a.new_snapshot(T0)
        original = copy.deepcopy(s)
        bad = [{'id': 'x', 'kind': 'advance', 'nowMs': T0, 'expectedRevision': 7},
               {'id': 'x', 'kind': 'advance', 'nowMs': T0 - 1, 'expectedRevision': 0},
               {'id': 'x', 'kind': 'advance', 'nowMs': T0, 'expectedRevision': 0, 'tool': 'send'},
               {'id': 'x', 'kind': 'experience', 'nowMs': T0, 'expectedRevision': 0, 'source': {'id': 'x', 'revision': 1}, 'appraisals': [{'weight': 1, 'value': app(intensity=float('nan'))}]}]
        for op in bad:
            with self.assertRaises(a.Rejected):
                a.transition(s, op)
        self.assertEqual(s, original)

    def test_disabled_fields_and_parameters_rejected(self):
        with self.assertRaises(a.Rejected):
            a.new_snapshot(T0, {'parameters': {'autonomy_enabled': True}})
        with self.assertRaises(a.Rejected):
            exp(a.new_snapshot(T0), aps=[{'weight': 1, 'value': app(erotic=.8)}])

    def test_online_absence_and_offline_freeze_differ(self):
        base = a.new_snapshot(T0)
        live = step(base, 'online', 90 * 24)['state']
        off = step(base, 'off', kind='mode', mode='offline')['state']
        resumed = step(off, 'on', 90 * 24, kind='mode', mode='online')['state']
        self.assertEqual(base['engineState'], resumed['engineState'])
        self.assertGreater(live['engineState']['drives']['social'], .9)
        self.assertEqual(resumed['wallAt'], live['wallAt'])

    def test_aligned_partition_and_serialized_restart(self):
        base = a.new_snapshot(T0)
        once = step(base, 'whole', 24)['state']['engineState']
        s = base
        # 24h split on the adapter's canonical five-minute grid.
        boundary = (math.floor(T0 / 300000) + 1) * 300000
        s = a.transition(s, {'id': 'align', 'kind': 'advance', 'expectedRevision': 0, 'nowMs': boundary})['state']
        for n in range(1, 25):
            now = min(T0 + 24 * H, boundary + n * H)
            s = a.transition(json.loads(json.dumps(s)), {'id': 'part' + str(n), 'kind': 'advance', 'expectedRevision': s['revision'], 'nowMs': now})['state']
        for group in ('mood', 'baseline', 'drives'):
            for key, value in once[group].items():
                self.assertAlmostEqual(value, s['engineState'][group][key], places=10)

    def test_history_changes_response_without_changing_event(self):
        base = a.new_snapshot(T0)
        tired = exp(base, aps=[], facts={'activity': {'kind': 'work', 'seconds': 86400, 'effort': 1}})['state']
        negative = [{'weight': 1, 'value': app(event='setback', valence=-.8, competence=-.8)}]
        x, y = exp(base, id='same', aps=negative), exp(tired, id='same', aps=negative)
        self.assertNotEqual(x['projection']['mood'], y['projection']['mood'])

    def test_fatigue_recovers(self):
        s = exp(a.new_snapshot(T0), aps=[], facts={'activity': {'kind': 'work', 'seconds': 86400, 'effort': 1}})['state']
        r = step(s, 'rest', 12)['state']
        self.assertAlmostEqual(r['engineState']['drives']['fatigue'], 1 / 16, places=10)

    def test_time_zone_is_explicit_and_os_independent(self):
        # Equal local clock readings at different UTC instants produce equal circadian drive.
        x = a.new_snapshot(T0, {'timezoneMinutes': 480})
        y = a.new_snapshot(T0 + 8 * H, {'timezoneMinutes': 0})
        dx = step(x, 'x', 1)['projection']['drives']['sleepiness']
        dy = step(y, 'y', 1)['projection']['drives']['sleepiness']
        self.assertAlmostEqual(dx, dy, places=12)

    def test_real_contact_eases_longing_and_refreshes_need_feelings(self):
        s = exp(a.new_snapshot(T0), aps=[], facts={'contacts': ['person:ann']})['state']
        # Explicit synthetic history; no production relationship is initialized this way.
        s['engineState']['relationships']['person:ann']['affection'] = .8
        missing = step(s, 'absence', 96)['state']
        before = missing['engineState']['relationships']['person:ann']['longing']
        self.assertGreater(before, .25)
        returned = exp(missing, id='return', aps=[], facts={'contacts': ['person:ann']})['state']['engineState']
        self.assertAlmostEqual(returned['relationships']['person:ann']['longing'], before * .15)
        self.assertFalse(returned['emotions']['longing@person:ann']['sustained'])
        self.assertFalse(returned['emotions']['loneliness']['sustained'])

    def test_jittered_partition_error_is_bounded_not_claimed_zero(self):
        base = a.new_snapshot(T0)
        once = step(base, 'whole', 7 * 24)['state']['engineState']
        s = base
        for n in range(1, 169):
            now = T0 + min(7 * 24 * H, n * H + 137000)
            s = a.transition(s, {'id': 'jitter' + str(n), 'kind': 'advance', 'expectedRevision': s['revision'], 'nowMs': now})['state']
        delta = max(abs(once[g][k] - s['engineState'][g][k]) for g in ('mood', 'baseline', 'drives') for k in once[g])
        self.assertLess(delta, .005)


def original_suite():
    import test_limbic
    import test_fatigue
    import test_trust
    # Original test classes unchanged; exclude HTTP server/model/installer paths by scope.
    classes = [test_limbic.Decay, test_limbic.Rules, test_limbic.SmallTalkCeiling,
               test_limbic.Habituation, test_limbic.Baseline, test_limbic.Drives,
               test_limbic.Relationship, test_limbic.Memory,
               test_fatigue.Circadian, test_fatigue.Sources, test_fatigue.TiredMood,
               test_trust.TrustSaturation]
    return unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(c) for c in classes)


def scenarios():
    outcomes = []
    for days in (30, 90):
        for rate in (.01, .02, .04):
            for scenario in ('idle', 'work-rest', 'negative-recovery', 'relationship'):
                s = a.new_snapshot(T0, {'parameters': {'social_need': rate}})
                samples = []
                for day in range(days):
                    if scenario == 'idle':
                        s = step(s, f'idle-{day}', 24)['state']
                    else:
                        negative = scenario == 'negative-recovery' and day < days // 2
                        value = app(event='setback' if negative else 'progress', valence=-.7 if negative else .6,
                                    competence=-.7 if negative else .6, agency='other' if scenario == 'relationship' else 'self',
                                    target='person:ann' if scenario == 'relationship' else None)
                        facts = {'activity': {'kind': 'work', 'seconds': 6 * 3600, 'effort': .8}}
                        if scenario == 'relationship':
                            facts = {'contacts': ['person:ann']}
                        s = exp(s, id=f'event-{day}', hours=8, aps=[{'weight': 1, 'value': value}], facts=facts)['state']
                        s = step(s, f'rest-{day}', 16)['state']
                    samples.append({'day': day + 1, **a.projected(State.from_dict(s['engineState']))})
                outcomes.append({'days': days, 'socialRate': rate, 'scenario': scenario, 'samples': samples,
                                 'bounded': True, 'meaning': 'synthetic-numerical-trajectory-not-psychological-or-behavior-validation'})
    return outcomes


def negative_controls():
    e = Engine(Temperament(dormant_after_h=0, circadian_strength=0))
    base = e.new_state(T0 / 1000)
    e.advance(base, base.t + 24 * 3600)
    original = []
    for n in (1, 4):
        s = copy.deepcopy(base)
        for _ in range(n):
            e.apply(s, Appraisal(valence=.5, intensity=.5, agency='self', interaction=True), s.t, speaker='person:ann')
        original.append(s.drives['social'])
    state = e.new_state(T0 / 1000)
    e.apply(state, Appraisal(target=None, agency='self'), state.t, speaker='person:ann')
    last = state.relationships['person:ann']['last_seen']
    e.apply(state, Appraisal(target=None, agency='self'), state.t + 3600, speaker='person:ann')
    stale_contact = state.relationships['person:ann']['last_seen'] == last
    dormant = Engine(Temperament(dormant_after_h=1))
    s = dormant.new_state(T0 / 1000)
    s.relationships['person:ann'] = __import__('limbic.needs', fromlist=['new_relationship']).new_relationship(s.t)
    s.relationships['person:ann'].update(is_person=True, affection=.8)
    dormant.advance(s, s.t + 4 * 86400)
    return {'originalSocialAfterOne': original[0], 'originalSocialAfterFour': original[1],
            'originalSpeakerLastSeenStale': stale_contact, 'originalDormantLonging': s.relationships['person:ann']['longing'],
            'meaning': 'reproduced-original-behavior-not-a-claim-of-human-psychology'}


if __name__ == '__main__':
    suite = original_suite()
    original_count = suite.countTestCases()
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(Contracts))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {'format': 'affect-shadow-numerical-v1', 'upstreamCommit': a.COMMIT,
              'originalTests': original_count, 'adapterTests': result.testsRun - original_count,
              'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
              'skipped': len(result.skipped), 'modelCalls': 0, 'qqConnections': 0,
              'negativeControls': negative_controls() if result.wasSuccessful() else {},
              'scenarios': scenarios() if result.wasSuccessful() else []}
    print(json.dumps(report, ensure_ascii=False, allow_nan=False))
    sys.exit(0 if result.wasSuccessful() else 1)
