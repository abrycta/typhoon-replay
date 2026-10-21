package app

import (
	"net/http"
	"strings"

	"github.com/abrycta/typhoon-replay/api/go/internal/api"
	"github.com/abrycta/typhoon-replay/api/go/internal/jsonw"
	"github.com/abrycta/typhoon-replay/api/go/internal/neon"
	"github.com/abrycta/typhoon-replay/api/go/internal/web"
)

var stormSorts = map[string]sortSpec{
	"season-desc":    {wire: "season-desc", key: "s.season", cast: "::numeric", render: "s.season::text", kind: int(web.KeyNumber)},
	"peak-wind-desc": {wire: "peak-wind-desc", key: "coalesce(s.peak_wind_kt, -1)", cast: "::numeric", render: "coalesce(s.peak_wind_kt, -1)::text", kind: int(web.KeyNumber)},
	"name":           {wire: "name", key: `upper(s.name) COLLATE "C"`, ascending: true, cast: "::text", render: "upper(s.name)", kind: int(web.KeyString)},
}

var (
	listStormsParams  = []string{"q", "season", "from", "to", "basin", "country", "minWindKt", "sort", "cursor", "limit"}
	stormPlacesParams = []string{"radiusKm", "country", "cursor", "limit"}
)

// ListStorms: GET /v1/storms.
func (s *Server) ListStorms(w http.ResponseWriter, r *http.Request, p api.ListStormsParams) {
	c := ctxOf(r)
	for _, check := range []*web.Problem{
		web.Length("q", p.Q, 2, 64), web.IntRange("season", p.Season, 1840, 2100), web.IntRange("from", p.From, 1840, 2100),
		web.IntRange("to", p.To, 1840, 2100), web.IntRange("minWindKt", p.MinWindKt, 0, 200), web.CursorShape(p.Cursor),
	} {
		if check != nil {
			c.Fail(check)
			return
		}
	}
	if p.Basin != nil && !p.Basin.Valid() {
		c.Fail(web.Invalid("#/query/basin", "must be one of WP, EP, NA, NI, SI, SP, SA"))
		return
	}
	country, prob := web.Country(p.Country)
	if prob != nil {
		c.Fail(prob)
		return
	}
	limit, prob := web.Limit(p.Limit, 50, 100)
	if prob != nil {
		c.Fail(prob)
		return
	}
	if p.Season != nil && (p.From != nil || p.To != nil) {
		c.Fail(&web.Problem{Type: web.Validation, Detail: "season cannot be combined with from/to.",
			Errors: []web.FieldProblem{{Pointer: "#/query/season", Detail: "cannot be combined with from/to"}}})
		return
	}
	sortWire := "season-desc"
	if p.Sort != nil {
		sortWire = string(*p.Sort)
	}
	sort, ok := stormSorts[sortWire]
	if !ok {
		c.Fail(web.Invalid("#/query/sort", "must be one of season-desc, peak-wind-desc, name"))
		return
	}
	cur, prob := web.DecodeCursor(deref(p.Cursor), sort.wire, web.KeyKind(sort.kind))
	if prob != nil {
		c.Fail(prob)
		return
	}

	var a args
	var sql strings.Builder
	sql.WriteString("SELECT " + stormColumns + ", " + sort.render + " AS sort_key FROM " + stormFrom + " WHERE true")
	if p.Q != nil {
		sql.WriteString(` AND s.search_text LIKE '%' || lower(` + a.add(likeEscape(*p.Q)) + `) || '%' ESCAPE '\'`)
	}
	if p.Season != nil {
		sql.WriteString(" AND s.season = " + a.add(*p.Season) + "::int")
	}
	if p.From != nil {
		sql.WriteString(" AND s.season >= " + a.add(*p.From) + "::int")
	}
	if p.To != nil {
		sql.WriteString(" AND s.season <= " + a.add(*p.To) + "::int")
	}
	if p.Basin != nil {
		sql.WriteString(" AND s.basin = " + a.add(string(*p.Basin)))
	}
	if country != nil {
		sql.WriteString(" AND s.landfall_countries @> ARRAY[" + a.add(*country) + "::text]")
	}
	if p.MinWindKt != nil {
		sql.WriteString(" AND s.peak_wind_kt >= " + a.add(*p.MinWindKt) + "::int")
	}
	if cur != nil {
		keyset(&sql, &a, sort.key, sort.ascending, sort.cast, "s.sid", cur.Key, cur.LastID)
	}
	dir := " DESC"
	if sort.ascending {
		dir = " ASC"
	}
	sql.WriteString(" ORDER BY " + sort.key + dir + ", s.sid ASC LIMIT " + a.add(limit+1) + "::int")

	res, etag, done := s.catalogue(c, listStormsParams, neon.Q(sql.String(), a.vals...))
	if done {
		return
	}
	rows := res[0]
	var w2 jsonw.W
	w2.Obj().Key("items").Arr()
	n := min(limit, rows.Len())
	for i := 0; i < n; i++ {
		stormSummary(&w2, rows.At(i))
	}
	w2.EndArr()
	next := ""
	if rows.Len() > limit {
		last := rows.At(limit - 1)
		next = web.EncodeCursor(sort.wire, web.KeyKind(sort.kind), last.S("sort_key"), last.S("s_sid"))
		w2.S("nextCursor", next)
	}
	w2.End()
	s.sendJSON(c, w2.Bytes(), etag, next)
}

