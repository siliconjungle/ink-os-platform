//! Reproduce the small independently replayable plan used by OS lifecycle tests.
use ink_core::{action_model::{FunctionProjection, FunctionReplacement, FUNCTION_SEMANTICS}, core::{CheckedModule, Expr}, logic::{Proof, Term}, planning, registry, syntax};
use std::collections::{BTreeMap, BTreeSet};

fn main() {
    let source = include_str!("../../tests/fixtures/planned-counter.ink");
    let original = CheckedModule::from_source(syntax::parse(source).unwrap()).unwrap();
    let mut selected = original.program().clone();
    selected.functions.iter_mut().find(|f| f.name == "amount").unwrap().body = Expr::Var("n".into());
    let selected = CheckedModule::from_source(selected).unwrap();
    let names = BTreeSet::from(["amount".to_string()]);
    let before = FunctionProjection::derive(&original, &names).unwrap();
    let after = FunctionProjection::derive(&selected, &names).unwrap();
    let mut objects = before.objects.clone(); objects.extend(after.objects.clone());
    let entries = objects.keys().cloned().collect::<Vec<_>>();
    let knowledge = registry::Bundle { schema: 1, snapshot: registry::Snapshot { schema: 1,
        semantics: registry::SNAPSHOT_SEMANTICS.into(), root: registry::identity(&serde_json::json!({"schema":1,"entries":entries})).unwrap() },
        roots: entries.clone(), membership: entries.iter().map(|id| (id.clone(), registry::Membership { entries: entries.clone(), path: vec![] })).collect(), objects };
    let args = before.functions["amount"].params.iter().map(|(name,_)| Term::Var(name.clone())).collect::<Vec<_>>();
    let replacement = FunctionReplacement { schema: 1, semantics: FUNCTION_SEMANTICS.into(), input_core_sha256: original.identity().unwrap(),
        selected: serde_json::from_slice(&selected.bytes().unwrap()).unwrap(), knowledge,
        proofs: BTreeMap::from([("amount".into(), Proof::Convert { from: Term::Call { function: before.functions["amount"].function.clone(), arguments: args.clone() },
            to: Term::Call { function: after.functions["amount"].function.clone(), arguments: args } })]) };
    let packet = planning::Package { schema: 1, semantics: planning::SEMANTICS.into(), input_core_sha256: original.identity().unwrap(), steps: vec![planning::Step::Functions(replacement)] };
    planning::check(&original, &packet).unwrap();
    println!("{}", String::from_utf8(planning::canonical(&packet).unwrap()).unwrap());
}
