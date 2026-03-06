const registeredFonts = new Set<string>();

export function ensureFontFace(userId: string, url: string) {
  const key = `${userId}:${url}`;
  if (registeredFonts.has(key)) return;
  registeredFonts.add(key);
  const style = document.createElement("style");
  style.textContent = `@font-face { font-family: 'user-font-${CSS.escape(userId)}'; src: url('${url}'); }`;
  document.head.appendChild(style);
}
