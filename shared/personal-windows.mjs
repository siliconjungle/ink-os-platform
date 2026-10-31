// A tab owns its app views. Shared desktop records never create or close these windows.
export function personalWindows(storage,legacy){let record;try{record=JSON.parse(storage.getItem('ink-personal-windows-v1')||'null');}catch{}return record&&Array.isArray(record.windows)?record:legacy||{windows:[]};}
export function savePersonalWindows(storage,windows,workspace){storage.setItem('ink-personal-windows-v1',JSON.stringify({windows,workspace}));}
