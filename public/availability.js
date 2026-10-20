// Shared by the Menu page (menu.js) and Home's featured cards (index.html): asks the server
// which menu items are sold out right now, and marks them.
//
// The server answer is optional decoration. Anything that goes wrong (the request fails or
// times out, the answer is not exactly { unavailable: [names] }) means no labels and no
// error: the page looks exactly as it did before this file existed.
//
// Item names are only ever used as keys, matched by exact string against a Map the page
// built from the menu. They are never put into markup. The label text is the constant
// "Sold out", written by the page.
(function (root) {
  'use strict';

  var TIMEOUT_MS = 4000;
  var MAX_NAMES = 200;

  // The names from a /api/availability body, or [] unless the body is exactly the expected
  // shape: an object whose own "unavailable" property is an array of strings.
  function parseUnavailable(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
    if (!Object.prototype.hasOwnProperty.call(body, 'unavailable')) return [];
    var list = body.unavailable;
    if (!Array.isArray(list) || list.length > MAX_NAMES) return [];
    for (var i = 0; i < list.length; i += 1) {
      if (typeof list[i] !== 'string') return [];
    }
    return list.slice();
  }

  // Resolves to an array of names, never rejects. fetchFn is the page's fetch.
  function fetchUnavailable(fetchFn, timeoutMs) {
    return new Promise(function (resolve) {
      var finished = false;
      var timer = null;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;

      function finish(names) {
        if (finished) return;
        finished = true;
        if (timer !== null) clearTimeout(timer);
        resolve(names);
      }

      timer = setTimeout(function () {
        if (controller) controller.abort();
        finish([]);
      }, timeoutMs || TIMEOUT_MS);

      try {
        fetchFn('/api/availability', controller ? { signal: controller.signal } : undefined)
          .then(function (res) {
            if (!res || !res.ok) return null;
            return res.json();
          })
          .then(
            function (body) { finish(parseUnavailable(body)); },
            function () { finish([]); }
          );
      } catch (err) {
        finish([]);
      }
    });
  }

  // Calls apply(element, name) once for each name that exactly matches a key of byName (a
  // Map of exact item name to element). Unknown names, near matches (other case, extra
  // spaces) and repeated names do nothing. Returns how many elements were marked.
  function applySoldOut(byName, names, apply) {
    var seen = new Set();
    var marked = 0;
    for (var i = 0; i < names.length; i += 1) {
      var name = names[i];
      if (typeof name !== 'string' || seen.has(name)) continue;
      seen.add(name);
      var element = byName.get(name);
      if (element) {
        apply(element, name);
        marked += 1;
      }
    }
    return marked;
  }

  var api = { parseUnavailable: parseUnavailable, fetchUnavailable: fetchUnavailable, applySoldOut: applySoldOut };

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.CafeAvailability = api;
  }
})(typeof self !== 'undefined' ? self : this);
