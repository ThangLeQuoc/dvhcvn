import Entity, { getEntityById } from "./entity.ts";
import { similarText } from "./locutus.ts";
import { deaccent, normalize } from "./vietnamese.ts";

const scorePerChar = 10;
const scoreDeltaType = 9;
const scoreDeltaSimilarity = -30;
const scoreDeltaSkip = -3;
const scoreDeltaInitials = -2;
const scoreDeltaName2 = -1;

function substrByDeaccentLength(str: string, length: number) {
  const lMax = str.length;
  for (let l = length; l < lMax; l++) {
    const substr = str.substring(lMax - l);
    if (deaccent(substr).length == length) return substr;
  }

  return str;
}

export class Matches {
  address: string;
  entity: Entity | null = null;
  matches: string[][] = [];
  scores: number[] = [];

  constructor(address: string) {
    this.address = address;
  }

  describe = () => ({
    match: this.entity?.describe(),
    scores: this.scores,
    address: [this.address, ...this.matches],
  });

  results() {
    const results = [];

    let entity = this.entity;
    while (entity && entity.id !== "root") {
      const { id, name, type } = entity;
      results.push({ id, name, type });
      entity = entity.parent;
    }

    return results;
  }

  score = () => this.scores.reduce((sum, s) => sum + s, 0);
}

let matcherCount = 0;
const delimsRegExp = /[ _.,/–-]+$/;

export default class Matcher {
  id = ++matcherCount;

  address: string;
  private address2: string;
  private count: { [score: string]: number } = {};
  private histories: { [score: string]: Matches } = {};
  private previous: Matches;

  constructor(address: string, matches: Matches) {
    this.address = address.replace(delimsRegExp, "");
    this.address2 = deaccent(this.address);

    this.previous = matches;
  }

  best(): Matches | null {
    let scoreMaxFloat = 0.0;
    let scoreMaxString = "";
    Object.keys(this.count).forEach((score) => {
      const scoreFloat = parseFloat(score);
      if (scoreFloat > scoreMaxFloat) {
        scoreMaxFloat = scoreFloat;
        scoreMaxString = score;
      }
    });

    if (!scoreMaxString) return null;

    if (this.count[scoreMaxString] > 1) {
      const { previous } = this;
      if (previous.entity) {
        return this.done(
          previous.entity,
          ["", ""],
          scoreMaxFloat - previous.score(),
        );
      } else {
        return null;
      }
    }

    return this.histories[scoreMaxString];
  }

  try(entity: Entity) {
    const { address, address2, previous } = this;
    const { entity: pe } = previous;
    const { initials, names, names2, regExp, typePatterns } = entity.prepare();
    if (!regExp) return null;

    const regExpMatch = regExp.exec(address2);
    if (!regExpMatch) {
      const nameSimilarity = deaccent(`${entity.name}`);
      if (nameSimilarity.length > 12 || (pe && pe.level === entity.level - 1)) {
        // perform fuzzy match if: (1) name is lengthy or (2) there's a direct parent match
        // this cpu intensive processing works as a last resort to catch typos etc.
        const similarityRegExp = new RegExp(
          `([^a-z]| |^)(((${typePatterns.join("|")})[ .:])?([a-z '-]{1,${
            nameSimilarity.length + 2
          }}))$`,
        );
        const matchSimilarityArray = similarityRegExp.exec(address2);
        if (matchSimilarityArray) {
          const matchSimilarity = matchSimilarityArray[2].trimStart();
          const matchSimilarityName = matchSimilarityArray[5].trimStart();
          const similarity = similarText(
            nameSimilarity,
            matchSimilarityName,
            true,
          );
          if (similarity > 80) {
            return this.done(
              entity,
              [matchSimilarity, nameSimilarity],
              scoreDeltaSimilarity + similarity / 100,
            );
          }
        }
      }

      return null;
    }

    const { length } = regExpMatch[0];
    const match = substrByDeaccentLength(address, length);
    const match2 = address2.substring(address2.length - length);

    const matchNormalized = normalize(match);
    const nameFound = names.reduce((prev, n) => {
      if (prev.length > n.length) return prev;
      if (matchNormalized.indexOf(n) > -1) return n;
      return prev;
    }, "");
    if (nameFound.length > 0) {
      return this.done(
        entity,
        [match, nameFound],
        this.calculateScoreDeltaType(typePatterns, match2),
      );
    }

    const name2Found = names2.reduce((prev, n) => {
      if (prev.length > n.length) return prev;
      if (match2.indexOf(n) > -1) return n;
      return prev;
    }, "");
    if (name2Found.length > 0) {
      return this.done(
        entity,
        [match2, name2Found],
        scoreDeltaName2 + this.calculateScoreDeltaType(typePatterns, match2),
      );
    }

    const acceptInitials = entity.level === 1 || pe; // first level only, or has previous match
    if (acceptInitials) {
      const initialsFound = initials.reduce((prev, initial) => {
        if (prev.length > initial.length) return prev;
        if (match.indexOf(initial) > -1) return initial;
        return prev;
      }, "");
      if (initialsFound.length > 0) {
        return this.done(entity, [match, initialsFound], scoreDeltaInitials);
      }
    }

    return null;
  }

  update(matches: Matches) {
    const score = matches.score();

    if (typeof this.count[score] === "number") {
      const thisLast = matches.entity;
      const otherLast = this.histories[score]
        ? this.histories[score].entity
        : null;
      if (
        thisLast &&
        otherLast &&
        normalize(`${thisLast.name}`) === normalize(`${otherLast.name}`) &&
        thisLast.parent === otherLast.parent
      ) {
        // special case: one parent has more than one entity
        if (otherLast.status) {
          // replace if it was deleted / moved
          this.histories[score] = matches;
        }
        // otherwise keep the first one
      } else {
        this.count[score]++;
        delete this.histories[score];
      }
    } else {
      this.count[score] = 1;
      this.histories[score] = matches;
    }
  }

  private calculateScoreDeltaType(
    typePatterns: string[],
    match2: string,
  ): number {
    let score = scoreDeltaType;
    const step = score / typePatterns.length / 2;

    for (const typePattern of typePatterns) {
      if (match2.startsWith(typePattern)) return score;
      score -= step;
    }

    return score;
  }

  private done(entity: Entity, found: string[], scoreDelta = 0) {
    const { address, previous } = this;
    const { matches, scores } = previous;
    const [full] = found;
    const addressLeft = address.substring(0, address.length - full.length);
    const _ = new Matches(addressLeft);

    if (entity.status) {
      const goodEntity = getEntityById(entity.id);
      if (goodEntity) entity = goodEntity;
    }
    _.entity = entity;

    _.matches = [...matches, found];
    _.scores = [
      ...scores,
      0.1 + similarText(full, `${entity.name}`, true) / 10000, // range 0.1000..0.1100, perfect match should should rank higher than typo
      entity.status === "Deleted" ? 0.0001 : 0.9999,
      full.length * scorePerChar,
      scoreDelta,
      entity.parent != previous.entity ? scoreDeltaSkip * entity.level : 0,
    ];

    return _;
  }
}
