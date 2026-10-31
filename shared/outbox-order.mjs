// IndexedDB indexes order equal timestamps by random request IDs. Text edits
// need their causal predecessors first, including queues written by older clients.
export function orderOutbox(entries){
 const rows=[...entries],owners=new Map(),actors=new Map(),edges=rows.map(()=>new Set()),incoming=rows.map(()=>0);
 for(let index=0;index<rows.length;index++){
  const row=rows[index];if(row.kind!=='text')continue;
  for(const op of row.updates){const id=BigInt(op.id),width=BigInt((typeof op.text==='string'?Array.from(op.text).length:op.text.length)+op.remove),actor=row.document+'\0'+String(id>>32n),list=actors.get(actor)||[];
   owners.set(row.document+'\0'+String(id+width-1n),index);list.push({id,index});actors.set(actor,list);
  }
 }
 const depend=(before,after)=>{if(before!==undefined&&before!==after&&!edges[before].has(after)){edges[before].add(after);incoming[after]++;}};
 for(const list of actors.values()){list.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);for(let i=1;i<list.length;i++)depend(list[i-1].index,list[i].index);}
 for(let index=0;index<rows.length;index++)if(rows[index].kind==='text')for(const op of rows[index].updates)for(const parent of op.parents||[])depend(owners.get(rows[index].document+'\0'+parent),index);
 const compare=(a,b)=>(rows[a].order&&rows[b].order?rows[a].order-rows[b].order:rows[a].created-rows[b].created)||rows[a].id.localeCompare(rows[b].id),ready=[];
 for(let i=0;i<rows.length;i++)if(!incoming[i])ready.push(i);
 const sorted=[];while(ready.length){ready.sort(compare);const index=ready.shift();sorted.push(rows[index]);for(const next of edges[index])if(!--incoming[next])ready.push(next);}
 if(sorted.length!==rows.length)throw Error('Pending text edits contain a causal cycle');return sorted;
}
