module app;
record Row {id:u64,title:String,}
state Rows:Table<u64,Row>=Table.empty();state Next:u64=1;state Page:Bool=false;
fn screen(page:Bool,content:String)->UiView<Bool> {
 return UiView<Bool>{root:"screen",nodes:[
  ui_group<Bool>("screen",UiKind.Column,["heading","nav","editor-slot","content-slot"]),
  ui_heading<Bool>("heading","Ink items"),
  ui_group<Bool>("nav",UiKind.Navigation,["list","table"]),
  ui_nav_item<Bool>("list","List",!page,false),
  ui_nav_item<Bool>("table","Table",page,true),
  ui_component<Bool>("editor-slot","editor"),
  ui_component<Bool>("content-slot",content)
 ]};
}
query view()->UiView<Bool> reads(Page) {
 if(Page){return screen(true,"grid");}
 return screen(false,"rows");
}
change navigate(event:UiEvent<Bool>)->Result<Unit,String> writes(Page){Page=event.action;return Ok(());}
fn editor()->UiView<Unit>{return UiView<Unit>{root:"form",nodes:[ui_form<Unit>("form","Add an item",["title","save"],()),ui_field<Unit>("title","Title",""),ui_submit<Unit>("save","Add")]};}
change add(event:UiEvent<Unit>)->Result<Unit,String> reads(Rows,Next) writes(Rows,Next){let title=ui_field_text(event.input,"title");if(title==""){return Err("Enter a title");}let key=Next;if(Rows.contains(key)){Rows.replace(key,Row{id:key,title:title});}else{Rows.insert(key,Row{id:key,title:title});}Next=Next+1;return Ok(());}
query rows()->UiView<u64> reads(Rows){let records=Rows.values();return UiView<u64>{root:"list",nodes:[ui_group<u64>("list",UiKind.List,records.map(fn(row)=>string_concat("row-",ui_key(row.id))))].concat(records.map(fn(row)=>ui_item<u64>(string_concat("row-",ui_key(row.id)),row.title,[string_concat("delete-",ui_key(row.id))]))).concat(records.map(fn(row)=>ui_button<u64>(string_concat("delete-",ui_key(row.id)),"Delete",row.id)))};}
change remove(event:UiEvent<u64>)->Result<Unit,String> reads(Rows) writes(Rows){Rows.remove(event.action);return Ok(());}
query grid()->UiView<u64> reads(Rows) {
 let records=Rows.values();
 return UiView<u64>{root:"table",nodes:[
  ui_description<u64>(ui_group<u64>("table",UiKind.Table,["head","body"]),"Items. Activate a row to remove it."),
  ui_group<u64>("head",UiKind.TableHead,["head-row"]),
  ui_group<u64>("head-row",UiKind.TableRow,["title-heading","id-heading"]),
  ui_header<u64>("title-heading","Title"),
  ui_header<u64>("id-heading","ID"),
  ui_group<u64>("body",UiKind.TableBody,records.map(fn(row)=>string_concat("row-",ui_key(row.id))))
 ].concat(records.map(fn(row)=>ui_events<u64>(ui_group<u64>(string_concat("row-",ui_key(row.id)),UiKind.TableRow,[string_concat("title-",ui_key(row.id)),string_concat("id-",ui_key(row.id))]),Some(row.id),None,None,None)))
 .concat(records.map(fn(row)=>ui_cell<u64>(string_concat("title-",ui_key(row.id)),row.title)))
 .concat(records.map(fn(row)=>ui_cell<u64>(string_concat("id-",ui_key(row.id)),ui_key(row.id))))};
}
