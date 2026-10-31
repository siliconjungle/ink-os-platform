module ink_os_world;

id ObjectId;

record Object {
  id: ObjectId,
  namespace: String,
  kind: String,
  title: String,
  body: String,
  summary: String,
  tags: List<String>,
  spaces: List<ObjectId>,
  status: String,
  cover: String,
  source: String,
  location: String,
  revision: u32,
  created: u64,
  updated: u64,
  starred: Bool,
  archived: Bool,
  vector: List<f32>,
}

record ObjectChange { id: ObjectId, revision: u32, }
record Match { id: ObjectId, score: f32, }
enum Error { Missing, Stale, Forbidden, }

state Objects: Table<ObjectId, Object> = Table.empty();
event changed: ObjectChange;

keep object_count: Int = count(Objects.values().filter(fn(item) => !item.archived));

change put(item: Object, expected: u32, writer: String) -> Result<Unit, Error>
  reads(Objects) writes(Objects) emits(changed)
{
  if item.namespace != writer { return Err(Error.Forbidden); }
  if Objects.contains(item.id) {
    let previous = Objects.get(item.id).ok_or(Error.Missing)?;
    if previous.namespace != writer { return Err(Error.Forbidden); }
    if previous.revision != expected { return Err(Error.Stale); }
    Objects.replace(item.id, item);
  } else {
    if expected != 0 { return Err(Error.Stale); }
    Objects.insert(item.id, item);
  }
  emit changed(ObjectChange { id: item.id, revision: item.revision });
  return Ok(());
}

change erase(id: ObjectId, writer: String) -> Result<Unit, Error>
  reads(Objects) writes(Objects)
{
  let previous = Objects.get(id).ok_or(Error.Missing)?;
  if previous.namespace != writer { return Err(Error.Forbidden); }
  Objects.remove(id);
  return Ok(());
}

query get(id: ObjectId) -> Option<Object> reads(Objects) { return Objects.get(id); }
query all() -> List<Object> reads(Objects) { return Objects.values(); }
query count_objects() -> Int reads(object_count) { return object_count; }

query select(kind: String, tag: String, starred: Bool) -> List<Object> reads(Objects) {
  return Objects.values().filter(fn(item) =>
    !item.archived && (kind == "" || item.kind == kind)
    && (tag == "" || exists { from t in item.tags; select t == tag; })
    && (!starred || item.starred));
}

query in_space(space: ObjectId) -> List<Object> reads(Objects) {
  return Objects.values().filter(fn(item) =>
    !item.archived && exists { from s in item.spaces; select s == space; });
}

fn similarity(left: List<f32>, right: List<f32>) -> f32 {
  return sum(left.zip(right, fn(a) => fn(b) => a * b));
}

query semantic(vector: List<f32>) -> List<Match> reads(Objects) {
  return Objects.values().filter(fn(item) => !item.archived).map(fn(item) =>
    Match { id: item.id, score: similarity(item.vector, vector) });
}

query in_namespace(namespace: String) -> List<Object> reads(Objects) {
  return Objects.values().filter(fn(item) => !item.archived && item.namespace == namespace);
}
