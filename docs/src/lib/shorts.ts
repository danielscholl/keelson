import data from "../data/shorts.json";

export interface Short {
  fig: string;
  title: string;
  act: string;
  problem: string;
  docs: string[];
  duration: number;
  /** A film from another series sets its own media base, label, and file prefix. */
  base?: string;
  label?: string;
  prefix?: string;
}

export interface ShortMedia extends Short {
  /** "FIG. 14": what the film is called on screen. */
  tag: string;
  /** "fig-14": its media folder and its #anchor on the watch page. */
  key: string;
  video: string;
  poster: string;
  thumb: string;
  captions: string;
  length: string;
}

// This file is shared verbatim by every docs site that plays the films; what
// differs between sites lives in `series` in shorts.json.
export const series = data.series;
export const watchHref = `${series.href}watch/`;

const media = (s: Short): ShortMedia => {
  const key = `${s.prefix ?? series.prefix}-${s.fig}`;
  const dir = `${s.base ?? data.base}${key}/`;
  const m = Math.floor(s.duration / 60);
  const sec = String(s.duration % 60).padStart(2, "0");
  return {
    ...s,
    tag: `${s.label ?? series.label} ${s.fig}`,
    key,
    video: `${dir}${key}.mp4`,
    poster: `${dir}poster.jpg`,
    thumb: `${dir}thumb.jpg`,
    captions: `${dir}captions.vtt`,
    length: `${m}:${sec}`,
  };
};

export const shorts: ShortMedia[] = (data.shorts as Short[]).map(media);

const actLabel = (id: string): string =>
  id === "0" ? "Prologue" : id === "Coda" ? "Codas" : `Act ${id}`;

export const acts = data.acts.map((act) => ({
  ...act,
  label: actLabel(act.id),
  shorts: shorts.filter((s) => s.act === act.id),
}));

export function actOf(short: Short) {
  const act = acts.find((a) => a.id === short.act);
  if (!act) throw new Error(`${short.fig} names unknown act '${short.act}'`);
  return act;
}

/** Looks a film up by number in this site's own series ("14"), or by key ("fig-14"). */
export function getShort(fig: string): ShortMedia {
  const own = `${series.prefix}-${fig.padStart(2, "0")}`;
  const short = shorts.find((s) => s.key === fig || s.key === own);
  if (!short) throw new Error(`No short '${fig}' in src/data/shorts.json`);
  return short;
}

// `docs` entries are slugs under the series route; an optional #anchor names the
// section a figure covers. Index pages reduce to their directory, as route ids do.
export function docsSlug(entry: string): { page: string; anchor?: string } {
  const [path, anchor] = entry.split("#");
  return { page: path.replace(/\/index$/, ""), anchor };
}

export const isWatchRoute = (routeId: string) => routeId === `${series.route}watch`;

export function shortsForPage(routeId: string): ShortMedia[] {
  const page = routeId.slice(series.route.length).replace(/\/$/, "");
  return shorts.filter((s) => s.docs.some((d) => docsSlug(d).page === page));
}
