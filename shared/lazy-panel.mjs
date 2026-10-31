// Inactive desktop pages have no iframe/JS context. Data and pending edits live in the host.
export function lazyPanel(create,node){let child,hidden=true,parked=false,closed=false,context;
 const mount=()=>{if(child||closed||parked||hidden)return;child=create();node.replaceChildren(child.node);if(context)child.context?.(context);};
 return{node,get background(){return !!child?.background;},acceptsFilePreview:files=>child?.acceptsFilePreview?.(files)||false,acceptsFiles:files=>child?.acceptsFiles?.(files)||false,dropFiles:(files,ids)=>child?.dropFiles?.(files,ids),destroy(){closed=true;child?.destroy();child=undefined;node.replaceChildren();},suspend(value){hidden=value;mount();child?.suspend?.(value);},park(value){parked=value;if(value&&!child?.background){child?.destroy();child=undefined;node.replaceChildren();}else mount();},context(value){context=value;child?.context?.(value);},command(value){child?.command?.(value);}};
}
