/* reveal.js - Premium redesign Phase 4: scroll-reveal (progressive enhancement).

   Fades a handful of section blocks up as they scroll into view. The dimmed
   start state lives in site.css behind BOTH the `.js-reveal` class AND
   `@media (prefers-reduced-motion: no-preference)`, so:
     - JS off / disabled -> `.js-reveal` never added        -> sections in place
     - reveal.js 404s / throws -> `.js-reveal` removed again -> sections in place
     - reduced motion    -> the opacity rules never match    -> sections in place
   The observer only ever adds a class; it never hides anything itself.

   A tiny inline script in each page's <head> adds `.js-reveal` before first
   paint (so there's no flash of content then hide) and removes it again on
   window `load` if this file never set `window.__revealReady`.

   Targets: Home's Featured / Story / Preview / Visit sections, the Menu list
   container, and the About details grid. The hero and the interior page
   headers are deliberately excluded. menu.js owns the per-item menu DOM, so
   the whole list reveals as one block rather than row by row. */
(function () {
  function revealAll(list) {
    for (var i = 0; i < list.length; i++) {
      list[i].classList.add('is-revealed');
    }
  }

  try {
    var root = document.documentElement;
    root.classList.add('js-reveal');

    var targets = document.querySelectorAll(
      '.featured, .story, .preview, .visit, .menu-list, .about-grid'
    );

    if (!targets.length) {
      window.__revealReady = true;
      return;
    }

    // Older browsers with no IntersectionObserver: just show everything.
    if (!('IntersectionObserver' in window)) {
      revealAll(targets);
      window.__revealReady = true;
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-revealed');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );

    for (var j = 0; j < targets.length; j++) {
      observer.observe(targets[j]);
    }

    window.__revealReady = true;
  } catch (err) {
    // Anything went wrong -> drop the start state so nothing stays hidden.
    document.documentElement.classList.remove('js-reveal');
  }
})();
