const form = document.querySelector('[data-track-changes]');
if (form) {
  let changed = form.dataset.unsaved === 'true';
  document.addEventListener('input', event => { if (event.target.form === form) changed = true; });
  form.addEventListener('change', () => { changed = true; });
  form.addEventListener('submit', () => { changed = false; });
  window.addEventListener('beforeunload', (event) => {
    if (changed) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

const description = document.querySelector('#id_description');
const toolbar = document.querySelector('#markdown-tools');
if (description && toolbar) {
  const tools = toolbar.content.cloneNode(true);
  description.before(tools);
  const group = description.previousElementSibling;
  group.addEventListener('mousedown', event => event.preventDefault());
  group.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    let start = description.selectionStart, end = description.selectionEnd;
    let selected = description.value.slice(start, end), replacement;
    if (button.dataset.prefix !== undefined) {
      start = description.value.lastIndexOf('\n', start - 1) + 1;
      selected = description.value.slice(start, end);
      replacement = selected.split('\n').map(line => button.dataset.prefix + line).join('\n');
    } else if (button.hasAttribute('data-link')) {
      replacement = '[' + selected + '](https://)';
    } else {
      replacement = button.dataset.wrap + selected + button.dataset.wrap;
    }
    description.setRangeText(replacement, start, end, 'select');
    if (button.dataset.wrap !== undefined) {
      description.setSelectionRange(start + button.dataset.wrap.length, start + button.dataset.wrap.length + selected.length);
    } else if (button.hasAttribute('data-link')) {
      description.setSelectionRange(start + selected.length + 3, start + selected.length + 11);
    }
    description.focus();
    description.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
const tags = document.querySelector('#id_tag_names');
const savedTags = document.querySelector('#saved-tags');
if (tags && savedTags) {
  tags.after(savedTags.content.cloneNode(true));
  const choices = tags.nextElementSibling;
  const refresh = () => {
    const selected = tags.value.split(',').map(value => value.trim());
    choices.querySelectorAll('[data-tag]').forEach(button => { button.hidden = selected.includes(button.dataset.tag); });
  };
  choices.addEventListener('click', event => {
    const button = event.target.closest('[data-tag]');
    if (!button) return;
    const values = tags.value.split(',').map(value => value.trim()).filter(Boolean);
    if (!values.includes(button.dataset.tag)) values.push(button.dataset.tag);
    tags.value = values.join(', ');
    tags.dispatchEvent(new Event('input', {bubbles: true}));
    tags.focus();
  });
  tags.addEventListener('input', refresh);
  refresh();
}
const editor = document.querySelector('.inline-editor');
editor?.addEventListener('toggle', () => {
  if (editor.open) document.querySelector('.task-title-input input')?.focus();
});
