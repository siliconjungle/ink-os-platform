//! State footprints and purity of every declaration, from Ink's mid-level IR.
//!
//! The OS uses these facts to invalidate cross-app reads only when a commit
//! writes state a read depends on, and to admit cross-app plans: code that
//! moves across an app boundary must be pure. Facts come from the checked
//! module's IR (`ink_core::mir`): a graph's reads and writes are the state its
//! nodes and the actions it calls touch. A declaration the IR does not express
//! keeps its checked declaration as a sound over-approximation and is never
//! reported pure. Nothing here grants equality, rewrite or profitability
//! authority.
use ink_core::{core::CheckedModule, mir};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const FORMAT: &str = "ink-footprints-v1";

/// True when a region, including lambda and branch regions, touches state,
/// emits, calls an action or performs an external effect.
fn touches(region: &mir::Region) -> bool {
    region.nodes.iter().any(|n| {
        matches!(
            n.op,
            mir::Op::Read { .. }
                | mir::Op::Write { .. }
                | mir::Op::Emit { .. }
                | mir::Op::Action { .. }
                | mir::Op::Effect { .. }
        ) || n.regions.iter().any(touches)
    })
}

fn callees(region: &mir::Region, out: &mut BTreeSet<String>) {
    for n in &region.nodes {
        if let mir::Op::Call { function } = &n.op {
            out.insert(function.clone());
        }
        for r in &n.regions {
            callees(r, out);
        }
    }
}

/// Physical state roots behind a set of read names: states are themselves; a
/// keep stands for the roots its definition reads. An unknown keep stands for
/// every root.
fn roots(
    names: &[String],
    states: &BTreeSet<String>,
    keeps: &BTreeMap<String, Option<Vec<String>>>,
    depth: usize,
) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for name in names {
        if states.contains(name) {
            out.insert(name.clone());
        } else if let Some(keep) = keeps.get(name) {
            match keep {
                Some(reads) if depth < 32 => out.extend(roots(reads, states, keeps, depth + 1)),
                _ => out.extend(states.iter().cloned()),
            }
        }
    }
    out
}

