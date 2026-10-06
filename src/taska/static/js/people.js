document.querySelectorAll('[data-people-form]').forEach(form => {
  form.querySelector('[data-people-search]').addEventListener('input', event => {
    const query = event.target.value.toLocaleLowerCase();
    form.querySelectorAll('select[multiple] option').forEach(option => {
      option.hidden = !option.selected && !option.textContent.toLocaleLowerCase().includes(query);
    });
  });
});
