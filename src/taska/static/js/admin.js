document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-copy-value]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copyValue);
        const previous = button.textContent;
        button.textContent = "✓";
        window.setTimeout(() => { button.textContent = previous; }, 1200);
      } catch (_) {
        window.prompt("Скопируйте ссылку", button.dataset.copyValue);
      }
    });
  });
});
