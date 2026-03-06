const registeredFonts = new Set<string>();

export function ensureFontFace(userId: string, url: string) {
  if (registeredFonts.has(url)) return;
  registeredFonts.add(url);
  const style = document.createElement("style");
  style.textContent = `@font-face { font-family: 'user-font-${CSS.escape(userId)}'; src: url('${url}'); }`;
  document.head.appendChild(style);
}
