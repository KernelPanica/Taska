document.addEventListener("DOMContentLoaded", () => {
  const root = document.documentElement;
  const prefs = {...(window.TASKA_SERVER_PREFS || {}), ...JSON.parse(localStorage.getItem("taska-ui") || "{}")};
  const savePreferences = (next) => {
    Object.assign(prefs, next);
    localStorage.setItem("taska-ui", JSON.stringify(prefs));
    fetch("/account/interface", {method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:`preferences=${encodeURIComponent(JSON.stringify(prefs))}`, credentials:"same-origin"}).catch(() => {});
  };
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
    select.value = prefs.theme || currentTheme;
    select.addEventListener("change", () => {
      document.documentElement.dataset.theme = select.value;
      localStorage.setItem("taska-theme", select.value);
      savePreferences({theme: select.value});
    });
  }

  const overlay = document.querySelector("[data-command-overlay]");
  const commandInput = document.querySelector("[data-command-input]");
  const openCommand = () => { if (!overlay) return; overlay.hidden = false; commandInput?.focus(); commandInput?.select(); };
  const closeCommand = () => { if (overlay) overlay.hidden = true; };
  document.querySelector("[data-command-open]")?.addEventListener("click", openCommand);
  overlay?.addEventListener("click", (event) => { if (event.target === overlay) closeCommand(); });
  commandInput?.addEventListener("input", () => {
    const query = commandInput.value.trim().toLowerCase();
    document.querySelectorAll("[data-command-results] a").forEach((item) => { item.hidden = query && !item.textContent.toLowerCase().includes(query); });
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openCommand(); }
    if (event.key === "Escape") closeCommand();
  });
  document.querySelectorAll("form:not([data-no-loading])").forEach((form) => form.addEventListener("submit", () => {
    const button = form.querySelector("button[type='submit']");
    if (button && !button.disabled) { button.disabled = true; button.dataset.originalText = button.textContent; button.textContent = "Сохранение…"; }
  }));

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
