-- Stock state for the inventory dashboard (see docs/inventory-plan.md).
-- Run by db.js on boot and is safe to run any number of times.
--
-- One row per menu item that has ever been toggled. A menu item with no row counts as
-- in stock, so an empty table behaves exactly like having no inventory tracking at all.
-- item_name is the item's name in menu.json, exactly. It is the stable key that links
-- stock state to menu items.
CREATE TABLE IF NOT EXISTS stock (
  item_name  text PRIMARY KEY,
  in_stock   boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
