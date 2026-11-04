module app;
record DataRow {id:String,title:String,}
fn view()->UiView<Unit>{return UiView<Unit>{root:"screen",nodes:[ui_group<Unit>("screen",UiKind.Column,["heading","results"]),ui_heading<Unit>("heading","Planned storage"),ui_component<Unit>("results","page")]};}
fn page(data:UiData<DataRow>)->UiView<Unit>{return UiView<Unit>{root:"rows",nodes:[ui_group<Unit>("rows",UiKind.List,data.rows.map(fn(row)=>row.id))].concat(data.rows.map(fn(row)=>ui_item<Unit>(row.id,row.title,[])))};}
change event(input:UiEvent<Unit>)->Unit{return ();}
