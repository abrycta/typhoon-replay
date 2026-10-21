package app

import (
	"net/http"
	"strings"

	"github.com/abrycta/typhoon-replay/api/go/internal/api"
	"github.com/abrycta/typhoon-replay/api/go/internal/jsonw"
	"github.com/abrycta/typhoon-replay/api/go/internal/neon"
	"github.com/abrycta/typhoon-replay/api/go/internal/web"
)

var (
	searchParams   = []string{"q", "country", "limit"}
	pointParams    = []string{"lat", "lon"}
	hitParams      = []string{"radiusKm", "minWindKt", "from", "to", "sort", "cursor", "limit"}
	pointHitParams = []string{"lat", "lon", "radiusKm", "minWindKt", "from", "to", "sort", "cursor", "limit"}
	hitSorts       = map[string]sortSpec{
		"closest":        {wire: "closest", key: "h.km", ascending: true, cast: "::numeric", render: "h.km::text", kind: int(web.KeyNumber)},
		"peak-wind-desc": {wire: "peak-wind-desc", key: "coalesce(h.wind, -1)", cast: "::numeric", render: "coalesce(h.wind, -1)::text", kind: int(web.KeyNumber)},
		"peak-gust-desc": {wire: "peak-gust-desc", key: "coalesce(h.gust, -1)", cast: "::numeric", render: "coalesce(h.gust, -1)::text", kind: int(web.KeyNumber)},
		"date-desc":      {wire: "date-desc", key: "h.at", cast: "::timestamptz", render: ts("h.at"), kind: int(web.KeyTimestamp)},
	}
)

// SearchPlaces: GET /v1/places/search. Exact name, then prefix, then substring; ties by population, then id.
func (s *Server) SearchPlaces(w http.ResponseWriter, r *http.Request, p api.SearchPlacesParams) {
	c := ctxOf(r)
	if prob := web.Length("q", &p.Q, 1, 64); prob != nil {
		c.Fail(prob)
		return
	}
	country, prob := web.Country(p.Country)
	if prob != nil {
		c.Fail(prob)
		return
	}
	limit, prob := web.Limit(p.Limit, 10, 50)
	if prob != nil {
		c.Fail(prob)
		return
	}
	var a args
	q, like := a.add(p.Q), a.add(likeEscape(p.Q))
	filter := ""
	if country != nil {
		filter = " AND p.country = " + a.add(*country)
	}
	sql := "SELECT " + placeColumns + " FROM catalog.place p WHERE p.search_text LIKE '%' || lower(" + like +
		`) || '%' ESCAPE '\'` + filter + " ORDER BY CASE WHEN lower(p.name) = lower(" + q + ") OR p.name_ja = " + q +
		" THEN 0 WHEN lower(p.name) LIKE lower(" + like + `) || '%' ESCAPE '\' OR p.name_ja LIKE ` + like +
		` || '%' ESCAPE '\' THEN 1 ELSE 2 END, p.population DESC NULLS LAST, p.place_id LIMIT ` + a.add(limit) + "::int"
	res, etag, done := s.catalogue(c, searchParams, neon.Q(sql, a.vals...))
	if done {
		return
	}
	var w2 jsonw.W
	w2.Obj().Key("items").Arr()
	for i := 0; i < res[0].Len(); i++ {
		placeSummary(&w2, res[0].At(i))
	}
	w2.EndArr().End()
	s.sendJSON(c, w2.Bytes(), etag, "")
}

// GetNearestPlace: GET /v1/places/nearest. The place containing the point, else the nearest within 50 km.
func (s *Server) GetNearestPlace(w http.ResponseWriter, r *http.Request, _ api.GetNearestPlaceParams) {
	c := ctxOf(r)
	lat, prob := web.Coordinate(c, "lat", 90)
	if prob != nil {
		c.Fail(prob)
		return
	}
	lon, prob := web.Coordinate(c, "lon", 180)
	if prob != nil {
		c.Fail(prob)
		return
	}
	sql := "WITH pt AS (SELECT ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)::geography AS g) SELECT " +
		placeColumns + ", ST_Covers(p.geom, pt.g) AS contains, " +
		"round((ST_Distance(p.geom, pt.g) / 1000.0)::numeric, 1)::text AS km " +
		"FROM catalog.place p, pt WHERE ST_DWithin(p.geom, pt.g, 50000) ORDER BY ST_Distance(p.geom, pt.g), p.place_id LIMIT 1"
	res, etag, done := s.catalogue(c, pointParams, neon.Q(sql, lon, lat))
	if done {
		return
	}
	if res[0].Len() == 0 {
		c.Fail(web.Missing("No covered place within 50 km of this point."))
		return
	}
	row := res[0].At(0)
	km := "0"
	if !row.B("contains") {
		km = jsonw.Tidy(row.S("km"))
	}
	var w2 jsonw.W
	w2.Obj().Key("place")
	placeSummary(&w2, row)
	w2.Key("contains").Bool(row.B("contains")).N("distanceKm", km).End()
	s.sendJSON(c, w2.Bytes(), etag, "")
}

