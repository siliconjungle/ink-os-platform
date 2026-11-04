"""Plot measured profile summaries. Requires an explicitly installed matplotlib.
Usage: python scripts/plot-ink-system-profile.py SUMMARY.json OUTPUT_DIRECTORY
"""
import json,sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
source=Path(sys.argv[1]); output=Path(sys.argv[2]);output.mkdir(parents=True,exist_ok=True)
r=json.loads(source.read_text()); runs=r['runs']; labels={'baseline-javascript':'Baseline JS','javascript':'Selected JS','native':'Native'}
plt.rcParams.update({'font.size':10,'svg.fonttype':'none','axes.spines.top':False,'axes.spines.right':False})
fig,ax=plt.subplots(figsize=(11,5.5),layout='constrained')
keys=[('submitToInvalidation','Submit → invalidation'),('invalidationToRefresh','Invalidation → refresh'),('refreshRpc','Refresh RPC'),('domApply','DOM application'),('applyDispatch','Apply dispatch'),('observationAndFrameTail','Observation + frame tail')]
colors=['#324c81','#d69a32','#5983bd','#39856e','#a2c8b8','#bcc4ce']; left=np.zeros(len(runs)); y=np.arange(len(runs))
for (key,label),color in zip(keys,colors):
 values=np.array([run['phaseMs'][key]['mean'] for run in runs]);ax.barh(y,values,left=left,label=label,color=color,height=.73);left+=values
ax.set_yticks(y,[f"{run['rows']:,} rows · {labels[run['mode']]}" for run in runs]);ax.invert_yaxis();ax.set_xlabel('Mean elapsed time per edit (ms); 32 edits per cell');ax.set_title('Where edit-to-observed-frame time goes\nDOM completion is measured; physical display presentation is outside the measurement',loc='left',pad=15);ax.grid(axis='x',alpha=.15);ax.set_axisbelow(True);ax.legend(ncol=3,loc='upper center',bbox_to_anchor=(.5,-.16),frameon=False)
fig.savefig(output/'tables-profile-latency.svg');fig.savefig(output/'tables-profile-latency.png',dpi=150);plt.close(fig)
fig,(ax,storage)=plt.subplots(1,2,figsize=(11,4.8),layout='constrained')
selected=[run for run in runs if run['mode']=='javascript']; x=np.arange(len(selected)); categories=[('Entries in write reply',lambda run:run['byteGroups']['put']['responseFieldsPerReply']['entries']),('Other write reply',lambda run:run['byteGroups']['put']['responseBytesPerEdit']-run['byteGroups']['put']['responseFieldsPerReply']['entries']),('Two UI replies',lambda run:sum(g['responseBytesPerEdit'] for key,g in run['byteGroups'].items() if key.startswith('refresh:'))),('Request bodies',lambda run:sum(g['requestBytesPerEdit'] for g in run['byteGroups'].values()))]; bottom=np.zeros(len(selected))
for (label,fn),color in zip(categories,['#324c81','#5983bd','#39856e','#d69a32']):
 values=np.array([fn(run)/1000 for run in selected]);ax.bar(x,values,bottom=bottom,label=label,color=color,width=.6);bottom+=values
ax.set_xticks(x,[f"{run['rows']:,}" for run in selected]);ax.set_ylabel('kB per edit (1 kB = 1,000 bytes)');ax.set_title('RPC bodies stay almost flat',loc='left');ax.set_xlabel('Rows · selected JavaScript');ax.legend(loc='upper left',bbox_to_anchor=(0,-.17),frameon=False,fontsize=9)
wal=np.array([run['walBytesPerEdit']/1000 for run in selected]);checkpoints=np.array([run['checkpointBytesPerEdit']/1000 for run in selected]);storage.bar(x,wal,label='WAL appends',color='#324c81',width=.6);storage.bar(x,checkpoints,bottom=wal,label='Collaboration checkpoint replacement',color='#d69a32',width=.6);storage.set_xticks(x,[f"{run['rows']:,}\n{len([s for s in run['checkpointEdits'] if s['collaborationCheckpoint']])} checkpoint(s)" for run in selected]);storage.set_xlabel('Rows · selected JavaScript');storage.set_ylabel('kB per edit averaged across 32 edits');storage.set_title('Persistence includes periodic whole-state work',loc='left');storage.legend(loc='upper left',bbox_to_anchor=(0,-.17),frameon=False,fontsize=9)
for axis in [ax,storage]:axis.grid(axis='y',alpha=.15);axis.set_axisbelow(True)
fig.savefig(output/'tables-profile-bytes.svg');fig.savefig(output/'tables-profile-bytes.png',dpi=150);plt.close(fig)
