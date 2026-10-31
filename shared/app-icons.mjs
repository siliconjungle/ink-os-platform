const token=/^[a-z][a-z0-9.-]{0,63}$/;
/** SVGs are rendered as isolated images, preserving their colors without inserting markup into the document. */
export function appIcon(input='layers'){
 if(typeof input==='string'&&token.test(input))return input;
 if(!input||typeof input!=='object'||typeof input.svg!=='string')throw Error('Icon must be a built-in name or an SVG');
 let svg=input.svg.trim().replace(/^<\?xml[^?]*\?>\s*/i,'');
 if(new TextEncoder().encode(svg).length>32768)throw Error('SVG icons must be 32 KB or smaller');
 if(!/^<svg\b/i.test(svg)||!/(?:<\/svg>|\/>)[\s]*$/i.test(svg))throw Error('Icon must contain an SVG root');
 if(/<!|<\?|<\s*\/?\s*(?:[\w.-]+:)?(?:script|foreignObject|iframe|object|embed|image|animate\w*|set|audio|video)\b|\s(?:on[\w-]+)\s*=|@import/i.test(svg))throw Error('Use a static, self-contained SVG icon');
 for(const match of svg.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi))if(!match[2].trim().startsWith('#'))throw Error('SVG icons cannot reference external resources');
 for(const match of svg.matchAll(/url\(([^)]*)\)/gi))if(!match[1].trim().replace(/^["']|["']$/g,'').startsWith('#'))throw Error('SVG icons cannot reference external resources');
 if(!/\bxmlns\s*=/.test(svg))svg=svg.replace(/^<svg\b/i,'<svg xmlns="http://www.w3.org/2000/svg"');
 return{svg};
}
export function desktopOverrides(input={}){if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid desktop appearance');const output={};for(const[key,value]of Object.entries(input)){if(!['icon','dock','shortcut','collaborative'].includes(key))throw Error('Only icon, dock, shortcut and collaborative can be customized');if(value===null)continue;if(key==='collaborative'){if(typeof value!=='boolean')throw Error('App collaboration must be true or false');output.collaborative=value;}if(key==='icon')output.icon=appIcon(value);if(key==='dock'){if(value!==false&&(!Number.isFinite(value)||Math.abs(value)>100000))throw Error('Invalid dock position');output.dock=value;}if(key==='shortcut'){if(typeof value!=='boolean')throw Error('Desktop shortcut must be true or false');output.shortcut=value;}}return output;}
