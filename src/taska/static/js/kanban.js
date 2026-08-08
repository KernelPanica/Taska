document.addEventListener("DOMContentLoaded", () => {
  let dragged = null;
  document.querySelectorAll(".kanban-card").forEach((card) => {
    card.addEventListener("dragstart", () => { dragged = card; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => { card.classList.remove("dragging"); dragged = null; });
  });
  document.querySelectorAll(".kanban-column").forEach((column) => {
    column.addEventListener("dragover", (event) => { if (dragged) { event.preventDefault(); column.classList.add("drag-over"); } });
    column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
    column.addEventListener("drop", () => {
      column.classList.remove("drag-over");
      if (!dragged) return;
      const select = dragged.querySelector("select[name='status']");
      if (select && select.value !== column.dataset.status) {
        select.value = column.dataset.status;
        select.form.submit();
      }
    });
  });
});
