// Indexed UTF-16 / Unicode-scalar conversion. Edits rebuild only small coordinate blocks.
export class TextCoordinates{
 constructor(text){this.blocks=[];this.replace(text);}
 replace(text){this.blocks=[];for(let i=0;i<text.length;){let end=Math.min(text.length,i+1024);if(end<text.length&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;const value=text.slice(i,end);this.blocks.push({text:value,units:value.length,scalars:Array.from(value).length});i=end;}this.index();}
 index(){this.units=[0];this.scalars=[0];for(const block of this.blocks){this.units.push(this.units.at(-1)+block.units);this.scalars.push(this.scalars.at(-1)+block.scalars);}}
 find(offset,prefix){let lo=0,hi=this.blocks.length;while(lo<hi){const mid=(lo+hi)>>1;if(prefix[mid+1]<=offset)lo=mid+1;else hi=mid;}return Math.min(lo,Math.max(0,this.blocks.length-1));}
 scalarOffset(offset){if(!this.blocks.length)return 0;const i=this.find(offset,this.units);return this.scalars[i]+Array.from(this.blocks[i].text.slice(0,offset-this.units[i])).length;}
 utf16Offset(offset){if(!this.blocks.length)return 0;const i=this.find(offset,this.scalars);let units=this.units[i],remaining=offset-this.scalars[i];for(const value of this.blocks[i].text){if(remaining--<=0)break;units+=value.length;}return units;}
 splice(at,remove,value){if(!this.blocks.length){this.replace(value);return;}const first=this.find(at,this.units),last=this.find(at+remove,this.units),text=this.blocks[first].text.slice(0,at-this.units[first])+value+this.blocks[last].text.slice(at+remove-this.units[last]),replacement=new TextCoordinates(text);this.blocks.splice(first,last-first+1,...replacement.blocks);this.index();}
}
