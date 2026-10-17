const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.classList = { toggle: jest.fn() };
    this.hidden = false;
    this.form = { listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, requestSubmit: jest.fn() };
    this.dataset = { suggest: 'archive' };
    this.value = '';
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  closest() { return this.wrapper; }
  contains() { return false; }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selector === '.sg-row' && child.className.split(' ').includes('sg-row')) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

describe('suggestion request freshness', () => {
  it('ignores an in-flight response after the query becomes too short', async () => {
    const input = new Element('input');
    const wrapper = new Element();
    input.wrapper = wrapper;
    const scheduled = [];
    let resolveFetch;
    const fetch = jest.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const document = {
      querySelectorAll: () => [input],
      createElement: (tag) => new Element(tag),
      addEventListener: jest.fn(),
    };
    const source = fs.readFileSync(require.resolve('../public/js/listTools.js'), 'utf8');
    vm.runInNewContext(source, {
      document,
      fetch,
      URLSearchParams,
      Math,
      setTimeout: (fn) => { scheduled.push(fn); return scheduled.length; },
      clearTimeout: jest.fn(),
    });

    input.value = 'report';
    input.listeners.input();
    scheduled[0]();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);

    input.value = 'r';
    input.listeners.input();
    resolveFetch({ ok: true, json: async () => ({ items: [{ url: '/', label: 'Stale', sub: '' }] }) });
    await Promise.resolve();
    await Promise.resolve();

    const panel = wrapper.children[0];
    expect(panel.hidden).toBe(true);
    expect(input.attributes['aria-expanded']).toBe('false');
  });
});