// GetPlace: GET /v1/places/{placeId}, with the display-simplified boundary (inside the 64 KB cap).
func (s *Server) GetPlace(w http.ResponseWriter, r *http.Request, placeID api.PlaceId, _ api.GetPlaceParams) {
	c := ctxOf(r)
	if !web.PlaceIDShape(placeID) {
		c.Fail(web.Invalid("#/path/placeId", "must match ^(PH-[0-9]{10}|JP-[0-9]{5})$"))
		return
	}
	sql := "SELECT " + placeColumns + ", p.population, p.area_km2, " +
		"round(ST_XMin(p.geom_display::geometry)::numeric, 4) AS min_lon, round(ST_YMin(p.geom_display::geometry)::numeric, 4) AS min_lat, " +
		"round(ST_XMax(p.geom_display::geometry)::numeric, 4) AS max_lon, round(ST_YMax(p.geom_display::geometry)::numeric, 4) AS max_lat, " +
		"ST_AsGeoJSON(p.geom_display::geometry, 4) AS geojson FROM catalog.place p WHERE p.place_id = $1"
	res, etag, done := s.catalogue(c, nil, neon.Q(sql, placeID))
	if done {
		return
	}
	if res[0].Len() == 0 {
		c.Fail(web.Missing("No such place."))
		return
	}
	row := res[0].At(0)
	var w2 jsonw.W
	w2.Obj()
	placeFields(&w2, row)
	w2.OptN("population", row.N("population")).N("areaKm2", jsonw.Tidy(row.S("area_km2")))
	w2.Key("bbox").Arr().Raw(jsonw.Tidy(row.S("min_lon"))).Raw(jsonw.Tidy(row.S("min_lat"))).
		Raw(jsonw.Tidy(row.S("max_lon"))).Raw(jsonw.Tidy(row.S("max_lat"))).EndArr()
	w2.Key("geometry").Raw(row.S("geojson")).End()
	s.sendJSON(c, w2.Bytes(), etag, "")
}

// ListPlaceStorms: GET /v1/places/{placeId}/storms, from the precomputed catalog.place_storm_exposure bands.
func (s *Server) ListPlaceStorms(w http.ResponseWriter, r *http.Request, placeID api.PlaceId, p api.ListPlaceStormsParams) {
	c := ctxOf(r)
	if !web.PlaceIDShape(placeID) {
		c.Fail(web.Invalid("#/path/placeId", "must match ^(PH-[0-9]{10}|JP-[0-9]{5})$"))
		return
	}
	h, prob := hitRequest(p.RadiusKm, p.MinWindKt, p.From, p.To, sortOf(p.Sort), p.Cursor, p.Limit)
	if prob != nil {
		c.Fail(prob)
		return
	}
	rs := itoa(h.radius)
	var a args
	var cte strings.Builder
	cte.WriteString("hits AS (SELECT e.sid, e.closest_approach_km AS km, e.closest_approach_at AS at, e.max_wind_kt_r" + rs +
		" AS wind, e.max_gust_kt_r" + rs + " AS gust, e.hours_r" + rs + " AS hours FROM catalog.place_storm_exposure e " +
		"WHERE e.place_id = " + a.add(placeID) + " AND e.closest_approach_km <= " + a.add(h.radius) + "::int")
	if h.from != nil {
		cte.WriteString(" AND e.season >= " + a.add(*h.from) + "::int")
	}
	if h.to != nil {
		cte.WriteString(" AND e.season <= " + a.add(*h.to) + "::int")
	}
	cte.WriteString(")")
	main := stormHits(cte.String(), &a, h)
	res, etag, done := s.catalogue(c, hitParams,
		neon.Q(`SELECT EXISTS (SELECT 1 FROM catalog.place WHERE place_id = $1) AS e`, placeID), neon.Q(main, a.vals...))
	if done {
		return
	}
	if !res[0].At(0).B("e") {
		c.Fail(web.Missing("No such place."))
		return
	}
	body, next := hitPage(res[1], h)
	s.sendJSON(c, body, etag, next)
}

