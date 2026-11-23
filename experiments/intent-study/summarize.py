# Summarize a results.json from run.mjs into a markdown table (stdout).
import json,sys,collections
d=json.load(open(sys.argv[1]));R=[r for r in d['results'] if 'crash' not in r]
arms=['full','intent'];scen=sorted({r['scenario'] for r in R})
def stat(rs):
  n=len(rs);ok=sum(r['adopted'] for r in rs)
  tin=sum(r['calls'][0]['usage'].get('prompt_tokens',0) for r in rs)/max(n,1);tout=sum(r['calls'][0]['usage'].get('completion_tokens',0) for r in rs)/max(n,1)
  ms=sum(sum(c['ms'] for c in r['calls']) for r in rs)/max(n,1);fmt=sum(r['firstPassFormatOk'] for r in rs)
  errs=collections.Counter(r['error']['code'] for r in rs if r['error'])
  return n,ok,tin,tout,ms,fmt,errs
print('| 协议 | 次数 | 采用 | 首次格式合格 | 平均输入token | 平均输出token | 平均耗时 | 拒绝原因 |\n|---|---|---|---|---|---|---|---|')
for a in arms:
  n,ok,tin,tout,ms,fmt,errs=stat([r for r in R if r['arm']==a])
  print(f"| {a} | {n} | {ok}/{n} | {fmt}/{n} | {tin:.0f} | {tout:.0f} | {ms/1000:.1f}s | {', '.join(f'{k}×{v}' for k,v in errs.items()) or '—'} |")
print('\n| 场景 | full 采用 | intent 采用 | 场景检查（full / intent） |\n|---|---|---|---|')
for s in scen:
  row=[]
  for a in arms:
    rs=[r for r in R if r['arm']==a and r['scenario']==s];row.append(f"{sum(r['adopted'] for r in rs)}/{len(rs)}")
  chk=[]
  for a in arms:
    c=collections.Counter()
    for r in R:
      if r['arm']==a and r['scenario']==s and r['checks']:
        for k,v in r['checks'].items():c[k]+=bool(v)
    chk.append(', '.join(f'{k}={v}' for k,v in c.items()) or '—')
  print(f"| {s} | {row[0]} | {row[1]} | {chk[0]} / {chk[1]} |")
