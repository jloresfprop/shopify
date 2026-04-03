document.addEventListener('DOMContentLoaded', () => {
  // Cart drawer placeholder
  document.querySelectorAll('[data-cart-toggle]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      document.querySelector('[data-cart-drawer]')?.classList.toggle('is-open');
    });
  });

  // Flechas en tarjetas de producto
  document.querySelectorAll('.product-card__media[data-card-images]').forEach(media => {
    const images = media.dataset.cardImages.split('|').filter(Boolean);
    if (images.length < 2) return;
    const img = media.querySelector('.product-card__img--main');
    if (!img) return;
    let current = 0;

    function goTo(idx) {
      current = (idx + images.length) % images.length;
      img.src = images[current];
    }

    media.querySelector('.card-arrow--prev')?.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation(); goTo(current - 1);
    });
    media.querySelector('.card-arrow--next')?.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation(); goTo(current + 1);
    });
  });
});
