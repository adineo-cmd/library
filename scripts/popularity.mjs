/**
 * Popularity scoring — hand knowledge, zero network.
 *
 * Two questions the atlas has to answer everywhere it lists things: which
 * of a domain's children is the famous one (Physics before Viticulture),
 * and which fields does everyone recognise (machine learning before
 * photolithography). The answers below are written from general knowledge:
 *
 *   - the spine's own declaration order in scripts/spine.mjs IS a curated
 *     fame ranking (domains were written famous-first, subdomains too), so
 *     a spine node's score comes from its position: earlier = higher;
 *   - pool fields get a bonus when their name hits the FAMOUS_TERMS list —
 *     the concepts a reasonably educated person has heard of;
 *   - the sitelink counts already cached by earlier builds (atlas-work/
 *     sitelinks.json) are used as a small local tie-breaker — real data,
 *     no new requests;
 *   - everything unrecognised scores low, which lands the enologies and
 *     Spumantes of the world at the bottom, exactly as intended.
 */

/** Famous concepts by name — the recognition tier. Lower array index within
 *  FAMOUS_TERMS groups is not meaningful; membership is what matters, and
 *  the exact-name map lets near-duplicates ("quantum mechanics" vs "Quantum
 *  Mechanics") share one rank. Ordered roughly famous-first so equal matches
 *  break toward the front. */
const FAMOUS_TERMS = [
  // physical sciences
  'physics', 'chemistry', 'biology', 'mathematics', 'astronomy', 'geology',
  'thermodynamics', 'quantum mechanics', 'relativity', 'electromagnetism',
  'classical mechanics', 'optics', 'statistical mechanics', 'particle physics',
  'nuclear physics', 'astrophysics', 'cosmology', 'organic chemistry',
  'inorganic chemistry', 'physical chemistry', 'analytical chemistry',
  'biochemistry', 'electrochemistry', 'genetics', 'evolution', 'ecology',
  'microbiology', 'molecular biology', 'cell biology', 'zoology', 'botany',
  'neuroscience', 'meteorology', 'oceanography', 'climatology', 'paleontology',
  'seismology', 'volcanology', 'hydrology', 'planetary science',
  // formal sciences
  'algebra', 'geometry', 'calculus', 'analysis', 'number theory', 'topology',
  'probability', 'statistics', 'combinatorics', 'logic', 'set theory',
  'game theory', 'optimization', 'numerical analysis', 'cryptograph',
  'differential equation', 'mathematical analysis', 'linear algebra',
  // computing & engineering
  'computer science', 'algorithm', 'programming language', 'artificial intelligence',
  'machine learning', 'deep learning', 'neural network', 'computer vision',
  'natural language processing', 'robotics', 'database', 'operating system',
  'computer network', 'software engineering', 'software development',
  'data science', 'big data', 'cybersecur', 'cryptographic', 'internet',
  'electrical engineering', 'electronic', 'circuit', 'signal processing',
  'control system', 'telecommunication', 'mechanical engineering',
  'thermodynamic', 'fluid mechanics', 'manufacturing', 'materials science',
  'civil engineering', 'structural engineering', 'aerodynamic', 'propulsion',
  'aerospace', 'chemical engineering', 'biotechnology', 'genetic engineering',
  'renewable energy', 'electricity', 'magnetism', 'energy', 'internet of things',
  // health & medicine
  'medicine', 'anatomy', 'physiology', 'pathology', 'pharmacolog', 'surgery',
  'cardiolog', 'neurolog', 'oncolog', 'epidemiolog', 'immunolog', 'genetics in medicine',
  'pediatric', 'psychiatr', 'radiolog', 'public health', 'nutrition', 'dentistr',
  'nursing', 'virolog', 'bacteriolog', 'endocrinolog', 'dermatolog',
  // social sciences
  'psycholog', 'sociolog', 'economics', 'microeconomic', 'macroeconomic',
  'econometric', 'political science', 'international relation', 'anthropolog',
  'archaeolog', 'geograph', 'demograph', 'linguistic', 'education', 'law',
  'criminolog', 'finance', 'accounting', 'marketing', 'management', 'entrepreneur',
  // humanities
  'philosoph', 'history', 'literature', 'poetry', 'linguisti', 'religio',
  'theolog', 'mytholog', 'ethic', 'logic in philosophy', 'aesthetic',
  'art histor', 'music theor', 'musicolog', 'linguistics',
  // applied & everyday-famous
  'agricultur', 'horticultur', 'architecture', 'urban planning', 'transport',
  'logistic', 'aviation', 'navigation', 'surveying', 'journalis', 'rhetoric',
  'design', 'photograph', 'cinematograph', 'animation', 'typograph',
  'culinar', 'gastronom', 'sport', 'kinesiolog', 'biomechanic',
  // sports & games
  'football', 'basketball', 'cricket', 'tennis', 'chess', 'boxing',
  'swimming', 'athletic', 'marathon', 'golf', 'rugby', 'baseball',
  'martial art', 'karate', 'judo', 'esport', 'video game', 'poker',
  'skiing', 'ice hockey', 'cycling', 'formula', 'gymnastic', 'yoga',
  // trades & crafts
  'carpenter', 'plumb', 'electrician', 'welding', 'blacksmith', 'tailor',
  'mechanic', 'machinist', 'bookbind', 'pottery', 'weaving', 'glassblow',
  'butcher', 'brewing', 'hairdress', 'tattoo',
  // everyday life
  'gardening', 'personal financ', 'budget', 'first aid', 'parenting',
  'dog training', 'genealog', 'camping', 'fishing', 'hiking', 'birdwatch',
  'wedding', 'volunteer', 'coffee', 'barbecue', 'home repair',
];

const FAMOUS_LOWER = new Set(FAMOUS_TERMS.map(t => t.toLowerCase()));

/** Score a pool field by name: famous concepts land in the 300–450 band,
 *  everything else 60–120 with the sitelink count nudging within the band. */
export function fieldScore(name, sitelinks = 0) {
  const n = name.toLowerCase();
  let hit = -1;
  for (let i = 0; i < FAMOUS_TERMS.length; i++) {
    if (n.includes(FAMOUS_TERMS[i].toLowerCase())) { hit = i; break; }
  }
  const fame = Math.max(0, Math.min(120, sitelinks)); // measured tie-breaker
  if (hit >= 0) return 330 - Math.min(150, hit) + fame * 0.5;
  return 90 + fame * 0.25;
}

/** Spine nodes score from their curated position: domains 600+, subdomains
 *  in a 400–650 band — both always above the pool's long tail. */
export function spineScore(kind, index) {
  if (kind === 'trunk') return 1000;
  if (kind === 'domain') return 900 - Math.min(300, index);
  if (kind === 'subdomain') return 650 - Math.min(250, index);
  return 100;
}
