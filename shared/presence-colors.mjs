// A shared identity palette: readable dark labels, bright pointers, no red/green-only identification.
export const PRESENCE_COLORS=Object.freeze(['#6CA8F5','#B299F2','#F2AA6B','#5BC9B1','#E991B7','#D5BE65','#83C2DF','#A5CA7A','#E28F7C','#929FE8']);
export const PRESENCE_INK='#17202B';
const index=id=>{let hash=2166136261;for(const char of String(id))hash=Math.imul(hash^char.charCodeAt(0),16777619);return(hash>>>0)%PRESENCE_COLORS.length;};
/** Existing sessions keep their color; new sessions take the least-used slot nearest their identity hash. */
export function presenceColor(id,peers=[]){const current=peers.find(peer=>peer.id===id);if(PRESENCE_COLORS.includes(current?.color))return current.color;const usage=new Map(PRESENCE_COLORS.map(color=>[color,0]));for(const peer of peers)if(peer.id!==id&&usage.has(peer.color))usage.set(peer.color,usage.get(peer.color)+1);const least=Math.min(...usage.values()),start=index(id);for(let offset=0;offset<PRESENCE_COLORS.length;offset++){const color=PRESENCE_COLORS[(start+offset)%PRESENCE_COLORS.length];if(usage.get(color)===least)return color;}return PRESENCE_COLORS[start];}
export function peerColor(peer){return PRESENCE_COLORS.includes(peer.color)?peer.color:presenceColor(peer.id);}
/** Label geometry is independent of the pointer hotspot, including narrow viewports and bottom/right edges. */
export function cursorLabel(x,y,textWidth,width,height){const labelWidth=Math.min(Math.max(24,width-16),180,Math.ceil(textWidth)+14),labelHeight=23,side=x+14+labelWidth>width-8?'left':'right',left=Math.max(8,Math.min(width-labelWidth-8,side==='left'?x-labelWidth-8:x+14)),top=Math.max(8,Math.min(height-labelHeight-8,y+22+labelHeight>height-8?y-labelHeight-8:y+22));return{width:labelWidth,x:left-x,y:top-y,side};}
