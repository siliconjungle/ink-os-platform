export function desktopCommand(e,editing=false,context={}){
 const key=e.key.toLowerCase(),mod=e.metaKey||e.ctrlKey;
 const selected=context.selection??(typeof getSelection==='function'?String(getSelection()||''):'');
 if(mod&&!editing&&((key==='c'||key==='x')&&selected||key==='a'&&context.app&&!context.hasObjects))return;
 if(!mod&&!e.altKey&&(key==='enter'||key===' ')&&(e.target?.closest?.('button,a[href],[role=button],summary')||e.composedPath?.().some(node=>node?.matches?.('button,a[href],[role=button],summary'))))return;
 if(key==='escape')return'escape';if(key==='f1'||(!editing&&key==='?'))return'help';
 if(e.ctrlKey&&e.altKey&&/^arrow(left|right)$/.test(key))return(e.shiftKey?'moveDesktop':'desktop')+(key==='arrowleft'?'Previous':'Next');
 if(e.ctrlKey&&e.altKey&&/^[1-9]$/.test(key))return'desktop:'+key;
 if(e.ctrlKey&&key==='arrowup')return'overview';
 if(e.altKey&&(key==='tab'||key==='`'))return e.shiftKey?'previousWindow':'nextWindow';
 if(e.altKey&&key==='f4')return'closeWindow';if(e.altKey&&key==='d')return'showDesktop';
 if(mod){if(key==='w')return e.shiftKey?'closeAppWindows':'closeWindow';if(key==='m')return'minimize';if(key==='enter')return'expand';if(key===',')return'settings';if(key==='k')return'search';if(key==='j')return'assistant';if(key==='f')return'find';if(key==='s')return'save';if(key==='n')return e.shiftKey?'newFolder':'newWindow';if(key==='o')return'open';if(key==='r')return'reload';if(key==='t'&&e.shiftKey)return'reopen';if(key==='/')return'help';
  if(!editing){if(key==='a')return'selectAll';if(key==='c')return'copy';if(key==='x')return'cut';if(key==='v')return'paste';if(key==='d')return'duplicate';if(key==='i')return'info';if(key==='z')return e.shiftKey?'redo':'undo';if(key==='y')return'redo';if(key==='backspace'||key==='delete')return'delete';}
 }
 if(!editing&&!mod&&!e.altKey){if(key==='f2')return'rename';if(key==='delete'||key==='backspace')return'delete';if(key==='enter'||key===' ')return'open';if(e.shiftKey&&key==='f10')return'contextMenu';}
}
export const DESKTOP_SHORTCUTS=[['Files','⌘/Ctrl A','Select all'],['','⌘/Ctrl C / X / V','Copy / cut / paste'],['','⌘/Ctrl D','Duplicate selection'],['','F2','Rename'],['','Delete or ⌘Backspace','Move to deleted items'],['','⌘/Ctrl Z / Shift Z','Undo / redo desktop changes'],['','Enter / Space','Open selection'],['','⌘/Ctrl I','Information'],['','⌘/Ctrl Shift N','New collection'],['Windows','⌘/Ctrl N','New window'],['','⌘/Ctrl W / M','Close / minimize'],['','⌘/Ctrl Shift T','Reopen closed window'],['','⌘/Ctrl Enter','Maximize / restore'],['','Alt Tab / Alt `','Cycle windows'],['','⌘/Ctrl R','Reload app'],['Desktops','Ctrl Alt ← / →','Previous / next desktop'],['','Ctrl Alt Shift ← / →','Move window between desktops'],['','Ctrl Alt 1–9','Jump to a desktop'],['','Ctrl ↑','Desktop overview'],['','Alt D','Show desktop'],['Tools','⌘/Ctrl K / F','Search'],['','⌘/Ctrl S','Save in the active app'],['','⌘/Ctrl ,','Settings'],['','F1 or ⌘/Ctrl /','Keyboard shortcuts']];
