// A tiny element builder. Everything that came from Arkiv is untrusted (anyone can write an entity
// with our attributes), so text always goes in through textContent, never innerHTML.

type Child = Node | string | number | null | undefined | false
export type Children = Child | Children[]
type Props = Record<string, string | boolean | ((e: Event) => void) | undefined>

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Children[]) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v)
    else if (k === "class") el.className = String(v)
    else if (v === true) el.setAttribute(k, "")
    else el.setAttribute(k, v)
  }
  append(el, children)
  return el
}

export function append(el: Element, children: Children) {
  for (const c of [children].flat(Infinity as 1) as Child[]) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
}

/** A link that only ever points at http(s); anything else renders as plain text. */
export function safeLink(url: string, text?: string, cls?: string) {
  try {
    const u = new URL(url)
    if (u.protocol === "https:" || u.protocol === "http:") {
      return h("a", { href: u.toString(), target: "_blank", rel: "noopener noreferrer", class: cls }, text ?? u.toString())
    }
  } catch {
    // fall through
  }
  return h("span", { class: cls }, text ?? url)
}

export function clear(el: Element) {
  while (el.firstChild) el.firstChild.remove()
}
