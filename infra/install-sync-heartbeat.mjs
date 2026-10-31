// Patch only the stateless heartbeat handler in the exact inherited OS image.
// This preserves unrelated deployed server changes while rolling out the client.
import{readFileSync,writeFileSync}from'node:fs';
const path=process.argv[2]||'/opt/ink-os/server/collaboration.mjs',source=readFileSync(path,'utf8'),marker='message=JSON.parse(bytes.toString());',reply="if(message.type==='ping'){send({type:'pong',requestId:message.requestId});return;}";
if(!source.includes(reply)){if(source.split(marker).length!==2)throw Error('Sync server heartbeat insertion point is ambiguous');writeFileSync(path,source.replace(marker,marker+reply));}
