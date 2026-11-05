// Rink metadata keyed by the `rinkId` used in icetimestl.com's /api/schedule feed.
//
// `name`  : human-friendly calendar name shown in people's calendar apps.
// `short` : compact tag used in the combined "all rinks" feed summaries.
// `club`  : true for members-only figure-skating club ice (not a public facility).
//
// NOTE on the two clubs (ccfsc, stlsc): on icetimestl.com their "Club Ice"
// sessions are shown under a host rink. We keep them as their own calendars here
// so a subscriber to a public rink isn't flooded with members-only ice. If you'd
// rather fold club ice into a physical rink, change `foldInto` to that rinkId and
// re-run; the build will route those sessions into the host rink's calendar.
export const RINKS = {
  centene:      { name: 'Centene Community Ice Center', short: 'Centene' },
  crevecoeur:   { name: 'Creve Coeur Ice Arena',        short: 'Creve Coeur' },
  greensfelder: { name: 'Greensfelder Rec Complex',     short: 'Greensfelder' },
  webster:      { name: 'Webster Groves Ice Arena',     short: 'Webster' },
  kennedy:      { name: 'Kennedy Rec Complex',          short: 'Kennedy' },
  brentwood:    { name: 'Brentwood Ice Rink',           short: 'Brentwood' },
  kirkwood:     { name: 'Kirkwood Ice Rink',            short: 'Kirkwood' },
  ccfsc:        { name: 'Creve Coeur FSC — Club Ice',   short: 'CCFSC', club: true, foldInto: null },
  stlsc:        { name: 'St. Louis SC — Club Ice',      short: 'STLSC', club: true, foldInto: null },
};

// Fallback for any rinkId that appears in the feed but isn't listed above.
export function rinkInfo(rinkId) {
  if (RINKS[rinkId]) return RINKS[rinkId];
  const pretty = rinkId.charAt(0).toUpperCase() + rinkId.slice(1);
  return { name: pretty, short: pretty };
}
