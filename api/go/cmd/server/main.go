// Command server is the Go backend: one process, net/http, configuration from the environment only
// (CONTRACT-GUIDE §11). It answers /healthz as soon as the port opens; /readyz waits for the database.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	replay "github.com/abrycta/typhoon-replay/api/go"
	"github.com/abrycta/typhoon-replay/api/go/internal/app"
	"github.com/abrycta/typhoon-replay/api/go/internal/web"
)

func main() {
	impl, contract := replay.ReadImpl()
	port := env("PORT", "8080")
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           app.New(config(impl, contract)),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	println(`{"level":"info","msg":"listening","impl":"go","port":"` + port + `"}`)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func config(impl replay.Impl, contract string) app.Config {
	var limiter web.Limiter
	if rate, err := strconv.Atoi(env("TR_RATE_LIMIT_PER_MINUTE", "600")); err == nil && rate > 0 {
		limiter = web.TokenBucket(rate)
	}
	streams, _ := strconv.Atoi(env("TR_MAX_STREAMS", "200"))
	hooks := os.Getenv("TR_TEST_HOOKS")
	return app.Config{
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		NeonHTTPURL:      os.Getenv("NEON_HTTP_URL"),
		SiteOrigin:       env("TR_SITE_ORIGIN", "https://replay.krtmtthw.dev"),
		TestHooks:        hooks == "1" || hooks == "true",
		Limiter:          limiter,
		MaxStreams:       streams,
		EdgeSecret:       os.Getenv("TR_EDGE_SECRET"),
		Commit:           env("TR_COMMIT", env("RENDER_GIT_COMMIT", "unknown")),
		MinSchemaVersion: impl.MinSchemaVersion,
		ID:               web.Identity{Impl: impl.Impl, ImplVersion: impl.ImplVersion, ContractVersion: contract},
		OpenAPI:          replay.OpenAPI,
	}
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