// GetStorm: GET /v1/storms/{sid}.
func (s *Server) GetStorm(w http.ResponseWriter, r *http.Request, sid api.Sid, _ api.GetStormParams) {
	c := ctxOf(r)
	if !web.SidShape(sid) {
		c.Fail(web.Invalid("#/path/sid", "must match ^[0-9]{7}[NS][0-9]{5}$"))
		return
	}
	detail := `SELECT s.sid, s.name, s.season, s.basin, s.number, s.atcf_id, ` + ts("s.started_at") + ` AS started_at, ` +
		ts("s.ended_at") + ` AS ended_at, extract(epoch FROM s.ended_at - s.started_at) / 3600.0 AS duration_hours, ` +
		`s.fix_count, coalesce(array_to_json(s.landfall_countries)::text, '[]') AS landfall_countries, s.replay_available, ` +
		`s.name_ja, pn.pagasa_name, pn.source_url AS pagasa_url, s.peak_wind_kt, s.peak_wind_agency, s.min_pressure_hpa, ` +
		ts("s.peak_at") + ` AS peak_at, ` + lon("s.peak_position") + ` AS peak_lon, ` + lat("s.peak_position") + ` AS peak_lat, ` +
		`s.jtwc_max_wind_kt, s.jtwc_min_pressure_hpa, s.jma_max_wind_kt, s.jma_min_pressure_hpa, ` +
		`s.wmo_max_wind_kt, s.wmo_min_pressure_hpa, ` +
		`(SELECT ibtracs_version FROM catalog.dataset_version ORDER BY version DESC LIMIT 1) AS ibtracs_version ` +
		`FROM catalog.storm s LEFT JOIN catalog.pagasa_name pn ON pn.sid = s.sid WHERE s.sid = $1`
	landfalls := `SELECT country, ` + ts("at") + ` AS at, place_id, ` + lon("position") + ` AS lon, ` + lat("position") +
		` AS lat FROM catalog.storm_landfall WHERE sid = $1 ORDER BY seq`
	res, etag, done := s.catalogue(c, nil, neon.Q(detail, sid), neon.Q(landfalls, sid))
	if done {
		return
	}
	if res[0].Len() == 0 {
		c.Fail(web.Missing("No such storm."))
		return
	}
	d := res[0].At(0)
	var w2 jsonw.W
	w2.Obj().S("sid", d.S("sid")).S("name", d.S("name"))
	localNames(&w2, d.N("pagasa_name"), d.N("name_ja"))
	w2.N("season", d.S("season")).S("basin", d.S("basin"))
	w2.OptN("number", d.N("number")).OptS("atcfId", d.N("atcf_id"))
	w2.S("startedAt", d.S("started_at")).S("endedAt", d.S("ended_at"))
	w2.N("durationHours", jsonw.Tidy(d.S("duration_hours"))).N("fixCount", d.S("fix_count"))
	w2.Key("landfallCountries").Raw(d.S("landfall_countries"))
	w2.Key("peak").Obj().OptN("windKt", d.N("peak_wind_kt")).OptS("agency", d.N("peak_wind_agency")).
		OptN("pressureHpa", d.N("min_pressure_hpa")).OptS("at", d.N("peak_at"))
	if d.N("peak_lon") != nil {
		lonLat(w2.Key("position"), d.S("peak_lon"), d.S("peak_lat"))
	}
	w2.End()
	// Lifetime extremes per agency. In the WP basin "wmo" is JMA, so it is listed only when JMA itself is absent.
	w2.Key("intensity").Arr()
	intensity(&w2, "jtwc", 1, d.N("jtwc_max_wind_kt"), d.N("jtwc_min_pressure_hpa"))
	if !intensity(&w2, "jma", 10, d.N("jma_max_wind_kt"), d.N("jma_min_pressure_hpa")) {
		intensity(&w2, "wmo", 10, d.N("wmo_max_wind_kt"), d.N("wmo_min_pressure_hpa"))
	}
	w2.EndArr()
	w2.Key("landfalls").Arr()
	for i := 0; i < res[1].Len(); i++ {
		l := res[1].At(i)
		w2.Obj().S("country", l.S("country")).S("at", l.S("at"))
		lonLat(w2.Key("position"), l.S("lon"), l.S("lat"))
		w2.OptS("placeId", l.N("place_id")).End()
	}
	w2.EndArr()
	version := "v04r01"
	if v := d.N("ibtracs_version"); v != nil {
		version = *v
	}
	w2.Key("sources").Arr()
	w2.Obj().S("id", "ibtracs-"+slug(version)).
		S("name", "IBTrACS "+version+" (NOAA NCEI)").
		S("url", "https://www.ncei.noaa.gov/products/international-best-track-archive").
		S("license", "Public domain (NOAA)").End()
	if d.N("pagasa_name") != nil && d.N("pagasa_url") != nil {
		w2.Obj().S("id", "pagasa-names").S("name", "PAGASA local name crosswalk").S("url", d.S("pagasa_url")).End()
	}
	w2.EndArr()
	w2.Key("replayAvailable").Bool(d.B("replay_available"))
	w2.End()
	s.sendJSON(c, w2.Bytes(), etag, "")
}