pub fn describe(checked: &CheckedModule) -> Value {
    let program = checked.program();
    let ir = mir::lower(checked);
    let states: BTreeSet<String> = program.states.iter().map(|s| s.name.clone()).collect();
    let by_name: BTreeMap<&str, &mir::Graph> = ir.graphs.iter().map(|g| (g.name.as_str(), g)).collect();
    let keeps: BTreeMap<String, Option<Vec<String>>> = program
        .keeps
        .iter()
        .map(|k| {
            let reads = by_name
                .get(k.name.as_str())
                .filter(|g| g.kind == mir::Kind::Keep)
                .map(|g| g.reads.clone());
            (k.name.clone(), reads)
        })
        .collect();

    // A function is pure when its own regions touch nothing and every function
    // it calls is pure. Iterate to a fixed point from "every IR function pure".
    let functions: BTreeMap<&str, (bool, BTreeSet<String>)> = ir
        .graphs
        .iter()
        .filter(|g| g.kind == mir::Kind::Function)
        .map(|g| {
            let mut called = BTreeSet::new();
            callees(&g.body, &mut called);
            (g.name.as_str(), (!touches(&g.body), called))
        })
        .collect();
    let mut pure: BTreeSet<&str> = functions.iter().filter(|(_, (own, _))| *own).map(|(n, _)| *n).collect();
    loop {
        let next: BTreeSet<&str> = pure
            .iter()
            .copied()
            .filter(|n| functions[n].1.iter().all(|c| pure.contains(c.as_str())))
            .collect();
        if next.len() == pure.len() {
            break;
        }
        pure = next;
    }

    let kind = |k: &mir::Kind| serde_json::to_value(k).unwrap_or(Value::Null);
    let mut graphs: Vec<Value> = ir
        .graphs
        .iter()
        .map(|g| {
            let read_roots = roots(&g.reads, &states, &keeps, 0);
            let write_roots: BTreeSet<String> = g.writes.iter().filter(|s| states.contains(*s)).cloned().collect();
            json!({
                "name": g.name, "kind": kind(&g.kind), "source": "ir",
                "reads": g.reads, "writes": g.writes, "emits": g.emits, "effects": g.effects,
                "roots": {"read": read_roots, "write": write_roots},
                "pure": g.kind == mir::Kind::Function && pure.contains(g.name.as_str()),
            })
        })
        .collect();
    // Declarations outside the IR keep their checked declarations.
    for action in &program.actions {
        if by_name.contains_key(action.name.as_str()) {
            continue;
        }
        let read_roots = roots(&action.reads, &states, &keeps, 0);
        let write_roots: BTreeSet<String> = action.writes.iter().filter(|s| states.contains(*s)).cloned().collect();
        graphs.push(json!({
            "name": action.name, "kind": format!("{:?}", action.kind).to_lowercase(), "source": "declaration",
            "reads": action.reads, "writes": action.writes, "emits": action.emits, "effects": [],
            "roots": {"read": read_roots, "write": write_roots}, "pure": false,
        }));
    }
    for function in &program.functions {
        if !by_name.contains_key(function.name.as_str()) {
            graphs.push(json!({
                "name": function.name, "kind": "function", "source": "declaration",
                "reads": [], "writes": [], "emits": [], "effects": [],
                "roots": {"read": [], "write": []}, "pure": false,
            }));
        }
    }
    graphs.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    json!({
        "format": FORMAT,
        "module": program.module,
        "states": states,
        "keeps": keeps.iter().map(|(k, v)| (k.clone(), json!(v.as_ref().map(|r| roots(r, &states, &keeps, 0))))).collect::<BTreeMap<_, _>>(),
        "graphs": graphs,
        "unsupported": ir.unsupported,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ink_core::syntax;

    fn describe_source(source: &str) -> Value {
        describe(&CheckedModule::from_source(syntax::parse(source).unwrap()).unwrap())
    }
    fn graph<'a>(v: &'a Value, name: &str) -> &'a Value {
        v["graphs"].as_array().unwrap().iter().find(|g| g["name"] == name).unwrap()
    }

    #[test]
    fn footprints_separate_reads_from_writes_and_resolve_keeps() {
        let v = describe_source(
            "module app;
record Row {id:u64,open:Bool,}
state A:Table<u64,Row>=Table.empty(); state B:u64=0; state C:u64=0;
keep K:u64=sum(A.values().filter(fn(r)=>r.open).map(fn(r)=>1));
change w(x:u64)->Result<Unit,String> reads(A,C) writes(B) { B = x + C; return Ok(()); }
change maybe(x:u64)->Result<Unit,String> reads(C) writes(B,C) { if (x > 3) { B = x; } return Ok(()); }
query q()->u64 reads(K) { return K; }
query r()->u64 reads(B) { return B; }
fn open(r:Row)->Bool { return r.open; }
fn twice(r:Row)->Bool { return open(r) && open(r); }",
        );
        assert_eq!(v["format"], FORMAT);
        assert_eq!(graph(&v, "w")["roots"], json!({"read":["C"],"write":["B"]}));
        // Declared writes(B,C) but the body writes only B.
        assert_eq!(graph(&v, "maybe")["roots"]["write"], json!(["B"]));
        assert_eq!(graph(&v, "q")["roots"], json!({"read":["A"],"write":[]}));
        assert_eq!(graph(&v, "r")["roots"]["read"], json!(["B"]));
        assert_eq!(v["keeps"]["K"], json!(["A"]));
        assert_eq!(graph(&v, "open")["pure"], true);
        assert_eq!(graph(&v, "twice")["pure"], true);
        for name in ["w", "maybe", "q", "r"] {
            assert_eq!(graph(&v, name)["pure"], false, "{name}");
        }
    }
}
