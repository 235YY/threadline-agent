"""Bounded JSONL worker: no database, network, subprocess, or filesystem writes."""
import sys
sys.dont_write_bytecode = True
import json
import hashlib
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'vendor'))
sys.path.insert(0, str(HERE))

def deny_side_effects(event, args):
    if event.startswith(('socket.', 'subprocess.', 'sqlite3.connect')) or event in ('os.system', 'os.remove', 'os.rename', 'os.mkdir'):
        raise RuntimeError('WORKER_CAPABILITY_DENIED')
    if event == 'open':
        mode, flags = args[1], args[2]
        if (isinstance(mode, str) and any(c in mode for c in 'wax+')) or (isinstance(flags, int) and flags & 3):
            raise RuntimeError('WORKER_WRITE_DENIED')

sys.addaudithook(deny_side_effects)
def verify_vendor():
    manifest = json.loads((HERE / 'vendor' / 'MANIFEST.json').read_text(encoding='utf-8'))
    for name, wanted in manifest['files'].items():
        raw_bytes = (HERE / 'vendor' / name).read_bytes()
        if hashlib.sha256(raw_bytes).hexdigest() != wanted and hashlib.sha256(raw_bytes.replace(b'\r\n', b'\n')).hexdigest() != wanted:
            raise RuntimeError('UPSTREAM_CHANGED')

try:
    verify_vendor()
except Exception:
    sys.stdout.write('{"ok":false,"error":"UPSTREAM_CHANGED"}\n')
    sys.exit(0)
import adapter

def dispatch(request):
    verify_vendor()
    adapter.finite(request)
    action = request.get('action')
    if action == 'initialize':
        return {'state': adapter.new_snapshot(request['nowMs'], request.get('config'))}
    if action == 'transition':
        return adapter.transition(request['state'], request['operation'])
    raise adapter.Rejected('WORKER_ACTION')

for raw in sys.stdin.buffer:
    try:
        adapter.check(len(raw) <= 8 * 1024 * 1024, 'INPUT_LIMIT')
        value = json.loads(raw, parse_constant=lambda _v: (_ for _ in ()).throw(adapter.Rejected('NONFINITE')))
        result = {'ok': True, 'result': dispatch(value)}
    except Exception as error:
        result = {'ok': False, 'error': getattr(error, 'code', 'WORKER_REJECTED')}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n')
    sys.stdout.flush()
