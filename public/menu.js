const menuContentEl = document.getElementById('menu-content');

function formatPrice(price) {
  return `$${price.toFixed(2)}`;
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
