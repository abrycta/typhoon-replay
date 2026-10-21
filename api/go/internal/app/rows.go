package app

import (
	"strconv"

	"github.com/abrycta/typhoon-replay/api/go/internal/jsonw"
	"github.com/abrycta/typhoon-replay/api/go/internal/neon"
)

// Row writers for the read models several operations share (StormSummary, PlaceSummary, the exposure numbers).
// Columns come from stormColumns / placeColumns; optional members are omitted, never null.

func stormSummary(w *jsonw.W, r neon.Row) {
	w.Obj().S("sid", r.S("s_sid")).S("name", r.S("s_name"))
	localNames(w, r.N("s_name_ph"), r.N("s_name_ja"))
	w.N("season", r.S("s_season")).S("basin", r.S("s_basin")).S("startedAt", r.S("s_started_at")).
		S("endedAt", r.S("s_ended_at")).OptN("peakWindKt", r.N("s_peak_wind_kt")).
		OptS("peakWindAgency", r.N("s_peak_wind_agency")).OptN("minPressureHpa", r.N("s_min_pressure_hpa")).
		Key("landfallCountries").Raw(r.S("s_landfall_countries"))
	w.End()
}

func placeSummary(w *jsonw.W, r neon.Row) {
	placeFields(w.Obj(), r)
	w.End()
}

// placeFields writes the PlaceSummary members into an open object (PlaceDetail extends it).
func placeFields(w *jsonw.W, r neon.Row) {
	w.S("id", r.S("p_id")).S("country", r.S("p_country")).S("kind", r.S("p_kind")).S("name", r.S("p_name")).
		OptS("nameJa", r.N("p_name_ja")).S("admin1", r.S("p_admin1")).OptS("admin1Ja", r.N("p_admin1_ja")).
		OptS("admin2", r.N("p_admin2"))
	lonLat(w.Key("centroid"), r.S("p_lon"), r.S("p_lat"))
}

// exposure writes the closest-approach members of a StormHit / PlaceHit (columns km, at, wind, gust, hours).
func exposure(w *jsonw.W, r neon.Row) {
	w.N("closestApproachKm", jsonw.Tidy(r.S("km"))).S("closestApproachAt", r.S("at")).
		OptN("maxWindKtWithinRadius", r.N("wind")).OptN("maxGustKtWithinRadius", r.N("gust")).
		N("hoursWithinRadius", jsonw.Tidy(r.S("hours")))
}

func localNames(w *jsonw.W, ph, ja *string) {
	if ph == nil && ja == nil {
		return
	}
	w.Key("localNames").Obj().OptS("ph", ph).OptS("ja", ja).End()
}

// lonLat writes [lon, lat] (already rounded to 4 decimals in SQL), longitude normalised to (-180, 180].
func lonLat(w *jsonw.W, lon, lat string) {
	if f, err := strconv.ParseFloat(lon, 64); err == nil && (f <= -180 || f > 180) {
		if f <= -180 {
			f += 360
		} else {
			f -= 360
		}
		lon = strconv.FormatFloat(f, 'f', 4, 64)
	}
	w.Arr().Raw(jsonw.Tidy(lon)).Raw(jsonw.Tidy(lat)).EndArr()
}

func itoa(n int) string { return strconv.Itoa(n) }
