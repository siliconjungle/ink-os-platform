//! Browser transport around Ink's existing checker and literal target lowerings.
//! No source evaluator is used to execute programs here.
use ink_core::{core::CheckedModule, eval, syntax};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Mutex;

const MAX_REQUEST: usize = 8 * 1024 * 1024;
const MAX_SOURCE: usize = 128 * 1024;
const MAX_INPUT: usize = 1024 * 1024;
static RESPONSE: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// Version-one source graph: bare imported names, unique global symbols, pure libraries,
/// and a stateful root. Source origins survive until the existing elaborator checks them.
/// No filesystem resolver, source concatenation, prechecked-core merge or proof admission.
mod modules {
    use super::*;
    use ink_core::core::{Expr, Statement, Type};
    use ink_core::syntax::SurfaceProgram;
    use std::collections::{BTreeMap, BTreeSet};

    struct Module<'a> {
        path: &'a str,
        name: &'a str,
        source: &'a str,
        dependencies: BTreeSet<String>,
        exports: BTreeSet<String>,
    }
    fn fields(value: &Value, keys: &[&str]) -> Result<(), String> {
        let object = value.as_object().ok_or("module graph needs objects")?;
        if object.len() != keys.len() || object.keys().any(|k| !keys.contains(&k.as_str())) {
            return Err("module graph has missing or unsupported fields".into());
        }
        Ok(())
    }
    fn identifier(name: &str) -> bool {
        !name.is_empty()
            && name.len() <= 100
            && !name.starts_with("__")
            && name
                .bytes()
                .enumerate()
                .all(|(i, c)| c.is_ascii_alphabetic() || c == b'_' || i > 0 && c.is_ascii_digit())
    }
    fn path(path: &str) -> bool {
        !path.is_empty()
            && path.len() <= 240
            && path.ends_with(".ink")
            && path.is_ascii()
            && path
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_./-".contains(&c))
            && path.split('/').all(|part| {
                let lower = part.to_ascii_lowercase();
                !part.is_empty()
                    && part != "."
                    && part != ".."
                    && !part.ends_with('.')
                    && ![".git", ".local", ".data", "node_modules"].contains(&lower.as_str())
                    && ![".env", ".dev.vars", ".npmrc"]
                        .iter()
                        .any(|prefix| lower == *prefix || lower.starts_with(&format!("{prefix}.")))
            })
    }
    fn strings(value: &Value, max: usize) -> Result<BTreeSet<String>, String> {
        let values = value
            .as_array()
            .ok_or("module graph lists must be arrays")?;
        if values.len() > max {
            return Err("module graph list limit".into());
        }
        let mut set = BTreeSet::new();
        for value in values {
            let text = value
                .as_str()
                .ok_or("module graph list entries must be strings")?;
            if !set.insert(text.to_owned()) {
                return Err("duplicate module graph list entry".into());
            }
        }
        Ok(set)
    }
    fn visit<'a>(
        path: &'a str,
        modules: &BTreeMap<&'a str, Module<'a>>,
        active: &mut BTreeSet<&'a str>,
        done: &mut BTreeSet<&'a str>,
        order: &mut Vec<&'a str>,
    ) -> Result<(), String> {
        if done.contains(path) {
            return Ok(());
        }
        if !active.insert(path) {
            return Err("cyclic module dependency".into());
        }
        let module = modules.get(path).ok_or("unknown module dependency")?;
        for dependency in &module.dependencies {
            let (key, _) = modules
                .get_key_value(dependency.as_str())
                .ok_or("unknown module dependency")?;
            visit(key, modules, active, done, order)?;
        }
        active.remove(path);
        done.insert(path);
        order.push(path);
        Ok(())
    }
    fn declarations(surface: &SurfaceProgram) -> Vec<String> {
        let p = &surface.program;
        p.functions
            .iter()
            .map(|f| f.name.clone())
            .chain(p.actions.iter().map(|f| f.name.clone()))
            .chain(p.states.iter().chain(&p.keeps).map(|b| b.name.clone()))
            .chain(
                p.records
                    .keys()
                    .chain(p.enums.keys())
                    .chain(p.events.keys())
                    .cloned(),
            )
            .chain(p.ids.iter().cloned())
            .chain(surface.aliases.keys().cloned())
            .chain(surface.callback_types.keys().cloned())
            .collect()
    }
    fn supported(surface: &SurfaceProgram, root: bool) -> Result<(), String> {
        let p = &surface.program;
        if !surface.payload_enums.is_empty() || !surface.matches.is_empty() {
            return Err(
                "module graphs do not yet support payload-enum/match surface declarations".into(),
            );
        }
        if !root
            && (!p.states.is_empty()
                || !p.keeps.is_empty()
                || !p.events.is_empty()
                || !p.actions.is_empty()
                || !p.frozen.is_empty())
        {
            return Err("version-one module libraries must be pure; state/query/change/event/keep declarations belong to the root".into());
        }
        if !p.rules.is_empty() || !p.termination.is_empty() {
            return Err(
                "module graphs do not yet support rewrite or termination declarations".into(),
            );
        }
        // These source-level predicates retain their real checking authority. Proof bundles,
        // protocol/learning/specification metadata require their own source-graph binding.
        let mut rest = p.contracts.clone();
        rest.value_invariants.clear();
        if root {
            rest.invariants.clear();
            rest.private_states.clear();
        }
        if !rest.is_empty() {
            return Err(
                "module graph contains unsupported contract/proof/protocol/learning declarations"
                    .into(),
            );
        }
        Ok(())
    }
    struct Access<'a> {
        module: &'a Module<'a>,
        owners: &'a BTreeMap<String, &'a str>,
        modules: &'a BTreeMap<&'a str, Module<'a>>,
        surface: &'a SurfaceProgram,
        function_names: &'a BTreeSet<String>,
        left: usize,
    }
    impl Access<'_> {
        fn global(&self, name: &str) -> Result<(), String> {
            let name = if self.owners.contains_key(name) {
                name
            } else {
                name.split('.').next().unwrap_or(name)
            };
            if let Some(owner) = self.owners.get(name) {
                if *owner != self.module.path
                    && (!self.module.dependencies.contains(*owner)
                        || !self.modules[owner].exports.contains(name))
                {
                    return Err(format!(
                        "foreign module symbol is not a directly imported export: {name}"
                    ));
                }
            }
            Ok(())
        }
        fn charge(&mut self, depth: usize) -> Result<(), String> {
            self.left = self
                .left
                .checked_sub(1)
                .ok_or("module reference work limit")?;
            if depth > 128 {
                return Err("module reference depth limit".into());
            }
            Ok(())
        }
        fn named(
            &mut self,
            name: &str,
            types: &BTreeSet<String>,
            depth: usize,
        ) -> Result<(), String> {
            if types.contains(name) {
                return Ok(());
            }
            if let Some((base, arguments)) = self.surface.applications.get(name).cloned() {
                self.global(&base)?;
                for ty in &arguments {
                    self.ty(ty, types, depth + 1)?;
                }
            } else {
                self.global(name)?;
            }
            Ok(())
        }
        fn ty(&mut self, ty: &Type, types: &BTreeSet<String>, depth: usize) -> Result<(), String> {
            self.charge(depth)?;
            match ty {
                Type::Named(n) => self.named(n, types, depth + 1),
                Type::Vector(a, _) | Type::List(a) | Type::Buffer(a) | Type::Option(a) => {
                    self.ty(a, types, depth + 1)
                }
                Type::Map(a, b) | Type::Result(a, b) | Type::Table(a, b) => {
                    self.ty(a, types, depth + 1)?;
                    self.ty(b, types, depth + 1)
                }
                _ => Ok(()),
            }
        }
        fn expr(
            &mut self,
            e: &Expr,
            locals: &BTreeSet<String>,
            types: &BTreeSet<String>,
            depth: usize,
        ) -> Result<(), String> {
            self.charge(depth)?;
            match e {
                // The existing callback elaborator recognizes named global functions even
                // under a same-spelled numeric local. Reserve those ambiguous spellings
                // across module boundaries rather than laundering a hidden function value.
                Expr::Var(n) if !locals.contains(n) || self.function_names.contains(n) => {
                    self.global(n)?;
                    self.named(n, types, depth + 1)
                }
                Expr::Call(n, args) => {
                    // Ordinary Call dispatch is global even when a numeric local has the same
                    // spelling. Callback elaboration does not authorize bypassing graph exports.
                    self.global(n)?;
                    self.named(n, types, depth + 1)?;
                    for arg in args {
                        self.expr(arg, locals, types, depth + 1)?;
                    }
                    Ok(())
                }
                Expr::Record(n, fields) => {
                    // The pinned elaborator expands updates to Let/Field/Record after
                    // source-origin marking. Its abstraction checker cannot retain the
                    // enclosing origin through that rewrite, so do not admit this syntax
                    // until that upstream transformation preserves representation checks.
                    if fields.iter().any(|(field, _)| field == "..") {
                        return Err("module graphs do not yet support record updates".into());
                    }
                    self.named(n, types, depth + 1)?;
                    for (_, value) in fields {
                        self.expr(value, locals, types, depth + 1)?;
                    }
                    Ok(())
                }
                Expr::Let(n, ty, a, b) => {
                    if let Some(ty) = ty {
                        self.ty(ty, types, depth + 1)?;
                    }
                    self.expr(a, locals, types, depth + 1)?;
                    let mut scope = locals.clone();
                    scope.insert(n.clone());
                    self.expr(b, &scope, types, depth + 1)
                }
                Expr::Lambda(n, e) => {
                    let mut scope = locals.clone();
                    scope.insert(n.clone());
                    self.expr(e, &scope, types, depth + 1)
                }
                Expr::Method(e, _, args) => {
                    // Labels are receiver operations, not global function references. The
                    // existing elaborator/checker resolves them; receiver/type/args stay scoped.
                    self.expr(e, locals, types, depth + 1)?;
                    for arg in args {
                        self.expr(arg, locals, types, depth + 1)?;
                    }
                    Ok(())
                }
                Expr::Binary(_, a, b) => {
                    self.expr(a, locals, types, depth + 1)?;
                    self.expr(b, locals, types, depth + 1)
                }
                Expr::Neg(e) | Expr::Try(e) | Expr::Field(e, _) => {
                    self.expr(e, locals, types, depth + 1)
                }
                _ => Ok(()),
            }
        }
        fn body(
            &mut self,
            body: &[Statement],
            locals: &mut BTreeSet<String>,
            types: &BTreeSet<String>,
            depth: usize,
        ) -> Result<(), String> {
            for statement in body {
                self.charge(depth)?;
                match statement {
                    Statement::Let(n, ty, e) => {
                        if let Some(ty) = ty {
                            self.ty(ty, types, depth + 1)?;
                        }
                        self.expr(e, locals, types, depth + 1)?;
                        locals.insert(n.clone());
                    }
                    Statement::Return(e) | Statement::Expr(e) => {
                        self.expr(e, locals, types, depth + 1)?
                    }
                    Statement::Emit(n, e) => {
                        self.global(n)?;
                        self.expr(e, locals, types, depth + 1)?;
                    }
                    Statement::If(e, yes, no) => {
                        self.expr(e, locals, types, depth + 1)?;
                        self.body(yes, &mut locals.clone(), types, depth + 1)?;
                        self.body(no, &mut locals.clone(), types, depth + 1)?;
                    }
                }
            }
            Ok(())
        }
        fn check(&mut self) -> Result<(), String> {
            let p = &self.surface.program;
            for f in &p.functions {
                let types = self
                    .surface
                    .parameters
                    .get(&f.name)
                    .into_iter()
                    .flatten()
                    .cloned()
                    .collect();
                let mut locals = f
                    .params
                    .iter()
                    .map(|(n, _)| n.clone())
                    .collect::<BTreeSet<_>>();
                if let Some(constants) = self.surface.constant_parameters.get(&f.name) {
                    locals.extend(constants.iter().cloned());
                }
                for (_, ty) in &f.params {
                    self.ty(ty, &types, 0)?;
                }
                self.ty(&f.result, &types, 0)?;
                self.expr(&f.body, &locals, &types, 0)?;
            }
            for a in &p.actions {
                let types = BTreeSet::new();
                let mut locals = a.params.iter().map(|(n, _)| n.clone()).collect();
                for (_, ty) in &a.params {
                    self.ty(ty, &types, 0)?;
                }
                self.ty(&a.result, &types, 0)?;
                for n in a.reads.iter().chain(&a.writes).chain(&a.emits) {
                    self.global(n)?;
                }
                self.body(&a.body, &mut locals, &types, 0)?;
            }
            for (name, fields) in &p.records {
                let types = self
                    .surface
                    .parameters
                    .get(name)
                    .into_iter()
                    .flatten()
                    .cloned()
                    .collect();
                for (_, ty) in fields {
                    self.ty(ty, &types, 0)?;
                }
            }
            for (name, ty) in &self.surface.aliases {
                let types = self
                    .surface
                    .parameters
                    .get(name)
                    .into_iter()
                    .flatten()
                    .cloned()
                    .collect();
                self.ty(ty, &types, 0)?;
            }
            for (a, b) in self.surface.callback_types.values() {
                self.ty(a, &BTreeSet::new(), 0)?;
                self.ty(b, &BTreeSet::new(), 0)?;
            }
            for b in p.states.iter().chain(&p.keeps) {
                self.ty(&b.ty, &BTreeSet::new(), 0)?;
                self.expr(&b.value, &BTreeSet::new(), &BTreeSet::new(), 0)?;
            }
            for ty in p.events.values() {
                self.ty(ty, &BTreeSet::new(), 0)?;
            }
            for e in &p.contracts.invariants {
                self.expr(e, &BTreeSet::new(), &BTreeSet::new(), 0)?;
            }
            for (name, e) in &p.contracts.value_invariants {
                let types = self
                    .surface
                    .parameters
                    .get(name)
                    .into_iter()
                    .flatten()
                    .cloned()
                    .collect();
                self.expr(e, &BTreeSet::from(["value".into()]), &types, 0)?;
            }
            Ok(())
        }
    }
    fn extend<K: Ord, V>(
        target: &mut BTreeMap<K, V>,
        source: BTreeMap<K, V>,
    ) -> Result<(), String> {
        for (key, value) in source {
            if target.insert(key, value).is_some() {
                return Err("module declaration/metadata collision".into());
            }
        }
        Ok(())
    }
    fn source_names(
        value: &Value,
        output: &mut BTreeSet<String>,
        depth: usize,
        left: &mut usize,
    ) -> Result<(), String> {
        *left = left.checked_sub(1).ok_or("module origin-name work limit")?;
        if depth > 256 {
            return Err("module origin-name depth limit".into());
        }
        match value {
            Value::String(s) => {
                output.insert(s.clone());
            }
            Value::Array(xs) => {
                for x in xs {
                    source_names(x, output, depth + 1, left)?;
                }
            }
            Value::Object(xs) => {
                for (key, x) in xs {
                    output.insert(key.clone());
                    source_names(x, output, depth + 1, left)?;
                }
            }
            _ => (),
        }
        Ok(())
    }
    pub fn assemble(graph: &Value) -> Result<(CheckedModule, Value), String> {
        fields(graph, &["version", "root", "modules"])?;
        if graph["version"].as_u64() != Some(1) {
            return Err("unsupported module graph version".into());
        }
        let root = text(graph, "root")?;
        let entries = graph["modules"]
            .as_array()
            .ok_or("module graph needs modules")?;
        if entries.is_empty() || entries.len() > 64 {
            return Err("module graph requires 1..64 sources".into());
        }
        let mut modules = BTreeMap::new();
        let mut paths = BTreeSet::new();
        let mut names = BTreeSet::new();
        let mut bytes = 0usize;
        for entry in entries {
            fields(
                entry,
                &["path", "name", "source", "dependencies", "exports"],
            )?;
            let p = text(entry, "path")?;
            let name = text(entry, "name")?;
            let source = text(entry, "source")?;
            bytes = bytes
                .checked_add(source.len())
                .ok_or("module source byte limit")?;
            if !path(p)
                || !paths.insert(p.to_ascii_lowercase())
                || name.len() > 100
                || !name.split('.').all(identifier)
                || !names.insert(name)
                || bytes > MAX_SOURCE
            {
                return Err(
                    "invalid/duplicate module path/name or total source exceeds 128 KiB".into(),
                );
            }
            let dependencies = strings(&entry["dependencies"], 64)?;
            let exports = strings(&entry["exports"], 63)?;
            if dependencies.iter().any(|p| !path(p)) || exports.iter().any(|n| !identifier(n)) {
                return Err("invalid module dependency or export name".into());
            }
            modules.insert(
                p,
                Module {
                    path: p,
                    name,
                    source,
                    dependencies,
                    exports,
                },
            );
        }
        if !modules.contains_key(root) {
            return Err("module graph root is missing".into());
        }
        let root = *modules.get_key_value(root).unwrap().0;
        let mut order = Vec::new();
        let mut done = BTreeSet::new();
        visit(root, &modules, &mut BTreeSet::new(), &mut done, &mut order)?;
        if done.len() != modules.len() {
            return Err("unreferenced module graph source".into());
        }
        let mut surfaces = BTreeMap::new();
        let mut owners = BTreeMap::new();
        for module in modules.values() {
            // Imported spelling allows parsing a constructor, never type or access authority.
            // Export ownership and every actual reference are checked below before elaboration.
            let imported = module
                .dependencies
                .iter()
                .flat_map(|p| modules[p.as_str()].exports.iter().cloned())
                .collect::<BTreeSet<_>>();
            let mut surface = syntax::parse_surface(module.source, imported)?;
            if surface.program.module != module.name {
                return Err("declared module name differs from graph identity".into());
            }
            supported(&surface, module.path == root)?;
            // A public function may return an unexported nominal record. Keep it usable as an
            // opaque value, but do not let inferred locals/aliases expose its private fields.
            if module.path != root {
                for name in surface.program.records.keys() {
                    if !module.exports.contains(name) {
                        surface
                            .abstract_records
                            .entry(name.clone())
                            .or_insert_with(|| module.name.to_owned());
                    }
                }
            }
            for declaration in declarations(&surface) {
                if owners.insert(declaration, module.path).is_some() {
                    return Err("duplicate module symbol".into());
                }
            }
            surfaces.insert(module.path, surface);
        }
        let function_names = surfaces
            .values()
            .flat_map(|s| s.program.functions.iter().map(|f| f.name.clone()))
            .collect();
        for module in modules.values() {
            for export in &module.exports {
                if owners.get(export).copied() != Some(module.path) {
                    return Err("module export is not a declaration of its defining source".into());
                }
                if module.path == root
                    && !surfaces[root]
                        .program
                        .functions
                        .iter()
                        .any(|f| &f.name == export)
                    && !surfaces[root]
                        .program
                        .actions
                        .iter()
                        .any(|a| &a.name == export)
                {
                    return Err("root exports must be functions, queries or changes".into());
                }
            }
            Access {
                module,
                owners: &owners,
                modules: &modules,
                surface: &surfaces[module.path],
                function_names: &function_names,
                left: 100_000,
            }
            .check()?;
        }
        // Include EVERY module's lexical/local names, not just global declarations: a hostile
        // callback cannot forge another module's source-origin marker by choosing its binder.
        let mut avoid = owners.keys().cloned().collect();
        let mut budget = 100_000;
        for surface in surfaces.values() {
            source_names(
                &serde_json::to_value(&surface.program).map_err(|e| e.to_string())?,
                &mut avoid,
                0,
                &mut budget,
            )?;
        }
        for surface in surfaces.values_mut() {
            surface.mark_accesses_avoiding(&avoid)?;
        }
        let mut merged = surfaces.remove(root).unwrap();
        for p in &order {
            if *p == root {
                continue;
            }
            let library = surfaces.remove(p).unwrap();
            merged.program.functions.extend(library.program.functions);
            merged.program.ids.extend(library.program.ids);
            extend(&mut merged.program.records, library.program.records)?;
            extend(&mut merged.program.enums, library.program.enums)?;
            extend(
                &mut merged.program.contracts.value_invariants,
                library.program.contracts.value_invariants,
            )?;
            extend(&mut merged.aliases, library.aliases)?;
            extend(&mut merged.parameters, library.parameters)?;
            extend(&mut merged.applications, library.applications)?;
            extend(&mut merged.callback_types, library.callback_types)?;
            extend(&mut merged.payload_enums, library.payload_enums)?;
            extend(&mut merged.matches, library.matches)?;
            extend(&mut merged.constant_parameters, library.constant_parameters)?;
            extend(&mut merged.abstract_records, library.abstract_records)?;
            extend(&mut merged.access_origins, library.access_origins)?;
        }
        let checked = CheckedModule::from_source(merged.elaborate()?)?;
        for export in &modules[root].exports {
            if let Some(function) = checked
                .program()
                .functions
                .iter()
                .find(|f| &f.name == export)
            {
                if ink_core::local_collections::owned(&function.result, checked.program())
                    || function
                        .params
                        .iter()
                        .any(|(_, ty)| ink_core::local_collections::owned(ty, checked.program()))
                {
                    return Err(
                        "root exports cannot expose internal owned Buffer/Map helpers".into(),
                    );
                }
            } else if !checked.program().actions.iter().any(|a| &a.name == export) {
                return Err(
                    "root export is not a concrete executable entry after elaboration".into(),
                );
            }
        }
        let sources = modules.values().map(|m| json!({"path":m.path,"name":m.name,"sha256":format!("{:x}",Sha256::digest(m.source.as_bytes())),"dependencies":m.dependencies,"exports":m.exports})).collect::<Vec<_>>();
        let provenance = json!({"version":1,"root":root,"modules":sources});
        let graph_sha256 = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&provenance).map_err(|e| e.to_string())?)
        );
        let core_sha256 = checked.identity()?;
        let identity = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!({"graph_sha256":graph_sha256,"core_sha256":core_sha256}))
                    .map_err(|e| e.to_string())?
            )
        );
        Ok((
            checked,
            json!({"version":1,"root":root,"modules":sources,"root_exports":modules[root].exports,"graph_sha256":graph_sha256,"core_sha256":core_sha256,"identity":identity}),
        ))
    }
}

