import { readFile } from 'node:fs/promises';
import { fixture, file, owner } from './ink-effects-fixture.mjs';
import { InkViews } from '../server/ink-ui.mjs';
import { InkPreviews } from '../server/ink-previews.mjs';
import { buildInkApp } from '../server/ink-apps.mjs';
export { owner, file };
export const library = await readFile(
  new URL('../sdk/ink/ui.ink', import.meta.url),
  'utf8',
);
const exports = [
  ...library.matchAll(/(?:record|enum|fn)\s+([A-Za-z_][A-Za-z_0-9]*)/g),
].map((match) => match[1]);
export const source = `module app;
record Row {id:u64,title:String,}
state Rows:Table<u64,Row>=Table.empty();state Next:u64=1;state Page:Bool=false;
query view()->UiView<Bool> reads(Page){return UiView<Bool>{root:"screen",nodes:[ui_group<Bool>("screen",UiKind.Column,["nav","editor-slot","rows-slot"]),ui_group<Bool>("nav",UiKind.Navigation,["first","second"]),ui_nav_item<Bool>("first","First",!Page,false),ui_nav_item<Bool>("second","Second",Page,true),ui_component<Bool>("editor-slot","editor"),ui_component<Bool>("rows-slot","rows")]};}
change navigate(event:UiEvent<Bool>)->Result<Unit,String> writes(Page){Page=event.action;return Ok(());}
fn editor()->UiView<Unit>{return UiView<Unit>{root:"form",nodes:[ui_form<Unit>("form","Add an item",["title","save"],()),ui_field<Unit>("title","Title",""),ui_submit<Unit>("save","Add")]};}
change add(event:UiEvent<Unit>)->Result<Unit,String> reads(Rows,Next) writes(Rows,Next){let title=ui_field_text(event.input,"title");if(title==""){return Err("Enter a title");}let key=Next;if(Rows.contains(key)){Rows.replace(key,Row{id:key,title:title});}else{Rows.insert(key,Row{id:key,title:title});}Next=Next+1;return Ok(());}
query rows()->UiView<u64> reads(Rows){let records=Rows.values();return UiView<u64>{root:"list",nodes:[ui_group<u64>("list",UiKind.List,records.map(fn(row)=>string_concat("row-",ui_key(row.id))))].concat(records.map(fn(row)=>ui_item<u64>(string_concat("row-",ui_key(row.id)),row.title,[string_concat("delete-",ui_key(row.id))]))).concat(records.map(fn(row)=>ui_button<u64>(string_concat("delete-",ui_key(row.id)),"Delete",row.id)))};}
change remove(event:UiEvent<u64>)->Result<Unit,String> reads(Rows) writes(Rows){Rows.remove(event.action);return Ok(());}
change seed()->Unit reads(Rows) writes(Rows){if(Rows.contains(18446744073709551615)){Rows.replace(18446744073709551615,Row{id:18446744073709551615,title:"Wide"});}else{Rows.insert(18446744073709551615,Row{id:18446744073709551615,title:"Wide"});}return ();}
`;
export function uiFiles(code = source, overrides = {}) {
  const manifest = {
    slug: 'typed-ui',
    language: 'ink',
    exports: ['navigate', 'add', 'remove', 'seed'],
    ui: {
      version: 1,
      entry: 'view',
      event: 'navigate',
      components: [
        { name: 'editor', entry: 'editor', event: 'add' },
        { name: 'rows', entry: 'rows', event: 'remove' },
      ],
    },
    modules: {
      version: 1,
      root: 'main.ink',
      modules: [
        {
          path: 'main.ink',
          name: 'app',
          dependencies: ['ui.ink'],
          exports: [
            'view',
            'editor',
            'rows',
            'navigate',
            'add',
            'remove',
            'seed',
          ],
        },
        { path: 'ui.ink', name: 'ink_ui', dependencies: [], exports },
      ],
    },
    ...overrides,
  };
  return {
    manifest,
    files: [
      file('main.ink', code),
      file('ui.ink', library),
      file('ink-app.json', JSON.stringify(manifest)),
    ],
  };
}
export async function uiFixture(t, options = {}) {
  const f = await fixture(t),
    p = f.platform;
  p.inkPreviews = new InkPreviews({ platform: p });
  p.inkViews = await new InkViews({ platform: p, ...options }).open();
  t.after(() => p.inkViews.close());
  const data = uiFiles(),
    bundle = await buildInkApp(data.manifest, data.files),
    app = await p.createApp({
      slug: 'typed-ui',
      capabilities: bundle.capabilities,
    }),
    release = await p.createRelease(app.id, bundle);
  await p.publish(app.id, release.id);
  return { ...f, p, app, release, bundle, data };
}
export function event(frame, node, kind, input) {
  return {
    sequence: 1,
    revision: frame.revision,
    node: node.id,
    kind,
    token: node.events.find((binding) => binding.kind === kind).token,
    input: input || { text: '', checked: false, fields: [], expected: '' },
  };
}
