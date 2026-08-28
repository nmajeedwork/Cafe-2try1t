/* Site-wide nav: mobile hamburger toggle.
   Shared by index.html, menu.html, order.html, about.html. Progressive
   enhancement: if this script doesn't run, the CSS still shows every link
   once the menu is expanded, and all four links stay reachable at desktop
   width. */
(function () {
  var toggle = document.querySelector('.navbar__toggle');
  var menu = document.getElementById('navbar-menu');
  if (!toggle || !menu) return;

  toggle.addEventListener('click', function () {
    var open = menu.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute(
      'aria-label',
      open ? 'Close navigation menu' : 'Open navigation menu'
    );
  });
})();
