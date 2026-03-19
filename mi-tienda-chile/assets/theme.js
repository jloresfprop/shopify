document.addEventListener('DOMContentLoaded', () => {
  // Cart drawer placeholder
  document.querySelectorAll('[data-cart-toggle]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      document.querySelector('[data-cart-drawer]')?.classList.toggle('is-open');
    });
  });
});
