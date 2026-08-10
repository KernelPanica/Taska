document.addEventListener("DOMContentLoaded", () => {
  let dragged = null;
  let suppressClick = false;
  const board = document.querySelector(".kanban-board");
  let autoScrollFrame = null;
  let autoScrollSpeed = 0;

  const stopAutoScroll = () => {
    if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = null;
    autoScrollSpeed = 0;
  };

  const runAutoScroll = () => {
    if (!board || !autoScrollSpeed) { stopAutoScroll(); return; }
    board.scrollLeft += autoScrollSpeed;
    autoScrollFrame = requestAnimationFrame(runAutoScroll);
  };

  const setAutoScroll = (clientX) => {
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const edge = Math.min(120, rect.width * 0.18);
    let speed = 0;
    if (clientX < rect.left + edge) speed = -Math.ceil((rect.left + edge - clientX) / 5);
    if (clientX > rect.right - edge) speed = Math.ceil((clientX - (rect.right - edge)) / 5);
    speed = Math.max(-22, Math.min(22, speed));
    if (speed === autoScrollSpeed) return;
    stopAutoScroll();
    autoScrollSpeed = speed;
    if (speed) autoScrollFrame = requestAnimationFrame(runAutoScroll);
  };

  const updateCount = (column, delta) => {
    const count = column.querySelector(".kanban-count");
    if (count) count.textContent = String(Math.max(0, Number(count.textContent) + delta));
  };

  document.querySelectorAll(".kanban-card").forEach((card) => {
    const handle = card.querySelector(".kanban-drag-handle");
    const form = card.querySelector(".kanban-status-select");
    handle?.addEventListener("dragstart", (event) => {
      dragged = card;
      suppressClick = true;
      card.setAttribute("aria-grabbed", "true");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", card.dataset.taskId || "");
      card.classList.add("dragging");
    });
    handle?.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      card.removeAttribute("aria-grabbed");
      dragged = null;
      stopAutoScroll();
      window.setTimeout(() => { suppressClick = false; }, 120);
    });
    card.addEventListener("click", (event) => {
      if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      data.set("ajax", "1");
      const response = await fetch(form.action, { method: "POST", body: data, headers: { "Accept": "application/json" } });
      if (!response.ok) { window.location.reload(); return; }
      const target = document.querySelector(`.kanban-column[data-status="${CSS.escape(data.get("status"))}"]`);
      const source = card.closest(".kanban-column");
      if (target && source && target !== source) {
        target.querySelector(".kanban-cards").append(card);
        updateCount(source, -1); updateCount(target, 1);
      }
    });
  });

  document.querySelectorAll(".kanban-column").forEach((column) => {
    column.addEventListener("dragover", (event) => {
      if (dragged) { event.preventDefault(); column.classList.add("drag-over"); setAutoScroll(event.clientX); }
    });
    column.addEventListener("dragleave", (event) => { if (!column.contains(event.relatedTarget)) column.classList.remove("drag-over"); });
    column.addEventListener("drop", (event) => {
      event.preventDefault(); column.classList.remove("drag-over");
      if (!dragged) return;
      const select = dragged.querySelector("select[name='status']");
      if (select && select.value !== column.dataset.status) {
        select.value = column.dataset.status;
        select.form.requestSubmit();
      }
    });
  });

  board?.addEventListener("dragover", (event) => {
    if (!dragged) return;
    event.preventDefault();
    setAutoScroll(event.clientX);
  });
  board?.addEventListener("dragleave", (event) => {
    if (!board.contains(event.relatedTarget)) stopAutoScroll();
  });

});