// slug lowercases and replaces every run of characters outside [a-z0-9] with one "-" (v04r01 → v04r01).
func slug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			dash = false
		} else if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	return b.String()
}

// intensity writes one AgencyIntensity when the agency has a wind or pressure value; it reports whether it did.
func intensity(w *jsonw.W, agency string, minutes int64, wind, pressure *string) bool {
	if wind == nil && pressure == nil {
		return false
	}
	w.Obj().S("agency", agency).Key("windAveragingMinutes").Int(minutes).OptN("maxWindKt", wind).
		OptN("minPressureHpa", pressure).End()
	return true
}

// GetStormTrack: GET /v1/storms/{sid}/track, best-track fixes as a GeoJSON FeatureCollection.
func (s *Server) GetStormTrack(w http.ResponseWriter, r *http.Request, sid api.Sid, _ api.GetStormTrackParams) {
	c := ctxOf(r)
	if !web.SidShape(sid) {
		c.Fail(web.Invalid("#/path/sid", "must match ^[0-9]{7}[NS][0-9]{5}$"))
		return
	}
	track := `SELECT ` + ts("observed_at") + ` AS at, wind_kt, wind_agency, gust_kt, pressure_hpa, nature, sshs_category, ` +
		`jma_grade, dist_to_land_km, speed_kt, direction_deg, ` + lon("position") + ` AS lon, ` + lat("position") + ` AS lat ` +
		`FROM catalog.storm_fix WHERE sid = $1 ORDER BY observed_at`
	res, etag, done := s.catalogue(c, nil, neon.Q(`SELECT EXISTS (SELECT 1 FROM catalog.storm WHERE sid = $1) AS e`, sid),
		neon.Q(track, sid))
	if done {
		return
	}
	if !res[0].At(0).B("e") {
		c.Fail(web.Missing("No such storm."))
		return
	}
	var w2 jsonw.W
	w2.Obj().S("type", "FeatureCollection").S("sid", sid).S("resolution", "best-track").Key("features").Arr()
	rows := res[1]
	for i := 0; i < rows.Len(); i++ {
		f := rows.At(i)
		w2.Obj().S("type", "Feature").Key("geometry").Obj().S("type", "Point")
		lonLat(w2.Key("coordinates"), f.S("lon"), f.S("lat"))
		w2.End().Key("properties").Obj().S("at", f.S("at")).OptN("windKt", f.N("wind_kt")).
			OptS("windAgency", f.N("wind_agency")).OptN("gustKt", f.N("gust_kt")).OptN("pressureHpa", f.N("pressure_hpa")).
			OptS("nature", f.N("nature")).OptN("sshsCategory", f.N("sshs_category")).OptN("jmaGrade", f.N("jma_grade")).
			OptN("distanceToLandKm", f.N("dist_to_land_km")).OptN("speedKt", f.N("speed_kt")).
			OptN("directionDeg", f.N("direction_deg")).End().End()
	}
	w2.EndArr().End()
	s.sendJSON(c, w2.Bytes(), etag, "", "application/geo+json")
}

