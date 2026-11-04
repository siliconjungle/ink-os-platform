module tables;
record Row {id:u64,title:String,amount:u64,open:Bool,}
record Item {id:u64,title:String,amount:u64,aggregate:u64,revision:u64,}

state Rows:Table<u64,Row>=Table.empty();state Version:u64=0;
keep OpenTotal:u64=sum(Rows.values().filter(fn(row)=>row.open).map(fn(row)=>row.amount));
keep OpenCount:u64=sum(Rows.values().filter(fn(row)=>row.open).map(fn(row)=>1));
event changed:u64;
change put(expected:u64,row:Row)->Result<u64,String> reads(Rows,Version) writes(Rows,Version) emits(changed){if(expected!=Version){return Err("conflict");}Rows.put(row.id,row);Version=Version+1;emit changed(Version);return Ok(Version);}
change abort_edit(row:Row)->Result<Unit,String> reads(Rows,Version) writes(Rows,Version) emits(changed){Rows.put(row.id,row);Version=Version+1;emit changed(Version);return Err("aborted");}
change remove(expected:u64,id:u64)->Result<u64,String> reads(Rows,Version) writes(Rows,Version) emits(changed){if(expected!=Version){return Err("conflict");}Rows.remove(id);Version=Version+1;emit changed(Version);return Ok(Version);}
fn page(rows:List<Row>,offset:u32,limit:u32)->List<Row>{return rows.drop(offset).take(limit);}
query dashboard(offset:u32,limit:u32)->UiData<Item> reads(Rows,OpenTotal,OpenCount,Version){let total=OpenTotal;let revision=Version;let rows=Rows.values().filter(fn(row)=>row.open);return UiData<Item>{rows:page(rows,offset,limit).map(fn(row)=>Item{id:row.id,title:row.title,amount:row.amount,aggregate:total,revision:revision}),total:Some(OpenCount),version:Version};}
query view()->UiView<Unit>{return UiView<Unit>{root:"screen",nodes:[ui_group<Unit>("screen",UiKind.Column,["heading","editor-slot","results-slot"]),ui_heading<Unit>("heading","Tables"),ui_component<Unit>("editor-slot","editor"),ui_component<Unit>("results-slot","results")]};}
fn no_event(event:UiEvent<Unit>)->Unit{return ();}
fn results(data:UiData<Item>)->UiView<Unit>{return UiView<Unit>{root:"results",nodes:[ui_group<Unit>("results",UiKind.Column,["total","list"]),ui_text<Unit>("total",string_concat("Open total: ",ui_key(data.rows.at_or(0,Item{id:0,title:"",amount:0,aggregate:0,revision:0}).aggregate))),ui_group<Unit>("list",UiKind.List,data.rows.map(fn(row)=>string_concat("item-",ui_key(row.id))))].concat(data.rows.map(fn(row)=>ui_item<Unit>(string_concat("item-",ui_key(row.id)),row.title,[])))};}
fn editor()->UiView<Unit>{return UiView<Unit>{root:"form",nodes:[ui_form<Unit>("form","Add an open item",["title","add"],()),ui_field<Unit>("title","Title",""),ui_submit<Unit>("add","Add")]};}
change add(event:UiEvent<Unit>)->Result<Unit,String> reads(Rows,Version) writes(Rows,Version) emits(changed){let title=ui_field_text(event.input,"title");if(title==""){return Err("Enter a title");}let key=Version+1;Rows.put(key,Row{id:key,title:title,amount:1,open:true});Version=Version+1;emit changed(Version);return Ok(());}
