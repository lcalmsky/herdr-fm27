// A chainable stand-in for gpui elements: every builder method returns the element itself.
let inRow = false;
const element = () => {
  const el = new Proxy(function () {}, {
    get: (target, key) => {
      if (key === "then") return undefined;
      if (inRow && typeof key === "string" && key.startsWith("on_")) {
        return () => { throw new Error(`${key} inside a virtual list row`); };
      }
      if (key === "when") return (cond, cb) => (cond ? cb(el) : el);
      return () => element();
    },
  });
  return el;
};
export class View {}
// Herdr throws on handlers registered inside a virtual list's item renderer; render eagerly to match.
export function h_virtual_list(_id, count, _sizes, getKey, render) {
  inRow = true;
  try {
    render({ start: 0, end: count }, {});
    for (let i = 0; i < count; i++) getKey(i);
  } finally {
    inRow = false;
  }
  return element();
}
export const div = element, image = element, svg = element, v_flex = element, h_flex = element;
export const VirtualListScrollHandle = { new: () => ({ scroll_to_item() {}, scroll_to_bottom() {}, release() { return true; } }) };
export const InputState = { new: () => ({ on() {}, focus() {}, value: () => "" }) }, Input = { new: element };
export const PathBuilder = { stroke: element, fill: element };
export const Background = { linear_gradient: element, solid: element };
globalThis.window ??= { paint_path: element };
export const Scrollbar = { horizontal: element, vertical: element, new: element };
// The editor pane's retained state and its two views.
export const EditorState = { new: (options = {}) => {
  let value = options.value ?? "";
  return {
    value: () => value,
    set_value: (next) => { value = next; },
    on: () => true,
    release: () => true,
  };
} };
export const Editor = { new: element };
export const TextView = { html: () => element(), markdown: () => element() };
