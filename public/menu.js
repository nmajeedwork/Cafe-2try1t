const menuContentEl = document.getElementById('menu-content');

// D6: ask which items are sold out at the same time as the menu is requested. This is
// optional decoration (see availability.js): if that file did not load, or the answer is
// anything other than the expected list, this resolves to [] and the page is exactly as it
// was before.
const availabilityPromise = window.CafeAvailability
  ? window.CafeAvailability.fetchUnavailable(fetch)
  : Promise.resolve([]);

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

// Where the page was left by the last jump to the URL's #hash (null if there was none).
let lastJumpY = null;

// The browser tries to jump to the URL's #hash on load, before the items exist,
// so redo that jump once rendering is done.
function scrollToHashTarget() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  if (!id) return;
  const target = document.getElementById(id);
  if (target) {
    target.scrollIntoView({ block: 'start' });
    lastJumpY = window.scrollY;
  }
}

// D6: marks the sold-out rows once the availability answer is in. Runs on its own promise
// chain and swallows every error, so nothing here can ever replace the menu with the error
// message or change the page when something goes wrong.
function showSoldOut(rowsByName, nameElsByName) {
  availabilityPromise.then((names) => {
    try {
      const marked = window.CafeAvailability.applySoldOut(rowsByName, names, (row, itemName) => {
        if (row.hasAttribute('data-sold-out')) return;
        row.setAttribute('data-sold-out', 'true');
        const label = document.createElement('span');
        label.className = 'sold-out-label';
        label.textContent = 'Sold out';
        const nameEl = nameElsByName.get(itemName);
        // A plain space keeps "Item name" and "Sold out" apart for screen readers.
        nameEl.appendChild(document.createTextNode(' '));
        nameEl.appendChild(label);
      });
      // A label that wraps onto a second line can push the row the URL points at down a
      // little. If the page is still where the first jump left it (the visitor has not
      // scrolled), jump again so the row stays aligned.
      if (marked > 0 && lastJumpY !== null && Math.abs(window.scrollY - lastJumpY) < 2) {
        scrollToHashTarget();
      }
    } catch (err) {
      // Decoration only: the page stays as it is.
    }
  });
}

function renderMenu(items) {
  menuContentEl.innerHTML = '';

  // Exact item name -> its row and its name element, for the sold-out labels.
  const rowsByName = new Map();
  const nameElsByName = new Map();

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
      rowsByName.set(item.name, row);
      nameElsByName.set(item.name, name);

      const price = document.createElement('div');
      price.className = 'menu-item-price';
      price.textContent = formatPrice(item.price);
      row.appendChild(price);

      section.appendChild(row);
    }

    menuContentEl.appendChild(section);
  }

  scrollToHashTarget();
  showSoldOut(rowsByName, nameElsByName);
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
