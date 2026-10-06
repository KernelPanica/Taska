(() => {
  const board = document.querySelector('.board');
  if (!board) return;
  const interactive = 'a,button,input,select,textarea,summary,form,details';
  let dragged = null, blocked = false, busy = false, suppressClick = false;
  board.addEventListener('pointerdown', e => { suppressClick = false; blocked = !!e.target.closest(interactive); });
  board.addEventListener('click', e => {
    if ((suppressClick && e.detail !== 0) || busy) { e.preventDefault(); return; }
    const card = e.target.closest('.issue-card');
    if (card && !e.target.closest(interactive) && !window.getSelection().toString()) location.assign(card.dataset.url);
  });
  board.addEventListener('dragstart', e => {
    const card = e.target.closest('.issue-card');
    if (blocked || busy || !card || card.draggable !== true) { e.preventDefault(); return; }
    suppressClick = true;
    dragged = card;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.issue);
    card.classList.add('dragging');
  });
  board.addEventListener('dragend', () => {
    dragged?.classList.remove('dragging');
    dragged = null;
    board.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  });
  board.addEventListener('dragover', e => {
    const column = e.target.closest('.board-column');
    if (!dragged || !column || busy) return;
    e.preventDefault();
    board.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    column.classList.add('drop-target');
  });
  board.addEventListener('drop', async e => {
    const column = e.target.closest('.board-column'), card = dragged;
    if (!card || !column || busy) return;
    e.preventDefault();
    const source = card.closest('.board-column');
    if (board.dataset.manager !== 'yes' && column.dataset.review === 'yes' && source !== column) {
      document.getElementById('board-feedback').textContent = board.dataset.reviewMessage; return;
    }
    const data = new FormData(card.querySelector('form'));
    data.set('status', column.dataset.status);
    const before = e.target.closest('.issue-card');
    if (before && before !== card) data.set('before', before.dataset.issue);
    if (before === card) return;
    busy = true;
    board.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(board.dataset.action, {method: 'POST', body: data, headers: {Accept: 'application/json'}});
      if (response.redirected) { location.assign(response.url); return; }
      if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error(board.dataset.error);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || board.dataset.error);
      // Fetch server-rendered state with the same session and current filters.
      // This refreshes permissions and versions without navigating the document.
      const current = await fetch(location.href, {headers: {Accept: 'text/html'}});
      if (current.redirected) { location.assign(current.url); return; }
      if (!current.ok) throw new Error(board.dataset.error);
      const updated = new DOMParser().parseFromString(await current.text(), 'text/html').querySelector('.board');
      if (!updated) throw new Error(board.dataset.error);
      const scroll = new Map([...board.querySelectorAll('.board-column')].map(el => [el.dataset.status, el.querySelector('.column-content').scrollTop]));
      board.innerHTML = updated.innerHTML;
      board.dataset.version = updated.dataset.version;
      board.dataset.manager = updated.dataset.manager;
      board.querySelectorAll('.board-column').forEach(el => { el.querySelector('.column-content').scrollTop = scroll.get(el.dataset.status) || 0; });
      document.getElementById('board-feedback').textContent = '';
      busy = false;
      board.removeAttribute('aria-busy');
    } catch (error) {
      document.getElementById('board-feedback').textContent = error.message || board.dataset.error;
      busy = false;
      board.removeAttribute('aria-busy');
    }
  });
})();
