/**
 * The preset reactions a post can carry, mirroring Solian's `kReactionTemplates`
 * (see `Solian/ios/SolianWatchApp/Models/ReactionTemplates.swift`): the same
 * fifteen symbols, the same attitudes, and the same sheet order — positive,
 * then neutral, then negative.
 *
 * The wire carries reactions as a `{ symbol: count }` map; only symbols in this
 * table have a bundled sticker (`public/img/reactions/{symbol}.png`). Custom
 * `prefix+slug` reactions from Stellar members have no bundled image here, so
 * they keep their plain count text instead of a tile.
 */

/** 0 = positive, 1 = neutral, 2 = negative — the API's own enum values. */
export type ReactionAttitude = 0 | 1 | 2;

export interface ReactionTemplate {
  symbol: string;
  attitude: ReactionAttitude;
  /** String-table key for the reaction's name. */
  labelKey: string;
}

const POSITIVE: Array<[string, string]> = [
  ['thumb_up', 'reaction_thumb_up'],
  ['salute', 'reaction_salute'],
  ['clap', 'reaction_clap'],
  ['laugh', 'reaction_laugh'],
  ['party', 'reaction_party'],
  ['heart', 'reaction_heart'],
];

const NEUTRAL: Array<[string, string]> = [
  ['cry', 'reaction_cry'],
  ['confuse', 'reaction_confuse'],
  ['hello', 'reaction_hello'],
  ['shock', 'reaction_shock'],
  ['speechless', 'reaction_speechless'],
  ['ridicule', 'reaction_ridicule'],
  ['pray', 'reaction_pray'],
];

const NEGATIVE: Array<[string, string]> = [
  ['thumb_down', 'reaction_thumb_down'],
  ['angry', 'reaction_angry'],
];

function templates(groups: Array<[string, string]>, attitude: ReactionAttitude): ReactionTemplate[] {
  const list: ReactionTemplate[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const entry = groups[index];
    list.push({ symbol: entry[0], attitude, labelKey: entry[1] });
  }
  return list;
}

/**
 * The fifteen preset reactions, in sheet order. The reaction picker lays them
 * out in this order, five per row, so the grouping the sheet shows as
 * attitude sections reads left-to-right top-to-bottom.
 */
export const REACTION_TEMPLATES: ReactionTemplate[] = [
  ...templates(POSITIVE, 0),
  ...templates(NEUTRAL, 1),
  ...templates(NEGATIVE, 2),
];

const LABEL_BY_SYMBOL: Record<string, string> = {};
for (let index = 0; index < REACTION_TEMPLATES.length; index += 1) {
  LABEL_BY_SYMBOL[REACTION_TEMPLATES[index].symbol] = REACTION_TEMPLATES[index].labelKey;
}

/** A bundled sticker's URL for a known symbol. */
export function reactionStickerUrl(symbol: string): string {
  return '/img/reactions/' + symbol + '.png';
}

export interface ReactionChip {
  symbol: string;
  count: number;
  labelKey: string;
}

/**
 * The post's reactions that have a bundled sticker, best first, capped at
 * `limit`. Custom `prefix+slug` reactions are not tiles — the plain count text
 * covers them — so they are filtered out here.
 */
export function reactionChips(
  reactions: Record<string, number>,
  limit = 3,
): ReactionChip[] {
  const chips: ReactionChip[] = [];
  const symbols = Object.keys(reactions);
  for (let index = 0; index < symbols.length; index += 1) {
    const symbol = symbols[index];
    const labelKey = LABEL_BY_SYMBOL[symbol];
    if (!labelKey) continue;
    chips.push({ symbol, count: reactions[symbol], labelKey });
  }

  chips.sort((a, b) => b.count - a.count);
  return chips.slice(0, limit);
}
