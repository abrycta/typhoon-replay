// The map chunk (MapLibre and the field layer, the largest download on a replay page). Routes that show a replay
// start it on entry, beside the storm's summary, instead of after the summary has arrived and the replay renders.
export const loadReplayMap = () => import("./ReplayMap");
