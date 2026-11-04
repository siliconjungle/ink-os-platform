"""Untrusted proof sharing; no claim is admitted without complete kernel replay.
Requires the explicitly configured ink-knowledge Python package.
"""
import json,argparse,tempfile
from pathlib import Path
from ink_knowledge import Store,canonical,identity
from producers.representations import refs
args=argparse.ArgumentParser(description='Share repeated self-contained proof certificates; replay the complete output with ink check-plan.');args.add_argument('input',type=Path);args.add_argument('output',type=Path);a=args.parse_args();
v=json.loads(a.input.read_bytes());p=v['steps'][0]['package'];objects=p['knowledge']['objects'];mapped={};new={};active=set()
# Preserve each theorem's claim. Replace duplicate self-contained bit-vector
# certificates with ordinary Use proofs; the entire result is replayed below.
proof_base={canonical(x['payload']['declaration']['Theorem']['proof']):k for k,x in objects.items() if x['kind']=='theorem' and not x['dependencies'] and 'BitVector' in x['payload']['declaration']['Theorem']['proof']}
for k,x in list(objects.items()):
 if x['kind']!='theorem':continue
 def share(t):
  if isinstance(t,dict):
   if 'BitVector'in t and canonical(t)in proof_base and proof_base[canonical(t)]!=k:
    ref=proof_base[canonical(t)];params=objects[ref]['payload']['declaration']['Theorem']['params'];return {'Use':{'theorem':ref,'arguments':[{'Var':n}for n,_ in params],'premises':[]}}
   return {n:(v if n=='certificate'else share(v))for n,v in t.items()}
  if isinstance(t,list):return[share(v)for v in t]
  return t
 y=json.loads(json.dumps(x));y['payload']['declaration']['Theorem']['proof']=share(y['payload']['declaration']['Theorem']['proof']);y['dependencies']=sorted(set(y['dependencies'])|(refs(y['payload'])&objects.keys()));objects[k]=y

def remap(x):
 if isinstance(x,str) and x in objects:return visit(x)
 if isinstance(x,list):return[remap(a)for a in x]
 if isinstance(x,dict):return{k:(a if k=='certificate'else remap(a))for k,a in x.items()}
 return x

def visit(k):
 if k in mapped:return mapped[k]
 if k in active:raise ValueError('cyclic proof object')
 active.add(k);x=remap(objects[k]);active.remove(k);x['dependencies']=sorted(set(x['dependencies']));n=identity(x);mapped[k]=n;new[n]=x;return n
views=remap(p['views']);
for k in objects:
 if objects[k]['kind']=='definition':visit(k)
todo=list((refs(views)|{k for k,x in new.items()if x['kind']=='definition'})&new.keys());keep=set()
while todo:
 k=todo.pop()
 if k in keep:continue
 keep.add(k);todo.extend((set(new[k]['dependencies'])|refs(new[k]['payload']))&new.keys()-keep)
p['views']=views
with tempfile.TemporaryDirectory(prefix='ink-plan-objects-') as temporary:
 p['knowledge']=Store.publish(Path(temporary),[new[k]for k in keep]).bundle(sorted(keep))
a.output.write_bytes(canonical(v)+b'\n')
print(json.dumps(dict(objects=len(keep),bytes=a.output.stat().st_size)))
