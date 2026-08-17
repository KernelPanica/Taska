document.addEventListener("DOMContentLoaded", () => {
  const panel = document.querySelector("[data-interface-settings]");
  if (!panel) return;
  const root = document.documentElement;
  const stored = {...(window.TASKA_SERVER_PREFS || {}), ...JSON.parse(localStorage.getItem("taska-ui") || "{}")};
  const controls = {
    theme: panel.querySelector("[data-ui-theme]"), accent: panel.querySelector("[data-ui-accent]"),
    density: panel.querySelector("[data-ui-density]"), motion: panel.querySelector("[data-ui-motion]"),
    font_scale: panel.querySelector("[data-ui-font-scale]"),
  };
  const defaults = {theme:"dark", accent:"#6da8ff", density:"comfortable", motion:"full", font_scale:"1"};
  Object.entries(controls).forEach(([key,input]) => { input.value = stored[key] || defaults[key]; });
  const read = () => Object.fromEntries(Object.entries(controls).map(([key,input]) => [key,input.value]));
  const apply = (prefs) => {
    root.dataset.theme = prefs.theme; root.dataset.density = prefs.density; root.dataset.motion = prefs.motion;
    root.style.setProperty("--primary", prefs.accent); root.style.setProperty("--font-scale", prefs.font_scale);
  };
  Object.values(controls).forEach((input) => input.addEventListener("input", () => apply(read())));
  const presets = {ocean:"#3276d1",graphite:"#6f7b8a",rose:"#d05278",mint:"#258b78"};
  panel.querySelectorAll("[data-theme-preset]").forEach((button) => button.addEventListener("click", () => { controls.theme.value="custom"; controls.accent.value=presets[button.dataset.themePreset]; apply(read()); }));
  panel.querySelector("[data-interface-reset]").addEventListener("click", () => { Object.entries(defaults).forEach(([key,value]) => controls[key].value=value); apply(defaults); });
  panel.querySelector("[data-interface-save]").addEventListener("click", async (event) => {
    const prefs=read(); localStorage.setItem("taska-ui",JSON.stringify(prefs)); localStorage.setItem("taska-theme",prefs.theme); event.currentTarget.disabled=true;
    const response=await fetch("/account/interface",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:`preferences=${encodeURIComponent(JSON.stringify(prefs))}`});
    event.currentTarget.disabled=false; event.currentTarget.textContent=response.ok?"Сохранено":"Ошибка"; setTimeout(()=>event.currentTarget.textContent="Сохранить оформление",1400);
  });
  apply(read());
});
