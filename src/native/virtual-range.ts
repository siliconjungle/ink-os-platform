export interface Range {start:number;end:number;rows:number;columns:number;height:number}
export function visibleRange(count:number,scrollTop:number,viewportHeight:number,rowHeight:number,columns=1,overscan=2):Range{
 if(rowHeight<=0||columns<1)throw Error('Invalid virtual geometry');columns=Math.max(1,Math.floor(columns));const rows=Math.ceil(count/columns);
 const first=Math.max(0,Math.floor(scrollTop/rowHeight)-overscan);const last=Math.min(rows,Math.ceil((scrollTop+viewportHeight)/rowHeight)+overscan);
 return{start:Math.min(count,first*columns),end:Math.min(count,Math.max(first,last)*columns),rows,columns,height:rows*rowHeight};
}
