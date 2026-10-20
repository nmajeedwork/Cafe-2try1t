// A very small stand-in for the browser DOM, just enough to run public/menu.js and the
// inline script of public/index.html in Node (see page-runner.js). It is not a browser: it
// records what the page code builds so tests can compare the result with a stored tree.
// Real rendering, layout and CSS are only proven in a real browser.
//
// Supported: createElement, createTextNode, getElementById (over registered roots),
// appendChild, insertBefore, setAttribute/getAttribute/hasAttribute, firstChild/lastChild,
// textContent and innerHTML setters (innerHTML sets are logged), and any other property
// (className, id, href, src, alt, loading ...) stored as a plain value.

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.text = String(text);
    this.parentNode = null;
  }
}

class FakeElement {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tag = String(tag).toLowerCase();
    this.children = [];
    this.props = {};
    this.attrs = {};
    this.rawHtml = null;
    this.parentNode = null;
    this._doc = doc;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, ref) {
    const index = this.children.indexOf(ref);
    child.parentNode = this;
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }

  hasAttribute(name) {
    return name in this.attrs;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get lastChild() {
    return this.children[this.children.length - 1] || null;
  }

  get textContent() {
    return this.children.map((c) => (c.nodeType === 3 ? c.text : c.textContent)).join('');
  }

  set textContent(value) {
    this.rawHtml = null;
    const text = String(value);
    this.children = text === '' ? [] : [Object.assign(new FakeText(text), { parentNode: this })];
  }

  get innerHTML() {
    return this.rawHtml === null ? '' : this.rawHtml;
  }

  set innerHTML(value) {
    const html = String(value);
    this.children = [];
    this.rawHtml = html === '' ? null : html;
    if (html !== '') this._doc.log.push({ innerHTML: html });
  }

  scrollIntoView() {
    this._doc.log.push({ scrollIntoView: this.props.id });
    // A jump to an element leaves the page scrolled somewhere other than the top.
    if (this._doc.window) this._doc.window.scrollY = 100;
  }
}

function makeElement(tag, doc) {
  return new Proxy(new FakeElement(tag, doc), {
    get(target, key) {
      return key in target ? target[key] : target.props[key];
    },
    set(target, key, value) {
      if (key in target) target[key] = value;
      else target.props[key] = value;
      return true;
    }
  });
}

function sortedObject(source) {
  return Object.fromEntries(Object.keys(source).sort().map((k) => [k, source[k]]));
}

// A plain, comparable description of a node and everything under it.
function serialize(node) {
  if (node.nodeType === 3) return node.text;
  const out = { tag: node.tag };
  if (Object.keys(node.props).length) out.props = sortedObject(node.props);
  if (Object.keys(node.attrs).length) out.attrs = sortedObject(node.attrs);
  if (node.rawHtml !== null) out.html = node.rawHtml;
  if (node.children.length) out.children = node.children.map(serialize);
  return out;
}

function createFakeDocument() {
  const roots = new Map();
  const doc = {
    log: [],
    window: null,
    createElement: (tag) => makeElement(tag, doc),
    createTextNode: (text) => new FakeText(text),
    getElementById(id) {
      const search = (node) => {
        if (node.nodeType !== 1) return null;
        if (node.props.id === id) return node;
        for (const child of node.children) {
          const found = search(child);
          if (found) return found;
        }
        return null;
      };
      for (const root of roots.values()) {
        const found = search(root);
        if (found) return found;
      }
      return null;
    },
    addRoot(id) {
      const el = makeElement('div', doc);
      el.props.id = id;
      roots.set(id, el);
      return el;
    }
  };
  return doc;
}

module.exports = { createFakeDocument, serialize, FakeText };
