// Keep app-defined data kinds visible without exposing platform bookkeeping as desktop objects.
const controls=new Set(['state','release','collaboration','fork-snapshot','os.version']);
export function userRecord(object){return !!object&&!controls.has(object.kind)&&!(object.kind==='file'&&object.tags?.includes('app-source'));}
