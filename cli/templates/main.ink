module app;

record View {
  kind:String, text:String, value:u32, entry:String, args:String,
  children:List<View>,
}

state Count:u32=0;

change add(amount:u32)->u32 reads(Count) writes(Count) {
  Count=Count+amount;
  return Count;
}

query total()->u32 reads(Count) { return Count; }

query view()->View reads(Count) {
  return View{
    kind:"column", text:"", value:0, entry:"", args:"[]",
    children:[
      View{kind:"heading",text:"My app",value:0,entry:"",args:"[]",children:[],},
      View{kind:"value",text:"Count",value:Count,entry:"",args:"[]",children:[],},
      View{kind:"button",text:"Add one",value:0,entry:"add",args:"[1]",children:[],}
    ],
  };
}
