const menuContentEl = document.getElementById('menu-content');

function formatPrice(price) {
  return `$${price.toFixed(2)}`;
}

// Stable per-item anchor id, e.g. "Iced Matcha Latte" -> "item-iced-matcha-latte".
// Home's featured cards (index.html) build their /menu#item-... links with an
// identical function, so the two must stay in sync.
function itemAnchorId(name) {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `item-${slug}`;
}

// The browser tries to jump to the URL's #hash on load, before the items exist,
// so redo that jump once rendering is done.
function scrollToHashTarget() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  if (!id) return;
  const target = document.getElementById(id);
  if (target) target.scrollIntoView({ block: 'start' });
}

function renderMenu(items) {
  menuContentEl.innerHTML = '';

  const categories = [];
  const byCategory = {};
  for (const item of items) {
    if (!byCategory[item.category]) {
      byCategory[item.category] = [];
      categories.push(item.category);
    }
    byCategory[item.category].push(item);
  }

  for (const category of categories) {
    const section = document.createElement('section');
    section.className = 'menu-category';

    const heading = document.createElement('h2');
    heading.textContent = category;
    section.appendChild(heading);

    for (const item of byCategory[category]) {
      const row = document.createElement('div');
      row.className = 'menu-item';
      row.id = itemAnchorId(item.name);

      const info = document.createElement('div');

      const name = document.createElement('div');
      name.className = 'menu-item-name';
      name.textContent = item.name;
      info.appendChild(name);

      const desc = document.createElement('div');
      desc.className = 'menu-item-desc';
      desc.textContent = item.description;
      info.appendChild(desc);

      const metaParts = [];
      if (item.sizes && item.sizes.length) {
        metaParts.push(item.sizes.join(', '));
      }
      if (item.allergens && item.allergens.length) {
        metaParts.push(`Contains: ${item.allergens.join(', ')}`);
      }
      if (metaParts.length) {
        const meta = document.createElement('div');
        meta.className = 'menu-item-meta';
        meta.textContent = metaParts.join(' · ');
        info.appendChild(meta);
      }

      row.appendChild(info);

      const price = document.createElement('div');
      price.className = 'menu-item-price';
      price.textContent = formatPrice(item.price);
      row.appendChild(price);

      section.appendChild(row);
    }

    menuContentEl.appendChild(section);
  }

  scrollToHashTarget();
}

fetch('/api/menu')
  .then((res) => {
    if (!res.ok) throw new Error('Menu request failed');
    return res.json();
  })
  .then(renderMenu)
  .catch(() => {
    menuContentEl.innerHTML = '<p class="menu-error">Sorry, the menu couldn\'t be loaded right now. Please try again later.</p>';
  });
