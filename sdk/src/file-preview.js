import {connect} from './browser.js';

export function previewKind(file) {
 let meta = {}; try { meta = JSON.parse(file.body); } catch {}
 const mime = meta.mime || '', name = meta.originalName || file.source || file.title || '';
 if (mime.startsWith('image/') || file.kind === 'image' || /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(name)) return 'image';
 if (mime.startsWith('audio/') || file.kind === 'audio' || /\.(mp3|m4a|wav|ogg|flac|aac|opus)$/i.test(name)) return 'audio';
 if (mime.startsWith('video/') || file.kind === 'video' || /\.(mp4|webm|mov)$/i.test(name)) return 'video';
 if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
 if (mime.startsWith('text/') || /(?:json|javascript|xml)/.test(mime) || ['note','code'].includes(file.kind) || /\.(txt|md|json|js|ts|css|html|csv|tsv|ink|log|ya?ml)$/i.test(name)) return 'text';
 return 'metadata';
}

/** Preview providers render without starting their normal editor or background work. */
export async function startPreview({render} = {}) {
 const root = document.createElement('main'); root.className = 'ink-file-preview'; root.tabIndex = 0;
 const style = document.createElement('style');
 style.textContent = `html,body{height:100%;margin:0;overflow:hidden;background:#171819;color:#eee;font:14px system-ui}body>main.ink-file-preview{box-sizing:border-box;width:100%;height:100%;padding:24px;overflow:auto;display:block;outline:none}body>main.ink-file-preview img,body>main.ink-file-preview video{display:block;max-width:100%;max-height:calc(100vh - 48px);object-fit:contain;margin:auto}body>main.ink-file-preview audio{display:block;width:min(560px,100%);margin:48px auto}body>main.ink-file-preview pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;margin:0}body>main.ink-file-preview iframe{border:0;width:100%;height:100%}body>main.ink-file-preview table{border-collapse:collapse;width:100%}body>main.ink-file-preview th,body>main.ink-file-preview td{padding:8px;border:1px solid #444;text-align:left;white-space:pre-wrap}body>main.ink-file-preview button{color:inherit;background:#303235;border:1px solid #555;border-radius:6px;padding:6px 12px;margin:0 8px 12px 0}body>main.ink-file-preview a{color:#9cc9ff}`;
 document.head.append(style); document.body.replaceChildren(root); root.textContent = 'Loading preview…'; root.focus();
 let dispose, generation = 0;
 try {
  const ink = await connect();
  const paint = async () => {
   const current = ++generation; dispose?.(); dispose = undefined;
   const file = await ink.world.get(ink.route.id);
   if (current !== generation) return;
   root.replaceChildren();
   if (!file || file.archived) { root.textContent = 'Item unavailable'; return; }
   document.title = file.title || 'Preview';
   if (render) { dispose = await render({ink, file, root}); return; }
   const kind = previewKind(file);
   if (['image','audio','video','pdf'].includes(kind)) {
    const media = document.createElement(kind === 'image' ? 'img' : kind === 'pdf' ? 'iframe' : kind);
    media.src = ink.files.url(file.id); media.title = file.title; media.alt = file.title;
    if (kind === 'audio' || kind === 'video') media.controls = true;
    root.append(media);
    dispose = () => { if (media.pause) media.pause(); media.removeAttribute('src'); media.remove(); };
   } else if (kind === 'text') {
    const {text} = await ink.files.readText(file.id);
    if (current !== generation) return;
    const pre = document.createElement('pre'); pre.textContent = text; root.append(pre);
   } else {
    const title = document.createElement('h2'); title.textContent = file.title || 'Untitled';
    const details = document.createElement('p'); let meta = {}; try { meta = JSON.parse(file.body); } catch {}
    details.textContent = [meta.mime || file.kind, Number.isFinite(meta.bytes) ? meta.bytes.toLocaleString() + ' bytes' : '', file.summary].filter(Boolean).join(' · ');
    root.append(title, details);
    if (file.kind === 'link' && /^https?:\/\//.test(file.source)) { const link = document.createElement('a'); link.href = file.source; link.target = '_blank'; link.rel = 'noopener'; link.textContent = file.source; root.append(link); }
   }
  };
  ink.on('world.delta', delta => { if ((delta.objects || []).some(file => file.id === ink.route.id) || (delta.removed || []).includes(ink.route.id)) void paint().catch(error => { root.textContent = error.message; }); });
  addEventListener('pagehide', () => { ++generation; dispose?.(); }, {once:true});
  ink.ready(); await paint(); return ink;
 } catch (error) { root.textContent = error.message; root.setAttribute('role','alert'); }
}
