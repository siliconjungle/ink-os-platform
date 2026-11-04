export interface KeyInput{key:string;metaKey?:boolean;ctrlKey?:boolean;altKey?:boolean;shiftKey?:boolean}
export function desktopCommand(event:KeyInput,editing?:boolean,context?:{app?:boolean;hasObjects?:boolean;selection?:string}):string|undefined;
export const DESKTOP_SHORTCUTS:string[][];
