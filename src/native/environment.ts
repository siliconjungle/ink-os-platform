import { api } from '../api';
import { el, text } from './dom';
import { modal, field } from './dialogs';
import type { WorldObject } from '../types';
import './environment.css';

type Metadata = { name: string; createdAt: string; updatedAt: string };
type Result = { variables: Metadata[]; configured: boolean; activation: string };
export function environmentDialog(app: WorldObject) {
  const path = '/v1/apps/' + app.id + '/env';
  const name = el('input', { 'aria-label': 'Variable name', placeholder: 'API_KEY', autocomplete: 'off', spellcheck: false, maxlength: 128 });
  const value = el('input', { type: 'password', 'aria-label': 'Variable value', placeholder: 'Enter a value', autocomplete: 'new-password' });
  const status = el('p', { class: 'environment-status', role: 'status' });
  const error = el('p', { class: 'inline-error', role: 'alert', hidden: true });
  const list = el('div', { class: 'environment-list', 'aria-label': 'Saved variables' });
  const file = el('input', { type: 'file', hidden: true, 'aria-label': 'Import .env file' });
  const form = el('form', { class: 'environment-form' }, field('Name', name), field('Value', value));
  const save = el('button', { type: 'submit', class: 'button primary' }, 'Save variable');
  const importFile = el('button', { type: 'button', class: 'button', onclick: () => file.click() }, 'Import .env');
  form.append(el('div', { class: 'modal-actions' }, importFile, save));
  const body = el('div', { class: 'create-dialog environment-dialog' }, el('p', { class: 'environment-description' }, 'Private values for ' + (app.title || 'this app') + '. Available to its server code on the next app start or deployment.'), list, form, file, status, error);
  const dialog = modal('Environment variables', body);
  let closed = false, busy = false, configured = false;
  save.disabled = importFile.disabled = true;
  dialog.node.addEventListener('closed', () => { closed = true; value.value = ''; });
  function paint(result: Result) {
    if (closed) return;
    list.replaceChildren();
    if (!result.variables.length) list.append(el('p', { class: 'environment-empty' }, 'No variables yet'));
    for (const variable of result.variables) {
      const update = el('button', { type: 'button', class: 'text-button', onclick: () => { name.value = variable.name; value.value = ''; value.focus(); } }, 'Replace');
      const remove = el('button', { type: 'button', class: 'text-button', 'aria-label': 'Remove ' + variable.name, onclick: () => void mutate(path + '/' + encodeURIComponent(variable.name), 'DELETE') }, 'Remove');
      list.append(el('div', { class: 'environment-row' }, el('code', {}, variable.name), el('small', {}, 'Value saved'), update, remove));
    }
    configured = result.configured;
    save.disabled = importFile.disabled = !configured;
    if (!result.configured) text(status, 'Environment storage is not configured on this server.');
  }
  async function mutate(endpoint: string, method: string, input?: unknown) {
    if (busy || closed) return;
    busy = true; error.hidden = true; text(status, 'Saving…');
    for (const button of body.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true;
    try {
      const result = await api<Result>(endpoint, { method, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (closed) return;
      name.value = ''; paint(result); text(status, 'Saved. Used on the next app start or deployment.');
    } catch (reason) { if (!closed) { error.hidden = false; text(error, (reason as Error).message); text(status, ''); } }
    finally { value.value = ''; busy = false; if (!closed) for (const button of body.querySelectorAll<HTMLButtonElement>('button')) button.disabled = !configured; }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void mutate(path, 'PUT', { values: { [name.value.trim()]: value.value } }); });
  file.addEventListener('change', () => { const selected = file.files?.[0]; file.value = ''; if (!selected) return; if (selected.size > 256 * 1024) { error.hidden = false; text(error, 'Use an .env file under 256 KiB.'); return; } void selected.text().then(dotenv => mutate(path, 'PUT', { dotenv })).catch(() => { error.hidden = false; text(error, 'Could not read the .env file.'); }); });
  text(status, 'Loading…');
  void api<Result>(path).then(result => { text(status, ''); paint(result); }).catch(reason => { if (!closed) { error.hidden = false; text(error, reason.message); text(status, ''); } });
  return dialog;
}
