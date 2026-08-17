document.addEventListener("DOMContentLoaded", () => {
  const createForm = document.querySelector("#create-sprint");
  document.querySelector("[data-toggle-create]")?.addEventListener("click", () => {
    createForm.hidden = !createForm.hidden;
    if (!createForm.hidden) createForm.querySelector("input")?.focus();
  });

  let draggedTask = null;
  document.querySelectorAll(".sp-task[draggable='true']").forEach((task) => {
    task.addEventListener("dragstart", () => { draggedTask = task; task.classList.add("is-dragging"); });
    task.addEventListener("dragend", () => { task.classList.remove("is-dragging"); draggedTask = null; });
  });
  document.querySelectorAll("[data-sprint-zone]").forEach((zone) => {
    zone.addEventListener("dragover", (event) => { if (draggedTask) { event.preventDefault(); zone.classList.add("is-drop-target"); } });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-drop-target"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault(); zone.classList.remove("is-drop-target");
      if (!draggedTask) return;
      const source = draggedTask.querySelector("form");
      const form = document.createElement("form");
      form.method = "post"; form.action = source.action;
      const fields = { sprint_id: zone.dataset.sprintZone, story_points: source.elements.story_points.value, priority: source.elements.priority.value };
      Object.entries(fields).forEach(([name, value]) => { const input = document.createElement("input"); input.type = "hidden"; input.name = name; input.value = value; form.append(input); });
      document.body.append(form); form.submit();
    });
  });
});
