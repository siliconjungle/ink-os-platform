(function() {
	// \0rolldown/runtime.js
	var __defProp = Object.defineProperty;
	var __exportAll = (all, no_symbols) => {
		let target = {};
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
		if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
		return target;
	};
	// sdk/src/ui-model.js
	/** Portable keyed widget model and ordered patch protocol, shared by adapters. */
	var UI_FORMAT = "ink-ui-v1";
	var UI_KINDS = Object.freeze([
		"Column",
		"Row",
		"Panel",
		"Heading",
		"Text",
		"Button",
		"Field",
		"Toggle",
		"Select",
		"List",
		"Item",
		"Table",
		"TableHead",
		"TableBody",
		"TableRow",
		"HeaderCell",
		"Cell",
		"Form",
		"Navigation",
		"NavItem",
		"Component"
	]);
	var UI_EVENTS = Object.freeze([
		"Activate",
		"Input",
		"Change",
		"Submit"
	]);
	var fail = (message) => {
		throw Error(message);
	};
	var plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
	function validateUiTree(tree) {
		if (!plain(tree) || tree.format !== "ink-ui-v1" || typeof tree.root !== "string" || !Array.isArray(tree.nodes) || !tree.nodes.length || tree.nodes.length > 5e3) fail("Invalid bounded UI tree");
		const nodes = /* @__PURE__ */ new Map();
		let bytes = 0;
		for (const node of tree.nodes) {
			if (!plain(node) || typeof node.id !== "string" || !node.id || node.id.length > 1024 || nodes.has(node.id) || !UI_KINDS.includes(node.kind) || !Array.isArray(node.children) || node.children.some((child) => typeof child !== "string") || !plain(node.props) || !Array.isArray(node.events) || node.events.length > 4 || node.events.some((event) => !plain(event) || !UI_EVENTS.includes(event.kind) || !/^[a-f0-9]{32}$/.test(event.token || "")) || new Set(node.events.map((event) => event.kind)).size !== node.events.length) fail("Invalid UI node identity, shape or event binding");
			validateProps(node.props);
			nodes.set(node.id, node);
			bytes += new TextEncoder().encode(JSON.stringify(node)).length;
		}
		if (bytes > 1048576) fail("UI tree exceeds 1 MiB");
		const seen = /* @__PURE__ */ new Set(), visit = (id, depth, insideForm = false) => {
			if (depth > 64 || seen.has(id) || !nodes.has(id)) fail("UI nodes need one parent and an acyclic bounded tree");
			seen.add(id);
			const node = nodes.get(id);
			if (insideForm && node.kind === "Form") fail("Forms cannot be nested");
			const eventKinds = {
				Activate: [
					"Button",
					"NavItem",
					"Item",
					"TableRow"
				],
				Input: ["Field"],
				Change: [
					"Field",
					"Toggle",
					"Select"
				],
				Submit: ["Form"]
			};
			if (node.events.some((event) => !eventKinds[event.kind].includes(node.kind))) fail("Unsupported event binding for " + node.kind);
			if ([
				"Heading",
				"Text",
				"Button",
				"Field",
				"Toggle",
				"Select",
				"NavItem"
			].includes(node.kind) && node.children.length) fail("Leaf widgets cannot contain children");
			if (new Set(node.children).size !== node.children.length) fail("Duplicate child identity");
			for (const child of node.children) visit(child, depth + 1, insideForm || node.kind === "Form");
		};
		visit(tree.root, 0);
		for (const node of nodes.values()) {
			const allowed = {
				Table: ["TableHead", "TableBody"],
				TableHead: ["TableRow"],
				TableBody: ["TableRow"],
				TableRow: ["HeaderCell", "Cell"],
				List: ["Item"],
				Navigation: ["NavItem"]
			}[node.kind];
			if (allowed && node.children.some((id) => !allowed.includes(nodes.get(id).kind))) fail("Invalid semantic widget hierarchy");
		}
		if (seen.size !== nodes.size) fail("UI tree contains unreachable nodes");
		return nodes;
	}
	function validateProps(props) {
		const names = [
			"text",
			"value",
			"checked",
			"disabled",
			"label",
			"description",
			"selected",
			"invalid",
			"placeholder",
			"fieldKind",
			"options",
			"valueToken"
		];
		if (Object.keys(props).length !== names.length || Object.keys(props).some((key) => !names.includes(key)) || [
			"text",
			"value",
			"label",
			"description",
			"placeholder"
		].some((key) => typeof props[key] !== "string" || props[key].length > 65536) || [
			"checked",
			"disabled",
			"selected",
			"invalid"
		].some((key) => typeof props[key] !== "boolean") || ![
			"Text",
			"Number",
			"Email",
			"Url",
			"Date",
			"Multiline"
		].includes(props.fieldKind) || typeof props.valueToken !== "string" || props.valueToken !== "" && !/^[a-f0-9]{32}$/.test(props.valueToken) || !Array.isArray(props.options) || props.options.length > 256 || props.options.some((option) => !plain(option) || Object.keys(option).sort().join(",") !== "disabled,label,value" || typeof option.value !== "string" || typeof option.label !== "string" || typeof option.disabled !== "boolean") || new Set(props.options.map((option) => option.value)).size !== props.options.length) fail("Invalid typed UI properties");
	}
	function postorder(tree) {
		if (!tree) return [];
		const nodes = new Map(tree.nodes.map((node) => [node.id, node])), result = [];
		const visit = (id) => {
			const node = nodes.get(id);
			for (const child of node.children) visit(child);
			result.push(node);
		};
		visit(tree.root);
		return result;
	}
	function diffUiTree(previous, next) {
		const before = previous ? validateUiTree(previous) : /* @__PURE__ */ new Map(), after = validateUiTree(next), operations = [];
		for (const node of next.nodes) {
			const old = before.get(node.id);
			if (!old || old.kind !== node.kind || node.kind === "Field" && old.props.fieldKind !== node.props.fieldKind) {
				operations.push({
					op: "mount",
					node
				});
				continue;
			}
			if (JSON.stringify(old.props) !== JSON.stringify(node.props) || JSON.stringify(old.events) !== JSON.stringify(node.events)) operations.push({
				op: "update",
				id: node.id,
				props: node.props,
				events: node.events
			});
			if (JSON.stringify(old.children) !== JSON.stringify(node.children)) operations.push({
				op: "children",
				id: node.id,
				children: node.children
			});
		}
		for (const node of postorder(previous)) if (!after.has(node.id)) operations.push({
			op: "dispose",
			id: node.id
		});
		return {
			format: UI_FORMAT,
			root: next.root,
			operations
		};
	}
	/** Adapters must implement these lifecycle/layout/input/accessibility operations.
	* The core validates whole transactions before invoking an adapter. */
	function createUiModel(adapter) {
		for (const method of [
			"mount",
			"update",
			"children",
			"root",
			"dispose"
		]) if (typeof adapter[method] !== "function") throw Error("UI adapters implement " + method);
		if (!adapter.capabilities || adapter.capabilities.format !== "ink-ui-v1" || !Array.isArray(adapter.capabilities.kinds) || [
			"layout",
			"input",
			"accessibility",
			"lifecycle"
		].some((key) => adapter.capabilities[key] !== {
			layout: "flow-v1",
			input: "controls-v1",
			accessibility: "semantic-v1",
			lifecycle: "explicit-v1"
		}[key])) throw Error("UI adapters declare their layout, input, accessibility and lifecycle capabilities");
		let tree = null, revision = 0, closed = false;
		function apply(frame) {
			if (closed) throw Error("UI model is disposed");
			if (frame.format !== "ink-ui-v1" || !Number.isSafeInteger(frame.revision) || frame.revision < 1 || frame.revision < revision) throw Error("Invalid UI frame revision");
			if (frame.baseRevision !== revision) throw Error("UI patch base revision changed");
			let next;
			if (frame.tree) next = structuredClone(frame.tree);
			else {
				const nodes = new Map((tree?.nodes || []).map((node) => [node.id, structuredClone(node)]));
				for (const operation of frame.patch?.operations || []) if (operation.op === "mount") nodes.set(operation.node.id, structuredClone(operation.node));
				else if (operation.op === "dispose") nodes.delete(operation.id);
				else {
					const node = nodes.get(operation.id);
					if (!node) throw Error("UI patch references an absent node");
					if (operation.op === "update") {
						node.props = structuredClone(operation.props);
						node.events = structuredClone(operation.events);
					} else if (operation.op === "children") node.children = [...operation.children];
					else throw Error("Unknown UI patch operation");
				}
				next = {
					format: UI_FORMAT,
					root: frame.patch?.root,
					nodes: [...nodes.values()]
				};
			}
			validateUiTree(next);
			if (next.nodes.some((node) => !adapter.capabilities.kinds.includes(node.kind))) throw Error("Unsupported widget in this UI adapter");
			const patch = diffUiTree(tree, next), old = new Map((tree?.nodes || []).map((node) => [node.id, node]));
			if (frame.revision === revision && patch.operations.length) throw Error("UI content changed without a revision");
			const childUpdates = new Set(patch.operations.filter((operation) => operation.op === "mount" || operation.op === "children").map((operation) => operation.id || operation.node.id));
			try {
				for (const operation of patch.operations) if (operation.op === "mount") {
					const replaced = old.get(operation.node.id);
					if (replaced) {
						adapter.children(replaced.id, []);
						adapter.dispose(replaced.id);
					}
					adapter.mount(operation.node);
				} else if (operation.op === "update") adapter.update(operation.id, operation.props, operation.events);
				for (const node of next.nodes) if (childUpdates.has(node.id)) adapter.children(node.id, node.children);
				adapter.root(next.root);
				for (const operation of patch.operations) if (operation.op === "dispose") adapter.dispose(operation.id);
			} catch (error) {
				closed = true;
				for (const id of /* @__PURE__ */ new Set([...(tree?.nodes || []).map((node) => node.id), ...next.nodes.map((node) => node.id)])) try {
					adapter.dispose(id);
				} catch {}
				throw error;
			}
			tree = freeze(structuredClone(next));
			revision = frame.revision;
			return patch;
		}
		return Object.freeze({
			apply,
			rebase(frame) {
				if (!frame.tree || frame.baseRevision !== 0) throw Error("UI session reset requires a complete tree");
				revision = 0;
				return apply(frame);
			},
			get tree() {
				return tree;
			},
			get revision() {
				return revision;
			},
			dispose() {
				if (closed) return;
				closed = true;
				for (const node of postorder(tree)) adapter.dispose(node.id);
				tree = null;
			}
		});
	}
	function freeze(value) {
		if (value && typeof value === "object") {
			for (const child of Object.values(value)) freeze(child);
			Object.freeze(value);
		}
		return value;
	}
	// sdk/src/ui-dom.js
	var controls = /* @__PURE__ */ new Set([
		"Field",
		"Toggle",
		"Select"
	]);
	var tags = {
		Column: "div",
		Row: "div",
		Panel: "section",
		Heading: "h1",
		Text: "p",
		Button: "button",
		Field: "label",
		Toggle: "label",
		Select: "label",
		List: "ul",
		Item: "li",
		Table: "table",
		TableHead: "thead",
		TableBody: "tbody",
		TableRow: "tr",
		HeaderCell: "th",
		Cell: "td",
		Form: "form",
		Navigation: "nav",
		NavItem: "button",
		Component: "div"
	};
	var sameText = (node, value) => {
		if (node.textContent !== value) node.textContent = value;
	};
	function createDomUi(element, { onEvent = () => {}, onDraftConflict = () => {}, onLifecycle = () => {} } = {}) {
		const document = element.ownerDocument, records = /* @__PURE__ */ new Map(), parents = /* @__PURE__ */ new Map();
		let disposed = false, savedFocus, busy = false;
		const create = (tag, className) => {
			const node = document.createElement(tag);
			if (className) node.className = className;
			return node;
		};
		function disabled(id) {
			for (let current = id; current; current = parents.get(current)) if (records.get(current)?.props.disabled) return true;
			return false;
		}
		function binding(record, kind) {
			return record.events.find((event) => event.kind === kind);
		}
		function preserveFocus() {
			const active = document.activeElement;
			if (!active || !element.contains(active)) return;
			savedFocus = {
				element: active,
				start: active.selectionStart,
				end: active.selectionEnd,
				direction: active.selectionDirection,
				scrollTop: active.scrollTop,
				scrollLeft: active.scrollLeft
			};
		}
		function restoreFocus() {
			const saved = savedFocus;
			savedFocus = null;
			if (!saved || !saved.element.isConnected) return;
			if (document.activeElement !== saved.element) saved.element.focus({ preventScroll: true });
			if (Number.isInteger(saved.start) && typeof saved.element.setSelectionRange === "function") try {
				saved.element.setSelectionRange(saved.start, saved.end, saved.direction);
			} catch {}
			saved.element.scrollTop = saved.scrollTop;
			saved.element.scrollLeft = saved.scrollLeft;
		}
		function move(parent, node, before) {
			if (node.parentNode === parent && node.nextSibling === before) return;
			if (typeof parent.moveBefore === "function" && parent.isConnected && node.isConnected) {
				parent.moveBefore(node, before);
				return;
			}
			preserveFocus();
			parent.insertBefore(node, before);
			restoreFocus();
		}
		function valueInput(record) {
			return {
				text: record.kind === "Toggle" ? "" : record.input.value,
				checked: record.kind === "Toggle" ? record.input.checked : false,
				expected: record.draft?.token || record.props.valueToken,
				fields: []
			};
		}
		function snapshots(ids) {
			return ids.map((id) => ({
				id,
				generation: records.get(id)?.draft?.generation ?? 0,
				expected: records.get(id)?.draft?.token
			}));
		}
		function emit(record, kind) {
			if (busy && ["Activate", "Submit"].includes(kind)) return;
			const event = binding(record, kind);
			if (!event || disabled(record.id)) return;
			let input = {
				text: "",
				checked: false,
				expected: "",
				fields: []
			}, versions = [];
			if (kind === "Submit") {
				const ids = [];
				const visit = (id) => {
					const current = records.get(id);
					if (controls.has(current.kind) && !disabled(id)) ids.push(id);
					for (const child of current.children) visit(child);
				};
				visit(record.id);
				input.fields = ids.map((id) => ({
					id,
					...valueInput(records.get(id))
				}));
				for (const field of input.fields) delete field.fields;
				versions = snapshots(ids);
			} else if (kind === "Input" || kind === "Change") {
				input = valueInput(record);
				versions = snapshots([record.id]);
			}
			onEvent({
				node: record.id,
				kind,
				token: event.token,
				input,
				versions
			});
		}
		function draft(record) {
			record.draft.generation++;
			record.draft.dirty = true;
			record.draft.text = record.input.value;
			record.draft.checked = record.input.checked;
		}
		function conflict(record) {
			const conflicted = record.draft.dirty && record.draft.token !== record.props.valueToken;
			record.conflict.hidden = !conflicted;
			if (conflicted) onDraftConflict(record.id);
		}
		function adopt(record) {
			const input = record.input, props = record.props;
			if (record.kind === "Toggle") {
				if (input.checked !== props.checked) input.checked = props.checked;
			} else if (input.value !== props.value && !record.composing) {
				const start = input.selectionStart, end = input.selectionEnd;
				input.value = props.value;
				if (document.activeElement === input && Number.isInteger(start) && typeof input.setSelectionRange === "function") try {
					input.setSelectionRange(Math.min(start, input.value.length), Math.min(end, input.value.length));
				} catch {}
			}
			record.draft = {
				...record.draft,
				text: input.value,
				checked: input.checked,
				token: props.valueToken,
				dirty: false
			};
			conflict(record);
		}
		function reconcile(record) {
			const desired = record.children.map((id) => records.get(id)?.element);
			if (desired.some((node) => !node)) throw Error("UI child was not mounted");
			if (typeof record.slot.moveBefore !== "function" && record.children.some((id) => hasComposition(id))) return;
			for (const child of [...record.slot.childNodes]) if (records.get(child.dataset?.inkUiId)?.element === child && !desired.includes(child)) record.slot.removeChild(child);
			let before = null;
			for (let i = desired.length - 1; i >= 0; i--) {
				const node = desired[i];
				if (node.parentNode !== record.slot || node.nextSibling !== before) move(record.slot, node, before);
				before = node;
			}
		}
		function hasComposition(id) {
			const record = records.get(id);
			return !!record && (record.composing || record.children.some(hasComposition));
		}
		function update(id, props, events) {
			const record = records.get(id);
			record.props = structuredClone(props);
			record.events = structuredClone(events);
			const target = record.element;
			if (record.label) sameText(record.label, controls.has(record.kind) ? props.label : props.text);
			else if (![
				"Table",
				"TableHead",
				"TableBody",
				"TableRow",
				"Component"
			].includes(record.kind)) sameText(record.text || target, props.text);
			if (record.kind === "Table" && record.caption) sameText(record.caption, props.label);
			if (controls.has(record.kind)) {
				const input = record.input;
				input.placeholder = props.placeholder;
				input.setAttribute("aria-label", props.label);
				input.setAttribute("aria-invalid", String(props.invalid));
				if (record.kind === "Select") {
					const old = new Map([...input.options].map((option) => [option.value, option]));
					for (const option of props.options) {
						const node = old.get(option.value) || create("option");
						node.value = option.value;
						node.disabled = option.disabled;
						sameText(node, option.label);
						input.append(node);
						old.delete(option.value);
					}
					for (const option of old.values()) option.remove();
					if (record.draft?.dirty) input.value = record.draft.text;
				}
				sameText(record.description, props.description);
				record.description.hidden = !props.description;
				input.setAttribute("aria-describedby", record.description.id);
				if (!record.draft) record.draft = {
					generation: 0,
					dirty: false,
					token: props.valueToken
				};
				if (!record.draft.dirty && !record.composing) adopt(record);
				else conflict(record);
			} else {
				if (props.label) target.setAttribute("aria-label", props.label);
				else target.removeAttribute("aria-label");
				if (props.description) target.setAttribute("aria-description", props.description);
				else target.removeAttribute("aria-description");
			}
			if (record.kind === "NavItem") {
				if (props.selected) target.setAttribute("aria-current", "page");
				else target.removeAttribute("aria-current");
			}
			if (record.kind === "Item" || record.kind === "TableRow") {
				if (binding(record, "Activate")) {
					target.tabIndex = 0;
					target.setAttribute("aria-label", props.label || props.text);
				} else target.removeAttribute("tabindex");
			}
		}
		const adapter = {
			capabilities: {
				format: UI_FORMAT,
				target: "dom",
				kinds: UI_KINDS,
				layout: "flow-v1",
				input: "controls-v1",
				accessibility: "semantic-v1",
				lifecycle: "explicit-v1"
			},
			mount(node) {
				const target = create(tags[node.kind], "ink-ui-" + node.kind), record = {
					id: node.id,
					kind: node.kind,
					element: target,
					slot: target,
					props: node.props,
					events: [],
					children: [],
					controller: new AbortController(),
					composing: false
				};
				records.set(node.id, record);
				if (node.kind === "HeaderCell") target.scope = "col";
				target.dataset.inkUiId = node.id;
				const listen = (target, type, listener) => target.addEventListener(type, listener, { signal: record.controller.signal });
				if (controls.has(node.kind)) {
					record.label = create("span");
					record.input = create(node.kind === "Select" ? "select" : node.props.fieldKind === "Multiline" ? "textarea" : "input");
					record.description = create("span", "ink-ui-description");
					record.description.id = "ink-ui-desc-" + globalThis.crypto.randomUUID();
					record.conflict = create("button", "ink-ui-conflict");
					record.conflict.type = "button";
					record.conflict.hidden = true;
					sameText(record.conflict, "Use updated value");
					listen(record.conflict, "click", () => adopt(record));
					if (record.kind === "Toggle") record.input.type = "checkbox";
					else if (record.kind === "Field" && record.input.tagName === "INPUT") record.input.type = {
						Text: "text",
						Number: "text",
						Email: "email",
						Url: "url",
						Date: "date"
					}[node.props.fieldKind];
					if (node.props.fieldKind === "Number") record.input.inputMode = "decimal";
					target.append(record.label, record.input, record.description, record.conflict);
					listen(record.input, "input", () => {
						draft(record);
						if (!record.composing) emit(record, "Input");
					});
					listen(record.input, "change", () => {
						draft(record);
						emit(record, "Change");
					});
					listen(record.input, "compositionstart", () => {
						record.composing = true;
					});
					listen(record.input, "compositionend", () => {
						record.composing = false;
						draft(record);
						emit(record, "Input");
						for (const parent of records.values()) reconcile(parent);
					});
				} else if (node.kind === "Table") {
					record.caption = create("caption");
					target.append(record.caption);
				} else if (![
					"TableHead",
					"TableBody",
					"TableRow",
					"Component"
				].includes(node.kind)) {
					record.text = create("span");
					target.append(record.text);
				}
				if (node.kind === "Form") listen(target, "submit", (event) => {
					event.preventDefault();
					emit(record, "Submit");
				});
				listen(target, "click", (event) => {
					if (event.target === record.conflict) return;
					if (record.kind === "Item" || record.kind === "TableRow") {
						if (event.target.closest("button,input,select,textarea,a")) return;
					}
					emit(record, "Activate");
				});
				if (node.kind === "Item" || node.kind === "TableRow") listen(target, "keydown", (event) => {
					if (event.target === target && (event.key === "Enter" || event.key === " ")) {
						event.preventDefault();
						emit(record, "Activate");
					}
				});
				update(node.id, node.props, node.events);
				onLifecycle({
					type: "mount",
					id: node.id,
					kind: node.kind
				});
			},
			update,
			children(id, children) {
				const record = records.get(id);
				for (const old of record.children) if (parents.get(old) === id) parents.delete(old);
				record.children = [...children];
				for (const child of children) parents.set(child, id);
				reconcile(record);
			},
			root(id) {
				const root = records.get(id)?.element;
				if (!root) throw Error("UI root was not mounted");
				if (element.firstChild !== root || element.childNodes.length !== 1) {
					preserveFocus();
					for (const child of [...element.childNodes]) if (child !== root) child.remove();
					if (root.parentNode !== element) element.append(root);
					restoreFocus();
				}
				for (const record of records.values()) {
					const state = disabled(record.id) || busy && ["Button", "NavItem"].includes(record.kind), control = record.input || record.element;
					if ("disabled" in control && control.disabled !== state) control.disabled = state;
					if (record.element.getAttribute("aria-disabled") !== String(state)) record.element.setAttribute("aria-disabled", String(state));
					if (record.kind === "Button" || record.kind === "NavItem") {
						let form = false;
						for (let current = parents.get(record.id); current; current = parents.get(current)) if (records.get(current).kind === "Form") form = true;
						const type = record.kind === "Button" && form && !binding(record, "Activate") ? "submit" : "button";
						if (record.element.type !== type) record.element.type = type;
					}
				}
			},
			dispose(id) {
				const record = records.get(id);
				if (!record) return;
				record.controller.abort();
				records.delete(id);
				parents.delete(id);
				record.element.remove();
				onLifecycle({
					type: "dispose",
					id,
					kind: record.kind
				});
			}
		};
		const model = createUiModel(adapter);
		return Object.freeze({
			apply: (frame) => model.apply(frame),
			rebase(frame) {
				const old = new Map([...records].map(([id, record]) => [id, JSON.stringify([
					record.props.value,
					record.props.checked,
					record.props.fieldKind,
					record.props.options
				])]));
				const result = model.rebase(frame);
				for (const [id, record] of records) if (record.draft?.dirty && old.get(id) === JSON.stringify([
					record.props.value,
					record.props.checked,
					record.props.fieldKind,
					record.props.options
				])) {
					record.draft.token = record.props.valueToken;
					conflict(record);
				}
				return result;
			},
			get revision() {
				return model.revision;
			},
			get tree() {
				return model.tree;
			},
			get records() {
				return records;
			},
			acknowledge(versions, ackFields = {}) {
				for (const version of versions || []) {
					const record = records.get(version.id);
					if (!record?.draft) continue;
					record.ownTokens ||= /* @__PURE__ */ new Map();
					if (ackFields[version.id]) record.ownTokens.set(version.expected, ackFields[version.id].token);
					while (record.ownTokens.size > 8) record.ownTokens.delete(record.ownTokens.keys().next().value);
					if (record.draft.generation === version.generation) adopt(record);
					else if (ackFields[version.id]) {
						record.draft.token = ackFields[version.id].token;
						conflict(record);
					}
				}
			},
			setBusy(value) {
				busy = !!value;
				if (model.tree) adapter.root(model.tree.root);
			},
			rebaseExpected(id, expected) {
				const record = records.get(id);
				let current = expected;
				for (let n = 0; n < 8 && record?.ownTokens?.has(current); n++) {
					const next = record.ownTokens.get(current);
					if (next === current) break;
					current = next;
				}
				return current === record?.draft?.token ? current : expected;
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				model.dispose();
			}
		});
	}
	// sdk/src/ui-client.js
	/** Transport-neutral typed Ink interface sessions. */
	function createInkUi(request) {
		return Object.freeze({
			open: (options = {}) => request("open", options),
			refresh: (id, input) => request("refresh", {
				id,
				...input
			}),
			event: (id, input) => request("event", {
				id,
				...input
			}),
			dispose: (id) => request("dispose", { id })
		});
	}
	// sdk/src/ui-runtime.js
	var ui_runtime_exports = /* @__PURE__ */ __exportAll({
		UI_FORMAT: () => UI_FORMAT,
		UI_KINDS: () => UI_KINDS,
		createDomUi: () => createDomUi,
		createInkUi: () => createInkUi,
		createUiModel: () => createUiModel,
		diffUiTree: () => diffUiTree,
		mountInkUi: () => mountInkUi,
		validateUiTree: () => validateUiTree
	});
	/** A serialized, bounded event lane; keystrokes update their local controls first. */
	async function mountInkUi({ element, transport, subscribe = () => () => {}, onError = () => {}, onStatus = () => {}, onLifecycle = () => {}, onTrace }) {
		let closed = false, hidden = false, frame, sequence = 0, tail = Promise.resolve(), dirty = false, timer, heartbeat, pending = null, draining = false, drainScheduled = false;
		const trace = (name, start, detail = {}) => {
			if (!onTrace) return;
			try {
				onTrace({
					name,
					start,
					end: performance.now(),
					detail
				});
			} catch {}
		};
		const queue = [];
		const renderer = createDomUi(element, {
			onEvent: enqueue,
			onLifecycle
		});
		function serial(run) {
			const queued = onTrace ? performance.now() : 0;
			const task = tail.catch(() => {}).then(() => {
				trace("ui.queue", queued);
				return run();
			});
			tail = task;
			task.catch((error) => {
				if (!closed) onError(error);
			});
			return task;
		}
		function apply(value) {
			if (closed) return;
			const started = onTrace ? performance.now() : 0;
			if (!frame || value.id !== frame.id) {
				renderer.rebase(value);
				sequence = 0;
			} else if (value.revision >= renderer.revision && value.baseRevision === renderer.revision) renderer.apply(value);
			else dirty = true;
			frame = {
				...value,
				revision: renderer.revision
			};
			element.setAttribute("aria-busy", "false");
			trace("ui.apply", started, {
				revision: renderer.revision,
				operations: value.patch?.operations.length ?? null
			});
		}
		async function open() {
			const value = await transport.open({ target: "dom" });
			if (closed) {
				await transport.dispose(value.id).catch(() => {});
				return;
			}
			apply(value);
		}
		async function read() {
			if (closed || hidden || pending) return;
			dirty = false;
			try {
				apply(await transport.refresh(frame.id, { revision: renderer.revision }));
			} catch (error) {
				if (error.status === 409 && error.current?.uiRetry) {
					invalidate();
					return;
				}
				if (error.status === 410) {
					await open();
					return;
				}
				throw error;
			}
		}
		function invalidate() {
			dirty = true;
			if (closed || hidden || timer !== void 0) return;
			const started = onTrace ? performance.now() : 0;
			trace("ui.invalidate", started, { delayMs: 32 });
			timer = setTimeout(() => {
				trace("ui.coalesce", started);
				timer = void 0;
				serial(read);
			}, 32);
		}
		function status(value) {
			element.setAttribute("aria-busy", String(value.pending));
			renderer.setBusy(value.pending);
			onStatus(value);
		}
		async function reopen() {
			if (pending) onError(Error("The previous action may have completed; the refreshed interface shows current state"));
			pending = null;
			queue.length = 0;
			status({ pending: false });
			await open();
		}
		async function send() {
			if (!pending || closed) return;
			try {
				const value = await transport.event(frame.id, pending.input);
				if (closed) return;
				const current = pending;
				apply(value);
				if (value.event?.sequence !== current.input.sequence) throw Error("Interface event acknowledgement changed");
				sequence = value.event.sequence;
				pending = null;
				status({ pending: false });
				if (value.event.status === "accepted") renderer.acknowledge(current.versions, value.event.fields);
				else {
					onError(Error(value.event.error || "The action could not be completed"));
					if (value.event.status === "unknown") queue.length = 0;
				}
				if (value.event.viewError) onError(Error(value.event.viewError));
				if (dirty) await read();
			} catch (error) {
				if (error.current?.notApplied) {
					pending = null;
					queue.length = 0;
					status({ pending: false });
					await read();
				} else if (pending) status({
					pending: true,
					retry: () => serial(async () => {
						await send();
						await drain();
					}),
					reopen: () => serial(reopen)
				});
				throw error;
			}
		}
		async function drain() {
			if (draining || closed || pending) return;
			draining = true;
			try {
				while (queue.length && !closed && !pending) {
					const value = queue.shift();
					if (dirty) await read();
					const binding = renderer.tree.nodes.find((node) => node.id === value.node)?.events.find((binding) => binding.kind === value.kind);
					if (!binding || binding.token !== value.token) {
						queue.length = 0;
						throw Error("This control changed before the action was sent");
					}
					const input = structuredClone(value.input);
					if (value.kind === "Input" || value.kind === "Change") input.expected = renderer.rebaseExpected(value.node, input.expected);
					for (const field of input.fields) field.expected = renderer.rebaseExpected(field.id, field.expected);
					pending = {
						versions: value.versions,
						input: {
							sequence: sequence + 1,
							revision: renderer.revision,
							node: value.node,
							kind: value.kind,
							token: value.token,
							input
						}
					};
					status({ pending: true });
					await send();
				}
			} finally {
				draining = false;
			}
		}
		function enqueue(value) {
			if (closed) return;
			const last = queue.at(-1);
			if (["Input", "Change"].includes(value.kind) && last?.kind === value.kind && last.node === value.node) queue[queue.length - 1] = value;
			else {
				if (queue.length >= 32) {
					onError(Error("The interface is busy; the local draft has been kept"));
					return;
				}
				queue.push(value);
			}
			if (!drainScheduled) {
				drainScheduled = true;
				serial(async () => {
					drainScheduled = false;
					await drain();
				});
			}
		}
		const stop = subscribe(invalidate);
		try {
			await serial(open);
		} catch (error) {
			stop?.();
			renderer.dispose();
			throw error;
		}
		heartbeat = setInterval(invalidate, 6e4);
		return Object.freeze({
			get renderer() {
				return renderer;
			},
			refresh: () => serial(read),
			retry: () => serial(async () => {
				await send();
				await drain();
			}),
			reopen: () => serial(reopen),
			get pending() {
				return !!pending;
			},
			suspend(value) {
				hidden = !!value;
				if (hidden) {
					clearTimeout(timer);
					timer = void 0;
				} else invalidate();
			},
			dispose() {
				if (closed) return;
				closed = true;
				queue.length = 0;
				clearTimeout(timer);
				clearInterval(heartbeat);
				stop?.();
				renderer.dispose();
				if (frame) transport.dispose(frame.id).catch(() => {});
			}
		});
	}
	// sdk/src/ui-global.js
	globalThis.InkUI = Object.freeze(ui_runtime_exports);
})();