// ListPointStorms: GET /v1/hits, the same question for an arbitrary point (geodesic distance on geography).
func (s *Server) ListPointStorms(w http.ResponseWriter, r *http.Request, p api.ListPointStormsParams) {
	c := ctxOf(r)
	lat, prob := web.Coordinate(c, "lat", 90)
	if prob != nil {
		c.Fail(prob)
		return
	}
	lon, prob := web.Coordinate(c, "lon", 180)
	if prob != nil {
		c.Fail(prob)
		return
	}
	h, prob := hitRequest(p.RadiusKm, p.MinWindKt, p.From, p.To, sortOf(p.Sort), p.Cursor, p.Limit)
	if prob != nil {
		c.Fail(prob)
		return
	}
	a := args{vals: []any{lon, lat, itoa(h.radius * 1000)}}
	seasons := ""
	if h.from != nil {
		seasons += " AND s.season >= " + a.add(*h.from) + "::int"
	}
	if h.to != nil {
		seasons += " AND s.season <= " + a.add(*h.to) + "::int"
	}
	main := stormHits(strings.Replace(pointHitsCTE, "%SEASONS%", seasons, 1), &a, h)
	// The planner over-estimates the interpolated rows and JIT-compiles the plan (about 1 s of LLVM time for a 60 ms
	// query). SET LOCAL lasts only for this transaction.
	res, etag, done := s.catalogue(c, pointHitParams, neon.Q("SET LOCAL jit = off"), neon.Q(main, a.vals...))
	if done {
		return
	}
	body, next := hitPage(res[1], h)
	s.sendJSON(c, body, etag, next)
}

type hitReq struct {
	radius   int
	minWind  *int
	from, to *int
	sort     sortSpec
	cursor   *web.Cursor
	limit    int
}

func sortOf[T ~string](v *T) *string {
	if v == nil {
		return nil
	}
	s := string(*v)
	return &s
}

func hitRequest(radiusKm *api.RadiusKm, minWind, from, to *int, sortWire *string, cursor *string, limit *int) (hitReq, *web.Problem) {
	var h hitReq
	var prob *web.Problem
	if h.radius, prob = web.Radius(radiusKm); prob != nil {
		return h, prob
	}
	for _, check := range []*web.Problem{web.IntRange("minWindKt", minWind, 0, 200), web.IntRange("from", from, 1840, 2100),
		web.IntRange("to", to, 1840, 2100), web.CursorShape(cursor)} {
		if check != nil {
			return h, check
		}
	}
	if h.limit, prob = web.Limit(limit, 50, 100); prob != nil {
		return h, prob
	}
	wire := "closest"
	if sortWire != nil {
		wire = *sortWire
	}
	sort, ok := hitSorts[wire]
	if !ok {
		return h, web.Invalid("#/query/sort", "must be one of closest, peak-wind-desc, peak-gust-desc, date-desc")
	}
	h.sort, h.minWind, h.from, h.to = sort, minWind, from, to
	h.cursor, prob = web.DecodeCursor(deref(cursor), sort.wire, web.KeyKind(sort.kind))
	return h, prob
}

// stormHits completes a hits CTE (columns sid, km, at, wind, gust, hours) into the page query.
func stormHits(cte string, a *args, h hitReq) string {
	var sql strings.Builder
	sql.WriteString("WITH " + cte + " SELECT " + stormColumns + ", h.km::text AS km, " + ts("h.at") +
		" AS at, h.wind, h.gust, h.hours, " + h.sort.render + " AS sort_key FROM hits h JOIN catalog.storm s ON s.sid = h.sid " +
		"LEFT JOIN catalog.pagasa_name pn ON pn.sid = s.sid WHERE true")
	if h.minWind != nil {
		sql.WriteString(" AND h.wind >= " + a.add(*h.minWind) + "::int")
	}
	if h.cursor != nil {
		keyset(&sql, a, h.sort.key, h.sort.ascending, h.sort.cast, "s.sid", h.cursor.Key, h.cursor.LastID)
	}
	dir := " DESC"
	if h.sort.ascending {
		dir = " ASC"
	}
	sql.WriteString(" ORDER BY " + h.sort.key + dir + ", s.sid ASC LIMIT " + a.add(h.limit+1) + "::int")
	return sql.String()
}

func hitPage(rows *neon.Rows, h hitReq) ([]byte, string) {
	var w jsonw.W
	w.Obj().Key("items").Arr()
	for i := 0; i < min(h.limit, rows.Len()); i++ {
		row := rows.At(i)
		w.Obj().Key("storm")
		stormSummary(&w, row)
		exposure(&w, row)
		w.End()
	}
	w.EndArr().Key("radiusKm").Int(int64(h.radius))
	next := ""
	if rows.Len() > h.limit {
		last := rows.At(h.limit - 1)
		next = web.EncodeCursor(h.sort.wire, web.KeyKind(h.sort.kind), last.S("sort_key"), last.S("s_sid"))
		w.S("nextCursor", next)
	}
	w.End()
	return w.Bytes(), next
}
