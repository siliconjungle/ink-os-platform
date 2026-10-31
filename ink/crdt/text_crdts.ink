module ink.knowledge.text_crdts;

// Plain-text sequence semantics. Algorithms remain ordinary library code.
// mode: 0 YjsMod/FugueMax, 1 YATA/Yjs, 2 RGA (descending actor tie), 3 Fugue.
// IDs encode a nonzero u32 actor followed by a nonzero u32 counter. Zero is
// the root/end sentinel. Payloads are Unicode scalar values, not UTF-16 offsets.
record Atom { id:u64, left:u64, right:u64, stamp:u64, value:u32, deleted:Bool, }
record Operation { insert:Bool, atom:Atom, target:u64, }
record Document { atoms:List<Atom>, deletes:List<u64>, }
enum Error { MissingDependency, ConflictingIdentity, InvalidMode, InvalidOperation, InvalidPosition, }

fn empty_atom()->Atom {return Atom{id:0,left:0,right:0,stamp:0,value:0,deleted:true};}
fn empty()->Document {return Document{atoms:[],deletes:[]};}
fn identity(actor:u64,counter:u64)->u64 {
 return wrapping_shl(actor,32) | counter;
}
fn actor(id:u64)->u64 {return wrapping_shr(id,32);}
fn contains(xs:List<u64>,id:u64)->Bool {
 return foldl(xs,false,fn(x)=>fn(found)=>found || x==id);
}
// A one-based position leaves zero available for the left root sentinel.
fn location(xs:List<Atom>,id:u64)->u32 {
 var index:u32=0;var found:u32=0;
 for x in xs {index=index+1;if x.id==id {found=index;}}
 return found;
}
fn right_location(xs:List<Atom>,id:u64)->u32 {
 return choose(id==0,length(xs)+1,location(xs,id));
}
fn parent_right(xs:List<Atom>,x:Atom)->u32 {
 let at=right_location(xs,x.right);
 let right=xs.at_or(at-1,empty_atom());
 return choose(x.right!=0 && right.left==x.left,at,length(xs)+1);
}
fn visible(doc:Document)->List<u32> {
 return doc.atoms.filter(fn(x)=>!x.deleted).map(fn(x)=>x.value);
}

fn insert_at(xs:List<Atom>,at:u32,x:Atom)->List<Atom> {
 return xs.take(at).concat([x]).concat(xs.drop(at));
}
fn same_insertion(a:Atom,b:Atom)->Bool {
 return a.id==b.id && a.left==b.left && a.right==b.right &&
        a.stamp==b.stamp && a.value==b.value;
}
fn valid_insertion(x:Atom)->Bool {
 return actor(x.id)!=0 && (x.id & 4294967295)!=0 && x.value<1114112 &&
        !(x.value>=55296 && x.value<57344) && x.left!=x.id && x.right!=x.id;
}
fn integrate(xs:List<Atom>,x:Atom,mode:u32)->List<Atom> {
 let left=location(xs,x.left);
 let right=right_location(xs,x.right);
 let parent=choose(mode==3,parent_right(xs,x),right);
 var i:u32=left;var dest:u32=left;var scanning:Bool=false;var done:Bool=false;
 // Each iteration inspects at most one existing atom. No arbitrary fuel cap.
 for ignored in xs {
  if !done {
   if !scanning {dest=i;}
   let other=xs.at_or(i,empty_atom());
   if i==length(xs) || (mode!=2 && i+1==right) {done=true;}
   else {
    let oleft=location(xs,other.left);
    let oright=right_location(xs,other.right);
    let oparent=choose(mode==3,parent_right(xs,other),oright);
    if mode==2 {
     if x.stamp>other.stamp || oleft<left ||
       (oleft==left && x.stamp==other.stamp && actor(x.id)>actor(other.id)) {done=true;}
    } else {
     if oleft<left || (oleft==left && oparent==parent && actor(x.id)<actor(other.id)) {done=true;}
     else {if oleft==left {
      scanning=choose(mode==1,actor(x.id)<actor(other.id),oparent<parent);
     }}
    }
    if !done {i=i+1;}
   }
  }
 }
 if !done && !scanning {dest=i;}
 return insert_at(xs,dest,x);
}
fn receive(doc:Document,op:Operation,mode:u32)->Result<Document,Error> {
 if mode>3 {return Err(Error.InvalidMode);}
 if !op.insert {
  let ids=choose(contains(doc.deletes,op.target),doc.deletes,doc.deletes.concat([op.target]));
  let atoms=doc.atoms.map(fn(x)=>Atom{id:x.id,left:x.left,right:x.right,stamp:x.stamp,value:x.value,deleted:x.deleted || x.id==op.target});
  return Ok(Document{atoms:atoms,deletes:ids});
 }
 let x=op.atom;let existing=location(doc.atoms,x.id);
 if !valid_insertion(x) {return Err(Error.InvalidOperation);}
 if existing!=0 {
  if !same_insertion(doc.atoms.at_or(existing-1,empty_atom()),x) {return Err(Error.ConflictingIdentity);}
  return Ok(doc);
 }
 if (x.left!=0 && location(doc.atoms,x.left)==0) ||
    (mode!=2 && x.right!=0 && location(doc.atoms,x.right)==0) ||
    ((x.id & 4294967295)>1 && location(doc.atoms,x.id-1)==0) {return Err(Error.MissingDependency);}
 if mode!=2 && location(doc.atoms,x.left)>=right_location(doc.atoms,x.right) {return Err(Error.InvalidOperation);}
 let x=Atom{id:x.id,left:x.left,right:x.right,stamp:x.stamp,value:x.value,deleted:x.deleted || contains(doc.deletes,x.id)};
 return Ok(Document{atoms:integrate(doc.atoms,x,mode),deletes:doc.deletes});
}
fn replay(ops:List<Operation>,mode:u32)->Result<Document,Error> {
 var result:Result<Document,Error>=Ok(empty());
 for op in ops {
  result=result.fold(fn(doc)=>receive(doc,op,mode),fn(error)=>Err(error));
 }
 return result;
}
