const ADJECTIVES = ["Brave", "Bright", "Cosmic", "Curious", "Daring", "Happy", "Mighty", "Quick", "Silly", "Sunny", "Swift", "Wild"] as const;
const NOUNS = ["Badger", "Falcon", "Gecko", "Goose", "Koala", "Otter", "Panda", "Robin", "Shark", "Tiger", "Wombat", "Yak"] as const;
const PALETTES = [
  ["#9bd31a", "#182413", "#f4ffd7"], ["#ff9f1c", "#33200a", "#fff2d6"], ["#57c7ff", "#10293a", "#e3f7ff"],
  ["#d783ff", "#32183f", "#f8e8ff"], ["#ff6f91", "#3b1520", "#ffe9ef"], ["#ffd447", "#372d0b", "#fff8d7"],
] as const;

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

export function generatedNickname(seed: string): string {
  const value = hash(seed.trim().toLowerCase());
  return `${ADJECTIVES[value % ADJECTIVES.length]} ${NOUNS[Math.floor(value / ADJECTIVES.length) % NOUNS.length]}`;
}

export function avatarSpec(pubkey: string) {
  const value = hash(pubkey);
  return { palette: PALETTES[value % PALETTES.length]!, eyes: value % 3, accessory: Math.floor(value / 7) % 4 };
}

export function avatarDataUri(pubkey: string): string {
  const { palette: [accent, ink, paper], eyes, accessory } = avatarSpec(pubkey);
  const eye = eyes === 0 ? "M18 23h4v4h-4zm12 0h4v4h-4z" : eyes === 1 ? "M17 23h6v3h-6zm12 0h6v3h-6z" : "M18 22h4v5h-4zm12 0h4v5h-4z";
  const hat = accessory === 0 ? "<path d='M14 16h24v4H14zM20 11h12v5H20z' fill='"+accent+"'/>" : accessory === 1 ? "<path d='M14 18l6-8 6 8 6-8 6 8z' fill='"+accent+"'/>" : accessory === 2 ? "<path d='M16 17h20v-5H16z' fill='"+accent+"'/><path d='M34 12h5v8h-5z' fill='"+ink+"'/>" : "<path d='M18 16l8-7 8 7z' fill='"+accent+"'/>";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 52 52' shape-rendering='crispEdges'><rect width='52' height='52' rx='10' fill='${ink}'/><path d='M7 42h38V18H7z' fill='${paper}'/>${hat}<path d='${eye}' fill='${ink}'/><path d='M21 34h10v4H21z' fill='${accent}'/><path d='M7 38h5v4H7zm33 0h5v4h-5z' fill='${accent}'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
