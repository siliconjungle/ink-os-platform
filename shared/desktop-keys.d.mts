export interface KeyInput{key:string;metaKey?:boolean;ctrlKey?:boolean;altKey?:boolean;shiftKey?:boolean}
export function desktopCommand(event:KeyInput,editing?:boolean):string|undefined;
export const DESKTOP_SHORTCUTS:string[][];
