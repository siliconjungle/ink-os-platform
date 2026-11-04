module dashboard;
record Item {id:u64,title:String,amount:u64,aggregate:u64,revision:u64,}
query view()->UiView<Unit>{return UiView<Unit>{root:"screen",nodes:[ui_group<Unit>("screen",UiKind.Column,["heading","results-slot"]),ui_heading<Unit>("heading","Open orders dashboard"),ui_component<Unit>("results-slot","results")]};}
fn no_event(event:UiEvent<Unit>)->Unit{return ();}
fn results(data:UiData<Item>)->UiView<Unit>{return UiView<Unit>{root:"results",nodes:[ui_group<Unit>("results",UiKind.Column,["total","list"]),ui_text<Unit>("total",string_concat("Open total: ",ui_key(data.rows.at_or(0,Item{id:0,title:"",amount:0,aggregate:0,revision:0}).aggregate))),ui_group<Unit>("list",UiKind.List,data.rows.map(fn(row)=>string_concat("item-",ui_key(row.id))))].concat(data.rows.map(fn(row)=>ui_item<Unit>(string_concat("item-",ui_key(row.id)),row.title,[])))};}
