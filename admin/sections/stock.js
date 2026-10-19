// D5: the admin Stock section (see docs/inventory-plan.md, D5).
//
// GET  /admin/stock               the menu by category, each item in stock or sold out, with
//                                 one button per item and a Reload from database button.
// POST /admin/api/stock           { _csrf, name, in_stock } sets one item. The database is
//                                 written first (db.setStock); memory (stock.setInMemory)
//                                 changes only if that write worked. A failed write is a 503
//                                 and memory stays exactly as it was.
// POST /admin/api/stock/reload    { _csrf } loads every row from the database into memory.
//
// Plain HTML forms, no JavaScript, so the admin CSP needs no script-src at all. Every POST
// goes through the D4 checks: exact Origin, a logged-in admin session, and the per-session
// CSRF token. Item names are the keys: the name sent must be exactly one of the names in
// menu.json, never a near match. Each button sends the state it wants ("Mark sold out"
// sends false), not "flip", so a stale tab can never invert an item by mistake.

const menuJson = require('../../menu.json');

const ITEM_ANCHOR = (index) => `item-${index}`;

// The boolean as JSON (true or false) or as a form field (exactly "true" or "false").
// Anything else, including a repeated field (an array), is not a boolean.
function parseInStock(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function formatTime(ms) {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function statusBanner(status) {
  if (status.state === 'off') {
    return {
      kind: 'warning',
      text: 'Stock tracking is off (DATABASE_URL is not set). Every item is treated as in stock, and changes cannot be saved.'
    };
  }
  if (status.state === 'unavailable') {
    return {
      kind: 'warning',
      text: 'Stock data could not be loaded from the database. Every item is being treated as in stock, and changes may fail until the database is reachable. Use Reload from database to try again.'
    };
  }
  return null;
}

function register(router, h, deps = {}) {
  const stock = deps.stock || require('../../stock');
  const db = deps.db || require('../../db');
  const menu = deps.menu || menuJson;

  const menuNames = menu.map((item) => item.name);
  const knownNames = new Set(menuNames);
  const anchorIndex = new Map(menuNames.map((name, index) => [name, index]));
  const categories = [];
  for (const item of menu) {
    let group = categories.find((c) => c.name === item.category);
    if (!group) {
      group = { name: item.category, items: [] };
      categories.push(group);
    }
    group.items.push(item);
  }

  // Every write to the stock state (toggles and reloads) runs one at a time, in the order the
  // requests arrived, so the database and memory always end in the same state, and the last
  // button pressed wins.
  let queue = Promise.resolve();
  function serialized(work) {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  }

  function reloadFromDatabase() {
    return stock.reloadStock({ menuNames, loadFn: db.loadStock });
  }

  function renderStock(req, res, { status = 200, error = null } = {}) {
    const csrf = h.escapeHtml(req.admin.csrf);
    const stockStatus = stock.getStockStatus();
    const banners = [];
    const flash = h.takeFlash(req);
    if (flash) banners.push({ kind: 'success', text: flash });
    if (error) banners.push({ kind: 'error', text: error });
    const statusMessage = statusBanner(stockStatus);
    if (statusMessage) banners.push(statusMessage);

    const lastLoaded = stockStatus.lastLoadedAt ? formatTime(stockStatus.lastLoadedAt) : 'never';
    const sections = categories
      .map((group) => {
        const rows = group.items
          .map((item) => {
            const inStock = stock.isInStock(item.name);
            const name = h.escapeHtml(item.name);
            return `<li class="stock-item ${inStock ? 'in-stock' : 'sold-out'}" id="${ITEM_ANCHOR(anchorIndex.get(item.name))}">
  <span><span class="name">${name}</span><span class="state">${inStock ? 'In stock' : 'Sold out'}</span></span>
  <form method="post" action="/admin/api/stock">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="name" value="${name}">
    <input type="hidden" name="in_stock" value="${inStock ? 'false' : 'true'}">
    <button type="submit">${inStock ? 'Mark sold out' : 'Mark in stock'}</button>
  </form>
</li>`;
          })
          .join('\n');
        return `<section class="stock-category">
<h2>${h.escapeHtml(group.name)}</h2>
<ul class="stock-items">
${rows}
</ul>
</section>`;
      })
      .join('\n');

    const content = `<h1>Stock</h1>
<div class="stock-meta">
  <span>Last loaded from the database: ${lastLoaded}</span>
  <form method="post" action="/admin/api/stock/reload">
    <input type="hidden" name="_csrf" value="${csrf}">
    <button type="submit">Reload from database</button>
  </form>
</div>
${sections}`;
    return h.renderPage(req, res, { status, title: 'Stock', sectionPath: '/stock', content, banners });
  }

  router.get('/stock', h.requirePageLogin, (req, res) => renderStock(req, res));

  router.post('/api/stock', h.requireSameOrigin, h.requireActionLogin, async (req, res) => {
    const name = req.body && req.body.name;
    if (typeof name !== 'string' || !knownNames.has(name)) {
      return renderStock(req, res, { status: 400, error: 'Unknown item. Nothing was changed.' });
    }
    const inStock = parseInStock(req.body.in_stock);
    if (inStock === null) {
      return renderStock(req, res, { status: 400, error: 'Invalid stock value. Nothing was changed.' });
    }

    try {
      await serialized(async () => {
        await db.setStock(name, inStock);
        stock.setInMemory(name, inStock);
      });
    } catch (err) {
      h.log.error(`[admin] stock: could not save "${name}": ${(err && err.message) || 'unknown error'}`);
      return renderStock(req, res, {
        status: 503,
        error: 'Could not save: the database is not reachable right now. Nothing was changed. Try again in a minute.'
      });
    }
    h.log.log(`[admin] stock: "${name}" set to ${inStock ? 'in stock' : 'sold out'}`);

    // The write just worked, so the database is reachable again. If stock was unavailable
    // (the boot load failed and nothing has loaded since), load everything now, so the other
    // items stop being treated as in stock. A failed reload does not undo the toggle.
    let reloaded = '';
    if (stock.getStockStatus().state === 'unavailable') {
      const result = await serialized(reloadFromDatabase);
      if (result.ok) {
        h.log.log(`[admin] stock: reloaded ${result.rows} rows after the database came back`);
        reloaded = ' Stock data was also reloaded from the database.';
      } else {
        h.log.error(`[admin] stock: reload after the toggle failed: ${(result.error && result.error.message) || 'unknown error'}`);
      }
    }

    h.setFlash(req, `${name} is now ${inStock ? 'in stock' : 'sold out'}.${reloaded}`);
    return res.redirect(303, `/admin/stock#${ITEM_ANCHOR(anchorIndex.get(name))}`);
  });

  router.post('/api/stock/reload', h.requireSameOrigin, h.requireActionLogin, async (req, res) => {
    const result = await serialized(reloadFromDatabase);
    if (!result.ok) {
      h.log.error(`[admin] stock: reload failed: ${(result.error && result.error.message) || 'unknown error'}`);
      return renderStock(req, res, {
        status: 503,
        error: 'Could not reload: the database is not reachable right now. Stock state was not changed.'
      });
    }
    h.log.log(`[admin] stock: reloaded ${result.rows} rows from the database`);
    h.setFlash(req, 'Stock reloaded from the database.');
    return res.redirect(303, '/admin/stock');
  });
}

module.exports = { path: '/stock', title: 'Stock', register };