// ListStormPlaces: GET /v1/storms/{sid}/places, places within radiusKm of the track, closest first.
func (s *Server) ListStormPlaces(w http.ResponseWriter, r *http.Request, sid api.Sid, p api.ListStormPlacesParams) {
	c := ctxOf(r)
	if !web.SidShape(sid) {
		c.Fail(web.Invalid("#/path/sid", "must match ^[0-9]{7}[NS][0-9]{5}$"))
		return
	}
	radius, prob := web.Radius(p.RadiusKm)
	if prob == nil {
		prob = web.CursorShape(p.Cursor)
	}
	var country *string
	if prob == nil {
		country, prob = countryOf(p.Country)
	}
	limit := 0
	if prob == nil {
		limit, prob = web.Limit(p.Limit, 50, 100)
	}
	var cur *web.Cursor
	if prob == nil {
		cur, prob = web.DecodeCursor(deref(p.Cursor), "closest", web.KeyNumber)
	}
	if prob != nil {
		c.Fail(prob)
		return
	}
	rs := itoa(radius)
	var a args
	var sql strings.Builder
	sidP := a.add(sid)
	sql.WriteString("SELECT " + placeColumns + ", e.closest_approach_km::text AS km, " + ts("e.closest_approach_at") +
		" AS at, e.max_wind_kt_r" + rs + " AS wind, e.max_gust_kt_r" + rs + " AS gust, e.hours_r" + rs + " AS hours " +
		"FROM catalog.place_storm_exposure e JOIN catalog.place p ON p.place_id = e.place_id " +
		"WHERE e.sid = " + sidP + " AND e.closest_approach_km <= " + a.add(radius) + "::int")
	if country != nil {
		sql.WriteString(" AND p.country = " + a.add(*country))
	}
	if cur != nil {
		keyset(&sql, &a, "e.closest_approach_km", true, "::numeric", "e.place_id", cur.Key, cur.LastID)
	}
	sql.WriteString(" ORDER BY e.closest_approach_km ASC, e.place_id ASC LIMIT " + a.add(limit+1) + "::int")
	res, etag, done := s.catalogue(c, stormPlacesParams,
		neon.Q(`SELECT EXISTS (SELECT 1 FROM catalog.storm WHERE sid = $1) AS e`, sid), neon.Q(sql.String(), a.vals...))
	if done {
		return
	}
	if !res[0].At(0).B("e") {
		c.Fail(web.Missing("No such storm."))
		return
	}
	rows := res[1]
	var w2 jsonw.W
	w2.Obj().Key("items").Arr()
	for i := 0; i < min(limit, rows.Len()); i++ {
		row := rows.At(i)
		w2.Obj().Key("place")
		placeSummary(&w2, row)
		exposure(&w2, row)
		w2.End()
	}
	w2.EndArr().Key("radiusKm").Int(int64(radius))
	next := ""
	if rows.Len() > limit {
		last := rows.At(limit - 1)
		next = web.EncodeCursor("closest", web.KeyNumber, last.S("km"), last.S("p_id"))
		w2.S("nextCursor", next)
	}
	w2.End()
	s.sendJSON(c, w2.Bytes(), etag, next)
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func countryOf(v *api.Country) (*string, *web.Problem) {
	if v == nil {
		return nil, nil
	}
	cc := api.CountryCode(*v)
	return web.Country(&cc)
}
