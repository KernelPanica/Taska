document.addEventListener("DOMContentLoaded", () => {
  const dropdowns = document.querySelectorAll("[data-dropdown]");
  const closeDropdowns = (except = null) => {
    dropdowns.forEach((dropdown) => {
      if (dropdown === except) return;
      dropdown.querySelector("[data-dropdown-panel]").hidden = true;
      dropdown.querySelector("[data-dropdown-toggle]").setAttribute("aria-expanded", "false");
    });
  };
  dropdowns.forEach((dropdown) => {
    const toggle = dropdown.querySelector("[data-dropdown-toggle]");
    const panel = dropdown.querySelector("[data-dropdown-panel]");
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = panel.hidden;
      closeDropdowns(dropdown);
      panel.hidden = !willOpen;
      toggle.setAttribute("aria-expanded", String(willOpen));
    });
  });
  document.addEventListener("click", () => closeDropdowns());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDropdowns();
  });

  const select = document.querySelector("[data-theme-select]");
  const currentTheme = localStorage.getItem("taska-theme") || "dark";
  if (select) {
    select.value = currentTheme;
    select.addEventListener("change", () => {
      document.documentElement.dataset.theme = select.value;
      localStorage.setItem("taska-theme", select.value);
    });
  }

  const badge = document.querySelector("[data-notification-count]");
  if (badge) {
    fetch("/notifications/unread-count", { credentials: "same-origin" })
      .then((response) => response.json())
      .then(({ count }) => {
        if (count > 0) {
          badge.textContent = count > 99 ? "99+" : String(count);
          badge.hidden = false;
        }
      })
      .catch(() => {});
  }
});
