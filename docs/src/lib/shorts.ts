import data from "../data/shorts.json";

export interface Short {
  fig: string;
  title: string;
  act: string;
  problem: string;
  docs: string[];
  duration: number;
}

export interface ShortMedia extends Short {
  video: string;
  poster: string;
  thumb: string;
  captions: string;
  length: string;
}

const media = (s: Short): ShortMedia => {
  const dir = `${data.base}fig-${s.fig}/`;
  const m = Math.floor(s.duration / 60);
  const sec = String(s.duration % 60).padStart(2, "0");
  return {
    ...s,
    video: `${dir}fig-${s.fig}.mp4`,
    poster: `${dir}poster.jpg`,
    thumb: `${dir}thumb.jpg`,
    captions: `${dir}captions.vtt`,
    length: `${m}:${sec}`,
  };
};

export const shorts: ShortMedia[] = data.shorts.map(media);

export const acts = data.acts.map((act) => ({
  ...act,
  shorts: shorts.filter((s) => s.act === act.id),
}));

export function getShort(fig: string): ShortMedia {
  const short = shorts.find((s) => s.fig === fig.padStart(2, "0"));
  if (!short) throw new Error(`No short for FIG. ${fig} in src/data/shorts.json`);
  return short;
}

// `docs` entries are slugs under docs/ (an optional #anchor names the section a
// figure covers); a route id is the page's content path, with index pages
// reduced to their directory.
export function shortsForPage(routeId: string): ShortMedia[] {
  const page = routeId.replace(/^docs\//, "").replace(/\/$/, "");
  return shorts.filter((s) =>
    s.docs.some((d) => {
      const slug = d.split("#")[0].replace(/\/index$/, "");
      return slug === page;
    }),
  );
}
