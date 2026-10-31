// Preserve Ink's portable snapshot bytes while avoiding boxed byte arrays and
// a tiny allocation for every integer byte during each durable World write.
export function optimizeSnapshotWriter(source){
 const before=" const out=[];let left=limits.values,maxDepth=0;\n function bytes(xs){if(xs.length>limits.bytes-out.length)throw Error('snapshot byte limit exceeded');for(const x of xs)out.push(x);}\n function integer(n,size){n=BigInt(n);for(let i=0;i<size;i++){bytes([Number(n&255n)]);n>>=8n;}}";
 const after=` let out=new Uint8Array(Math.min(16384,limits.bytes)),view=new DataView(out.buffer),offset=0,left=limits.values,maxDepth=0;
 function reserve(size){if(size>limits.bytes-offset)throw Error('snapshot byte limit exceeded');const end=offset+size;if(end>out.length){const next=new Uint8Array(Math.min(limits.bytes,Math.max(end,out.length*2,16384)));next.set(out);out=next;view=new DataView(out.buffer);}}
 function bytes(xs){reserve(xs.length);out.set(xs,offset);offset+=xs.length;}
 function integer(n,size){n=BigInt(n);reserve(size);if(size===4)view.setUint32(offset,Number(n&0xffffffffn),true);else if(size===8)view.setBigUint64(offset,BigInt.asUintN(64,n),true);else if(size===16){view.setBigUint64(offset,BigInt.asUintN(64,n),true);view.setBigUint64(offset+8,BigInt.asUintN(64,n>>64n),true);}else for(let i=0;i<size;i++){out[offset+i]=Number(n&255n);n>>=8n;}offset+=size;}`;
 if(source.includes('function reserve(size){if(size>limits.bytes-offset)'))return source;
 if(source.split(before).length!==2||source.split('finish:()=>new Uint8Array(out)').length!==2)throw Error('Unrecognized Ink snapshot writer; review the compiler output before patching');
 return source.replace(before,after).replace('finish:()=>new Uint8Array(out)','finish:()=>out.slice(0,offset)');
}
