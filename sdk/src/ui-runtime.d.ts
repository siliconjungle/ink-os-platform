export type UiKind =
  | 'Column'
  | 'Row'
  | 'Panel'
  | 'Heading'
  | 'Text'
  | 'Button'
  | 'Field'
  | 'Toggle'
  | 'Select'
  | 'List'
  | 'Item'
  | 'Table'
  | 'TableHead'
  | 'TableBody'
  | 'TableRow'
  | 'HeaderCell'
  | 'Cell'
  | 'Form'
  | 'Navigation'
  | 'NavItem'
  | 'Component';
export type UiEventKind = 'Activate' | 'Input' | 'Change' | 'Submit';
export interface UiProps {
  text: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  description: string;
  selected: boolean;
  invalid: boolean;
  placeholder: string;
  fieldKind: 'Text' | 'Number' | 'Email' | 'Url' | 'Date' | 'Multiline';
  options: Array<{ value: string; label: string; disabled: boolean }>;
  valueToken: string;
}
export interface UiNode {
  id: string;
  kind: UiKind;
  props: UiProps;
  events: Array<{ kind: UiEventKind; token: string }>;
  children: string[];
}
export interface UiTree {
  format: 'ink-ui-v1';
  root: string;
  nodes: UiNode[];
}
export type UiOperation =
  | { op: 'mount'; node: UiNode }
  | { op: 'update'; id: string; props: UiProps; events: UiNode['events'] }
  | { op: 'children'; id: string; children: string[] }
  | { op: 'dispose'; id: string };
export interface UiPatch {
  format: 'ink-ui-v1';
  root: string;
  operations: UiOperation[];
}
export interface UiFrame {
  format: 'ink-ui-v1';
  id: string;
  releaseId: string | null;
  revision: number;
  baseRevision: number;
  expiresAt: number;
  target: 'dom';
  computed: string[];
  tree?: UiTree;
  patch?: UiPatch;
  event?: {
    sequence: number;
    status: 'accepted' | 'rejected' | 'unknown';
    error?: string;
    viewError?: string;
    fields?: Record<string, { token: string }>;
  };
}
export interface UiInput {
  text: string;
  checked: boolean;
  expected: string;
  fields: Array<{
    id: string;
    text: string;
    checked: boolean;
    expected: string;
  }>;
}
export interface UiEvent {
  sequence: number;
  revision: number;
  node: string;
  kind: UiEventKind;
  token: string;
  input: UiInput;
}
export interface UiTransport {
  open(options?: { target?: 'dom'; releaseId?: string }): Promise<UiFrame>;
  refresh(id: string, input: { revision: number }): Promise<UiFrame>;
  event(id: string, input: UiEvent): Promise<UiFrame>;
  dispose(id: string): Promise<unknown>;
}
export interface UiAdapter {
  capabilities: {
    format: 'ink-ui-v1';
    target?: string;
    kinds: readonly UiKind[];
    layout: 'flow-v1';
    input: 'controls-v1';
    accessibility: 'semantic-v1';
    lifecycle: 'explicit-v1';
  };
  mount(node: UiNode): void;
  update(id: string, props: UiProps, events: UiNode['events']): void;
  children(id: string, children: string[]): void;
  root(id: string): void;
  dispose(id: string): void;
}
export interface UiModel {
  readonly tree: Readonly<UiTree> | null;
  readonly revision: number;
  apply(frame: UiFrame): UiPatch;
  rebase(frame: UiFrame): UiPatch;
  dispose(): void;
}
export const UI_FORMAT: 'ink-ui-v1';
export const UI_KINDS: readonly UiKind[];
export function validateUiTree(tree: UiTree): Map<string, UiNode>;
export function diffUiTree(previous: UiTree | null, next: UiTree): UiPatch;
export function createUiModel(adapter: UiAdapter): UiModel;
export function createInkUi(
  request: (
    action: 'open' | 'refresh' | 'event' | 'dispose',
    input: unknown,
  ) => Promise<unknown>,
): UiTransport;
export interface DraftVersion {
  id: string;
  generation: number;
  expected: string;
}
export interface UiLocalEvent {
  node: string;
  kind: UiEventKind;
  token: string;
  input: UiInput;
  versions: DraftVersion[];
}
export interface DomUi extends UiModel {
  acknowledge(
    versions: DraftVersion[],
    fields?: Record<string, { token: string }>,
  ): void;
  setBusy(value: boolean): void;
  rebaseExpected(id: string, expected: string): string;
}
export interface UiLifecycle {
  type: 'mount' | 'dispose';
  id: string;
  kind: UiKind;
}
export function createDomUi(
  element: HTMLElement,
  options?: {
    onEvent?: (event: UiLocalEvent) => void;
    onDraftConflict?: (id: string) => void;
    onLifecycle?: (event: UiLifecycle) => void;
  },
): DomUi;
export function mountInkUi(options: {
  element: HTMLElement;
  transport: UiTransport;
  subscribe?: (invalidate: () => void) => () => void;
  onError?: (error: Error) => void;
  onStatus?: (status: {
    pending: boolean;
    retry?: () => Promise<void>;
    reopen?: () => Promise<void>;
  }) => void;
  onLifecycle?: (event: UiLifecycle) => void;
  onTrace?: (event: { name: string; start: number; end: number; detail: Record<string, unknown> }) => void;
}): Promise<{
  readonly renderer: DomUi;
  readonly pending: boolean;
  refresh(): Promise<void>;
  retry(): Promise<void>;
  reopen(): Promise<void>;
  suspend(hidden: boolean): void;
  dispose(): void;
}>;
