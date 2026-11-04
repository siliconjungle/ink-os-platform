"""Plot matching refresh/live benchmark cells; requires explicit matplotlib/NumPy."""
import json,sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
baseline=json.load(open(sys.argv[1]))['runs'];live=json.load(open(sys.argv[2]))['runs']; by_key={(r['mode'],r['workload']['seedRows']):r for r in live}
fig,ax=plt.subplots(figsize=(9,4.8),layout='constrained');plt.rcParams['svg.fonttype']='none'
x=np.arange(len(baseline))
for offset,label,color,runs in [(-.18,'Explicit refresh','#6c7f99',baseline),(.18,'Retained delivery','#31856e',[by_key[(r['mode'],r['workload']['seedRows'])]for r in baseline])]:
 med=np.array([r['editToPaint']['p50Ms']for r in runs]);tail=np.array([r['editToPaint']['p95Ms']for r in runs]);ax.bar(x+offset,med,.34,label=label,color=color);ax.errorbar(x+offset,med,yerr=[np.zeros(len(med)),tail-med],fmt='none',ecolor='#283443',capsize=4,linewidth=1.2)
ax.set_xticks(x,[('JavaScript'if r['mode']=='javascript'else'Native')+'\n'+f"{r['workload']['seedRows']:,} rows"for r in baseline]);ax.set_ylabel('DOM / animation-frame proxy (ms)');ax.set_title('Retained delivery removes the client invalidation wait\nMedians with p95 whiskers · 32 edits per cell · physical presentation is not measured',loc='left',pad=14);ax.spines[['top','right']].set_visible(False);ax.grid(axis='y',alpha=.16);ax.set_axisbelow(True);ax.legend(frameon=False);fig.savefig(sys.argv[3]);fig.savefig(sys.argv[3].replace('.svg','.png'),dpi=150)