fn text<'a>(request: &'a Value, name: &str) -> Result<&'a str, String> {
    request[name]
        .as_str()
        .ok_or_else(|| format!("missing {name}"))
}
fn arguments(
    input: &Value,
    params: &[(String, syntax::Type)],
    program: &syntax::Program,
) -> Result<Value, String> {
    let xs = input.as_array().ok_or("Arguments must be a JSON array.")?;
    if xs.len() != params.len() {
        return Err(format!(
            "Expected {} arguments; received {}.",
            params.len(),
            xs.len()
        ));
    }
    xs.iter()
        .zip(params)
        .map(|(value, (name, ty))| {
            eval::Value::from_program_json(value, ty, program)
                .map(|v| v.json())
                .map_err(|e| format!("Argument {name}: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn emit_checked(checked: &CheckedModule) -> Result<Value, String> {
    let emission = ink_lowering_js::lower(checked)?;
    if emission.javascript.len() > MAX_REQUEST {
        return Err("Generated JavaScript exceeds 8 MiB.".into());
    }
    let bundle = (|| -> Result<Value, String> {
        checked.pure_program()?;
        let rust = ink_lowering_wasm::lower_with_abi(checked, true)?.rust;
        let mut gpu = ink_lowering_gpu::compute::lower(checked)?;
        gpu.manifest["javascript"] = emission.manifest.clone();
        gpu.manifest["javascript_sha256"] = json!(format!(
            "{:x}",
            Sha256::digest(emission.javascript.as_bytes())
        ));
        gpu.manifest["cpu_rust_sha256"] = json!(format!("{:x}", Sha256::digest(rust.as_bytes())));
        gpu.manifest["runtime_abi"] = json!("ink-packed-pipeline-v2");
        gpu.manifest["destination_abi"] = json!({"name":"ink-packed-into-v1","symbol":"ink_compute_into","count":"words32","ownership":"caller-owned","capacity":"trusted","alignment":8,"aliasing":"destination-disjoint-from-all-reachable-inputs","scratch_lifetime":"call-mark-rewind","prepared_instance":"exclusive"});
        Ok(json!({"manifest":gpu.manifest,"shaders":gpu.shaders,"rust":rust}))
    })();
    let rust = ink_lowering_rust::state_native::emit_checked(checked);
    let (rust, rust_reason) = match rust {
        Ok(value) => (json!(value), Value::Null),
        Err(error) => (Value::Null, json!(error)),
    };
    let (bundle, reason) = match bundle {
        Ok(v) => (v, Value::Null),
        Err(e) => (Value::Null, json!(e)),
    };
    Ok(
        json!({"bundle":bundle,"host_reason":reason,"rust":rust,"rust_reason":rust_reason,"javascript":emission.javascript,"manifest":emission.manifest,
    "core":String::from_utf8(checked.bytes()?).map_err(|e|e.to_string())?}),
    )
}

pub fn handle(request: &Value) -> Result<Value, String> {
    match text(request, "op")? {
        "compile" => {
            let source = text(request, "source")?;
            if source.len() > MAX_SOURCE {
                return Err("Source exceeds 128 KiB.".into());
            }
            let mut program = syntax::parse(source)?;
            if let Some(evidence) = request.get("contractEvidence").filter(|v| !v.is_null()) {
                let evidence = if let Some(raw) = evidence.as_str() {
                    serde_json::from_str(raw)
                        .map_err(|e| format!("Invalid contract evidence JSON: {e}"))?
                } else {
                    serde_json::from_value(evidence.clone())
                        .map_err(|e| format!("Invalid contract evidence: {e}"))?
                };
                ink_core::contracts::attach(&mut program, evidence)?;
            }
            let checked = CheckedModule::from_source(program)?;
            emit_checked(&checked)
        }
        "compileModules" => {
            if request
                .as_object()
                .is_none_or(|o| o.len() != 2 || o.keys().any(|k| k != "op" && k != "graph"))
            {
                return Err("compileModules accepts only op and graph".into());
            }
            let (checked, graph) = modules::assemble(&request["graph"])?;
            let mut output = emit_checked(&checked)?;
            output["module_graph"] = graph;
            Ok(output)
        }
        "prepare" => {
            let core = text(request, "core")?;
            let checked = CheckedModule::from_bytes(core.as_bytes())?;
            if checked.identity()? != text(request, "identity")? {
                return Err("Compiled program identity mismatch.".into());
            }
            let program = checked.program();
            let input = text(request, "input")?;
            if input.len() > MAX_INPUT {
                return Err("Input exceeds 1 MiB.".into());
            }
            let input: Value =
                serde_json::from_str(input).map_err(|e| format!("Invalid input JSON: {e}"))?;
            let entry = text(request, "entry")?;
            let prepared = if entry == "@pipeline" {
                let steps = input["steps"].as_array().ok_or("Pipeline needs steps.")?;
                if steps.is_empty() || steps.len() > 8 {
                    return Err("The editor supports 1..8 pipeline steps.".into());
                }
                if input.get("feedback").is_some() || input.get("iterations").is_some() {
                    return Err("The editor accepts a single-pass pipeline. Use the runtime API for feedback.".into());
                }
                let mut types = std::collections::BTreeMap::new();
                let mut canonical = input.clone();
                for (i, step) in steps.iter().enumerate() {
                    let id = step["id"].as_str().ok_or("Step needs an id.")?;
                    if id.is_empty() || types.contains_key(id) {
                        return Err("Invalid or duplicate step id.".into());
                    }
                    let name = step["call"].as_str().ok_or("Step needs a call.")?;
                    let f = program
                        .functions
                        .iter()
                        .find(|f| f.name == name)
                        .ok_or("Unknown pipeline function.")?;
                    let args = step["args"]
                        .as_array()
                        .ok_or("Step args must be an array.")?;
                    if args.len() != f.params.len() {
                        return Err("Pipeline argument count mismatch.".into());
                    }
                    for (j, (arg, (_, ty))) in args.iter().zip(&f.params).enumerate() {
                        if let Some(previous) = arg.get("step").and_then(Value::as_str) {
                            if arg.as_object().map(|x| x.len()) != Some(1)
                                || types.get(previous) != Some(ty)
                            {
                                return Err("Pipeline reference has wrong type or does not name an earlier step.".into());
                            }
                        } else {
                            let value = if let Some(port) = arg.get("input").and_then(Value::as_str)
                            {
                                if arg.as_object().map(|x| x.len()) != Some(1) {
                                    return Err("Invalid input reference.".into());
                                }
                                input["inputs"].get(port).ok_or("Missing pipeline input.")?
                            } else {
                                arg
                            };
                            let value = eval::Value::from_program_json(value, ty, program)?.json();
                            canonical["steps"][i]["args"][j] = value;
                        }
                    }
                    types.insert(id.to_string(), f.result.clone());
                }
                canonical.as_object_mut().unwrap().remove("inputs");
                if let Some(outputs) = input.get("outputs") {
                    let outputs = outputs
                        .as_array()
                        .ok_or("Pipeline outputs must be an array.")?;
                    if outputs.is_empty()
                        || outputs
                            .iter()
                            .any(|v| v.as_str().map(|n| !types.contains_key(n)).unwrap_or(true))
                    {
                        return Err("Unknown pipeline output.".into());
                    }
                }
                canonical
            } else if entry == "@script" {
                let commands = input
                    .as_array()
                    .ok_or("A state script must be a JSON array of {call, args} commands.")?;
                if commands.len() > 256 {
                    return Err("A script may contain at most 256 commands.".into());
                }
                let mut result = Vec::new();
                for (index, command) in commands.iter().enumerate() {
                    let name = command["call"]
                        .as_str()
                        .ok_or_else(|| format!("Command {} needs a call name.", index + 1))?;
                    let action = program
                        .actions
                        .iter()
                        .find(|a| a.name == name)
                        .ok_or_else(|| format!("Unknown query/change: {name}"))?;
                    let args = arguments(&command["args"], &action.params, program)
                        .map_err(|e| format!("Command {}: {e}", index + 1))?;
                    result.push(json!({"call":name,"args":args}));
                }
                Value::Array(result)
            } else {
                if let Some(function) = program.functions.iter().find(|f| f.name == entry) {
                    if ink_core::local_collections::owned(&function.result, program)
                        || function
                            .params
                            .iter()
                            .any(|(_, t)| ink_core::local_collections::owned(t, program))
                    {
                        return Err("Owned Buffer/Map helpers are internal to the program.".into());
                    }
                    arguments(&input, &function.params, program)?
                } else if let Some(action) = program.actions.iter().find(|a| a.name == entry) {
                    arguments(&input, &action.params, program)?
                } else {
                    return Err(format!("Unknown function, query, or change: {entry}"));
                }
            };
            Ok(json!({"input":serde_json::to_string(&prepared).map_err(|e|e.to_string())?}))
        }
        _ => Err("Unknown compiler request.".into()),
    }
}

#[no_mangle]
pub extern "C" fn ink_env_alloc(len: usize) -> *mut u8 {
    if len == 0 || len > MAX_REQUEST {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0u8; len].into_boxed_slice()).cast()
}
/// Only pointers allocated by ink_env_alloc, with their original length, are valid.
#[no_mangle]
pub unsafe extern "C" fn ink_env_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 && len <= MAX_REQUEST {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}
#[no_mangle]
pub unsafe extern "C" fn ink_env_request(ptr: *const u8, len: usize) -> *const u8 {
    let outcome = if ptr.is_null() || len == 0 || len > MAX_REQUEST {
        Err("Invalid request size.".into())
    } else {
        serde_json::from_slice(std::slice::from_raw_parts(ptr, len))
            .map_err(|e| format!("Invalid compiler request: {e}"))
            .and_then(|request| handle(&request))
    };
    let wire = match outcome {
        Ok(value) => json!({"ok":value}),
        Err(error) => json!({"error":error}),
    };
    let mut response = RESPONSE.lock().unwrap();
    *response = serde_json::to_vec(&wire).unwrap();
    response.as_ptr()
}
#[no_mangle]
pub extern "C" fn ink_env_response_len() -> usize {
    RESPONSE.lock().unwrap().len()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn compile(source: &str) -> Value {
        handle(&json!({"op":"compile","source":source})).unwrap()
    }
    fn prepare(compiled: &Value, entry: &str, input: &str) -> Result<Value, String> {
        handle(
            &json!({"op":"prepare","core":compiled["core"],"identity":compiled["manifest"]["core_sha256"],"entry":entry,"input":input}),
        )
    }
    #[test]
    fn compiler_checks_types_and_rejects_unlinked_source() {
        assert!(
            handle(&json!({"op":"compile","source":"module bad; fn f()->u32{return true;}"}))
                .is_err()
        );
        assert!(handle(
            &json!({"op":"compile","source":"module app; import \"std:words\" as words;"})
        )
        .is_err());
        let c=compile("module generic;fn identity<T>(x:T)->T{return x;} fn run(x:u32)->u32{return identity<u32>(x);}");
        assert!(c["javascript"].as_str().unwrap().contains("export"));
    }
    #[test]
    fn pure_browser_targets_export_rust_and_have_no_c_toolchain() {
        let c = compile("module targets;fn total(xs:List<u32>)->u32{return sum(xs);}");
        assert!(c["rust"].as_str().unwrap().contains("l_total"));
        assert!(c["bundle"]["rust"]
            .as_str()
            .unwrap()
            .contains("ink_compute_call"));
        assert!(c["bundle"].get("c").is_none());
        assert!(c["bundle"]["manifest"]["cpu_rust_sha256"].is_string());
    }
    #[test]
    fn trusted_generated_calls_receive_checked_exact_values() {
        let c =
            compile("module exact;fn word(x:u64)->u64{return x;}fn small(x:u32)->u32{return x;}");
        assert_eq!(
            prepare(&c, "word", "[18446744073709551615]").unwrap()["input"],
            "[18446744073709551615]"
        );
        for input in ["[-1]", "[18446744073709551616]", "[]", "[1,2]", "[true]"] {
            assert!(prepare(&c, "word", input).is_err(), "{input}");
        }
        assert!(prepare(&c, "small", "[4294967296]").is_err());
    }
    #[test]
    fn scripts_validate_every_command_without_executing_it() {
        let c=compile("module stateful;state Rows:Table<u64,u64>=Table.empty();query get(k:u64)->Option<u64> reads(Rows){return Rows.get(k);}");
        assert!(prepare(&c, "@script", r#"[{"call":"get","args":[7]}]"#).is_ok());
        assert!(prepare(
            &c,
            "@script",
            r#"[{"call":"get","args":[7]},{"call":"get","args":[-1]}]"#
        )
        .is_err());
        assert!(prepare(&c, "@script", r#"[{"call":"missing","args":[]}]"#).is_err());
    }
    #[test]
    fn static_contracts_are_checked_before_browser_emission() {
        let prefix = "module contracts; spec fn next(x:u32)->u32 ensures result==x+1;";
        compile(&format!(
            "{prefix} implementation direct for next{{return x+1;}}"
        ));
        assert!(handle(&json!({"op":"compile","source":format!("{prefix} implementation bad for next{{return x;}}") })).is_err());
        assert!(handle(&json!({"op":"compile","source":format!("{prefix} implementation direct for next{{return x+1;}}"),"contractEvidence":{"schema":1,"semantics":"ink-contracts-v1","source_sha256":"wrong"}})).is_err());
    }

    fn source_module(
        path: &str,
        name: &str,
        source: &str,
        dependencies: &[&str],
        exports: &[&str],
    ) -> Value {
        json!({"path":path,"name":name,"source":source,"dependencies":dependencies,"exports":exports})
    }
    fn linked(root: &str, modules: Vec<Value>) -> Value {
        json!({"version":1,"root":root,"modules":modules})
    }
    fn simple_graph() -> Value {
        linked(
            "main.ink",
            vec![
                source_module(
                    "main.ink",
                    "app",
                    "module app; fn run(n:u32)->u32{return bump(n);}",
                    &["lib/math.ink"],
                    &["run"],
                ),
                source_module(
                    "lib/math.ink",
                    "math",
                    "module math; fn bump(n:u32)->u32{return n+1;} fn hidden()->u32{return 41;}",
                    &[],
                    &["bump"],
                ),
            ],
        )
    }
    #[test]
    fn modules_compile_checked_sources_and_retain_exact_explicit_root_exports() {
        let graph = simple_graph();
        let out = handle(&json!({"op":"compileModules","graph":graph})).unwrap();
        assert_eq!(out["module_graph"]["root_exports"], json!(["run"]));
        assert!(out["javascript"].is_string());
        assert!(out["rust"].is_string());
        let checked = CheckedModule::from_bytes(out["core"].as_str().unwrap().as_bytes()).unwrap();
        assert_eq!(
            out["module_graph"]["core_sha256"],
            checked.identity().unwrap()
        );
        assert_eq!(
            eval::call(
                checked.program(),
                "run",
                vec![eval::Value::U32(8)],
                &mut 10000
            )
            .unwrap(),
            eval::Value::U32(9)
        );
        let mut reordered = graph.clone();
        reordered["modules"].as_array_mut().unwrap().reverse();
        let (_, original) = modules::assemble(&graph).unwrap();
        let (_, reordered) = modules::assemble(&reordered).unwrap();
        assert_eq!(original, reordered);
        let mut changed = graph.clone();
        changed["modules"][1]["source"] = json!(format!(
            "{}\n// retained source identity",
            graph["modules"][1]["source"].as_str().unwrap()
        ));
        let (_, changed) = modules::assemble(&changed).unwrap();
        assert_ne!(original["graph_sha256"], changed["graph_sha256"]);
        assert_ne!(original["identity"], changed["identity"]);
    }
    #[test]
    fn modules_check_direct_dependencies_export_ownership_and_symbol_collisions() {
        for which in 0..6 {
            let mut graph = simple_graph();
            match which {
                0 => {
                    graph["modules"][0]["source"] =
                        json!("module app; fn run(n:u32)->u32{return hidden();}")
                }
                1 => graph["modules"][1]["exports"] = json!(["run"]),
                2 => {
                    graph["modules"][1]["source"] = json!(
                        "module math; fn bump(n:u32)->u32{return n;} fn run(n:u32)->u32{return n;}"
                    )
                }
                3 => graph["modules"][0]["exports"] = json!(["bump"]),
                4 => {
                    graph["modules"][0]["source"] =
                        json!("module app; fn run(n:u32)->u32{return bump(true);}")
                }
                _ => {
                    graph["modules"][0]["dependencies"] = json!(["middle.ink"]);
                    graph["modules"].as_array_mut().unwrap().push(source_module(
                        "middle.ink",
                        "middle",
                        "module middle; fn bridge(n:u32)->u32{return bump(n);}",
                        &["lib/math.ink"],
                        &["bridge"],
                    ));
                }
            }
            assert!(modules::assemble(&graph).is_err(), "case {which}");
        }
    }
    #[test]
    fn modules_validate_names_paths_cycles_complete_closure_and_source_bounds() {
        for which in 0..10 {
            let mut graph = simple_graph();
            match which {
                0 => graph["version"] = json!(2),
                1 => graph["modules"][0]["name"] = json!("different"),
                2 => graph["modules"][1]["path"] = json!("../lib.ink"),
                3 => graph["modules"][1]["path"] = json!(".env.ink"),
                4 => graph["modules"][1]["dependencies"] = json!(["main.ink"]),
                5 => graph["modules"][0]["dependencies"] = json!([]),
                6 => graph["modules"][0]["exports"] = json!(["run", "run"]),
                7 => graph["modules"][1]["extra"] = json!(true),
                8 => graph["modules"][0]["source"] = json!("x".repeat(MAX_SOURCE + 1)),
                _ => {
                    let extra = graph["modules"][1].clone();
                    graph["modules"].as_array_mut().unwrap().push(extra);
                }
            }
            assert!(modules::assemble(&graph).is_err(), "case {which}");
        }
        let mut request = json!({"op":"compileModules","graph":simple_graph()});
        request["contractEvidence"] = json!({});
        assert!(handle(&request).unwrap_err().contains("only op and graph"));
    }
    #[test]
    fn modules_preserve_generic_imported_records_and_type_aliases_before_elaboration() {
        let graph = linked("main.ink", vec![
            source_module("main.ink", "app", "module app; fn run(n:Word)->Word{return unbox<Word>(box<Word>(n));}", &["box.ink"], &["run"]),
            source_module("box.ink", "boxlib", "module boxlib; type Word=u32; record Box<T>{item:T,} fn box<T>(v:T)->Box<T>{return Box<T>{item:v};} fn unbox<T>(v:Box<T>)->T{return v.item;}", &[], &["Word", "Box", "box", "unbox"]),
        ]);
        let (checked, _) = modules::assemble(&graph).unwrap();
        assert_eq!(
            eval::call(
                checked.program(),
                "run",
                vec![eval::Value::U32(29)],
                &mut 10000
            )
            .unwrap(),
            eval::Value::U32(29)
        );
        let direct = linked(
            "main.ink",
            vec![
                source_module(
                    "main.ink",
                    "app",
                    "module app; fn run()->u32{let b=Point{x:7};return b.x;}",
                    &["point.ink"],
                    &["run"],
                ),
                source_module(
                    "point.ink",
                    "points",
                    "module points; record Point{x:u32,}",
                    &[],
                    &["Point"],
                ),
            ],
        );
        let (checked, _) = modules::assemble(&direct).unwrap();
        assert_eq!(
            eval::call(checked.program(), "run", vec![], &mut 10000).unwrap(),
            eval::Value::U32(7)
        );
    }
    #[test]
    fn modules_enforce_abstract_and_unexported_record_origins_including_callbacks_and_aliases() {
        let library = "module library; abstract refined record Hidden<T>{item:T,valid:Bool,} invariant value.valid; fn wrap<T>(item:T)->Hidden<T>{return Hidden<T>{item:item,valid:true};} fn observe<T>(v:Hidden<T>)->T{return v.item;} fn through<T>(v:Hidden<T>,read:fn(Hidden<T>)->T)->T{return read(v);}";
        let assemble = |source: &str| {
            modules::assemble(&linked(
                "main.ink",
                vec![
                    source_module("main.ink", "app", source, &["lib.ink"], &["run"]),
                    source_module(
                        "lib.ink",
                        "library",
                        library,
                        &[],
                        &["Hidden", "wrap", "observe", "through"],
                    ),
                ],
            ))
        };
        assert!(assemble("module app; fn run()->u32{return observe<u32>(wrap<u32>(7));}").is_ok());
        for source in [
            "module app;fn run(v:Hidden<u32>)->u32{return v.item;}",
            "module app;fn run()->Hidden<u32>{return Hidden<u32>{item:7,valid:true};}",
            "module app;fn run(v:Hidden<u32>)->u32{return through<u32>(v,fn(x)=>x.item);}",
        ] {
            let error = assemble(source)
                .err()
                .expect("foreign representation leaked");
            assert!(error.contains("representation access outside"), "{error}");
        }
        let marker = format!("__ink_origin_{:x}", Sha256::digest(b"library"));
        for suffix in ["", "_", "__"] {
            let source = format!(
                "module app;fn run(v:Hidden<u32>)->u32{{let {marker}{suffix}=();return v.item;}}"
            );
            assert!(
                assemble(&source).is_err(),
                "source-origin marker forgery accepted"
            );
        }
        let private = linked("main.ink", vec![
            source_module("main.ink", "app", "module app;fn run()->u32{let v=make();return v.item;}", &["private.ink"], &["run"]),
            source_module("private.ink", "private", "module private;record Secret{item:u32,}fn make()->Secret{return Secret{item:7};}", &[], &["make"]),
        ]);
        assert!(modules::assemble(&private)
            .err()
            .unwrap()
            .contains("representation access outside"));
        for source in [
            "module app;fn run(v:Public)->u32{return v.item;}",
            "module app;fn run()->Public{return Public{item:7};}",
        ] {
            let mut alias = private.clone();
            alias["modules"][0]["source"] = json!(source);
            alias["modules"][1]["source"] = json!("module private;record Secret{item:u32,}type Public=Secret;fn make()->Secret{return Secret{item:7};}");
            alias["modules"][1]["exports"] = json!(["make", "Public"]);
            assert!(modules::assemble(&alias)
                .err()
                .unwrap()
                .contains("representation access outside"));
        }
    }
    #[test]
    fn modules_reject_record_updates_before_origin_erasing_expansion() {
        for source in [
            "module app;fn run()->Public{return Public{..make(),item:9};}",
            "module app;fn run(v:Public)->Public{return Public{..v,item:9};}",
        ] {
            let graph = linked("main.ink", vec![
                source_module("main.ink", "app", source, &["private.ink"], &["run"]),
                source_module("private.ink", "private", "module private;record Secret{item:u32,}type Public=Secret;fn make()->Secret{return Secret{item:7};}", &[], &["make", "Public"]),
            ]);
            assert!(modules::assemble(&graph)
                .err()
                .expect("foreign record update accepted")
                .contains("do not yet support record updates"));
        }
        let mut graph = simple_graph();
        graph["modules"][0]["source"] = json!(
            "module app;record Owned{item:u32,}fn run(v:Owned)->Owned{return Owned{..v,item:9};}"
        );
        assert!(modules::assemble(&graph)
            .err()
            .unwrap()
            .contains("do not yet support record updates"));
    }
    #[test]
    fn modules_keep_root_state_and_effect_checks_and_reject_unimplemented_library_semantics() {
        let mut graph = simple_graph();
        graph["modules"][0]["source"] = json!("module app;state Total:u32=0;change run(n:u32)->u32 reads(Total) writes(Total){Total=Total+bump(n);return Total;}query total()->u32 reads(Total){return Total;}");
        graph["modules"][0]["exports"] = json!(["run", "total"]);
        let (checked, _) = modules::assemble(&graph).unwrap();
        let emitted = emit_checked(&checked).unwrap();
        assert!(emitted["javascript"].is_string());
        assert!(emitted["rust"].is_string());
        assert_eq!(emitted["manifest"]["state"]["actions"][0]["change"], true);
        assert_eq!(emitted["manifest"]["state"]["actions"][1]["change"], false);
        let mut runtime = ink_core::stateful::Runtime::from_checked(&checked).unwrap();
        assert_eq!(
            runtime.invoke_json("run", &json!([8])).unwrap().json()["result"],
            9
        );
        let query = runtime.invoke_json("total", &json!([])).unwrap().json();
        assert_eq!(query["result"], 9);
        assert_eq!(query["committed"], false);
        graph["modules"][0]["source"] = json!("module app;state Total:u32=0;query run(n:u32)->u32 reads(Total){Total=bump(n);return Total;}");
        graph["modules"][0]["exports"] = json!(["run"]);
        assert!(modules::assemble(&graph).is_err());
        for source in ["module math;state Total:u32=0;fn bump(n:u32)->u32{return n;}", "module math;spec fn bump(n:u32)->u32 ensures result==n;implementation direct for bump{return n;}"] {
            let mut graph = simple_graph(); graph["modules"][1]["source"] = json!(source); assert!(modules::assemble(&graph).is_err());
        }
    }
    #[test]
    fn modules_builtin_method_labels_do_not_reference_foreign_global_functions() {
        let graph = linked(
            "main.ink",
            vec![
                source_module(
                    "main.ink",
                    "app",
                    "module app;fn run(xs:List<u32>)->u32{return xs.at_or(0,7);}",
                    &["lib.ink"],
                    &["run"],
                ),
                source_module(
                    "lib.ink",
                    "library",
                    "module library;fn at_or()->u32{return 0;}fn answer()->u32{return 1;}",
                    &[],
                    &["answer"],
                ),
            ],
        );
        let (checked, _) = modules::assemble(&graph).unwrap();
        assert_eq!(
            eval::call(
                checked.program(),
                "run",
                vec![eval::Value::List(vec![])],
                &mut 10000
            )
            .unwrap(),
            eval::Value::U32(7)
        );
    }
    #[test]
    fn modules_local_binders_cannot_hide_foreign_global_calls_from_visibility_checks() {
        for source in [
            "module app;fn run(hidden:u32)->u32{return hidden();}",
            "module app;fn run()->u32{let hidden:u32=0;return hidden();}",
            "module app;fn run(xs:List<u32>)->List<u32>{return xs.map(fn(hidden)=>hidden());}",
            "module app;fn run<hidden>(n:hidden)->u32{return hidden();}",
        ] {
            let mut graph = simple_graph();
            graph["modules"][0]["source"] = json!(source);
            let error = modules::assemble(&graph)
                .err()
                .expect("foreign global call leaked");
            assert!(error.contains("not a directly imported export"), "{error}");
        }
    }
    #[test]
    fn modules_local_binders_cannot_launder_named_foreign_callbacks() {
        for source in [
            "module app;fn run(hidden:u32)->u32{return apply(hidden);}",
            "module app;fn run()->u32{let hidden:u32=0;return apply(hidden);}",
            "module app;fn run(xs:List<u32>)->List<u32>{return xs.map(fn(hidden)=>apply(hidden));}",
        ] {
            let graph = linked("main.ink", vec![
                source_module("main.ink", "app", source, &["lib.ink"], &["run"]),
                source_module("lib.ink", "library", "module library;fn hidden(n:u32)->u32{return n+41;}fn apply(read:fn(u32)->u32)->u32{return read(1);}", &[], &["apply"]),
            ]);
            let error = modules::assemble(&graph)
                .err()
                .expect("foreign callback leaked");
            assert!(error.contains("not a directly imported export"), "{error}");
        }
        let graph = linked(
            "main.ink",
            vec![
                source_module(
                    "main.ink",
                    "app",
                    "module app;fn run(xs:List<u32>)->List<u32>{return xs.map(hidden<u32>);}",
                    &["lib.ink"],
                    &["run"],
                ),
                source_module(
                    "lib.ink",
                    "library",
                    "module library;fn hidden<T>(n:T)->T{return n;}fn answer()->u32{return 1;}",
                    &[],
                    &["answer"],
                ),
            ],
        );
        // This generic function-value spelling is rejected by the current parser;
        // application visibility is still checked if a future frontend accepts it.
        assert!(
            modules::assemble(&graph).is_err(),
            "foreign generic callback leaked"
        );
    }
    #[test]
    fn modules_root_exports_must_survive_as_concrete_callable_entries() {
        for source in [
            "module app;fn run<T>(n:T)->T{return n;}",
            "module app;fn run(read:fn(u32)->u32)->u32{return read(1);}",
        ] {
            let mut graph = simple_graph();
            graph["modules"][0]["source"] = json!(source);
            let error = modules::assemble(&graph)
                .err()
                .expect("erased template exported");
            assert!(error.contains("not a concrete executable entry"), "{error}");
        }
    }
}
