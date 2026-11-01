// Shared monochrome file glyphs. Shapes use the same 24px, rounded stroke grid as Ink OS.
const page='<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"/>';
export const fileIconPaths={
 document:page+'<path d="M8 13h8M8 17h5"/>',
 image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
 vector:'<path d="M5 17C5 6 19 6 19 17M4 7h16M12 5v4"/><rect x="3" y="16" width="4" height="4" rx=".5"/><rect x="17" y="16" width="4" height="4" rx=".5"/>',
 audio:page+'<path d="M8 14v3m3-5v7m3-6v5m3-4v3"/>',
 video:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8 6 4-6 4zM3 7h3M3 12h3M3 17h3M18 7h3M18 12h3M18 17h3"/>',
 pdf:page+'<path d="M7 18v-5h1.5a1.3 1.3 0 0 1 0 2.6H7m5 2.4v-5h1a2.5 2.5 0 0 1 0 5h-1m5 0v-5h2m-2 2.5h1.5"/>',
 text:page+'<path d="M8 12h8M8 15h8M8 18h5"/>',
 code:page+'<path d="m10 13-3 3 3 3m4-6 3 3-3 3"/>',
 table:page+'<path d="M7 12h10v7H7zM7 15h10M11 12v7"/>',
 archive:page+'<path d="M11 4v3m0 3v2m0 2v2m-2-7h4m-4 4h4m-3 4h3v3h-3z"/>',
 font:page+'<path d="m8 18 4-7 4 7m-6.5-2h5"/>',
 model:'<path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5"/>',
 link:'<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 4 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>'
};
const extensions={image:'png jpg jpeg gif webp avif heic heif bmp tif tiff ico psd ase aseprite',vector:'svg ai eps',audio:'wav mp3 flac ogg opus m4a aac aiff aif mid midi',video:'mp4 mov webm mkv avi m4v mpg mpeg',pdf:'pdf',text:'txt md markdown rtf doc docx odt pages',code:'ink js mjs cjs ts tsx jsx json jsonl html css scss xml yaml yml toml py rs sh sql glsl wgsl',table:'csv tsv xls xlsx ods numbers',archive:'zip gz tgz bz2 xz tar rar 7z',font:'ttf otf woff woff2',model:'obj glb gltf fbx stl blend usd usdz'};
const byExtension=new Map(Object.entries(extensions).flatMap(([type,list])=>list.split(' ').map(ext=>[ext,type])));
export function fileIconType(file={}){
 let body={};try{body=typeof file.body==='string'?JSON.parse(file.body):file.body||{};}catch{}body=body&&typeof body==='object'?body:{};
 const mime=String(body.mime||file.mime||file.type||'').toLowerCase().split(';')[0].trim(),name=String(body.originalName||file.source||file.name||file.title||''),ext=name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
 if(mime==='image/svg+xml')return'vector';if(mime.startsWith('image/'))return'image';if(mime.startsWith('audio/'))return'audio';if(mime.startsWith('video/'))return'video';if(mime==='application/pdf')return'pdf';
 if(/(?:spreadsheet|excel|csv|tab-separated)/.test(mime))return'table';if(/(?:zip|compressed|x-tar|gzip)/.test(mime))return'archive';if(mime.startsWith('font/')||/font|woff/.test(mime))return'font';if(mime.startsWith('model/'))return'model';
 if(byExtension.has(ext))return byExtension.get(ext);if(/(?:json|javascript|typescript|xml|yaml|toml)/.test(mime))return'code';if(mime.startsWith('text/'))return'text';
 return({image:'image',audio:'audio',video:'video',note:'text',code:'code',link:'link'}[file.kind])||'document';
}
export function fileIconSVG(file,size=24){size=Number.isFinite(size)?Math.max(8,Math.min(256,size)):24;return'<svg xmlns="http://www.w3.org/2000/svg" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+fileIconPaths[fileIconType(file)]+'</svg>';}
