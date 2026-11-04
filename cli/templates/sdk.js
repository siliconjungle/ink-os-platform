(function() {
	// \0rolldown/runtime.js
	var __defProp = Object.defineProperty;
	var __esmMin = (fn, res, err) => () => {
		if (err) throw err[0];
		try {
			return fn && (res = fn(fn = 0)), res;
		} catch (e) {
			throw err = [e], e;
		}
	};
	var __exportAll = (all, no_symbols) => {
		let target = {};
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
		if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
		return target;
	};
	// work/ink-os-platform/sdk/src/object-drag.js
	function dragObjectIds(value) {
		if (!Array.isArray(value) || !value.length || value.length > 1e3 || value.some((id) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))) return [];
		return [...new Set(value)];
	}
	/** Internal drags stay in the desktop's pointer stream, including when a source is an iframe. */
	function bindObjectDrag(node, { objects, begin, error = () => {} }) {
		node.draggable = false;
		node.style.touchAction = "none";
		let stop = () => {}, suppressClick = false, reset;
		const click = (event) => {
			if (suppressClick) {
				event.preventDefault();
				event.stopImmediatePropagation();
				suppressClick = false;
			}
		};
		const down = (event) => {
			if (event.button !== 0 || event.isPrimary === false || event.target.closest?.("input,textarea,select,a,[contenteditable=true],[data-drag-ignore]")) return;
			const ids = dragObjectIds(objects());
			if (!ids.length) return;
			stop();
			event.preventDefault();
			const x = event.clientX, y = event.clientY, rect = node.getBoundingClientRect(), at = Date.now();
			const cleanup = () => {
				removeEventListener("pointermove", move, true);
				removeEventListener("pointerup", up, true);
				removeEventListener("pointercancel", up, true);
				removeEventListener("blur", cleanup);
				removeEventListener("keydown", key, true);
			};
			const up = (e) => {
				if (e.pointerId === event.pointerId) cleanup();
			}, key = (e) => {
				if (e.key === "Escape") cleanup();
			};
			const move = (e) => {
				if (e.pointerId !== event.pointerId || Math.hypot(e.clientX - x, e.clientY - y) < 6) return;
				cleanup();
				suppressClick = true;
				clearTimeout(reset);
				reset = setTimeout(() => {
					suppressClick = false;
				}, 1e3);
				try {
					Promise.resolve(begin({
						ids,
						pointerId: event.pointerId,
						pointerType: event.pointerType || "mouse",
						x: e.clientX,
						y: e.clientY,
						grabX: Math.max(0, Math.min(1, (x - rect.left) / Math.max(1, rect.width))),
						grabY: Math.max(0, Math.min(1, (y - rect.top) / Math.max(1, rect.height))),
						at
					})).catch(error);
				} catch (e) {
					error(e);
				}
			};
			stop = cleanup;
			addEventListener("pointermove", move, true);
			addEventListener("pointerup", up, true);
			addEventListener("pointercancel", up, true);
			addEventListener("blur", cleanup);
			addEventListener("keydown", key, true);
		};
		node.addEventListener("pointerdown", down);
		node.addEventListener("click", click, true);
		return () => {
			stop();
			clearTimeout(reset);
			node.removeEventListener("pointerdown", down);
			node.removeEventListener("click", click, true);
		};
	}
	// work/ink-os-platform/sdk/src/file-icons.js
	var page = "<path d=\"M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6\"/>";
	var fileIconPaths = {
		document: page + "<path d=\"M8 13h8M8 17h5\"/>",
		image: "<rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"3\"/><circle cx=\"8\" cy=\"8\" r=\"1.5\"/><path d=\"m3 17 6-6 4 4 3-3 5 5\"/>",
		vector: "<path d=\"M5 17C5 6 19 6 19 17M4 7h16M12 5v4\"/><rect x=\"3\" y=\"16\" width=\"4\" height=\"4\" rx=\".5\"/><rect x=\"17\" y=\"16\" width=\"4\" height=\"4\" rx=\".5\"/>",
		audio: page + "<path d=\"M8 14v3m3-5v7m3-6v5m3-4v3\"/>",
		video: "<rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"3\"/><path d=\"m10 8 6 4-6 4zM3 7h3M3 12h3M3 17h3M18 7h3M18 12h3M18 17h3\"/>",
		pdf: page + "<path d=\"M7 18v-5h1.5a1.3 1.3 0 0 1 0 2.6H7m5 2.4v-5h1a2.5 2.5 0 0 1 0 5h-1m5 0v-5h2m-2 2.5h1.5\"/>",
		text: page + "<path d=\"M8 12h8M8 15h8M8 18h5\"/>",
		code: page + "<path d=\"m10 13-3 3 3 3m4-6 3 3-3 3\"/>",
		table: page + "<path d=\"M7 12h10v7H7zM7 15h10M11 12v7\"/>",
		archive: page + "<path d=\"M11 4v3m0 3v2m0 2v2m-2-7h4m-4 4h4m-3 4h3v3h-3z\"/>",
		font: page + "<path d=\"m8 18 4-7 4 7m-6.5-2h5\"/>",
		model: "<path d=\"m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5\"/>",
		link: "<path d=\"m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 4 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0\"/>"
	};
	var byExtension = new Map(Object.entries({
		image: "png jpg jpeg gif webp avif heic heif bmp tif tiff ico psd ase aseprite",
		vector: "svg ai eps",
		audio: "wav mp3 flac ogg opus m4a aac aiff aif mid midi",
		video: "mp4 mov webm mkv avi m4v mpg mpeg",
		pdf: "pdf",
		text: "txt md markdown rtf doc docx odt pages",
		code: "ink js mjs cjs ts tsx jsx json jsonl html css scss xml yaml yml toml py rs sh sql glsl wgsl",
		table: "csv tsv xls xlsx ods numbers",
		archive: "zip gz tgz bz2 xz tar rar 7z",
		font: "ttf otf woff woff2",
		model: "obj glb gltf fbx stl blend usd usdz"
	}).flatMap(([type, list]) => list.split(" ").map((ext) => [ext, type])));
	function fileIconType(file = {}) {
		let body = {};
		try {
			body = typeof file.body === "string" ? JSON.parse(file.body) : file.body || {};
		} catch {}
		body = body && typeof body === "object" ? body : {};
		const mime = String(body.mime || file.mime || file.type || "").toLowerCase().split(";")[0].trim(), ext = String(body.originalName || file.source || file.name || file.title || "").match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
		if (mime === "image/svg+xml") return "vector";
		if (mime.startsWith("image/")) return "image";
		if (mime.startsWith("audio/")) return "audio";
		if (mime.startsWith("video/")) return "video";
		if (mime === "application/pdf") return "pdf";
		if (/(?:spreadsheet|excel|csv|tab-separated)/.test(mime)) return "table";
		if (/(?:zip|compressed|x-tar|gzip)/.test(mime)) return "archive";
		if (mime.startsWith("font/") || /font|woff/.test(mime)) return "font";
		if (mime.startsWith("model/")) return "model";
		if (byExtension.has(ext)) return byExtension.get(ext);
		if (/(?:json|javascript|typescript|xml|yaml|toml)/.test(mime)) return "code";
		if (mime.startsWith("text/")) return "text";
		return {
			image: "image",
			audio: "audio",
			video: "video",
			note: "text",
			code: "code",
			link: "link"
		}[file.kind] || "document";
	}
	function fileIconSVG(file, size = 24) {
		size = Number.isFinite(size) ? Math.max(8, Math.min(256, size)) : 24;
		return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + size + "\" height=\"" + size + "\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">" + fileIconPaths[fileIconType(file)] + "</svg>";
	}
	// work/ink-os-platform/sdk/src/workflows.js
	/** Shared workflow definitions and durable background runs. */
	function createWorkflows(request) {
		const call = (method, input = {}) => request("workflows." + method, input);
		return Object.freeze({
			list: (options = {}) => call("list", options),
			get: (id) => call("get", { id }),
			save: (definition, options = {}) => call("save", {
				definition,
				...options
			}),
			archive: (id, expected) => call("archive", {
				id,
				expected
			}),
			preview: (id, inputs = {}) => call("preview", {
				id,
				inputs
			}),
			run: (id, inputs = {}, options = {}) => call("run", {
				id,
				inputs,
				requestId: crypto.randomUUID(),
				...options
			}),
			runs: (options = {}) => call("runs", options),
			cancel: (runId) => call("cancel", { runId }),
			retry: (runId, options = {}) => call("retry", {
				runId,
				requestId: crypto.randomUUID(),
				...options
			})
		});
	}
	// work/ink-os-platform/sdk/src/commands.js
	/** Public commands use one API in browser and backend clients. */
	function createCommands(request, show) {
		return Object.freeze({
			query: (query = {}) => request("commands.query", query),
			list: (query = {}) => request("commands.query", query),
			get: async (appId, id) => {
				let offset = 0;
				for (;;) {
					const result = await request("commands.query", {
						appId,
						limit: 100,
						...offset ? { offset } : {}
					}), command = result.commands.find((command) => command.id === id);
					if (command) return command;
					if (result.nextOffset === null || result.nextOffset === void 0) throw Error("Command unavailable");
					offset = result.nextOffset;
				}
			},
			run: (appId, id, input = {}, options = {}) => request("commands.run", {
				appId,
				id,
				input,
				...options.requestId ? { requestId: options.requestId } : {}
			}),
			...show ? { show: (query = {}) => show(query) } : {}
		});
	}
	// work/ink-os-platform/sdk/src/command-bridge.js
	function commandBridge({ origin, appId, handlers = {} }) {
		const host = parent, cache = Symbol.for("ink.commands.client");
		if (globalThis[cache]?.__host === host) {
			globalThis[cache].register(handlers);
			return globalThis[cache];
		}
		let port, serial = 0;
		const pending = /* @__PURE__ */ new Map(), seen = /* @__PURE__ */ new Map(), inbox = [];
		let connected;
		const ready = new Promise((resolve) => connected = resolve);
		const hello = () => host.postMessage({
			source: "ink-command-client",
			version: 1,
			type: "hello",
			appId
		}, origin);
		const connect = (event) => {
			if (event.source !== host || event.origin !== origin || event.data?.source !== "ink-command-host" || event.data.version !== 1 || !event.ports[0]) return;
			port?.close();
			port = event.ports[0];
			port.onmessage = async ({ data }) => {
				if (data.type === "response") {
					const waiter = pending.get(data.id);
					if (!waiter) return;
					clearTimeout(waiter.timer);
					pending.delete(data.id);
					data.error ? waiter.reject(Object.assign(Error(data.error), { status: data.status })) : waiter.resolve(data.result);
				}
				if (data.type === "execute") {
					if (seen.has(data.requestId)) return;
					if (!handlers[data.command.id] && data.command.id !== "open") {
						if (inbox.length < 20 && !inbox.some((item) => item.requestId === data.requestId)) inbox.push(data);
						return;
					}
					seen.set(data.requestId, true);
					if (seen.size > 100) seen.delete(seen.keys().next().value);
					try {
						const handler = handlers[data.command.id];
						if (handler) await handler(data.command.input || {});
						port.postMessage({
							type: "executed",
							requestId: data.requestId
						});
					} catch (error) {
						port.postMessage({
							type: "executed",
							requestId: data.requestId,
							error: error.message
						});
					}
				}
			};
			port.start();
			connected(port);
			port.postMessage({ type: "ready" });
		};
		addEventListener("message", connect);
		hello();
		const timer = setInterval(() => {
			if (!port) hello();
			else clearInterval(timer);
		}, 1e3);
		timer.unref?.();
		setTimeout(() => clearInterval(timer), 15e3).unref?.();
		const request = async (method, params) => {
			if (!port) await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(Error("Reload Ink OS to enable commands")), 5e3))]);
			return new Promise((resolve, reject) => {
				const id = String(++serial), timer = setTimeout(() => {
					pending.delete(id);
					reject(Error("Command request timed out"));
				}, 18e4);
				pending.set(id, {
					resolve,
					reject,
					timer
				});
				port.postMessage({
					type: "request",
					id,
					method,
					params
				});
			});
		};
		const api = {
			workflows: createWorkflows(request),
			...createCommands(request, (query) => request("commands.show", query)),
			register: (actions) => {
				Object.assign(handlers, actions);
				for (const data of inbox.splice(0)) port.onmessage({ data });
			}
		};
		Object.defineProperty(api, "__host", { value: host });
		globalThis[cache] = api;
		return api;
	}
	// work/ink-os-platform/sdk/src/interop-bridge.js
	/** Optional second checked channel lets old app-frame hosts adopt new SDK APIs. */
	function interopBridge({ origin, instance, appId, emit }) {
		let port, serial = 0, appReady = false;
		const pending = /* @__PURE__ */ new Map(), waiters = /* @__PURE__ */ new Set();
		const connected = (event) => {
			const message = event.data;
			if (event.source !== parent || event.origin !== origin || message?.source !== "ink-app-interop-host" || message.version !== 1 || message.instance !== instance || !event.ports[0]) return;
			port?.close();
			port = event.ports[0];
			port.onmessage = ({ data }) => {
				if (data.type === "response") {
					const call = pending.get(data.id);
					if (!call) return;
					pending.delete(data.id);
					clearTimeout(call.timer);
					data.error ? call.reject(Object.assign(Error(data.error), { status: data.status })) : call.resolve(data.result);
				} else if (data.type === "launch") emit("launch", data.data);
			};
			port.start();
			for (const resolve of waiters) resolve(port);
			waiters.clear();
			if (appReady) port.postMessage({ type: "ready" });
		};
		addEventListener("message", connected);
		parent.postMessage({
			source: "ink-app-interop",
			version: 1,
			type: "hello",
			instance,
			appId
		}, origin);
		const wait = (ms) => port ? Promise.resolve(port) : new Promise((resolve) => {
			let timer;
			const done = (value) => {
				clearTimeout(timer);
				waiters.delete(done);
				resolve(value);
			};
			waiters.add(done);
			timer = setTimeout(() => done(null), ms);
		});
		return {
			ready: () => {
				appReady = true;
				port?.postMessage({ type: "ready" });
			},
			request: async (method, params, fallback) => {
				const channel = port || await wait(fallback ? 150 : 2e3);
				if (!channel) {
					if (fallback) return fallback();
					throw Error("Reload Ink to enable app interoperability");
				}
				return new Promise((resolve, reject) => {
					const id = String(++serial), timer = setTimeout(() => {
						pending.delete(id);
						reject(Error("App request timed out"));
					}, 12e4);
					pending.set(id, {
						resolve,
						reject,
						timer
					});
					channel.postMessage({
						type: "request",
						id,
						method,
						params
					});
				});
			}
		};
	}
	// work/ink-os-platform/sdk/src/context-menu.js
	/** App-owned menus travel over the existing, checked SDK channel. */
	function createContextMenus({ send, on, selection = () => String(getSelection() || ""), report = () => {}, defer = (fn) => typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : queueMicrotask(fn) }) {
		let registration, serial = 0, active;
		const show = (event, items) => {
			if (!event || typeof event.preventDefault !== "function") throw TypeError("Pass a contextmenu event");
			if (!Array.isArray(items) || items.length > 40) throw TypeError("Context menu requires up to 40 items");
			const actions = /* @__PURE__ */ new Map(), wire = items.map((item, index) => {
				if (!item || typeof item.label !== "string" || !item.label.trim() || item.label.length > 120 || /[\u0000-\u001f\u007f]/.test(item.label) || typeof item.onSelect !== "function") throw TypeError("Each menu item requires a label and onSelect callback");
				const id = String(index), disabled = item.disabled === true;
				if (!disabled) actions.set(id, item.onSelect);
				return {
					id,
					label: item.label.trim(),
					disabled
				};
			});
			event.preventDefault();
			active = {
				menuId: String(++serial),
				actions,
				target: event.target
			};
			send({
				type: "contextmenu",
				menuId: active.menuId,
				x: event.clientX,
				y: event.clientY,
				items: wire
			});
		};
		const register = (items) => {
			if (!Array.isArray(items) && typeof items !== "function") throw TypeError("Register menu items or a synchronous item resolver");
			const value = { items };
			registration = value;
			return () => {
				if (registration === value) registration = void 0;
			};
		};
		const handle = (event) => {
			if (event.defaultPrevented) return false;
			const target = event.target, editable = !!target?.closest?.("input,textarea,[contenteditable=true]"), selected = selection();
			try {
				const items = registration && (typeof registration.items === "function" ? registration.items({
					event,
					target,
					selection: selected,
					editable
				}) : registration.items);
				if (items !== void 0 && items !== false) {
					show(event, items);
					return true;
				}
			} catch (error) {
				event.preventDefault();
				report(error);
				return true;
			}
			event.preventDefault();
			active = void 0;
			send({
				type: "contextmenu",
				x: event.clientX,
				y: event.clientY,
				selection: selected,
				editable
			});
			return true;
		};
		on("contextmenu.select", (value) => {
			if (!active || value?.menuId !== active.menuId) return;
			const action = active.actions.get(value.id);
			if (!action) return;
			const target = active.target?.closest?.("input,textarea,select,button,a[href],[tabindex],[contenteditable=true]");
			active = void 0;
			target?.focus?.({ preventScroll: true });
			defer(() => {
				try {
					Promise.resolve(action()).catch(report);
				} catch (error) {
					report(error);
				}
			});
		});
		return {
			api: {
				register,
				show
			},
			handle
		};
	}
	// work/ink-os-platform/sdk/src/app-api.js
	var appID = (id) => {
		if (!/^[a-f0-9]{32}$/.test(id || "")) throw Error("Provide a valid app ID");
		return id;
	};
	function routePath(route, input, query = false) {
		const rest = { ...input };
		return {
			path: route.path.replace(/:([a-z][a-z0-9_]*)/g, (_, key) => {
				const value = String(rest[key] ?? "");
				if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw Error("Provide the " + key + " route parameter");
				delete rest[key];
				return encodeURIComponent(value);
			}) + (query && Object.keys(rest).length ? "?" + new URLSearchParams(Object.entries(rest).map(([k, v]) => [k, String(v)])) : ""),
			body: rest
		};
	}
	function createAppCalls({ describe, call, open }) {
		const api = (id) => describe(appID(id));
		const invoke = async (id, path, init = {}) => {
			appID(id);
			const result = await call(id, path, init), body = result && Object.hasOwn(result, "body") ? result.body : result;
			if (result?.status >= 400) throw Object.assign(Error(body?.error || "App API request failed"), { status: result.status });
			return body;
		};
		const named = async (id, name, input, method) => {
			if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Named app messages and reads accept JSON objects");
			const route = (await api(id)).routes.find((route) => route.name === name && route.methods.includes(method));
			if (!route) throw Error("This app does not expose a " + name + " " + (method === "GET" ? "read" : "message") + " handler");
			const request = routePath(route, input, method === "GET");
			return invoke(id, request.path, {
				method,
				...method === "GET" ? {} : { body: request.body }
			});
		};
		return {
			api,
			invoke,
			send: (id, name, data = {}) => named(id, name, data, "POST"),
			read: (id, name, params = {}) => named(id, name, params, "GET"),
			...open ? { open: (id, data, options = {}) => open(appID(id), data, options) } : {}
		};
	}
	// work/ink-os-platform/sdk/src/desktop-keys.js
	var desktop_keys_exports = /* @__PURE__ */ __exportAll({
		DESKTOP_SHORTCUTS: () => DESKTOP_SHORTCUTS,
		desktopCommand: () => desktopCommand
	});
	function desktopCommand(e, editing = false, context = {}) {
		editing = editing || e.target?.isContentEditable === true;
		const key = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
		const control = e.target?.closest?.("button,a[href],[role=button],summary");
		if (!editing && !mod && !e.altKey && !e.shiftKey && key === " " && context.hasObjects && (!control || control.matches?.("[data-object-id]"))) return "selection.preview";
		const selected = context.selection ?? (typeof getSelection === "function" ? String(getSelection() || "") : "");
		if (mod && !editing && ((key === "c" || key === "x") && selected || key === "a" && context.app && !context.hasObjects)) return;
		if (!mod && !e.altKey && (key === "enter" || key === " ") && (e.target?.closest?.("button,a[href],[role=button],summary") || e.composedPath?.().some((node) => node?.matches?.("button,a[href],[role=button],summary")))) return;
		if (key === "escape") return "escape";
		if (key === "f1" || !editing && key === "?") return "help";
		if (e.ctrlKey && e.altKey && /^arrow(left|right)$/.test(key)) return (e.shiftKey ? "moveDesktop" : "desktop") + (key === "arrowleft" ? "Previous" : "Next");
		if (e.ctrlKey && e.altKey && /^[1-9]$/.test(key)) return "desktop:" + key;
		if (e.ctrlKey && key === "arrowup") return "overview";
		if (e.altKey && (key === "tab" || key === "`")) return e.shiftKey ? "previousWindow" : "nextWindow";
		if (e.altKey && key === "f4") return "closeWindow";
		if (e.altKey && key === "d") return "showDesktop";
		if (mod) {
			if (key === "w") return e.shiftKey ? "closeAppWindows" : "closeWindow";
			if (key === "m") return "minimize";
			if (key === "enter") return "expand";
			if (key === ",") return "settings";
			if (key === "k") return "search";
			if (key === "j") return "assistant";
			if (key === "f") return "find";
			if (key === "s") return "save";
			if (key === "n") return e.shiftKey ? "newFolder" : "newWindow";
			if (key === "o") return "open";
			if (key === "r") return "reload";
			if (key === "t" && e.shiftKey) return "reopen";
			if (key === "/") return "help";
			if (!editing) {
				if (key === "a") return "selectAll";
				if (key === "c") return "copy";
				if (key === "x") return "cut";
				if (key === "v") return "paste";
				if (key === "d") return "duplicate";
				if (key === "i") return "info";
				if (key === "z") return e.shiftKey ? "redo" : "undo";
				if (key === "y") return "redo";
				if (key === "backspace" || key === "delete") return "delete";
			}
		}
		if (!editing && !mod && !e.altKey) {
			if (key === "f2") return "rename";
			if (key === "delete" || key === "backspace") return "delete";
			if (key === "enter") return "open";
			if (e.shiftKey && key === "f10") return "contextMenu";
		}
	}
	var DESKTOP_SHORTCUTS;
	var init_desktop_keys = __esmMin((() => {
		DESKTOP_SHORTCUTS = [
			[
				"Files",
				"⌘/Ctrl A",
				"Select all"
			],
			[
				"",
				"⌘/Ctrl C / X / V",
				"Copy / cut / paste"
			],
			[
				"",
				"⌘/Ctrl D",
				"Duplicate selection"
			],
			[
				"",
				"F2",
				"Rename"
			],
			[
				"",
				"Delete or ⌘Backspace",
				"Move to deleted items"
			],
			[
				"",
				"⌘/Ctrl Z / Shift Z",
				"Undo / redo desktop changes"
			],
			[
				"",
				"Enter",
				"Open selection"
			],
			[
				"",
				"Space",
				"Quick preview selection"
			],
			[
				"",
				"Escape",
				"Dismiss preview"
			],
			[
				"",
				"← / →",
				"Browse preview items"
			],
			[
				"",
				"⌘/Ctrl I",
				"Information"
			],
			[
				"",
				"⌘/Ctrl Shift N",
				"New collection"
			],
			[
				"Windows",
				"⌘/Ctrl N",
				"New window"
			],
			[
				"",
				"⌘/Ctrl W / M",
				"Close / minimize"
			],
			[
				"",
				"⌘/Ctrl Shift T",
				"Reopen closed window"
			],
			[
				"",
				"⌘/Ctrl Enter",
				"Maximize / restore"
			],
			[
				"",
				"Alt Tab / Alt `",
				"Cycle windows"
			],
			[
				"",
				"⌘/Ctrl R",
				"Reload app"
			],
			[
				"Desktops",
				"Ctrl Alt ← / →",
				"Previous / next desktop"
			],
			[
				"",
				"Ctrl Alt Shift ← / →",
				"Move window between desktops"
			],
			[
				"",
				"Ctrl Alt 1–9",
				"Jump to a desktop"
			],
			[
				"",
				"Ctrl ↑",
				"Desktop overview"
			],
			[
				"",
				"Alt D",
				"Show desktop"
			],
			[
				"Tools",
				"⌘/Ctrl K / F",
				"Search"
			],
			[
				"",
				"⌘/Ctrl S",
				"Save in the active app"
			],
			[
				"",
				"⌘/Ctrl ,",
				"Settings"
			],
			[
				"",
				"F1 or ⌘/Ctrl /",
				"Keyboard shortcuts"
			]
		];
	}));
	// work/ink-os-platform/sdk/src/live-query.js
	var live_query_exports = /* @__PURE__ */ __exportAll({
		queryInvalidator: () => queryInvalidator,
		watchQuery: () => watchQuery
	});
	function watchQuery({ read, subscribe, onResult, onError = () => {}, signal, delay = 24, relevant = () => true }) {
		let closed = false, dirty = true, running = false, timer, controller, settled = false, resolveReady, rejectReady;
		const ready = new Promise((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		ready.catch(() => {});
		function schedule() {
			if (!closed && !running && timer === void 0) timer = setTimeout(run, delay);
		}
		function invalidate(event) {
			if (closed || event !== void 0 && !relevant(event)) return;
			dirty = true;
			controller?.abort();
			schedule();
		}
		async function run() {
			timer = void 0;
			if (closed || running || !dirty) return;
			dirty = false;
			running = true;
			controller = new AbortController();
			try {
				const result = await read({ signal: controller.signal });
				if (!closed && !dirty) {
					onResult(result);
					if (!settled) {
						settled = true;
						resolveReady(result);
					}
				}
			} catch (error) {
				if (!closed && !dirty && error.name !== "AbortError") {
					onError(error);
					if (!settled) {
						settled = true;
						rejectReady(error);
					}
				}
			} finally {
				running = false;
				controller = void 0;
				if (dirty) schedule();
			}
		}
		const stop = subscribe(invalidate);
		function unsubscribe() {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			controller?.abort();
			stop?.();
			signal?.removeEventListener("abort", unsubscribe);
			if (!settled) {
				settled = true;
				rejectReady(signal?.reason || new DOMException("Subscription closed", "AbortError"));
			}
		}
		signal?.addEventListener("abort", unsubscribe, { once: true });
		if (signal?.aborted) unsubscribe();
		else schedule();
		return Object.freeze({
			ready,
			unsubscribe,
			refresh: () => invalidate()
		});
	}
	function queryInvalidator(query = {}) {
		let ids = /* @__PURE__ */ new Set(), version = -1;
		const matches = (o) => !!o && (!query.namespace || o.namespace === query.namespace) && (!query.kind || o.kind === query.kind);
		return {
			accept(result) {
				ids = new Set(result.objects.map((o) => o.id));
				version = Number(result.version ?? -1);
			},
			relevant(event) {
				if (event.quiet) return false;
				if ([
					"ready",
					"refresh",
					"world.metadata"
				].includes(event.type)) return event.version === void 0 || Number(event.version) > version;
				if (event.object) return ids.has(event.object.id) || matches(event.object);
				if (event.objects || event.removed) return (event.objects || []).some((o) => ids.has(o.id) || matches(o)) || (event.removed || []).length > 0;
				return true;
			}
		};
	}
	var init_live_query = __esmMin((() => {}));
	// work/ink-os-platform/sdk/src/browser.js
	function connect() {
		const keymap = Promise.resolve().then(() => (init_desktop_keys(), desktop_keys_exports));
		return new Promise((resolve, reject) => {
			const origin = new URLSearchParams(location.search).get("desktopOrigin") || "http://127.0.0.1:4318";
			let connected = false;
			const timer = setTimeout(() => {
				removeEventListener("message", hello);
				reject(Error("Desktop connection timed out"));
			}, 15e3);
			function hello(event) {
				if (connected || event.source !== parent || event.origin !== origin || event.data?.source !== "ink-desktop" || event.data?.version !== 1 || event.data?.type !== "connect" || !event.ports[0]) return;
				connected = true;
				clearTimeout(timer);
				removeEventListener("message", hello);
				const port = event.ports[0], pending = /* @__PURE__ */ new Map(), listeners = /* @__PURE__ */ new Map();
				let serial = 0;
				port.onmessage = (e) => {
					const message = e.data;
					if (message.type === "response") {
						const request = pending.get(message.id);
						if (!request) return;
						pending.delete(message.id);
						clearTimeout(request.timer);
						message.error ? request.reject(Object.assign(Error(message.error), {
							status: message.status,
							current: message.current
						})) : request.resolve(message.result);
					} else for (const fn of listeners.get(message.type) || []) fn(message.data, message);
				};
				port.start();
				const request = (method, params = {}) => new Promise((resolve, reject) => {
					const id = String(++serial), timer = setTimeout(() => {
						pending.delete(id);
						reject(Error("Desktop request timed out"));
					}, 18e4);
					pending.set(id, {
						resolve,
						reject,
						timer
					});
					port.postMessage({
						type: "request",
						id,
						method,
						params
					});
				});
				const on = (type, fn) => {
					const set = listeners.get(type) || /* @__PURE__ */ new Set();
					set.add(fn);
					listeners.set(type, set);
					return () => set.delete(fn);
				};
				let selectedObjectIds = [], selectionRoot, selectionItems = [];
				document.addEventListener("ink-selection", (event) => {
					selectedObjectIds = Array.isArray(event.detail?.ids) ? event.detail.ids : [];
				});
				const client = {
					selection: { set: (ids, { root, items = ids } = {}) => {
						selectedObjectIds = [...new Set(ids)];
						selectionRoot = root;
						selectionItems = [...new Set(items)];
					} },
					version: 1,
					instance: event.data.instance,
					route: event.data.route,
					mode: event.data.route?.mode || "open",
					snapshot: event.data.snapshot,
					request,
					on,
					ready: () => port.postMessage({ type: "ready" }),
					focus: () => port.postMessage({ type: "focus" }),
					close: () => request("desktop.close"),
					world: {
						snapshot: () => request("world.snapshot"),
						get: (id) => request("http", {
							path: "/objects/" + id,
							method: "GET"
						}),
						search: (query) => request("http", {
							path: "/search",
							method: "POST",
							body: typeof query === "string" ? { query } : query
						}),
						create: (object) => request("http", {
							path: "/objects",
							method: "POST",
							body: object
						}),
						update: (id, changes, expected) => request("http", {
							path: "/objects/" + id,
							method: "PATCH",
							body: {
								changes,
								expected
							}
						})
					},
					backend: { request: (path, init = {}) => request("backend.request", {
						path,
						...init
					}) },
					desktop: {
						place: (objectId, position) => request("desktop.place", {
							objectId,
							position
						}),
						open: (objectId) => request("desktop.open", { objectId }),
						preview: (objectIds, options = {}) => request("desktop.preview", {
							objectIds: Array.isArray(objectIds) ? objectIds : [objectIds],
							items: options.items
						}),
						launch: (appId, options = {}) => request("desktop.launchApp", {
							appId,
							data: options.data,
							fresh: options.fresh === true
						}),
						toast: (message) => request("desktop.toast", { message }),
						create: (kind, space) => request("desktop.create", {
							kind,
							space
						}),
						environment: () => request("desktop.environment")
					}
				};
				client.ink = {
					describe: () => request("ink.describe"),
					run: (entry, input = "[]", options = {}) => request("ink.run", {
						entry,
						input,
						...options
					}),
					native: {
						status: () => request("ink.native.status"),
						build: () => request("ink.native.build"),
						jobs: () => request("ink.native.jobs"),
						get: (id) => request("ink.native.get", { id })
					}
				};
				let pointerHidden = false, lastPointer = 0;
				on("visibility", (value) => {
					pointerHidden = value.hidden;
				});
				addEventListener("pointermove", (event) => {
					if (pointerHidden || performance.now() - lastPointer < 80) return;
					lastPointer = performance.now();
					port.postMessage({
						type: "pointer-move",
						x: event.clientX,
						y: event.clientY
					});
				}, {
					capture: true,
					passive: true
				});
				client.desktop.activity = (info = {}) => request("desktop.activity", info);
				const interop = interopBridge({
					origin,
					instance: client.instance,
					appId: client.snapshot?.namespace,
					emit: (type, data) => {
						for (const fn of listeners.get(type) || []) fn(data);
					}
				});
				client.commands = commandBridge({
					origin,
					appId: client.snapshot?.namespace
				});
				client.workflows = client.commands.workflows;
				const normalReady = client.ready;
				client.ready = () => {
					normalReady();
					interop.ready();
				};
				client.backend.request = (path, init = {}) => interop.request("backend.request", {
					path,
					...init
				}, () => request("backend.request", {
					path,
					...init
				}));
				client.desktop.launch = (appId, options = {}) => interop.request("apps.open", {
					appId,
					data: options.data,
					fresh: options.fresh === true
				}, options.data === void 0 ? () => request("desktop.launchApp", { appId }) : void 0);
				client.desktop.gestures = (features = {}) => request("desktop.features", { gestures: features });
				addEventListener("pointerup", (e) => port.postMessage({
					type: "pointer-release",
					pointerId: e.pointerId,
					x: e.clientX,
					y: e.clientY,
					at: Date.now()
				}), {
					capture: true,
					passive: true
				});
				let contextTarget, contextSelection;
				const contextMenus = createContextMenus({
					send: (message) => port.postMessage(message),
					on,
					report: (error) => {
						client.desktop.toast(error.message).catch(() => {});
					}
				});
				client.contextMenu = contextMenus.api;
				client.schedules = {
					list: () => request("schedules.list"),
					create: (input) => request("schedules.create", { input }),
					update: (id, input) => request("schedules.update", {
						id,
						input
					}),
					cancel: (id) => request("schedules.cancel", { id }),
					runs: (id) => request("schedules.runs", { id }),
					run: (id) => request("schedules.run", { id })
				};
				addEventListener("contextmenu", (e) => {
					if (contextMenus.handle(e)) {
						contextTarget = e.target;
						const input = contextTarget?.closest?.("input,textarea");
						contextSelection = {
							text: input?.selectionStart !== void 0 ? input.value.slice(input.selectionStart, input.selectionEnd) : String(getSelection() || ""),
							start: input?.selectionStart,
							end: input?.selectionEnd,
							value: input?.value
						};
					}
				});
				on("edit", async (action) => {
					try {
						const node = contextTarget;
						node?.closest?.("input,textarea,select,button,a[href],[tabindex],[contenteditable=true]")?.focus?.({ preventScroll: true });
						await new Promise((resolve) => requestAnimationFrame(resolve));
						if (action === "selectAll") {
							if (node?.select) node.select();
							else {
								const range = document.createRange();
								range.selectNodeContents(document.body);
								getSelection().removeAllRanges();
								getSelection().addRange(range);
							}
							return;
						}
						if (action === "paste") {
							const value = await navigator.clipboard.readText();
							if (node?.setRangeText) {
								node.setRangeText(value, node.selectionStart, node.selectionEnd, "end");
								node.dispatchEvent(new Event("input", { bubbles: true }));
							}
							return;
						}
						if (action === "copy" || action === "cut") {
							const input = node?.closest?.("input,textarea"), selection = contextSelection?.text ?? (input?.selectionStart !== void 0 ? input.value.slice(input.selectionStart, input.selectionEnd) : String(getSelection() || ""));
							await navigator.clipboard.writeText(selection);
							if (action === "cut" && input?.setRangeText && input.value === contextSelection?.value) {
								input.setRangeText("", contextSelection.start, contextSelection.end, "end");
								input.dispatchEvent(new Event("input", { bubbles: true }));
							}
						}
					} catch (error) {
						for (const listener of pendingDropListeners) listener({
							transferId,
							error: error.message
						});
						client.desktop.toast(error.message);
					}
				});
				let documentClient;
				const sharedDocuments = () => documentClient ||= Promise.resolve().then(async () => {
					const modules = client.snapshot?.modules;
					if (!modules?.documents) throw Error("Shared app state is unavailable on this OS version");
					return (await import(modules.documents).catch(() => {
						throw Error("Shared app state could not be loaded");
					})).createDocuments(client, {
						namespace: client.snapshot.namespace || "os",
						workerURL: modules.worker
					});
				});
				client.state = { open: async (key = "state", options) => (await sharedDocuments()).state.open(key, options) };
				client.text = { open: async (key, options) => (await sharedDocuments()).text.open(key, options) };
				let acceptedDrops = [], dropListeners = /* @__PURE__ */ new Set(), pendingDropListeners = /* @__PURE__ */ new Set();
				const fileURL = (id) => origin + "/api/v1/files/" + encodeURIComponent(id) + "/content?access=" + encodeURIComponent(client.snapshot?.assetsToken || "");
				const supports = (file) => {
					const name = String(file.name || file.source || ""), mime = String(file.type || file.mime || "").toLowerCase(), extension = name.match(/\.[a-z0-9][a-z0-9.+_-]{0,20}$/i)?.[0].toLowerCase();
					return acceptedDrops.some((type) => type === "*" || type === (file.kind || "file") || type === extension || type === mime || type.endsWith("/*") && mime.startsWith(type.slice(0, -1)));
				};
				const uploadFiles = async (files) => {
					const input = await Promise.all([...files].map((file) => new Promise((resolve, reject) => {
						if (file.size > 25165824) return reject(Error("Keep each file below 24 MiB"));
						const reader = new FileReader();
						reader.onload = () => resolve({
							name: file.name,
							mime: file.type,
							base64: String(reader.result).split(",")[1]
						});
						reader.onerror = () => reject(Error("Could not read " + file.name));
						reader.readAsDataURL(file);
					})));
					return request("files.upload", { files: input });
				};
				client.files = {
					icon: fileIconSVG,
					draggable: (node, objects) => bindObjectDrag(node, {
						objects: typeof objects === "function" ? objects : () => objects,
						begin: (start) => request("desktop.drag", start),
						error: (error) => client.desktop.toast(error.message)
					}),
					readText: (id) => request("files.readText", { id }),
					saveText: (id, text, expected) => request("files.saveText", {
						id,
						text,
						expected
					}),
					createText: (name, text) => request("files.createText", {
						name,
						text
					}),
					url: fileURL,
					download: (id) => {
						const link = document.createElement("a");
						link.href = fileURL(id) + "&download=1";
						link.target = "_blank";
						link.rel = "noopener";
						document.body.append(link);
						link.click();
						link.remove();
					},
					pick: (options) => request("files.pick", options || {}),
					upload: uploadFiles,
					acceptDrops: (types, listener, options = {}) => {
						dropListeners.add(listener);
						if (options.onPending) pendingDropListeners.add(options.onPending);
						return {
							ready: request("files.acceptDrops", { types }).then((result) => {
								acceptedDrops = result;
								return result;
							}),
							unsubscribe: () => {
								dropListeners.delete(listener);
								if (options.onPending) pendingDropListeners.delete(options.onPending);
								if (!dropListeners.size) {
									acceptedDrops = [];
									request("files.acceptDrops", { types: [] });
								}
							}
						};
					}
				};
				on("files.dropped", (files, message) => {
					for (const listener of dropListeners) listener(files, { transferId: message?.transferId });
				});
				on("files.pending", (value) => {
					for (const listener of pendingDropListeners) listener(value);
				});
				const dragState = (active, accepted = false, files = []) => port.postMessage({
					type: "file-drag",
					active,
					accepted,
					files
				});
				const previewSupport = (file) => {
					if (!acceptedDrops.length) return false;
					if (file.name) return supports(file);
					if (!file.mime || file.mime === "application/octet-stream") return true;
					return supports(file) || acceptedDrops.some((type) => type.startsWith("."));
				};
				addEventListener("dragover", (event) => {
					const transfer = event.dataTransfer;
					if (!transfer || ![...transfer.types].some((type) => ["Files", "application/x-ink-object"].includes(type))) return;
					event.preventDefault();
					const files = transfer.files.length ? [...transfer.files].map((file) => ({
						name: file.name,
						mime: file.type
					})) : [...transfer.items].filter((item) => item.kind === "file").map((item) => ({
						name: item.getAsFile()?.name || "",
						mime: item.type
					})), accepted = acceptedDrops.length > 0 && files.length <= 12 && files.every(previewSupport);
					transfer.dropEffect = accepted ? "copy" : "none";
					dragState(true, accepted, files);
				});
				addEventListener("dragleave", (event) => {
					if (!event.relatedTarget) dragState(false);
				});
				addEventListener("drop", async (event) => {
					const transfer = event.dataTransfer;
					if (!transfer) return;
					const id = transfer.getData("application/x-ink-object");
					if (!id && !transfer.files.length) return;
					event.preventDefault();
					dragState(false);
					const transferId = crypto.randomUUID();
					try {
						if (!acceptedDrops.length) throw Error("This app does not accept files");
						if (id) await request("files.drop", { ids: [id] });
						else {
							if (![...transfer.files].every(supports)) throw Error("This app does not accept these file types");
							for (const listener of pendingDropListeners) listener({
								transferId,
								files: [...transfer.files]
							});
							const files = await uploadFiles(transfer.files);
							for (const listener of dropListeners) listener(files, { transferId });
						}
					} catch (error) {
						for (const listener of pendingDropListeners) listener({
							transferId,
							error: error.message
						});
						client.desktop.toast(error.message);
					}
				});
				client.media = { playing: (playing) => request("media.playing", { playing: playing === true }) };
				client.calls = { open: async (options = {}) => {
					const initial = await request("call.open", { room: options.room || "space" }), listeners = /* @__PURE__ */ new Set();
					let self = initial.self, participants = initial.participants, closed = false;
					const emit = (data) => {
						if (data.self) self = data.self;
						if (data.participants) participants = data.participants;
						for (const fn of listeners) fn(data);
					};
					const off = on("call", emit), run = async (action, params = {}) => {
						if (closed) throw Error("Call channel closed");
						const value = await request("call." + action, params);
						if (value?.self) self = value.self;
						if (value?.participants) participants = value.participants;
						return value;
					};
					return {
						get self() {
							return self;
						},
						get participants() {
							return participants;
						},
						iceServers: initial.iceServers,
						on: (fn) => {
							listeners.add(fn);
							return () => listeners.delete(fn);
						},
						join: () => run("join"),
						ready: (media) => run("ready", media),
						send: (to, toEpoch, payload) => run("signal", {
							to,
							toEpoch,
							epoch: self.epoch,
							payload
						}),
						leave: () => run("leave"),
						close: async () => {
							if (closed) return;
							closed = true;
							off();
							listeners.clear();
							return request("call.close");
						}
					};
				} };
				client.env = {
					list: () => request("env.list"),
					set: (values) => request("env.set", { values }),
					unset: (name) => request("env.unset", { name })
				};
				client.world.flush = (id) => request("world.flush", { id });
				client.world.query = (query = {}) => request("world.query", { query });
				client.world.watch = (query, onResult, options = {}) => {
					let subscription, closed = false;
					const controller = new AbortController(), stopExternal = () => controller.abort(options.signal?.reason);
					options.signal?.addEventListener("abort", stopExternal, { once: true });
					if (options.signal?.aborted) stopExternal();
					const ready = Promise.resolve().then(() => (init_live_query(), live_query_exports)).then(({ watchQuery, queryInvalidator }) => {
						if (closed) throw new DOMException("Subscription closed", "AbortError");
						const filter = queryInvalidator(query);
						subscription = watchQuery({
							signal: controller.signal,
							read: () => client.world.query(query),
							subscribe: (invalidate) => {
								const stops = [on("world.delta", invalidate), on("world.metadata", (data) => invalidate({
									type: "world.metadata",
									version: data.version ?? data.stats?.version
								}))];
								return () => stops.forEach((stop) => stop());
							},
							relevant: filter.relevant,
							onResult: (result) => {
								filter.accept(result);
								onResult(result);
							},
							onError: options.onError
						});
						return subscription.ready;
					});
					ready.catch(() => {});
					return {
						ready,
						refresh: () => subscription?.refresh(),
						unsubscribe: () => {
							closed = true;
							options.signal?.removeEventListener("abort", stopExternal);
							controller.abort();
							subscription?.unsubscribe();
						}
					};
				};
				client.apps = {
					list: () => client.world.query({
						kind: "app",
						namespace: "os",
						limit: 1e3
					}),
					watch: (onResult, options) => client.world.watch({
						kind: "app",
						namespace: "os",
						limit: 1e3
					}, onResult, options)
				};
				Object.assign(client.apps, createAppCalls({
					describe: (appId) => interop.request("apps.api", { appId }),
					call: (appId, path, init) => interop.request("apps.invoke", {
						appId,
						path,
						method: init.method,
						body: init.body
					}),
					open: (appId, data, options) => client.desktop.launch(appId, {
						...options,
						data
					})
				}));
				addEventListener("pointerdown", () => port.postMessage({
					type: "focus",
					intent: "pointer"
				}), {
					capture: true,
					passive: true
				});
				keymap.then(({ desktopCommand }) => addEventListener("keydown", (e) => {
					if (e.defaultPrevented) return;
					const editing = !!e.target.closest?.("input,textarea,select,[contenteditable=true]"), command = desktopCommand(e, editing, {
						app: true,
						hasObjects: (!selectionRoot || selectionRoot.contains(e.target)) && (selectedObjectIds.length > 0 || !!document.querySelector?.("[data-object-id].selected"))
					});
					if (client.mode === "preview" && !editing && !e.target.closest?.("button,a[href],[role=button],summary,audio,video,[role=slider]") && !e.metaKey && !e.ctrlKey && !e.altKey) {
						if (e.key === " ") {
							if (e.repeat) return;
							e.preventDefault();
							port.postMessage({
								type: "shortcut",
								key: "preview.dismiss"
							});
							return;
						}
						if (e.key === "Escape" || /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
							e.preventDefault();
							port.postMessage({
								type: "shortcut",
								key: e.key === "Escape" ? "preview.dismiss" : "preview." + e.key,
								extend: e.shiftKey
							});
							return;
						}
					}
					if (!command) return;
					if (command === "selection.preview" && e.repeat) {
						e.preventDefault();
						return;
					}
					if (document.querySelector("dialog[open],[role=dialog][aria-modal=true]")) return;
					if (command === "find" && !document.querySelector("input[type=search]")) return;
					e.preventDefault();
					const selected = selectedObjectIds.length ? selectedObjectIds : [...document.querySelectorAll("[data-object-id].selected")].map((n) => n.dataset.objectId);
					port.postMessage({
						type: "shortcut",
						key: command,
						objectIds: selected,
						items: selectionItems
					});
				}));
				resolve(client);
			}
			addEventListener("message", hello);
			parent.postMessage({
				source: "ink-app",
				version: 1,
				type: "hello"
			}, origin);
		});
	}
	// work/sdk-global-entry.mjs
	window.Ink = Object.freeze({
		connect,
		version: 1
	});
})();
